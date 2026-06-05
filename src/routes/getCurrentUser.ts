// ─────────────────────────────────────────────────────────────────────────────
// routes/getCurrentUser.ts
// TC_Get_Current_User — Spec 1.9 (Get Current User)
//
// Endpoint: POST /test-current-user
//
// Validates GET /api/auth/user end-to-end:
//   Step 1 — Login (authenticated context obtained)
//   Step 2 — Authed   GET /api/auth/user returns 200
//   Step 3 — Response contains "id"
//   Step 4 — Response contains "email"
//   Step 5 — Response contains "role"
//   Step 6 — Unauthed GET /api/auth/user returns 401
//   Pass criteria — endpoint returns user data for authenticated requests only
//
// ── Design notes from endpoint verification ──────────────────────────────────
//
// Captus authenticates this endpoint with a Bearer JWT in the Authorization
// header (an express-session cookie rides along). The app's JS attaches the
// header, so a raw request would NOT include it. We capture the Authorization
// header off the app's OWN /api/auth/user call after login (with a localStorage
// fallback), then replay it on our controlled request.
//
// companyId is intentionally NOT asserted — the live payload returns user
// identity only (id, email, role, name…); company is chosen via the company
// selector, not part of this object. Asserting id + email + role only.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, Router } from "express";
import { Page, BrowserContext } from "playwright";
import { config } from "../server";
import { getBrowser, closeBrowser, executionQueue } from "../services/browserManager";
import { withTimeout } from "../utils/retry";
import { createContextAndLogin } from "../services/loginService";
import { recordTestResult } from "../services/allureReporter";
import { saveTestResult } from "../services/supabaseLogger";

const router = Router();

const API_PATH = "/api/auth/user";
const REQUIRED_FIELDS = ["id", "email", "role"] as const;

interface GcuStep {
  step: number;
  name: string;
  status: "pass" | "fail";
  expected: string;
  actual: string;
}

interface GcuResult {
  status: "success" | "failed" | "error";
  message: string;
  username: string;
  assertion_match: "pass" | "fail";
  assertion_expected: string;
  assertion_actual: string;
  total_steps: number;
  passed: number;
  failed: number;
  steps: GcuStep[];
  screenshot_url: string | null;
}

// ── Core test ─────────────────────────────────────────────────────────────────

