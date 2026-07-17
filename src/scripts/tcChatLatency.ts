// ─────────────────────────────────────────────────────────────────────────────
// scripts/tcChatLatency.ts
// TC_Chat_Latency — Chatbot Latency Investigation (Phase 1: standalone)
//
// Executes a fixed 14-question conversation against the Captus chat widget
// and collects browser-observable latency metrics per question, per the
// "Chatbot Latency Investigation Test Specification (Playwright)".
//
// SCOPE (phase 1):
//   - Browser-observable metrics ONLY. No OpenAI/RAG/DB/n8n attribution.
//   - Runs locally via ts-node with a locally launched browser. NOT wired
//     into n8n or the daily regression. No Supabase/Allure writes.
//   - Entry point: existing chat widget on /dashboard. The spec's
//     "Agents page" flow is deferred pending selector confirmation
//     (see OPEN_ITEMS at the bottom of this header).
//
// RUN:
//   QA_USERNAME=... QA_PASSWORD=... npx ts-node src/scripts/tcChatLatency.ts
//
// OPTIONAL ENV:
//   CHAT_LATENCY_COMPANY   company to switch to before the run (default: demo)
//                          — set to "University Place Associates" once that
//                          company is confirmed present in the QA account.
//   CHAT_SLA_MS            per-question SLA threshold in ms (default: 10000)
//   CHAT_QUESTION_PAUSE_MS pause between questions in ms (default: 1000)
//
// OUTPUT:
//   reports/chat_latency_<timestamp>.json   full structured report
//   reports/chat_latency_<timestamp>_qNN.png  screenshot on per-question failure
//   console summary table
//
// MEASUREMENT MODEL (per question):
//   t_before_send        Node clock immediately before Enter is pressed
//   t_request_started    page.on('request') for the chat API call
//   t_response_headers   page.on('response') — first byte / headers received
//   t_request_finished   page.on('requestfinished') — network body complete
//                        (for SSE streams this is when the stream closes)
//   t_first_visible      first NEW assistant bubble appears in the DOM
//   t_stream_complete    typing dots == 0 AND assistant bubble delta >= 1
//   t_render_settled     t_stream_complete + settle window (multi-bubble)
//
//   total_user_wait_ms      = t_stream_complete - t_before_send
//   time_to_first_visible   = t_first_visible  - t_before_send
//   network_time_ms         = t_request_finished - t_request_started
//   frontend_render_lag_ms  = t_first_visible - t_response_headers
//     (how long after the browser started receiving data did the user
//      first SEE anything — the browser-side share of the wait)
//
// SELECTOR NOTE: SEL and the benign console-noise filter are imported from
//   routes/testChatMessage.ts (single source of truth — exported there).
//   If chat selectors change, update only testChatMessage.ts.
//
// OPEN_ITEMS:
//   1. "Agents page" entry flow — no selectors exist in this repo for it;
//      confirm with Khanak/Ali whether it is live on app.captus.ai post
//      CB-8 and what its testids are. openChat() is the seam to swap.
//   2. "University Place Associates" — presence in the QA account
//      unconfirmed; default company remains "demo" until verified.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";
import { Page, BrowserContext, ConsoleMessage, Request as PWRequest } from "playwright";
import { createContextAndLogin } from "../services/loginService";
import { ensureCompanyIsDemo } from "../services/companyGuardService";
import { safeClose, closeBrowser } from "../services/browserManager";
// SEL + isBenignError are the single source of truth in testChatMessage.ts
// (exported there for reuse). Importing the route module is side-effect-free:
// server.ts guards app.listen() behind `require.main === module`.
import { SEL, isBenignError } from "../routes/testChatMessage";

// ─── Tunables ───────────────────────────────────────────────────────────────

const SLA_MS = Number(process.env.CHAT_SLA_MS ?? 10_000);
const REQUIRED_COMPANY = process.env.CHAT_LATENCY_COMPANY ?? "demo";
const QUESTION_PAUSE_MS = Number(process.env.CHAT_QUESTION_PAUSE_MS ?? 1_000);

const CHAT_OPEN_TIMEOUT_MS = 10_000;
const INPUT_VISIBLE_TIMEOUT_MS = 5_000;
const USER_BUBBLE_DELTA_TIMEOUT_MS = 5_000;
const AI_RESPONSE_TIMEOUT_MS = 60_000; // hard ceiling per question
const STREAM_SETTLE_MS = 1_500;
const TYPING_APPEARS_TIMEOUT_MS = 5_000;

