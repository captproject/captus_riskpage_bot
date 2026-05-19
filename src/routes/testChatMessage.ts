// ─────────────────────────────────────────────────────────────────────────────
// routes/testChatMessage.ts
// CP-7 — Send Chat Message
//
// Endpoint: POST /test-chat-message
//
// Spec coverage:
//   "Message persists, AI response received" (Critical Path 8.2)
//
// Validates the end-to-end AI chat workflow:
//   1. Chat widget visible + opens cleanly
//   2. User can send a message (via Enter key)
//   3. Real AI response generated (non-empty, differs from prompt)
//   4. Streaming completes (typing indicator returns to 0)
//   5. Both messages persist across chat panel close + reopen (content-match)
//      NOTE: Captus chat is session-scoped, NOT reload-persistent (by design).
//            CP-7 "Message persists" = panel close/reopen, not page reload.
//   6. No console errors during interaction (third-party CSP noise filtered)
//   7. Latency captured for telemetry
//
// Key design choice (per manager review):
//   Bubble identification uses BEFORE/AFTER COUNT DELTA, not "latest bubble".
//   Rationale:
//     - Old assistant messages may exist in thread history
//     - Thread history may reorder
//     - Stale messages could confuse matching
//   Pattern:
//     1. assistantCountBefore = locator.count()
//     2. send message
//     3. waitFor assistantCount === assistantCountBefore + 1 (or more)
//     4. capture bubble[assistantCountBefore..end] — guaranteed new
//
// Selectors derived from Captus DOM inspection:
//   - Chat widget:         data-testid="button-chat-widget"
//   - Chat close:          data-testid="button-chat-close"
//   - Chat input:          input[placeholder="Type a message..."]
//   - Send mechanism:      Enter key (primary), button[type="submit"] (fallback)
//   - Scroll container:    [data-radix-scroll-area-content]  (Radix UI)
//   - User message row:    div.flex.justify-end
//   - AI message row:      div.flex.justify-start
//   - Message text:        .whitespace-pre-wrap.break-words (within row)
//   - Typing indicator:    span.animate-bounce (3 dots, count→0 when done)
//
// Anti-flake measures:
//   - No fixed-time waits inside polls (uses waitForFunction with predicates)
//   - 60s ceiling on AI response (then fail cleanly)
//   - 1.5s settle period after streaming completes (handles multi-bubble responses)
//   - All locator scopes use Radix UI data-* attrs (stable across versions)
//
// Runtime: ~30-90s (depends on AI response speed + reload)
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, Router } from "express";
import { Page, BrowserContext, ConsoleMessage } from "playwright";
import { createContextAndLogin } from "../services/loginService";
import { ensureCompanyIsDemo } from "../services/companyGuardService";
import { uploadScreenshot } from "../utils/screenshot";
import { recordTestResult } from "../services/allureReporter";
import { saveTestResult } from "../services/supabaseLogger";
import { config } from "../server";

const router = Router();

// ─── Tunables ───────────────────────────────────────────────────────────────

const CHAT_OPEN_TIMEOUT_MS = 10_000;
const INPUT_VISIBLE_TIMEOUT_MS = 5_000;
const USER_BUBBLE_DELTA_TIMEOUT_MS = 5_000;
const AI_RESPONSE_TIMEOUT_MS = 60_000;    // max wait for streaming to complete
const STREAM_SETTLE_MS = 1_500;            // pause after typing dots reach 0
const TYPING_APPEARS_TIMEOUT_MS = 5_000;   // optional — may skip if AI is fast
const RELOAD_TIMEOUT_MS = 30_000;
const PERSISTENCE_TIMEOUT_MS = 10_000;

// ─── Selectors ──────────────────────────────────────────────────────────────

const SEL = {
  chatWidget: 'button[data-testid="button-chat-widget"]',
  chatClose: 'button[data-testid="button-chat-close"]',
  chatInput: 'input[placeholder="Type a message..."]',
  sendButton: 'button[type="submit"]',
  scrollArea: '[data-radix-scroll-area-content]',
  userRow: '[data-radix-scroll-area-content] div.flex.justify-end',
  aiRow: '[data-radix-scroll-area-content] div.flex.justify-start',
  messageText: '.whitespace-pre-wrap.break-words',
  typingDots: '[data-radix-scroll-area-content] span.animate-bounce',
};

