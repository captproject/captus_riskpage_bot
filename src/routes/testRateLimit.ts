// ─────────────────────────────────────────────────────────────────────────────
// routes/testRateLimit.ts
// SEC-1 — Login Rate Limiting
//
// Endpoint: POST /test-rate-limit
//
// Validates that Captus enforces login rate limiting AND surfaces the EXACT
// expected 429 modal message:
//   "Too many authentication attempts. Please try again in a minute."
//
// Why only the 429 modal:
//   The 401 (wrong password) modal is validated by other login TCs. SEC-1
//   focuses exclusively on the rate-limit behavior — we don't read or assert
//   on the 401 modal text here, just track the HTTP status to know when
//   bad-credential attempts give way to rate limiting.
//
// Test design — STRICT, exact-text match:
//   - rate_limit_triggered:    EITHER 429 captured OR exact modal text seen
//                              within MAX_ATTEMPTS attempts.
//   - exact_modal_text_seen:   The literal string EXPECTED_429_MESSAGE appears
//                              on the page at the moment 429 fires.
//   - rate_limit_recovered:    Valid login succeeds after 65s wait.
//
// Why fake email for the burst:
//   Using a non-existent email triggers Captus's rate limiter (typically per-IP
//   or per-session) without locking the QA account under per-username throttling.
//   Recovery uses the REAL QA user with correct password.
//
// No data created — no cleanup needed.
// Runtime: ~90-100s total (≤30 attempts × ~2s + 65s wait + ~5s recovery).
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, Router } from "express";
import { Page, BrowserContext } from "playwright";
import { getBrowser } from "../services/browserManager";
import { uploadScreenshot } from "../utils/screenshot";
import { recordTestResult } from "../services/allureReporter";
import { saveTestResult } from "../services/supabaseLogger";
import { config } from "../server";

const router = Router();

// ─── Tunables ───────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 30;          // Spec range observed: 18-30 attempts to 429
const ATTEMPT_WAIT_MS = 1500;     // Pause after click for response + UI render
const RECOVERY_WAIT_MS = 65_000;  // TC says 60s; +5s buffer

/**
 * The EXACT text expected in the 429 modal/error.
 * STRICT match — if Captus changes wording or punctuation, this test fails
 * (intentional: catches regressions in user-facing security messaging).
 */