// Issue-detection thresholds
const SPIKE_FACTOR = 2.5;          // response > 2.5x running median = spike
const RENDER_LAG_ISSUE_MS = 2_000; // first paint lags first byte by > 2s
const GROWTH_SLOPE_PCT = 5;        // slope > 5% of mean per question = increasing

// ─── Fixed conversation script ──────────────────────────────────────────────
// Fixed and ordered so latency trends are comparable run-to-run.

type Category = "basic" | "follow_up" | "memory" | "complex";

const QUESTIONS: { category: Category; text: string }[] = [
  // Category 1 — baseline
  { category: "basic", text: "What is this project?" },
  { category: "basic", text: "Tell me about this property." },
  { category: "basic", text: "What services are available?" },
  { category: "basic", text: "Who manages this property?" },
  // Category 2 — context continuation
  { category: "follow_up", text: "Can you elaborate on that?" },
  { category: "follow_up", text: "Give more details about the services you mentioned." },
  { category: "follow_up", text: "Explain further." },
  { category: "follow_up", text: "What do you mean by that?" },
  // Category 3 — conversation memory
  { category: "memory", text: "What was my first question in this conversation?" },
  { category: "memory", text: "Summarize everything we have discussed so far." },
  { category: "memory", text: "Repeat your previous answer." },
  // Category 4 — complex / long generation
  { category: "complex", text: "Compare the two most important services you mentioned, including advantages and disadvantages of each." },
  { category: "complex", text: "What recommendations would you give a prospective tenant, and why?" },
  { category: "complex", text: "Produce a structured summary of this property: overview, services available, and key takeaways." },
];

// ─── Types ──────────────────────────────────────────────────────────────────

interface NetEvent {
  url: string;
  method: string;
  resourceType: string;
  t_request_started: number;
  t_response_headers: number | null;
  t_request_finished: number | null;
  status: number | null;
  failed: boolean;
  failure_text: string | null;
}

interface QuestionMetrics {
  question_number: number;
  category: Category;
  question_text: string;
  conversation_length_before: number; // total bubbles (user+ai) before send

  t_before_send: number;
  t_request_started: number | null;
  t_response_headers: number | null;
  t_request_finished: number | null;
  t_typing_appeared: number | null;
  t_first_visible: number | null;
  t_stream_complete: number | null;
  t_render_settled: number | null;

  total_user_wait_ms: number | null;
  time_to_first_visible_ms: number | null;
  network_time_ms: number | null;
  frontend_render_lag_ms: number | null;
  typing_indicator_duration_ms: number | null;

  response_length_chars: number;
  ai_bubble_delta: number;
  duplicate_ai_bubbles: boolean;
  chat_request_url: string | null;
  http_status: number | null;
  request_failed: boolean;
  timeout_occurred: boolean;
  exceeded_sla: boolean;
  console_errors: string[];
  failed_requests: { url: string; failure: string | null }[];
  status: "ok" | "timeout" | "error";
  error: string | null;
}

interface Issue {
  severity: "high" | "medium" | "low";
  question_number: number | null;
  observed_behaviour: string;
  evidence: string;
  recommendation: string;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const nowTag = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stddev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
/** Least-squares slope of y over 0..n-1 (ms per question). */
const slope = (ys: number[]) => {
  const n = ys.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = mean(ys);
  let num = 0, den = 0;
  ys.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return den ? num / den : 0;
};

async function countRows(page: Page, sel: string): Promise<number> {
  return page.locator(sel).count();
}

async function readNewAiBubbles(page: Page, from: number, to: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    try {
      const t = await page.locator(SEL.aiRow).nth(i).locator(SEL.messageText).first()
        .textContent({ timeout: 3_000 });
      if (t !== null) out.push(t.trim());
    } catch { /* bubble may lack a text node — skip */ }
  }
  return out;
}

// Chat-API heuristic: POST fetch/xhr whose URL suggests chat traffic.
// First run's report includes the matched URL so the real endpoint gets
// confirmed empirically; tighten the pattern afterwards if needed.
const looksLikeChatRequest = (e: NetEvent) =>
  e.method === "POST" &&
  (e.resourceType === "fetch" || e.resourceType === "xhr") &&
  /chat|message|conversation|agent|assistant|ai/i.test(e.url);

