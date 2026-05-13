// ─────────────────────────────────────────────────────────────────────────────
// routes/testInjection.ts
// SEC-11 — Injection Protection
//
// Endpoint: POST /test-injection
//
// Validates that Captus safely handles malicious input strings:
//   - SQL injection (no errors leak, no DB damage)
//   - XSS (no script execution, payloads escaped in rendered DOM)
//   - Path traversal / command injection / NoSQL operator bypass
//
// Test runs in Project B (TEST) — default project after login.
// 8 payloads × 2 fields (title, description) = 16 individual attempts.
//
// Assertion strategy:
//   STRICT (any failure = test FAIL + screenshot):
//     - no_sql_leakage_detected
//     - no_xss_executed
//     - no_reflected_xss
//   TOLERANT (warn only — Captus may legitimately reject ugly input):
//     - no_crashes  (500 responses logged but don't fail)
//
// Cleanup: all INJECTION_TEST_* risks deleted in batch at the end.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, Router } from "express";
import { Page, BrowserContext } from "playwright";
import { createContextAndLogin } from "../services/loginService";
import { ensureCompanyIsDemo } from "../services/companyGuardService";
import { createRiskInProject } from "../services/riskCreateHelper";
import { searchRisk } from "../services/riskHelpers";
import { uploadScreenshot } from "../utils/screenshot";
import { recordTestResult } from "../services/allureReporter";
import { saveTestResult } from "../services/supabaseLogger";
import {
  PAYLOADS,
  SQL_ERROR_SIGNATURES,
  XSS_REFLECTION_MARKERS,
  InjectionPayload,
} from "../services/injectionPayloads";
import { XssWatchdog } from "../services/xssWatchdog";
import {
  cleanupInjectionRisks,
  CLEANUP_PREFIX,
} from "../services/injectionCleanup";

const router = Router();

// ─── Types ──────────────────────────────────────────────────────────────────