const EXPECTED_429_MESSAGE =
  "Too many authentication attempts. Please try again in a minute.";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AttemptResult {
  attempt: number;
  http_status: number | null;   // 401 = bad creds, 429 = rate limit, null = no API call captured
  rate_limited: boolean;        // 429 status observed OR exact modal text seen
  modal_text_at_429: string | null; // only populated when rate_limited=true
  exact_text_match: boolean;    // true if modal_text contains EXPECTED_429_MESSAGE
  duration_ms: number;
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

/**
 * Scrape all visible text from common error/alert containers on the page.
 * Used ONLY when we suspect rate limiting (after seeing a 429) — we do NOT
 * read the page on 401 attempts.
 */
async function readPageErrorText(page: Page): Promise<string | null> {
  try {
    const text = await page.evaluate(() => {
      const selectors = [
        '[role="alert"]',
        '[role="status"]',
        '[data-testid*="error" i]',
        '[data-testid*="toast" i]',
        '[class*="toast" i]',
        '[class*="error" i]',
        '[class*="alert" i]',
      ];
      const seen = new Set<string>();
      const found: string[] = [];

      for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          const t = (el as HTMLElement).innerText?.trim() ?? "";
          if (t && t.length > 0 && t.length < 500 && !seen.has(t)) {
            seen.add(t);
            found.push(t);
          }
        }
      }
      // Also check the entire body text as fallback — captures cases where the
      // message renders directly into form area without a recognized container
      if (found.length === 0) {
        const bodyText = (document.body.innerText || "").trim();
        if (bodyText.includes("Too many") || bodyText.includes("429")) {
          // Return just the relevant region — extract up to 500 chars around the keyword
          const idx = bodyText.toLowerCase().indexOf("too many");
          if (idx >= 0) {
            const start = Math.max(0, idx - 50);
            const end = Math.min(bodyText.length, idx + 300);
            found.push(bodyText.slice(start, end));
          }
        }
      }
      return found.join(" | ");
    });
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function isExactMatch(text: string | null): boolean {
  if (!text) return false;
  return text.includes(EXPECTED_429_MESSAGE);
}

// ─── Result recording (matches CP-6 / SEC-11 pattern) ───────────────────────

async function recordResult(payload: any, startTime: number): Promise<void> {
  const assertions = payload?.assertions ?? {};
  const strictKeys = [
    "rate_limit_triggered",
    "exact_modal_text_seen",
    "rate_limit_recovered",
  ];
  const matchedStrict = strictKeys.filter(
    (k) => assertions[k]?.match === true
  ).length;
  const failedStrict = strictKeys
    .filter((k) => assertions[k]?.match === false)
    .join(", ");

  const assertionExpected = `Rate limit triggers within ${MAX_ATTEMPTS} attempts AND modal text equals "${EXPECTED_429_MESSAGE}", AND valid login recovers after 65s`;
  const assertionActual =
    payload?.status === "success"
      ? `PASS — ${matchedStrict}/${strictKeys.length} strict assertions matched (triggered at attempt ${payload?.first_rate_limited_at ?? "?"})`
      : `FAIL — ${failedStrict || payload?.message || "see details"}`;

  // ── Allure ──
  try {
    recordTestResult(
      "SEC-1_Rate_Limiting",
      "Security Tests",
      payload?.status ?? "error",
      payload?.message ?? "",
      startTime,
      undefined,
      payload?.screenshot_url ?? null,
      {
        username: payload?.username,
        assertion_expected: assertionExpected,
        assertion_actual: assertionActual,
        failure_type: payload?.aborted_reason ?? null,
        mode: "full",
      }
    );
  } catch (err) {
    console.error(`[Allure] Failed to record SEC-1: ${(err as Error).message}`);
  }

  // ── Supabase ──
  try {
    await saveTestResult(
      "SEC-1_Rate_Limiting",
      {
        status: payload?.status ?? "error",
        username: payload?.username ?? "",
        risk_title: `rate_limit_test (${payload?.attempts?.length ?? 0} attempts)`,
        message: payload?.message ?? null,
        assertion_expected: assertionExpected,
        assertion_actual: assertionActual,
        assertion_match: payload?.status === "success",
        screenshot_failure: payload?.screenshot_url ?? null,
      },
      {
        assertions: payload?.assertions,
        attempts: payload?.attempts,
        first_rate_limited_at: payload?.first_rate_limited_at,
        modal_text_captured: payload?.modal_text_captured,
        recovery_url: payload?.recovery_url,
        counts: payload?.counts,
        aborted_reason: payload?.aborted_reason,
        total_duration_ms: payload?.total_duration_ms,
      }
    );
  } catch (err) {
    console.error(`[Supabase] Failed to save SEC-1: ${(err as Error).message}`);
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

async function captureShot(
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

// ─── Route ──────────────────────────────────────────────────────────────────

router.post("/test-rate-limit", async (req: Request, res: Response) => {
  if (req.headers["x-api-key"] !== process.env.API_KEY) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: username, password (used for recovery test)",
    });
  }

  const ts = timestamp();
  const fakeEmail = `ratetest+${Date.now()}@captus.ai`;
  const fakePassword = "WRONG_PASSWORD_FOR_RATE_TEST";

  const startedAt = new Date().toISOString();
  const overallStart = Date.now();
  const attempts: AttemptResult[] = [];
  const networkLog: { url: string; status: number; ts: number }[] = [];
  const assertions: Record<string, Assertion> = {};
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let screenshotUrl: string | null = null;
  let firstRateLimitedAt: number | null = null;
  let modalTextCaptured: string | null = null;

  console.log(`[RateLimit] Starting SEC-1 test — fake email: ${fakeEmail}`);
  console.log(`[RateLimit] Expected 429 message: "${EXPECTED_429_MESSAGE}"`);

  try {
    // ── Step 1: Fresh browser context, no session ──
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    context.setDefaultTimeout(config.navigationTimeout);
    page = await context.newPage();

    // Capture every response from the login flow.
    page.on("response", (response) => {
      const url = response.url();
      const status = response.status();
      if (/login|auth|session/i.test(url) && url !== page!.url()) {
        networkLog.push({ url, status, ts: Date.now() });
      }
    });

    // ── Step 2: Navigate to login page ──
    await page.goto(config.loginUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout,
    });

    const emailLocator = page.locator('input[name="email"]');
    const passwordLocator = page.locator('input[name="password"]');
    const loginButton = page.getByTestId("button-login");

    await emailLocator.waitFor({ state: "visible", timeout: 15_000 });

    // ── Step 3: Burst loop — up to MAX_ATTEMPTS failed logins ──
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const attemptStart = Date.now();
      const networkPos = networkLog.length;

      // Clear + refill (some apps don't auto-clear inputs after a failed submit)
      try {
        await emailLocator.fill("");
        await passwordLocator.fill("");
        await emailLocator.fill(fakeEmail);
        await passwordLocator.fill(fakePassword);
      } catch (err) {
        console.log(`[RateLimit] Attempt ${i} — fill failed: ${(err as Error).message}`);
        // Try reloading the page if inputs broke
        await page.goto(config.loginUrl, { waitUntil: "networkidle" }).catch(() => {});
        await emailLocator.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
        await emailLocator.fill(fakeEmail).catch(() => {});
        await passwordLocator.fill(fakePassword).catch(() => {});
      }

      // Click Login (don't wait for navigation — we don't expect success on bad creds)
      await loginButton.click().catch(() => {});

      // Pause for response + UI render
      await page.waitForTimeout(ATTEMPT_WAIT_MS);

      // Capture HTTP status from network log
      const newResponses = networkLog.slice(networkPos);
      const loginResponse =
        newResponses.find((r) => /login|auth|session/i.test(r.url)) ?? null;
      const httpStatus = loginResponse?.status ?? null;

      // ── Only read the page when we suspect rate limiting (HTTP 429) ──
      // For 401 attempts we don't validate modal text (covered by other TCs).
      let modalText: string | null = null;
      let exactMatch = false;
      let rateLimited = httpStatus === 429;

      if (rateLimited) {
        modalText = await readPageErrorText(page);
        exactMatch = isExactMatch(modalText);
        if (exactMatch) {
          modalTextCaptured = modalText;
        }
      }

      const attemptResult: AttemptResult = {
        attempt: i,
        http_status: httpStatus,
        rate_limited: rateLimited,
        modal_text_at_429: modalText,
        exact_text_match: exactMatch,
        duration_ms: Date.now() - attemptStart,
      };
      attempts.push(attemptResult);

      console.log(
        `[RateLimit] Attempt ${i}/${MAX_ATTEMPTS}: HTTP=${httpStatus}` +
          (rateLimited
            ? ` | modal_exact_match=${exactMatch} | text="${modalText?.slice(0, 120) ?? ""}"`
            : "")
      );

      // First time we see rate limiting — screenshot & break
      if (rateLimited && firstRateLimitedAt === null) {
        firstRateLimitedAt = i;
        try {
          const buf = await page.screenshot({ fullPage: false });
          screenshotUrl = await uploadScreenshot(
            buf,
            `sec1_rate_limit_modal_attempt_${i}`
          );
          console.log(`[RateLimit] Modal captured at attempt ${i}`);
        } catch (err) {
          console.log(`[RateLimit] Screenshot failed: ${(err as Error).message}`);
        }
        // Break the loop — we have what we need
        break;
      }
    }

    // ── Step 4: Aggregate burst-phase findings ──
    const triggered = firstRateLimitedAt !== null;
    const firstAttemptResult = triggered ? attempts[firstRateLimitedAt! - 1] : null;
    const exactTextSeen = attempts.some((a) => a.exact_text_match === true);

    assertions.rate_limit_triggered = {
      expected: `HTTP 429 captured within ${MAX_ATTEMPTS} attempts`,
      actual: triggered
        ? `Triggered at attempt ${firstRateLimitedAt}`
        : `NOT triggered in ${attempts.length} attempts`,
      match: triggered,
    };

    assertions.exact_modal_text_seen = {
      expected: `Modal text contains EXACT string: "${EXPECTED_429_MESSAGE}"`,
      actual: exactTextSeen
        ? `MATCH — captured: "${modalTextCaptured?.slice(0, 200) ?? ""}"`
        : firstAttemptResult?.modal_text_at_429
          ? `MISMATCH — got: "${firstAttemptResult.modal_text_at_429.slice(0, 200)}"`
          : "No modal text captured",
      match: exactTextSeen,
    };

    if (!triggered) {
      // Burst didn't trigger rate limit — skip recovery and report failure
      assertions.rate_limit_recovered = {
        expected: "Valid login succeeds after 65s wait",
        actual: "skipped — burst never triggered rate limit",
        match: false,
      };
      const payload = {
        status: "failed" as const,
        message: `Rate limiting NOT triggered after ${attempts.length} attempts — either Captus has no rate limit on /login or our detection missed it`,
        username,
        assertions,
        attempts,
        first_rate_limited_at: null,
        modal_text_captured: null,
        counts: {
          total_attempts: attempts.length,
          http_429_count: attempts.filter((a) => a.http_status === 429).length,
          http_401_count: attempts.filter((a) => a.http_status === 401).length,
          exact_match_count: attempts.filter((a) => a.exact_text_match).length,
        },
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        total_duration_ms: Date.now() - overallStart,
        screenshot_url: screenshotUrl,
      };
      if (context) await context.close().catch(() => {});
      return await respond(res, 500, payload, overallStart);
    }

    // ── Step 5: Wait 65 seconds for rate limit to reset ──
    console.log(`[RateLimit] Waiting ${RECOVERY_WAIT_MS / 1000}s for rate limit to reset...`);
    await page.waitForTimeout(RECOVERY_WAIT_MS);

    // ── Step 6: Recovery — valid login with REAL QA credentials ──
    console.log(`[RateLimit] Recovery: attempting valid login as ${username}`);
    try {
      await page.goto(config.loginUrl, {
        waitUntil: "networkidle",
        timeout: config.navigationTimeout,
      });

      await emailLocator.waitFor({ state: "visible", timeout: 15_000 });
      await emailLocator.fill("");
      await passwordLocator.fill("");
      await emailLocator.fill(username);
      await passwordLocator.fill(password);

      await loginButton.click();

      // Wait for redirect away from /login (success indicator)
      await page
        .waitForURL((url) => !url.pathname.includes("/login"), {
          timeout: 20_000,
        })
        .catch(() => {});

      const afterUrl = page.url();
      const recovered = !afterUrl.includes("/login");

      assertions.rate_limit_recovered = {
        expected: "Valid login succeeds after 65s wait",
        actual: recovered
          ? `succeeded — redirected to ${afterUrl}`
          : `still on login page (${afterUrl})`,
        match: recovered,
      };

      console.log(`[RateLimit] Recovery: ${recovered ? "SUCCESS" : "FAILED"} — URL: ${afterUrl}`);

      if (!recovered) {
        try {
          const buf = await page.screenshot({ fullPage: true });
          screenshotUrl =
            (await uploadScreenshot(buf, `sec1_recovery_failed_${username}`)) ||
            screenshotUrl;
        } catch {
          /* best-effort */
        }
      }

      // ── Final verdict ──
      // All 3 strict assertions must pass: triggered, exact_text, recovered
      const allStrictMatch =
        assertions.rate_limit_triggered.match &&
        assertions.exact_modal_text_seen.match &&
        assertions.rate_limit_recovered.match;
      const overallStatus: "success" | "failed" = allStrictMatch ? "success" : "failed";

      const payload = {
        status: overallStatus,
        message:
          overallStatus === "success"
            ? `Rate limit verified — 429 at attempt ${firstRateLimitedAt}, exact modal text matched, recovery successful`
            : `Rate limit test failed — see assertions for details`,
        username,
        assertions,
        attempts,
        first_rate_limited_at: firstRateLimitedAt,
        modal_text_captured: modalTextCaptured,
        recovery_url: afterUrl,
        counts: {
          total_attempts: attempts.length,
          http_429_count: attempts.filter((a) => a.http_status === 429).length,
          http_401_count: attempts.filter((a) => a.http_status === 401).length,
          exact_match_count: attempts.filter((a) => a.exact_text_match).length,
        },
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        total_duration_ms: Date.now() - overallStart,
        screenshot_url: screenshotUrl,
      };

      if (context) await context.close().catch(() => {});
      return await respond(res, overallStatus === "success" ? 200 : 500, payload, overallStart);
    } catch (recoveryErr) {
      assertions.rate_limit_recovered = {
        expected: "Valid login succeeds after 65s wait",
        actual: `error during recovery: ${(recoveryErr as Error).message}`,
        match: false,
      };
      try {
        const buf = await page.screenshot({ fullPage: true });
        screenshotUrl =
          (await uploadScreenshot(buf, `sec1_recovery_error_${username}`)) ||
          screenshotUrl;
      } catch {
        /* best-effort */
      }
      const payload = {
        status: "failed" as const,
        message: `Recovery step failed: ${(recoveryErr as Error).message}`,
        username,
        assertions,
        attempts,
        first_rate_limited_at: firstRateLimitedAt,
        modal_text_captured: modalTextCaptured,
        counts: {
          total_attempts: attempts.length,
          http_429_count: attempts.filter((a) => a.http_status === 429).length,
          http_401_count: attempts.filter((a) => a.http_status === 401).length,
          exact_match_count: attempts.filter((a) => a.exact_text_match).length,
        },
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        total_duration_ms: Date.now() - overallStart,
        screenshot_url: screenshotUrl,
      };
      if (context) await context.close().catch(() => {});
      return await respond(res, 500, payload, overallStart);
    }
  } catch (err) {
    screenshotUrl = await captureShot(context, `sec1_error_${username}`);
    if (context) await context.close().catch(() => {});

    const payload = {
      status: "error" as const,
      message: (err as Error).message,
      username,
      assertions,
      attempts,
      first_rate_limited_at: firstRateLimitedAt,
      modal_text_captured: modalTextCaptured,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };
    return await respond(res, 500, payload, overallStart);
  }
});

export default router;