// ─── Chat entry (the seam to swap for the Agents-page flow later) ───────────

async function openChat(page: Page): Promise<void> {
  await page.locator(SEL.chatWidget).waitFor({ state: "visible", timeout: CHAT_OPEN_TIMEOUT_MS });
  await page.locator(SEL.chatWidget).click();
  await page.locator(SEL.chatClose).waitFor({ state: "visible", timeout: CHAT_OPEN_TIMEOUT_MS });
  await page.locator(SEL.chatInput).waitFor({ state: "visible", timeout: INPUT_VISIBLE_TIMEOUT_MS });
}

// ─── Per-question execution ─────────────────────────────────────────────────

async function askQuestion(
  page: Page,
  qNum: number,
  category: Category,
  text: string,
  netEvents: NetEvent[],
  consoleErrors: { t: number; text: string }[],
  reportsDir: string,
  runTag: string
): Promise<QuestionMetrics> {
  const userBefore = await countRows(page, SEL.userRow);
  const aiBefore = await countRows(page, SEL.aiRow);
  const netIdxBefore = netEvents.length;
  const errIdxBefore = consoleErrors.length;

  const m: QuestionMetrics = {
    question_number: qNum,
    category,
    question_text: text,
    conversation_length_before: userBefore + aiBefore,
    t_before_send: 0,
    t_request_started: null,
    t_response_headers: null,
    t_request_finished: null,
    t_typing_appeared: null,
    t_first_visible: null,
    t_stream_complete: null,
    t_render_settled: null,
    total_user_wait_ms: null,
    time_to_first_visible_ms: null,
    network_time_ms: null,
    frontend_render_lag_ms: null,
    typing_indicator_duration_ms: null,
    response_length_chars: 0,
    ai_bubble_delta: 0,
    duplicate_ai_bubbles: false,
    chat_request_url: null,
    http_status: null,
    request_failed: false,
    timeout_occurred: false,
    exceeded_sla: false,
    console_errors: [],
    failed_requests: [],
    status: "ok",
    error: null,
  };

  try {
    // Send
    const input = page.locator(SEL.chatInput);
    await input.click();
    await input.fill(text);
    m.t_before_send = Date.now();
    await page.keyboard.press("Enter");

    const deadline = m.t_before_send + AI_RESPONSE_TIMEOUT_MS;
    const remaining = () => Math.max(500, deadline - Date.now());

    // User bubble echo (best-effort; a miss is reported, not fatal)
    await page.waitForFunction(
      ({ sel, baseline }) => document.querySelectorAll(sel).length > baseline,
      { sel: SEL.userRow, baseline: userBefore },
      { timeout: USER_BUBBLE_DELTA_TIMEOUT_MS }
    ).catch(() => {});

    // Typing indicator appearance (best-effort — fast responses may skip it)
    await page.locator(SEL.typingDots).first()
      .waitFor({ state: "visible", timeout: TYPING_APPEARS_TIMEOUT_MS })
      .then(() => { m.t_typing_appeared = Date.now(); })
      .catch(() => {});

    // First visible NEW assistant bubble — requires non-empty rendered text.
    // A bare count-delta could fire on the typing-indicator row (which may
    // itself render as an assistant-style row), which would make
    // time_to_first_visible ≈ indicator appearance instead of first token.
    let firstVisibleOk = true;
    await page.waitForFunction(
      ({ sel, textSel, baseline }) => {
        const rows = document.querySelectorAll(sel);
        for (let i = baseline; i < rows.length; i++) {
          const el = rows[i].querySelector(textSel) as HTMLElement | null;
          if (el && (el.innerText ?? "").trim().length > 0) return true;
        }
        return false;
      },
      { sel: SEL.aiRow, textSel: SEL.messageText, baseline: aiBefore },
      { timeout: remaining() }
    ).then(() => { m.t_first_visible = Date.now(); })
     .catch(() => { firstVisibleOk = false; });

    // Streaming complete: dots gone AND bubble delta holds
    let streamOk = false;
    if (firstVisibleOk) {
      await page.waitForFunction(
        ({ dotsSel, aiSel, baseline }) => {
          const typing = document.querySelectorAll(dotsSel).length;
          const bubbles = document.querySelectorAll(aiSel).length;
          return typing === 0 && bubbles > baseline;
        },
        { dotsSel: SEL.typingDots, aiSel: SEL.aiRow, baseline: aiBefore },
        { timeout: remaining() }
      ).then(() => { streamOk = true; m.t_stream_complete = Date.now(); })
       .catch(() => {});
    }

    if (!streamOk) {
      m.timeout_occurred = true;
      m.status = "timeout";
      await page.screenshot({
        path: path.join(reportsDir, `chat_latency_${runTag}_q${String(qNum).padStart(2, "0")}.png`),
        fullPage: false,
      }).catch(() => {});
    }

    // Settle (multi-bubble streams) + capture
    await page.waitForTimeout(STREAM_SETTLE_MS);
    m.t_render_settled = Date.now();

    const aiAfter = await countRows(page, SEL.aiRow);
    m.ai_bubble_delta = aiAfter - aiBefore;
    if (m.ai_bubble_delta > 0) {
      const bubbles = await readNewAiBubbles(page, aiBefore, aiAfter);
      m.response_length_chars = bubbles.join("\n").length;
      const nonEmpty = bubbles.filter((b) => b.length > 0);
      m.duplicate_ai_bubbles = new Set(nonEmpty).size < nonEmpty.length;
    }

    // Derived timings
    if (m.t_stream_complete) m.total_user_wait_ms = m.t_stream_complete - m.t_before_send;
    if (m.t_first_visible) m.time_to_first_visible_ms = m.t_first_visible - m.t_before_send;
    if (m.t_typing_appeared && m.t_stream_complete)
      m.typing_indicator_duration_ms = m.t_stream_complete - m.t_typing_appeared;
    m.exceeded_sla = (m.total_user_wait_ms ?? Infinity) > SLA_MS;
  } catch (err) {
    m.status = "error";
    m.error = (err as Error).message.slice(0, 500);
    await page.screenshot({
      path: path.join(reportsDir, `chat_latency_${runTag}_q${String(qNum).padStart(2, "0")}.png`),
      fullPage: false,
    }).catch(() => {});
  }

  // Attribute network events + console errors captured during this question
  const windowEnd = Date.now();
  const windowEvents = netEvents.slice(netIdxBefore)
    .filter((e) => e.t_request_started >= m.t_before_send && e.t_request_started <= windowEnd);

  const chatCandidates = windowEvents.filter(looksLikeChatRequest);
  const chatReq =
    chatCandidates[0] ??
    // fallback: longest-running POST fetch/xhr in the window
    windowEvents
      .filter((e) => e.method === "POST" && (e.resourceType === "fetch" || e.resourceType === "xhr"))
      .sort((a, b) =>
        ((b.t_request_finished ?? windowEnd) - b.t_request_started) -
        ((a.t_request_finished ?? windowEnd) - a.t_request_started)
      )[0] ?? null;

  if (chatReq) {
    m.chat_request_url = chatReq.url;
    m.t_request_started = chatReq.t_request_started;
    m.t_response_headers = chatReq.t_response_headers;
    m.t_request_finished = chatReq.t_request_finished;
    m.http_status = chatReq.status;
    m.request_failed = chatReq.failed;
    if (chatReq.t_request_finished)
      m.network_time_ms = chatReq.t_request_finished - chatReq.t_request_started;
    if (chatReq.t_response_headers && m.t_first_visible)
      m.frontend_render_lag_ms = m.t_first_visible - chatReq.t_response_headers;
  }

  m.failed_requests = windowEvents
    .filter((e) => e.failed)
    .map((e) => ({ url: e.url.slice(0, 200), failure: e.failure_text }));
  m.console_errors = consoleErrors.slice(errIdxBefore).map((e) => e.text);

  return m;
}