interface PayloadResult {
  id: string;
  type: string;
  field: "title" | "description";
  payload_preview: string;          // truncated for the report
  title_used: string;
  create_succeeded: boolean;
  create_error: string | null;
  http_500_observed: boolean;       // tolerant signal
  sql_leakage_detected: boolean;    // strict
  xss_executed: boolean;            // strict
  reflected_xss_found: boolean;     // strict
  reflected_xss_locations: string[];
  xss_events: any[];
  screenshot_url: string | null;
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

function previewPayload(s: string, max: number = 60): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Detect SQL error leakage in page text after a create attempt. */
async function detectSqlLeakage(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    return SQL_ERROR_SIGNATURES.some((sig) =>
      bodyText.includes(sig.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** Detect reflected XSS in the rendered DOM after viewing the risk. */
async function detectReflectedXss(
  page: Page,
  payload: string
): Promise<{ found: boolean; locations: string[] }> {
  const locations: string[] = [];

  try {
    // Look for any of the XSS reflection markers as literal HTML in the page
    const html = await page.content();
    for (const marker of XSS_REFLECTION_MARKERS) {
      if (html.includes(marker)) {
        locations.push(`Marker "${marker}" found in page HTML (raw, not escaped)`);
      }
    }

    // Also check: is the FULL payload present unescaped? Compare exact-substring
    // against raw HTML — payload appearing as escaped text (e.g. &lt;script&gt;)
    // is SAFE, but as <script> in raw HTML is unsafe.
    const trimmed = payload.trim();
    if (trimmed.length > 8 && html.includes(trimmed) && trimmed.includes("<")) {
      // Heuristic: if our raw "<...>" payload appears verbatim in HTML, it might
      // be inside <script> or an attribute. Either is bad.
      locations.push(`Raw payload "${previewPayload(trimmed)}" found unescaped in HTML`);
    }
  } catch {
    // ignore — could not read page
  }

  return { found: locations.length > 0, locations };
}

/**
 * Run one payload against one field. Captures all relevant signals and returns
 * a PayloadResult that the orchestrator aggregates.
 */
async function runOnePayload(
  page: Page,
  watchdog: XssWatchdog,
  ts: string,
  idx: number,
  total: number,
  payload: InjectionPayload,
  field: "title" | "description",
  username: string
): Promise<PayloadResult> {
  const start = Date.now();
  // Marker-only title (so cleanup can find it). The payload itself goes in the
  // chosen field. Even when field=title, we keep the prefix readable for cleanup.
  const titleUsed = `${CLEANUP_PREFIX}${idx}_${payload.id}_${ts}`;

  const result: PayloadResult = {
    id: payload.id,
    type: payload.type,
    field,
    payload_preview: previewPayload(payload.payload),
    title_used: titleUsed,
    create_succeeded: false,
    create_error: null,
    http_500_observed: false,
    sql_leakage_detected: false,
    xss_executed: false,
    reflected_xss_found: false,
    reflected_xss_locations: [],
    xss_events: [],
    screenshot_url: null,
    duration_ms: 0,
  };

  console.log(
    `[Inject ${idx}/${total}] ${payload.type.toUpperCase()} in ${field}: ${previewPayload(payload.payload, 40)}`
  );

  try {
    // Drain any pre-existing events
    watchdog.drain();

    // Build the field-specific input
    // When field=title, the payload IS the title. We append a unique suffix so
    // cleanup can identify it. When field=description, title is just the marker.
    const titleForRisk =
      field === "title"
        ? `${CLEANUP_PREFIX}${idx}_${payload.id}_${ts}_${payload.payload}`
        : titleUsed;
    const descForRisk =
      field === "description"
        ? payload.payload
        : `INJECTION_TEST description ${idx}`;

    // record the actual title used (for cleanup)
    result.title_used = titleForRisk;

    const createResult = await createRiskInProject(page, titleForRisk, {
      description: descForRisk,
    });

    result.create_succeeded = createResult.success;
    if (!createResult.success) {
      result.create_error = createResult.error;
      // Server-rejected ugly input is fine — could be 400 validation. Tolerant.
    }

    // ── Strict check 1: SQL leakage in the page text ──
    result.sql_leakage_detected = await detectSqlLeakage(page);

    // ── Strict check 2: XSS execution (drain watchdog) ──
    const events = watchdog.drain();
    result.xss_events = events;
    result.xss_executed = events.some((e) => e.type === "dialog");

    // ── Strict check 3: reflected XSS in DOM ──
    // Only meaningful for XSS-type payloads
    if (payload.type === "xss" && result.create_succeeded) {
      // Re-render the risks list and search for the title we just created
      const found = await searchRisk(page, titleForRisk).catch(() => false);
      if (found) {
        const refl = await detectReflectedXss(page, payload.payload);
        result.reflected_xss_found = refl.found;
        result.reflected_xss_locations = refl.locations;

        // After search, drain watchdog again — XSS might execute on render
        const eventsAfterRender = watchdog.drain();
        result.xss_events.push(...eventsAfterRender);
        if (eventsAfterRender.some((e) => e.type === "dialog")) {
          result.xss_executed = true;
        }
      }
    }

    // ── Screenshot if any strict check failed ──
    const anyStrictFailed =
      result.sql_leakage_detected ||
      result.xss_executed ||
      result.reflected_xss_found;

    if (anyStrictFailed) {
      try {
        const buf = await page.screenshot({ fullPage: true });
        result.screenshot_url = await uploadScreenshot(
          buf,
          `sec11_unsafe_${payload.id}_${field}_${username}`
        );
      } catch {
        /* screenshot best-effort */
      }
    }

    result.duration_ms = Date.now() - start;
    return result;
  } catch (err) {
    result.create_error = (err as Error).message;
    // Could be a 500 from the server propagated as an exception
    if (/5\d\d|server error|crashed/i.test(result.create_error)) {
      result.http_500_observed = true;
    }
    result.duration_ms = Date.now() - start;
    return result;
  }
}

// ─── Result recording (matches CP-6 pattern) ────────────────────────────────

async function recordResult(payload: any, startTime: number): Promise<void> {
  const assertions = payload?.assertions ?? {};
  const matched = Object.values(assertions).filter((a: any) => a?.match).length;
  const total = Object.keys(assertions).length;
  const failedNames = Object.entries(assertions)
    .filter(([_, a]: [string, any]) => !a?.match)
    .map(([k]) => k)
    .join(", ");

  const assertionExpected =
    "No SQL leakage, no XSS execution, no reflected XSS across 16 injection attempts";
  const assertionActual =
    payload?.status === "success"
      ? `PASS — ${matched}/${total} strict assertions matched`
      : `FAIL — ${failedNames || payload?.aborted_reason || payload?.message || "see details"}`;

  // ── Allure ──
  try {
    recordTestResult(
      "SEC-11_Injection_Protection",
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
    console.error(`[Allure] Failed to record SEC-11: ${(err as Error).message}`);
  }

  // ── Supabase ──
  try {
    await saveTestResult(
      "SEC-11_Injection_Protection",
      {
        status: payload?.status ?? "error",
        username: payload?.username ?? "",
        risk_title: `${CLEANUP_PREFIX}* (${payload?.counts?.attempts ?? 0} attempts)`,
        message: payload?.message ?? null,
        assertion_expected: assertionExpected,
        assertion_actual: assertionActual,
        assertion_match: payload?.status === "success",
        screenshot_failure: payload?.screenshot_url ?? null,
      },
      {
        company_verified: payload?.company_verified,
        assertions: payload?.assertions,
        per_payload_results: payload?.per_payload,
        counts: payload?.counts,
        cleanup: payload?.cleanup,
        aborted_reason: payload?.aborted_reason,
        total_duration_ms: payload?.total_duration_ms,
      }
    );
  } catch (err) {
    console.error(`[Supabase] Failed to save SEC-11: ${(err as Error).message}`);
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

async function captureAbortShot(
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

router.post("/test-injection", async (req: Request, res: Response) => {
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
  const startedAt = new Date().toISOString();
  const overallStart = Date.now();
  const perPayload: PayloadResult[] = [];
  const assertions: Record<string, Assertion> = {};
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let screenshotUrl: string | null = null;
  const createdTitles: string[] = [];

  try {
    // ── Step 1: Login + company guard ──
    const session = await createContextAndLogin(username, password);
    context = session.context;
    page = session.page;

    const guard = await ensureCompanyIsDemo(page, requiredCompany);
    assertions.company_is_demo = {
      expected: requiredCompany,
      actual: guard.company_after ?? guard.company_before ?? null,
      match: guard.ok,
    };
    if (!guard.ok) {
      screenshotUrl = await captureAbortShot(context, `sec11_wrong_company_${username}`);
      const payload = {
        status: "failed" as const,
        message: `Aborted: wrong company (${guard.failure_reason})`,
        username,
        company_verified: requiredCompany,
        assertions,
        per_payload: perPayload,
        counts: { attempts: 0, payloads: PAYLOADS.length, fields: 2 },
        aborted_reason: "wrong_company",
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        total_duration_ms: Date.now() - overallStart,
        screenshot_url: screenshotUrl,
      };
      if (context) await context.close().catch(() => {});
      return await respond(res, 500, payload, overallStart);
    }

    // ── Step 2: Install XSS watchdog on the page ──
    const watchdog = new XssWatchdog();
    watchdog.install(page);

    // ── Step 3: Run all 8 payloads × 2 fields = 16 attempts ──
    const total = PAYLOADS.length * 2;
    let idx = 1;

    for (const payloadDef of PAYLOADS) {
      for (const field of ["title", "description"] as const) {
        const result = await runOnePayload(
          page,
          watchdog,
          ts,
          idx,
          total,
          payloadDef,
          field,
          username
        );
        perPayload.push(result);
        createdTitles.push(result.title_used);
        idx++;
      }
    }

    // ── Step 4: Aggregate into the strict + tolerant assertions ──
    const anySqlLeak = perPayload.some((r) => r.sql_leakage_detected);
    const anyXssExec = perPayload.some((r) => r.xss_executed);
    const anyReflectedXss = perPayload.some((r) => r.reflected_xss_found);
    const any500 = perPayload.some((r) => r.http_500_observed);
    const total500s = perPayload.filter((r) => r.http_500_observed).length;
    const totalSqlLeaks = perPayload.filter((r) => r.sql_leakage_detected).length;
    const totalXssExecs = perPayload.filter((r) => r.xss_executed).length;
    const totalReflectedXss = perPayload.filter((r) => r.reflected_xss_found).length;

    // Strict assertions
    assertions.no_sql_leakage_detected = {
      expected: "No SQL error signatures in any response",
      actual: anySqlLeak
        ? `LEAKED — ${totalSqlLeaks} payload(s) caused SQL errors to surface`
        : "clean",
      match: !anySqlLeak,
    };
    assertions.no_xss_executed = {
      expected: "No alert/confirm/prompt dialogs fired during testing",
      actual: anyXssExec
        ? `EXECUTED — ${totalXssExecs} payload(s) triggered dialogs`
        : "clean",
      match: !anyXssExec,
    };
    assertions.no_reflected_xss = {
      expected: "No XSS payload appears unescaped in rendered DOM",
      actual: anyReflectedXss
        ? `REFLECTED — ${totalReflectedXss} payload(s) found raw in HTML`
        : "clean",
      match: !anyReflectedXss,
    };

    // Tolerant assertion (logged but doesn't fail the test)
    assertions.no_crashes_tolerant = {
      expected: "No HTTP 500 server errors (tolerant — does not fail test)",
      actual: any500 ? `${total500s} payload(s) caused 500 responses` : "clean",
      match: true, // tolerant: always true, just a record
    };

    // ── Step 5: Batch cleanup ──
    const cleanup = await cleanupInjectionRisks(page, createdTitles);
    assertions.cleanup_complete = {
      expected: `${cleanup.attempted} test risks deleted`,
      actual:
        cleanup.failed_titles.length === 0
          ? `${cleanup.succeeded}/${cleanup.attempted} deleted`
          : `${cleanup.succeeded}/${cleanup.attempted} deleted, ${cleanup.failed_titles.length} orphaned`,
      match: cleanup.failed_titles.length === 0,
    };

    // ── Step 6: Overall verdict — only strict assertions decide pass/fail ──
    const strictAssertionKeys = [
      "no_sql_leakage_detected",
      "no_xss_executed",
      "no_reflected_xss",
      "company_is_demo",
      "cleanup_complete",
    ];
    const allStrictPassed = strictAssertionKeys.every(
      (k) => assertions[k]?.match === true
    );
    const overallStatus: "success" | "failed" = allStrictPassed ? "success" : "failed";

    // Take a wrap-up screenshot if anything went wrong
    if (overallStatus === "failed") {
      screenshotUrl = await captureAbortShot(context, `sec11_overall_fail_${username}`);
    }

    const payload = {
      status: overallStatus,
      message:
        overallStatus === "success"
          ? `Injection protection verified — ${total} payloads handled safely (${total500s} tolerant 500s logged)`
          : `Injection protection FAILED — see assertions and per_payload for details`,
      username,
      company_verified: requiredCompany,
      assertions,
      per_payload: perPayload,
      counts: {
        attempts: total,
        payloads: PAYLOADS.length,
        fields: 2,
        sql_leaks: totalSqlLeaks,
        xss_executions: totalXssExecs,
        reflected_xss: totalReflectedXss,
        http_500s: total500s,
      },
      cleanup,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };

    if (context) await context.close().catch(() => {});
    context = null;
    return await respond(res, overallStatus === "success" ? 200 : 500, payload, overallStart);
  } catch (err) {
    screenshotUrl = await captureAbortShot(context, `sec11_error_${username}`);

    // Best-effort cleanup if we have a page + created titles
    let cleanup = null;
    if (page && createdTitles.length > 0) {
      try {
        cleanup = await cleanupInjectionRisks(page, createdTitles);
      } catch {
        /* ignore cleanup failure during error path */
      }
    }

    if (context) await context.close().catch(() => {});

    const payload = {
      status: "error" as const,
      message: (err as Error).message,
      username,
      assertions,
      per_payload: perPayload,
      cleanup,
      counts: {
        attempts: perPayload.length,
        payloads: PAYLOADS.length,
        fields: 2,
      },
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };
    return await respond(res, 500, payload, overallStart);
  }
});

export default router;