async function performGetCurrentUser(username: string, password: string): Promise<GcuResult> {
  const steps: GcuStep[] = [];
  let context: BrowserContext | null = null;
  let cleanContext: BrowserContext | null = null;

  const addStep = (name: string, status: "pass" | "fail", expected: string, actual: string): void => {
    steps.push({ step: steps.length + 1, name, status, expected, actual });
  };

  const finish = (status: GcuResult["status"]): GcuResult => {
    const passed = steps.filter((s) => s.status === "pass").length;
    const failed = steps.length - passed;
    return {
      status,
      message:
        status === "success"
          ? `GET ${API_PATH} validated — ${passed}/${steps.length} assertions passed`
          : `GET ${API_PATH} — ${failed} assertion(s) failed`,
      username,
      assertion_match: failed === 0 && status === "success" ? "pass" : "fail",
      assertion_expected: "200 + {id, email, role} when authed; 401 when unauthed",
      assertion_actual: `${passed}/${steps.length} passed`,
      total_steps: steps.length,
      passed,
      failed,
      steps,
      screenshot_url: null, // API-level test — no meaningful UI state to capture
    };
  };

  try {
    // ── Step 1: Login (reuse shared login → authenticated context) ──
    const session = await createContextAndLogin(username, password);
    context = session.context;
    const page: Page = session.page;
    addStep("Login successful", "pass", "Authenticated context obtained", `Logged in as ${username}`);

    const origin = new URL(config.dashboardUrl).origin;
    const apiUrl = `${origin}${API_PATH}`;

    // ── Capture the Bearer token from the app's own /api/auth/user call ──
    let bearer = "";
    try {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes(API_PATH), { timeout: 30_000 }),
        page.reload({ waitUntil: "networkidle" }),
      ]);
      bearer = resp.request().headers()["authorization"] || "";
    } catch {
      // App may not re-fire on reload — fall back to localStorage below.
    }
    if (!bearer) {
      bearer = await page
        .evaluate(() => {
          const keys = ["token", "authToken", "accessToken", "jwt", "access_token"];
          for (const k of keys) {
            const v = localStorage.getItem(k);
            if (v) return v.startsWith("Bearer ") ? v : `Bearer ${v}`;
          }
          return "";
        })
        .catch(() => "");
    }

    // ── Steps 2-5: Authenticated request (cookies auto + captured Bearer) ──
    const authedResp = await context.request.get(apiUrl, {
      headers: bearer ? { authorization: bearer } : {},
    });
    const authedStatus = authedResp.status();
    addStep(
      "Authed GET returns 200",
      authedStatus === 200 ? "pass" : "fail",
      "HTTP 200",
      `HTTP ${authedStatus}`
    );

    let body: Record<string, unknown> = {};
    try {
      body = await authedResp.json();
    } catch {
      body = {};
    }

    for (const field of REQUIRED_FIELDS) {
      const val = body[field];
      const present = val !== undefined && val !== null && val !== "";
      addStep(
        `Response contains "${field}"`,
        present ? "pass" : "fail",
        `${field} present`,
        present ? `${field} = ${String(val)}` : `${field} missing`
      );
    }

    // ── Step 6: Unauthenticated request (fresh context, no cookies/token) ──
    const browser = await getBrowser();
    cleanContext = await browser.newContext();
    const unauthResp = await cleanContext.request.get(apiUrl);
    const unauthStatus = unauthResp.status();
    await cleanContext.close();
    cleanContext = null;
    addStep(
      "Unauthed GET returns 401",
      unauthStatus === 401 ? "pass" : "fail",
      "HTTP 401",
      `HTTP ${unauthStatus}`
    );

    await context.close();
    context = null;
    await closeBrowser();

    return finish(steps.every((s) => s.status === "pass") ? "success" : "failed");
  } catch (error) {
    if (cleanContext) await cleanContext.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    await closeBrowser();
    const r = finish("failed");
    r.status = "error";
    r.message = (error as Error).message;
    r.assertion_actual = `ERROR: ${(error as Error).message}`;
    return r;
  }
}

// ── Route ───────────────────────────────────────────────────────────────────

router.post("/test-current-user", async (req: Request, res: Response) => {
  if (req.headers["x-api-key"] !== process.env.API_KEY) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: username, password",
    });
  }

  const startTime = Date.now();
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performGetCurrentUser(username, password), config.executionTimeout, "test-current-user")
    );

    // ── Allure ──
    try {
      recordTestResult(
        "TC_Get_Current_User",
        "Authentication Tests",
        result.status,
        result.message,
        startTime,
        undefined,
        result.screenshot_url,
        {
          username,
          assertion_expected: result.assertion_expected,
          assertion_actual: result.assertion_actual,
          mode: "full",
        }
      );
    } catch (err) {
      console.error(`[Allure] Failed to record TC_Get_Current_User: ${(err as Error).message}`);
    }

    // ── Supabase ──
    try {
      await saveTestResult(
        "TC_Get_Current_User",
        {
          status: result.status,
          username,
          message: result.message,
          assertion_expected: result.assertion_expected,
          assertion_actual: result.assertion_actual,
          assertion_match: result.assertion_match === "pass",
          screenshot_failure: result.screenshot_url,
        },
        {
          total_steps: result.total_steps,
          passed: result.passed,
          failed: result.failed,
          steps: result.steps,
        }
      );
    } catch (err) {
      console.error(`[Supabase] Failed to save TC_Get_Current_User: ${(err as Error).message}`);
    }

    return res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    return res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

export default router;