// ─── Analysis / report assembly ─────────────────────────────────────────────

function buildIssues(questions: QuestionMetrics[]): Issue[] {
  const issues: Issue[] = [];
  const waits = questions.map((q) => q.total_user_wait_ms).filter((x): x is number => x !== null);
  const med = median(waits);

  for (const q of questions) {
    if (q.status === "timeout") {
      issues.push({
        severity: "high",
        question_number: q.question_number,
        observed_behaviour: "AI response did not complete within the 60s ceiling",
        evidence: `Q${q.question_number} ("${q.question_text.slice(0, 60)}") — no stream completion after ${AI_RESPONSE_TIMEOUT_MS}ms; first_visible=${q.time_to_first_visible_ms ?? "never"}ms`,
        recommendation: "Backend investigation recommended — browser sent the request and did not receive a complete response.",
      });
    }
    if (q.status === "error") {
      issues.push({
        severity: "high",
        question_number: q.question_number,
        observed_behaviour: "Script-level error during question execution",
        evidence: `Q${q.question_number}: ${q.error}`,
        recommendation: "Review screenshot and selectors; may indicate UI change or freeze.",
      });
    }
    if (q.exceeded_sla && q.status === "ok") {
      issues.push({
        severity: "medium",
        question_number: q.question_number,
        observed_behaviour: `Response exceeded SLA (${SLA_MS}ms)`,
        evidence: `Q${q.question_number}: total_user_wait=${q.total_user_wait_ms}ms, network_time=${q.network_time_ms ?? "n/a"}ms, render_lag=${q.frontend_render_lag_ms ?? "n/a"}ms`,
        recommendation:
          (q.frontend_render_lag_ms ?? 0) < RENDER_LAG_ISSUE_MS
            ? "Delay occurred before browser rendering. Backend investigation recommended."
            : "Rendering consumed a significant share of the wait. Frontend investigation recommended.",
      });
    }
    if (q.total_user_wait_ms !== null && med > 0 && q.total_user_wait_ms > SPIKE_FACTOR * med) {
      issues.push({
        severity: "medium",
        question_number: q.question_number,
        observed_behaviour: "Latency spike relative to session median",
        evidence: `Q${q.question_number}: ${q.total_user_wait_ms}ms vs session median ${Math.round(med)}ms (>${SPIKE_FACTOR}x)`,
        recommendation: "Correlate with backend logs for this timestamp window.",
      });
    }
    if (q.frontend_render_lag_ms !== null && q.frontend_render_lag_ms > RENDER_LAG_ISSUE_MS) {
      issues.push({
        severity: "medium",
        question_number: q.question_number,
        observed_behaviour: "First visible response lagged network first-byte",
        evidence: `Q${q.question_number}: render_lag=${q.frontend_render_lag_ms}ms after response headers received`,
        recommendation: "Frontend rendering path investigation recommended (markdown rendering / re-render cost).",
      });
    }
    if (q.duplicate_ai_bubbles) {
      issues.push({
        severity: "medium",
        question_number: q.question_number,
        observed_behaviour: "Duplicate assistant message content within one response",
        evidence: `Q${q.question_number}: ${q.ai_bubble_delta} new assistant bubbles with identical text detected`,
        recommendation: "Check for duplicate workflow executions or double-render.",
      });
    }
    if (q.console_errors.length > 0) {
      issues.push({
        severity: "low",
        question_number: q.question_number,
        observed_behaviour: "Console errors during question",
        evidence: `Q${q.question_number}: ${q.console_errors.slice(0, 3).join(" | ").slice(0, 300)}`,
        recommendation: "Review console errors; may correlate with rendering issues.",
      });
    }
    if (q.failed_requests.length > 0) {
      issues.push({
        severity: "medium",
        question_number: q.question_number,
        observed_behaviour: "Failed network request(s) during question",
        evidence: `Q${q.question_number}: ${q.failed_requests.map((f) => `${f.url} (${f.failure})`).join("; ").slice(0, 300)}`,
        recommendation: "Inspect network layer / retry behaviour.",
      });
    }
  }

  const growth = slope(waits);
  if (waits.length >= 6 && growth > (GROWTH_SLOPE_PCT / 100) * mean(waits)) {
    issues.push({
      severity: "medium",
      question_number: null,
      observed_behaviour: "Latency grew continuously across the conversation",
      evidence: `Slope=${Math.round(growth)}ms per question over ${waits.length} questions (mean ${Math.round(mean(waits))}ms)`,
      recommendation: "Consistent with prompt/context growth cost. Consider limiting conversation history sent per request.",
    });
  }
  return issues;
}