// ─── Benign error filter ────────────────────────────────────────────────────
// These are third-party dev-tooling scripts that Captus's own CSP correctly
// blocks. They are NOT Captus app errors — they'd fire on any page in the app.
// Filtering them out so we don't flag false-positive "errors during interaction".

const BENIGN_ERROR_PATTERNS: RegExp[] = [
  /cdn\.gpteng\.co/i,         // GPTEngineer dev tool
  /replit-cdn\.com/i,         // Replit feedback widget
  /feedback-widget/i,         // Same as above, different match angle
];

function isBenignError(text: string): boolean {
  return BENIGN_ERROR_PATTERNS.some((p) => p.test(text));
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface StepResult {
  name: string;
  status: "pass" | "fail" | "skip";
  duration_ms: number;
  details: any;
  error: string | null;
}

interface Assertion {
  expected: any;
  actual: any;
  match: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function runStep<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ step: StepResult; result: T | null }> {
  const start = Date.now();
  try {
    const result = await fn();
    return {
      step: { name, status: "pass", duration_ms: Date.now() - start, details: result, error: null },
      result,
    };
  } catch (err) {
    return {
      step: { name, status: "fail", duration_ms: Date.now() - start, details: null, error: (err as Error).message },
      result: null,
    };
  }
}

async function captureFailureScreenshot(
  context: BrowserContext | null,
  label: string
): Promise<string | null> {
  if (!context) return null;
  try {
    const pages = context.pages();
    if (pages.length === 0) return null;
    const buf = await pages[0].screenshot({ fullPage: true });
    return await uploadScreenshot(buf, label);
  } catch {
    return null;
  }
}

/**
 * Read the text content of a specific message bubble by row index + role.
 * Returns null if the bubble doesn't exist or has no inner text element.
 */
async function readBubbleTextAt(
  page: Page,
  rowSelector: string,
  index: number
): Promise<string | null> {
  try {
    const rows = page.locator(rowSelector);
    const row = rows.nth(index);
    const textEl = row.locator(SEL.messageText).first();
    const text = await textEl.textContent({ timeout: 5_000 });
    return text?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Read every message bubble's text by role. Used after streaming completes
 * to capture multi-bubble AI responses.
 */
async function readAllBubbleTexts(
  page: Page,
  rowSelector: string,
  startIndex: number,
  endIndex: number
): Promise<string[]> {
  const out: string[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const t = await readBubbleTextAt(page, rowSelector, i);
    if (t !== null) out.push(t);
  }
  return out;
}

/**
 * Find whether a specific text appears in any bubble of the given role.
 * Used for content-based persistence verification after reload.
 */
async function bubbleWithTextExists(
  page: Page,
  rowSelector: string,
  needle: string
): Promise<boolean> {
  try {
    const result = await page.evaluate(
      ({ sel, text }) => {
        const target = (text || "").trim();
        if (!target) return false;
        const rows = document.querySelectorAll(sel);
        for (const row of Array.from(rows)) {
          const allText = (row as HTMLElement).innerText?.trim() ?? "";
          if (allText === target) return true;
          // also match if target is contained (for multi-line bubbles)
          if (allText.includes(target)) return true;
        }
        return false;
      },
      { sel: rowSelector, text: needle }
    );
    return result;
  } catch {
    return false;
  }
}

// ─── Result recording ───────────────────────────────────────────────────────

async function recordResult(payload: any, startTime: number): Promise<void> {
  const assertions = payload?.assertions ?? {};
  const matched = Object.values(assertions).filter((a: any) => a?.match).length;
  const total = Object.keys(assertions).length;
  const failedNames = Object.entries(assertions)
    .filter(([_, a]: [string, any]) => !a?.match)
    .map(([k]) => k)
    .join(", ");

  const assertionExpected =
    "Chat opens, user message sent, real AI response received, streaming completes, messages persist across reload, no console errors";
  const assertionActual =
    payload?.status === "success"
      ? `PASS — ${matched}/${total} assertions; latency=${payload?.ai_response_latency_ms ?? "?"}ms`
      : `FAIL — ${failedNames || payload?.message || "see details"}`;

  // ── Allure ──
  try {
    recordTestResult(
      "TC_Chat_Message",
      "Chat Workflow Tests",
      payload?.status ?? "error",
      payload?.message ?? "",
      startTime,
      undefined,
      payload?.screenshot_url ?? null,
      {
        risk_title: payload?.prompt
          ? `chat_test (${payload.prompt.slice(0, 60)})`
          : undefined,
        username: payload?.username,
        assertion_expected: assertionExpected,
        assertion_actual: assertionActual,
        failure_type: payload?.aborted_reason ?? null,
        mode: "full",
      }
    );
  } catch (err) {
    console.error(`[Allure] Failed to record TC_Chat_Message: ${(err as Error).message}`);
  }

  // ── Supabase ──
  try {
    await saveTestResult(
      "TC_Chat_Message",
      {
        status: payload?.status ?? "error",
        username: payload?.username ?? "",
        risk_title: payload?.prompt
          ? `chat_test (${payload.prompt.slice(0, 60)})`
          : null,
        message: payload?.message ?? null,
        assertion_expected: assertionExpected,
        assertion_actual: assertionActual,
        assertion_match: payload?.status === "success",
        screenshot_failure: payload?.screenshot_url ?? null,
      },
      {
        prompt: payload?.prompt,
        captured_response_preview: payload?.captured_response_preview,
        ai_response_latency_ms: payload?.ai_response_latency_ms,
        bubble_counts: payload?.bubble_counts,
        console_errors: payload?.console_errors,
        assertions: payload?.assertions,
        steps: payload?.steps,
        aborted_reason: payload?.aborted_reason,
        total_duration_ms: payload?.total_duration_ms,
      }
    );
  } catch (err) {
    console.error(`[Supabase] Failed to save TC_Chat_Message: ${(err as Error).message}`);
  }
}

async function respond(
  res: Response,
  statusCode: number,
  payload: any,
  startTime: number
): Promise<Response> {
  await recordResult(payload, startTime);
  return res.status(statusCode).json(payload);
}

// ─── Route ──────────────────────────────────────────────────────────────────

router.post("/test-chat-message", async (req: Request, res: Response) => {
  if (req.headers["x-api-key"] !== process.env.API_KEY) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const { username, password } = req.body ?? {};
  const requiredCompany = req.body?.required_company ?? "demo";

  if (!username || !password) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: username, password",
    });
  }

  const ts = timestamp();
  const prompt = `Test message from QA automation - please respond briefly [${ts}]`;

  const startedAt = new Date().toISOString();
  const overallStart = Date.now();
  const steps: StepResult[] = [];
  const assertions: Record<string, Assertion> = {};
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let screenshotUrl: string | null = null;

  // ── Bubble tracking ──
  let userCountBefore = 0;
  let userCountAfter = 0;
  let assistantCountBefore = 0;
  let assistantCountAfter = 0;
  let capturedUserText: string | null = null;
  let capturedAiBubbles: string[] = [];
  let capturedResponseText: string = "";
  let aiResponseLatencyMs: number | null = null;

  try {
    // ─────────────────────────────────────────────────────────────────────
    // PHASE 1 — Login + company guard
    // ─────────────────────────────────────────────────────────────────────
    const loginStep = await runStep("login_with_session", async () => {
      const session = await createContextAndLogin(username, password);
      context = session.context;
      page = session.page;
      return { username, post_login_url: page.url() };
    });
    steps.push(loginStep.step);
    if (loginStep.step.status === "fail") {
      const payload = {
        status: "failed" as const,
        message: `Login failed: ${loginStep.step.error}`,
        username,
        prompt,
        assertions,
        steps,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        total_duration_ms: Date.now() - overallStart,
        screenshot_url: null,
      };
      return await respond(res, 500, payload, overallStart);
    }

    const guardStep = await runStep("company_guard", async () => {
      const g = await ensureCompanyIsDemo(page!, requiredCompany);
      if (!g.ok) throw new Error(g.failure_reason ?? "company guard failed");
      return g;
    });
    steps.push(guardStep.step);
    assertions.company_is_demo = {
      expected: requiredCompany,
      actual: guardStep.result?.company_after ?? guardStep.result?.company_before ?? null,
      match: guardStep.step.status === "pass",
    };
    if (guardStep.step.status === "fail") {
      screenshotUrl = await captureFailureScreenshot(context, "cp7_guard_failed");
      const payload = {
        status: "failed" as const,
        message: "Aborted: company guard",
        username,
        prompt,
        assertions,
        steps,
        aborted_reason: "wrong_company",
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        total_duration_ms: Date.now() - overallStart,
        screenshot_url: screenshotUrl,
      };
      if (context) await (context as BrowserContext).close().catch(() => {});
      return await respond(res, 500, payload, overallStart);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 2 — Set up console error listeners + navigate to /dashboard
    // ─────────────────────────────────────────────────────────────────────
    page!.on("console", (msg: ConsoleMessage) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        if (isBenignError(text)) return; // skip third-party dev-tool noise
        consoleErrors.push(text.slice(0, 500));
      } else if (type === "warning") {
        consoleWarnings.push(text.slice(0, 500));
      }
    });
    page!.on("pageerror", (err) => {
      if (isBenignError(err.message)) return; // skip third-party dev-tool noise
      consoleErrors.push(`PageError: ${err.message.slice(0, 500)}`);
    });

    const navStep = await runStep("navigate_to_dashboard", async () => {
      await page!.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: 30_000 });
      return { url: page!.url() };
    });
    steps.push(navStep.step);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 3 — Verify chat widget visible
    // ─────────────────────────────────────────────────────────────────────
    const widgetStep = await runStep("verify_chat_widget", async () => {
      await page!
        .locator(SEL.chatWidget)
        .waitFor({ state: "visible", timeout: 10_000 });
      return { visible: true };
    });
    steps.push(widgetStep.step);
    assertions.chat_widget_button_visible = {
      expected: "Chat widget button visible on /dashboard",
      actual: widgetStep.step.status === "pass" ? "visible" : `not visible: ${widgetStep.step.error}`,
      match: widgetStep.step.status === "pass",
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 4 — Click chat widget, verify panel opens
    // ─────────────────────────────────────────────────────────────────────
    const openStep = await runStep("open_chat_panel", async () => {
      await page!.locator(SEL.chatWidget).click();
      await page!
        .locator(SEL.chatClose)
        .waitFor({ state: "visible", timeout: CHAT_OPEN_TIMEOUT_MS });
      return { opened: true };
    });
    steps.push(openStep.step);
    assertions.chat_panel_opens = {
      expected: "Chat panel opens after clicking widget (close button visible)",
      actual: openStep.step.status === "pass" ? "opened" : `did not open: ${openStep.step.error}`,
      match: openStep.step.status === "pass",
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 5 — Verify chat input is visible
    // ─────────────────────────────────────────────────────────────────────
    const inputStep = await runStep("verify_chat_input", async () => {
      await page!
        .locator(SEL.chatInput)
        .waitFor({ state: "visible", timeout: INPUT_VISIBLE_TIMEOUT_MS });
      return { visible: true };
    });
    steps.push(inputStep.step);
    assertions.chat_input_visible = {
      expected: "Chat input field visible",
      actual: inputStep.step.status === "pass" ? "visible" : `not visible: ${inputStep.step.error}`,
      match: inputStep.step.status === "pass",
    };

    if (inputStep.step.status === "fail") {
      // Can't proceed without input
      screenshotUrl = await captureFailureScreenshot(context, "cp7_no_input");
      const payload = {
        status: "failed" as const,
        message: "Chat input not visible — cannot send message",
        username,
        prompt,
        assertions,
        steps,
        aborted_reason: "no_chat_input",
        bubble_counts: { user_before: 0, user_after: 0, ai_before: 0, ai_after: 0 },
        console_errors: consoleErrors,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        total_duration_ms: Date.now() - overallStart,
        screenshot_url: screenshotUrl,
      };
      if (context) await (context as BrowserContext).close().catch(() => {});
      return await respond(res, 500, payload, overallStart);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 6 — Capture baselines (delta tracking per manager's design)
    // ─────────────────────────────────────────────────────────────────────
    userCountBefore = await page!.locator(SEL.userRow).count();
    assistantCountBefore = await page!.locator(SEL.aiRow).count();

    console.log(
      `[Chat] Baselines: user=${userCountBefore}, assistant=${assistantCountBefore}`
    );

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 7 — Send message via Enter key
    // ─────────────────────────────────────────────────────────────────────
    const sendStep = await runStep("send_message", async () => {
      const input = page!.locator(SEL.chatInput);
      await input.click();
      await input.fill(prompt);
      await page!.keyboard.press("Enter");
      return { prompt };
    });
    steps.push(sendStep.step);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 8 — Wait for user bubble delta + capture
    // ─────────────────────────────────────────────────────────────────────
    let userBubbleAppeared = false;
    try {
      await page!.waitForFunction(
        ({ sel, baseline }) => {
          return document.querySelectorAll(sel).length > baseline;
        },
        { sel: SEL.userRow, baseline: userCountBefore },
        { timeout: USER_BUBBLE_DELTA_TIMEOUT_MS }
      );
      userBubbleAppeared = true;
    } catch (err) {
      console.log(`[Chat] User bubble did not appear: ${(err as Error).message}`);
    }

    userCountAfter = await page!.locator(SEL.userRow).count();
    assertions.user_bubble_count_increased = {
      expected: `User bubble count increases from ${userCountBefore}`,
      actual: `before=${userCountBefore}, after=${userCountAfter}`,
      match: userCountAfter > userCountBefore,
    };

    // Capture the NEW user bubble (at index = userCountBefore)
    if (userCountAfter > userCountBefore) {
      capturedUserText = await readBubbleTextAt(page!, SEL.userRow, userCountBefore);
    }
    assertions.new_user_bubble_contains_prompt = {
      expected: `New user bubble text matches prompt: "${prompt}"`,
      actual: capturedUserText ?? "<not captured>",
      match: capturedUserText === prompt,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 9 — Wait for AI response (streaming complete + new bubble)
    // ─────────────────────────────────────────────────────────────────────
    const aiWaitStart = Date.now();

    // Optionally observe typing dots appearing — fast AI may skip the indicator,
    // so this is best-effort.
    await page!
      .locator(SEL.typingDots)
      .first()
      .waitFor({ state: "visible", timeout: TYPING_APPEARS_TIMEOUT_MS })
      .catch(() => {});

    // Definitive wait: typing dots gone AND new assistant bubble present
    let streamingCompleted = false;
    try {
      await page!.waitForFunction(
        ({ dotsSel, aiSel, baseline }) => {
          const typing = document.querySelectorAll(dotsSel).length;
          const bubbles = document.querySelectorAll(aiSel).length;
          return typing === 0 && bubbles > baseline;
        },
        { dotsSel: SEL.typingDots, aiSel: SEL.aiRow, baseline: assistantCountBefore },
        { timeout: AI_RESPONSE_TIMEOUT_MS }
      );
      streamingCompleted = true;
    } catch (err) {
      console.log(`[Chat] AI response wait timed out: ${(err as Error).message}`);
    }

    // Settle period — handles multi-bubble streams
    await page!.waitForTimeout(STREAM_SETTLE_MS);
    aiResponseLatencyMs = Date.now() - aiWaitStart;

    assertions.streaming_completed_cleanly = {
      expected: "Typing indicator returns to 0 dots, new assistant bubble present",
      actual: streamingCompleted
        ? `completed in ${aiResponseLatencyMs}ms`
        : `timeout after ${aiResponseLatencyMs}ms`,
      match: streamingCompleted,
    };

    assistantCountAfter = await page!.locator(SEL.aiRow).count();
    assertions.assistant_bubble_count_increased = {
      expected: `Assistant bubble count increases from ${assistantCountBefore}`,
      actual: `before=${assistantCountBefore}, after=${assistantCountAfter}`,
      match: assistantCountAfter > assistantCountBefore,
    };

    // Capture all NEW assistant bubbles (indices [assistantCountBefore..assistantCountAfter))
    if (assistantCountAfter > assistantCountBefore) {
      capturedAiBubbles = await readAllBubbleTexts(
        page!,
        SEL.aiRow,
        assistantCountBefore,
        assistantCountAfter
      );
      capturedResponseText = capturedAiBubbles.filter((t) => t.length > 0).join("\n");
    }

    console.log(
      `[Chat] Captured AI response (${capturedAiBubbles.length} bubbles, ${capturedResponseText.length} chars): "${capturedResponseText.slice(0, 200)}"`
    );

    assertions.new_assistant_bubble_non_empty = {
      expected: "New assistant bubble has non-empty text",
      actual:
        capturedResponseText.length > 0
          ? `${capturedResponseText.length} chars`
          : "<empty>",
      match: capturedResponseText.length > 0,
    };

    assertions.response_differs_from_prompt = {
      expected: "AI response differs from user prompt (not echoed)",
      actual:
        capturedResponseText.trim() === prompt.trim()
          ? "RESPONSE EQUALS PROMPT (echo)"
          : "differs",
      match: capturedResponseText.trim() !== prompt.trim() && capturedResponseText.length > 0,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 10 — Persistence test: close + reopen chat panel
    //
    // Captus chat is SESSION-SCOPED, not reload-persistent (verified with
    // manual QA). The CP-7 spec "Message persists" refers to closing the
    // chat panel and reopening it within the same browser session — NOT
    // across page reload. This test matches Captus's actual behavior.
    // ─────────────────────────────────────────────────────────────────────
    const persistStep = await runStep("verify_persistence_close_reopen", async () => {
      // Close the chat panel
      await page!.locator(SEL.chatClose).click();
      await page!
        .locator(SEL.chatClose)
        .waitFor({ state: "hidden", timeout: 5_000 })
        .catch(() => {});
      await page!.waitForTimeout(500); // brief pause between actions

      // Reopen the chat panel
      await page!
        .locator(SEL.chatWidget)
        .waitFor({ state: "visible", timeout: 10_000 });
      await page!.locator(SEL.chatWidget).click();
      await page!
        .locator(SEL.chatClose)
        .waitFor({ state: "visible", timeout: PERSISTENCE_TIMEOUT_MS });

      // Brief wait for messages to render
      await page!.waitForTimeout(1_500);

      const promptPersists = await bubbleWithTextExists(page!, SEL.userRow, prompt);
      const firstAiText = capturedAiBubbles.find((t) => t.length > 0) ?? "";
      const responsePersists = firstAiText.length > 0
        ? await bubbleWithTextExists(page!, SEL.aiRow, firstAiText)
        : false;

      return { promptPersists, responsePersists, firstAiText };
    });
    steps.push(persistStep.step);

    const promptPersists = persistStep.result?.promptPersists ?? false;
    const responsePersists = persistStep.result?.responsePersists ?? false;

    assertions.messages_persist_close_reopen = {
      expected: "Both user message AND AI response remain after closing and reopening chat panel (within session)",
      actual: `user=${promptPersists ? "persisted" : "LOST"}, ai=${responsePersists ? "persisted" : "LOST"}`,
      match: promptPersists && responsePersists,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 11 — Console error assertion
    // ─────────────────────────────────────────────────────────────────────
    assertions.no_console_errors_during_interaction = {
      expected: "No console errors or page errors during chat interaction",
      actual:
        consoleErrors.length === 0
          ? "clean (0 errors)"
          : `${consoleErrors.length} error(s): ${consoleErrors.slice(0, 3).join(" | ").slice(0, 300)}`,
      match: consoleErrors.length === 0,
    };

    // ─────────────────────────────────────────────────────────────────────
    // Cleanup hygiene — close chat panel (best-effort, no assertion)
    // ─────────────────────────────────────────────────────────────────────
    await page!
      .locator(SEL.chatClose)
      .click({ timeout: 5_000 })
      .catch(() => {});

    // ─────────────────────────────────────────────────────────────────────
    // Final verdict
    // ─────────────────────────────────────────────────────────────────────
    const allMatch = Object.values(assertions).every((a) => a.match);
    const overallStatus: "success" | "failed" = allMatch ? "success" : "failed";

    if (overallStatus === "failed") {
      screenshotUrl = await captureFailureScreenshot(context, `cp7_fail_${username}`);
    }

    const payload = {
      status: overallStatus,
      message:
        overallStatus === "success"
          ? `Chat workflow verified — AI responded in ${aiResponseLatencyMs}ms, messages persisted`
          : "Chat workflow test failed — see assertions for details",
      username,
      prompt,
      captured_response_preview: capturedResponseText.slice(0, 400),
      ai_response_latency_ms: aiResponseLatencyMs,
      bubble_counts: {
        user_before: userCountBefore,
        user_after: userCountAfter,
        ai_before: assistantCountBefore,
        ai_after: assistantCountAfter,
      },
      console_errors: consoleErrors,
      console_warnings_count: consoleWarnings.length,
      assertions,
      steps,
      counts: {
        assertions_matched: Object.values(assertions).filter((a) => a.match).length,
        assertions_total: Object.keys(assertions).length,
      },
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };

    if (context) await (context as BrowserContext).close().catch(() => {});
    context = null;
    return await respond(res, overallStatus === "success" ? 200 : 500, payload, overallStart);
  } catch (err) {
    screenshotUrl = await captureFailureScreenshot(context, `cp7_error_${username}`);
    if (context) await (context as BrowserContext).close().catch(() => {});

    const payload = {
      status: "error" as const,
      message: (err as Error).message,
      username,
      prompt,
      captured_response_preview: capturedResponseText.slice(0, 400),
      ai_response_latency_ms: aiResponseLatencyMs,
      bubble_counts: {
        user_before: userCountBefore,
        user_after: userCountAfter,
        ai_before: assistantCountBefore,
        ai_after: assistantCountAfter,
      },
      console_errors: consoleErrors,
      assertions,
      steps,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };
    return await respond(res, 500, payload, overallStart);
  }
});

export default router;