function classifyTrend(waits: number[]): "stable" | "increasing" | "random_spikes" {
  if (waits.length < 4) return "stable";
  const g = slope(waits);
  if (g > (GROWTH_SLOPE_PCT / 100) * mean(waits)) return "increasing";
  const med = median(waits);
  if (med > 0 && waits.some((w) => w > SPIKE_FACTOR * med)) return "random_spikes";
  return "stable";
}

function overallAssessment(questions: QuestionMetrics[]): string {
  const withNet = questions.filter(
    (q) => q.network_time_ms !== null && q.total_user_wait_ms !== null
  );
  if (!withNet.length) {
    return "Insufficient network correlation data — chat request could not be matched to a network event. No attribution made.";
  }
  const netShare = mean(withNet.map((q) => q.network_time_ms! / q.total_user_wait_ms!));
  const renderLags = questions
    .map((q) => q.frontend_render_lag_ms)
    .filter((x): x is number => x !== null);
  const avgLag = mean(renderLags);
  if (netShare > 0.8 && avgLag < RENDER_LAG_ISSUE_MS) {
    return `Observed latency appears server-side (based on browser evidence only): network time accounted for ~${Math.round(netShare * 100)}% of user wait on average, and frontend rendering lag averaged ${Math.round(avgLag)}ms.`;
  }
  if (avgLag >= RENDER_LAG_ISSUE_MS) {
    return `Frontend rendering contributed materially: average render lag ${Math.round(avgLag)}ms after network first-byte. Mixed browser-side/server-side attribution.`;
  }
  return `Mixed profile: network time ~${Math.round(netShare * 100)}% of user wait, average render lag ${Math.round(avgLag)}ms. No single dominant contributor identified from browser evidence.`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const username = process.env.QA_USERNAME;
  const password = process.env.QA_PASSWORD;
  if (!username || !password) {
    console.error("Missing QA_USERNAME / QA_PASSWORD environment variables.");
    process.exit(1);
  }

  const runTag = nowTag();
  const reportsDir = path.resolve(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const netEvents: NetEvent[] = [];
  const consoleErrors: { t: number; text: string }[] = [];
  const requestIndex = new Map<PWRequest, NetEvent>();

  let context: BrowserContext | null = null;

  try {
    console.log(`[TC_Chat_Latency] Logging in as ${username}...`);
    const session = await createContextAndLogin(username, password);
    context = session.context;
    const page = session.page;

    // Listeners BEFORE any chat interaction
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error" && !isBenignError(msg.text()))
        consoleErrors.push({ t: Date.now(), text: msg.text().slice(0, 500) });
    });
    page.on("pageerror", (err) => {
      if (!isBenignError(err.message))
        consoleErrors.push({ t: Date.now(), text: `PageError: ${err.message.slice(0, 500)}` });
    });
    page.on("request", (req) => {
      const e: NetEvent = {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        t_request_started: Date.now(),
        t_response_headers: null,
        t_request_finished: null,
        status: null,
        failed: false,
        failure_text: null,
      };
      requestIndex.set(req, e);
      netEvents.push(e);
    });
    page.on("response", (res) => {
      const e = requestIndex.get(res.request());
      if (e) { e.t_response_headers = Date.now(); e.status = res.status(); }
    });
    page.on("requestfinished", (req) => {
      const e = requestIndex.get(req);
      if (e) e.t_request_finished = Date.now();
    });
    page.on("requestfailed", (req) => {
      const e = requestIndex.get(req);
      if (e) { e.failed = true; e.failure_text = req.failure()?.errorText ?? null; }
    });

    console.log(`[TC_Chat_Latency] Ensuring company = "${REQUIRED_COMPANY}"...`);
    const guard = await ensureCompanyIsDemo(page, REQUIRED_COMPANY);
    if (!guard.ok) throw new Error(`Company guard failed: ${guard.failure_reason}`);

    console.log("[TC_Chat_Latency] Opening chat...");
    await openChat(page);

    const results: QuestionMetrics[] = [];
    for (let i = 0; i < QUESTIONS.length; i++) {
      const q = QUESTIONS[i];
      console.log(`[TC_Chat_Latency] Q${i + 1}/${QUESTIONS.length} [${q.category}] ${q.text}`);
      const r = await askQuestion(page, i + 1, q.category, q.text, netEvents, consoleErrors, reportsDir, runTag);
      results.push(r);
      console.log(
        `    wait=${r.total_user_wait_ms ?? "TIMEOUT"}ms  first_visible=${r.time_to_first_visible_ms ?? "-"}ms  ` +
        `net=${r.network_time_ms ?? "-"}ms  chars=${r.response_length_chars}  status=${r.status}`
      );
      if (i < QUESTIONS.length - 1) await page.waitForTimeout(QUESTION_PAUSE_MS);
    }

    // ── Session analysis ──
    const waits = results.map((r) => r.total_user_wait_ms).filter((x): x is number => x !== null);
    const firstVisibles = results.map((r) => r.time_to_first_visible_ms).filter((x): x is number => x !== null);
    const renderLags = results.map((r) => r.frontend_render_lag_ms).filter((x): x is number => x !== null);
    const avg = mean(waits);
    const issues = buildIssues(results);

    const report = {
      summary: {
        test: "TC_Chat_Latency",
        phase: "1 — standalone, browser-observable metrics only",
        run_tag: runTag,
        started_at: new Date(results[0]?.t_before_send ?? Date.now()).toISOString(),
        company: REQUIRED_COMPANY,
        entry_point: "dashboard chat widget (Agents-page flow deferred — see script header)",
        sla_ms: SLA_MS,
        questions_executed: results.length,
        successful_responses: results.filter((r) => r.status === "ok").length,
        timeouts: results.filter((r) => r.status === "timeout").length,
        errors: results.filter((r) => r.status === "error").length,
        detected_chat_endpoints: [...new Set(results.map((r) => r.chat_request_url).filter(Boolean))],
      },
      conversation: { questions: results },
      performance: {
        average_response_time_ms: Math.round(avg),
        median_response_time_ms: Math.round(median(waits)),
        min_response_time_ms: waits.length ? Math.min(...waits) : null,
        max_response_time_ms: waits.length ? Math.max(...waits) : null,
        stddev_ms: Math.round(stddev(waits)),
        average_time_to_first_visible_ms: Math.round(mean(firstVisibles)),
        average_frontend_render_lag_ms: renderLags.length ? Math.round(mean(renderLags)) : null,
        questions_exceeding_sla: results.filter((r) => r.exceeded_sla).map((r) => r.question_number),
        questions_above_session_average: results
          .filter((r) => (r.total_user_wait_ms ?? 0) > avg)
          .map((r) => r.question_number),
        latency_growth_ms_per_question: Math.round(slope(waits)),
      },
      latency_trend: classifyTrend(waits),
      browser_findings: {
        total_console_errors: consoleErrors.length,
        questions_with_console_errors: results.filter((r) => r.console_errors.length > 0).map((r) => r.question_number),
        questions_with_failed_requests: results.filter((r) => r.failed_requests.length > 0).map((r) => r.question_number),
        duplicate_response_questions: results.filter((r) => r.duplicate_ai_bubbles).map((r) => r.question_number),
      },
      issues,
      overall_assessment: overallAssessment(results),
    };

    const reportPath = path.join(reportsDir, `chat_latency_${runTag}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // ── Console summary ──
    console.log("\n=== TC_Chat_Latency — Session Summary ===");
    console.table(
      results.map((r) => ({
        q: r.question_number,
        cat: r.category,
        wait_ms: r.total_user_wait_ms ?? "TIMEOUT",
        first_visible_ms: r.time_to_first_visible_ms ?? "-",
        net_ms: r.network_time_ms ?? "-",
        render_lag_ms: r.frontend_render_lag_ms ?? "-",
        chars: r.response_length_chars,
        sla: r.exceeded_sla ? "MISS" : "ok",
        errs: r.console_errors.length,
      }))
    );
    console.log(`Trend: ${report.latency_trend} | avg=${report.performance.average_response_time_ms}ms | ` +
      `median=${report.performance.median_response_time_ms}ms | slope=${report.performance.latency_growth_ms_per_question}ms/q`);
    console.log(`Issues found: ${issues.length}`);
    issues.forEach((i) =>
      console.log(`  [${i.severity}] ${i.question_number ? `Q${i.question_number} — ` : ""}${i.observed_behaviour}`)
    );
    console.log(`\nAssessment: ${report.overall_assessment}`);
    console.log(`\nFull report: ${reportPath}`);
  } finally {
    await safeClose(context);
    await closeBrowser().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[TC_Chat_Latency] Fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});