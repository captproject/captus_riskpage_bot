// ─── Session Termination Route ────────────────────────────────────────────────
// TC_Session_Termination — Validates session security after logout.
//
// 9 Assertions (each shown as a separate step in Allure):
//   1. Login successful (lands on /admin/companies)
//   2. Auth cookies present after login
//   3. Protected page accessible while logged in
//   4. Logout completes (redirects to /login)
//   5. Auth cookies cleared after logout
//   6. localStorage/sessionStorage cleared of auth data
//   7. Protected page redirects to /login after logout
//   8. Old captured cookies don't grant access (server-side invalidation)
//   9. Audit log shows "Logout" entry

import { BrowserContext, Page, Cookie } from "playwright";
import { config } from "../server";
import { getBrowser, closeBrowser } from "../services/browserManager";

// Inline screenshot upload (same pattern as loginBot.ts)
async function uploadSessionScreenshot(buffer: Buffer, status: string): Promise<string | null> {
  if (!config.supabaseUrl || !config.supabaseKey) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `session_termination_${status}_${timestamp}.png`;
  try {
    const response = await fetch(`${config.supabaseUrl}/storage/v1/object/screenshots/${fileName}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.supabaseKey}`,
        "Content-Type": "image/png",
        "x-upsert": "true",
      },
      body: buffer as unknown as BodyInit,
    });
    if (response.ok) return `${config.supabaseUrl}/storage/v1/object/public/screenshots/${fileName}`;
    return null;
  } catch { return null; }
}

export interface SessionTerminationInput {
  username: string;
  password: string;
}

export interface SessionStepResult {
  step: number;
  name: string;
  status: "pass" | "fail";
  expected: string;
  actual: string;
}

export interface SessionTerminationResult {
  status: "success" | "failed" | "error";
  message: string;
  username: string;
  total_steps: number;
  passed: number;
  failed: number;
  steps: SessionStepResult[];
  steps_summary: string;
  assertion_match: boolean;
  screenshot_url: string | null;
}

// ─── Helper: Fill and submit login form ──────────────────────────────────────

async function performLogin(page: Page, username: string, password: string): Promise<string> {
  await page.goto(config.loginUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('input[name="email"]', { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(3_000);

  await page.evaluate(([email, pass]) => {
    const setVal = (sel: string, val: string) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      if (el) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    setVal('input[name="email"]', email);
    setVal('input[name="password"]', pass);
  }, [username, password]);

  await page.evaluate(() => {
    (document.querySelector('button[data-testid="button-login"]') as HTMLButtonElement)?.click();
  });

  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2_000);
  return page.url();
}

// ─── Main Function ───────────────────────────────────────────────────────────

export async function performSessionTermination(
  input: SessionTerminationInput
): Promise<SessionTerminationResult> {
  const { username, password } = input;
  let context: BrowserContext | null = null;
  const steps: SessionStepResult[] = [];

  try {
    console.log(`[SessionTerm] Starting for: ${username}`);
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page: Page = await context.newPage();

    // ── STEP 1: Login successful ──────────────────────────────────────
    console.log("[SessionTerm] Step 1: Login");
    let landingUrl = "";
    let step1Pass = false;
    try {
      landingUrl = await performLogin(page, username, password);
      step1Pass = !landingUrl.includes("/login");
    } catch (e) {
      console.log(`[SessionTerm] Step 1 error: ${(e as Error).message}`);
    }
    steps.push({
      step: 1,
      name: "Login successful",
      status: step1Pass ? "pass" : "fail",
      expected: "Lands on /admin/companies (not /login)",
      actual: step1Pass ? `Landed on ${new URL(landingUrl).pathname}` : "Login failed — still on /login",
    });

    if (!step1Pass) {
      // Cannot continue if login fails
      return await finalizeResult({ steps, page, context, username });
    }

    // ── STEP 2: Auth cookies present after login ─────────────────────
    console.log("[SessionTerm] Step 2: Verify cookies present");
    const cookiesAfterLogin: Cookie[] = await context.cookies();
    const authCookieNames = cookiesAfterLogin
      .filter(c =>
        c.name.toLowerCase().includes("auth") ||
        c.name.toLowerCase().includes("session") ||
        c.name.toLowerCase().includes("token") ||
        c.name.toLowerCase().includes("sid") ||
        c.name.toLowerCase().includes("jwt")
      )
      .map(c => c.name);
    const step2Pass = cookiesAfterLogin.length > 0;
    steps.push({
      step: 2,
      name: "Auth cookies present after login",
      status: step2Pass ? "pass" : "fail",
      expected: "At least 1 cookie present after login",
      actual: `${cookiesAfterLogin.length} cookies total, ${authCookieNames.length} auth-related: ${authCookieNames.join(", ") || "none"}`,
    });

    // Save cookies for step 8
    const capturedCookies = [...cookiesAfterLogin];

    // ── STEP 3: Protected page accessible while logged in ────────────
    console.log("[SessionTerm] Step 3: Access protected page");
    let step3Pass = false;
    let protectedUrl = "";
    try {
      await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(2_000);
      protectedUrl = page.url();
      step3Pass = !protectedUrl.includes("/login");
    } catch (e) {
      console.log(`[SessionTerm] Step 3 error: ${(e as Error).message}`);
    }
    steps.push({
      step: 3,
      name: "Protected page accessible while logged in",
      status: step3Pass ? "pass" : "fail",
      expected: "Dashboard loads (not redirected to /login)",
      actual: step3Pass ? `Loaded ${new URL(protectedUrl).pathname}` : `Redirected to ${protectedUrl}`,
    });

    // ── STEP 4: Logout completes ─────────────────────────────────────
    console.log("[SessionTerm] Step 4: Logout");
    let step4Pass = false;
    let postLogoutUrl = "";
    try {
      const avatar = page.locator("div.rounded-full span.text-white").filter({ hasText: /^[A-Z]{1,2}$/ }).first();
      await avatar.waitFor({ state: "visible", timeout: 5_000 });
      await avatar.click();
      await page.waitForTimeout(1_000);
      const logoutBtn = page.locator('[data-testid="menu-item-logout"]');
      await logoutBtn.waitFor({ state: "visible", timeout: 5_000 });
      await logoutBtn.click();
      await page.waitForTimeout(3_000);
      postLogoutUrl = page.url();
      step4Pass = postLogoutUrl.includes("/login") || postLogoutUrl.includes("/sign-in");
    } catch (e) {
      console.log(`[SessionTerm] Step 4 error: ${(e as Error).message}`);
    }
    steps.push({
      step: 4,
      name: "Logout completes (redirects to /login)",
      status: step4Pass ? "pass" : "fail",
      expected: "URL redirects to /login or /sign-in",
      actual: step4Pass ? `Redirected to ${new URL(postLogoutUrl).pathname}` : `Stayed at ${postLogoutUrl || "unknown"}`,
    });

    // ── STEP 5: Auth cookies cleared after logout ────────────────────
    console.log("[SessionTerm] Step 5: Verify cookies cleared");
    const cookiesAfterLogout: Cookie[] = await context.cookies();
    const remainingAuthCookies = cookiesAfterLogout.filter(c =>
      c.name.toLowerCase().includes("auth") ||
      c.name.toLowerCase().includes("session") ||
      c.name.toLowerCase().includes("token") ||
      c.name.toLowerCase().includes("sid") ||
      c.name.toLowerCase().includes("jwt")
    );
    const step5Pass = remainingAuthCookies.length === 0;
    steps.push({
      step: 5,
      name: "Auth cookies cleared after logout",
      status: step5Pass ? "pass" : "fail",
      expected: "0 auth/session/token cookies after logout",
      actual: `${remainingAuthCookies.length} auth cookies remain${remainingAuthCookies.length > 0 ? `: ${remainingAuthCookies.map(c => c.name).join(", ")}` : ""}`,
    });

    // ── STEP 6: localStorage/sessionStorage cleared of auth data ─────
    console.log("[SessionTerm] Step 6: Verify storage cleared");
    let step6Pass = false;
    let storageDetails = "";
    try {
      const storage = await page.evaluate(() => ({
        localKeys: Object.keys(localStorage),
        sessionKeys: Object.keys(sessionStorage),
      }));
      const allKeys = [...storage.localKeys, ...storage.sessionKeys];
      const authKeys = allKeys.filter(k =>
        k.toLowerCase().includes("auth") ||
        k.toLowerCase().includes("token") ||
        k.toLowerCase().includes("user") ||
        k.toLowerCase().includes("session") ||
        k.toLowerCase().includes("jwt")
      );
      step6Pass = authKeys.length === 0;
      storageDetails = `localStorage: ${storage.localKeys.length} keys, sessionStorage: ${storage.sessionKeys.length} keys, auth-related: ${authKeys.length}${authKeys.length > 0 ? ` (${authKeys.join(", ")})` : ""}`;
    } catch (e) {
      storageDetails = `Error reading storage: ${(e as Error).message}`;
    }
    steps.push({
      step: 6,
      name: "localStorage/sessionStorage cleared of auth data",
      status: step6Pass ? "pass" : "fail",
      expected: "No auth-related keys in browser storage",
      actual: storageDetails,
    });

    // ── STEP 7: Protected page redirects to /login after logout ──────
    console.log("[SessionTerm] Step 7: Protected page denied after logout");
    let step7Pass = false;
    let attemptUrl = "";
    try {
      await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(2_000);
      attemptUrl = page.url();
      step7Pass = attemptUrl.includes("/login") || attemptUrl.includes("/sign-in");
    } catch (e) {
      attemptUrl = `Error: ${(e as Error).message}`;
    }
    steps.push({
      step: 7,
      name: "Protected page redirects to /login after logout",
      status: step7Pass ? "pass" : "fail",
      expected: "Accessing /dashboard redirects to /login",
      actual: step7Pass ? `Correctly redirected to ${new URL(attemptUrl).pathname}` : `Got ${attemptUrl}`,
    });

    // ── STEP 8: Old cookies don't grant access (server-side invalidation) ──
    console.log("[SessionTerm] Step 8: Try old captured cookies");
    let step8Pass = false;
    let step8Details = "";
    try {
      // Reuse same context - inject captured cookies and try protected page
      // (avoids spawning second browser which causes memory crash on Render)
      await context.addCookies(capturedCookies);
      await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(2_500);
      const finalUrl = page.url();
      step8Pass = finalUrl.includes("/login") || finalUrl.includes("/sign-in");
      step8Details = step8Pass
        ? `Old cookies rejected — redirected to ${new URL(finalUrl).pathname}`
        : `SECURITY ISSUE: Old cookies still grant access to ${new URL(finalUrl).pathname}`;
    } catch (e) {
      step8Details = `Error: ${(e as Error).message}`;
    }
    steps.push({
      step: 8,
      name: "Old captured cookies invalidated server-side",
      status: step8Pass ? "pass" : "fail",
      expected: "Captured pre-logout cookies must NOT grant access",
      actual: step8Details,
    });

    // ── STEP 9: Audit log shows Logout entry ──────────────────────────
    console.log("[SessionTerm] Step 9: Verify audit log Logout entry");
    let step9Pass = false;
    let step9Details = "";
    try {
      // Re-login to access audit page
      await performLogin(page, username, password);

      // Select demo company if needed
      try {
        const companyBtn = page.getByTestId("button-company-selector");
        const btnText = (await companyBtn.textContent().catch(() => ""))?.trim() || "";
        if (!btnText.toLowerCase().includes("demo")) {
          await companyBtn.click();
          const opt = page.locator('[role="menuitem"]').filter({ hasText: "demo" }).first();
          await opt.waitFor({ state: "visible", timeout: 5_000 });
          await opt.click();
          await page.waitForTimeout(1_500);
        }
      } catch {}

      await page.goto(config.auditUrl, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(3_000);

      // Look for recent Logout entry
      const logoutFound = await page.evaluate(() => {
        const rows = document.querySelectorAll('[data-testid^="row-audit-log-"]');
        for (let i = 0; i < Math.min(rows.length, 10); i++) {
          const text = rows[i].textContent || "";
          if (text.includes("Logout") && text.toLowerCase().includes("user logged out")) {
            return true;
          }
        }
        return false;
      });

      step9Pass = logoutFound;
      step9Details = logoutFound
        ? "Logout entry found in recent audit rows"
        : "Logout entry not found in recent 10 audit rows";
    } catch (e) {
      step9Details = `Error: ${(e as Error).message}`;
    }
    steps.push({
      step: 9,
      name: "Audit log shows Logout entry",
      status: step9Pass ? "pass" : "fail",
      expected: "Audit row with action=Logout, summary='User logged out'",
      actual: step9Details,
    });

    return await finalizeResult({ steps, page, context, username });
  } catch (error) {
    console.error(`[SessionTerm] Fatal error: ${(error as Error).message}`);
    if (context) await context.close().catch(() => {});
    await closeBrowser();
    return {
      status: "error",
      message: (error as Error).message,
      username,
      total_steps: 9,
      passed: steps.filter(s => s.status === "pass").length,
      failed: 9 - steps.filter(s => s.status === "pass").length,
      steps,
      steps_summary: steps.map(s => `${s.step}.${s.status === "pass" ? "✅" : "❌"}`).join(" "),
      assertion_match: false,
      screenshot_url: null,
    };
  }
}

// ─── Helper: Build final result ──────────────────────────────────────────────

async function finalizeResult(args: {
  steps: SessionStepResult[];
  page: Page;
  context: BrowserContext | null;
  username: string;
}): Promise<SessionTerminationResult> {
  const { steps, page, context, username } = args;
  const passed = steps.filter(s => s.status === "pass").length;
  const failed = steps.length - passed;
  const allPassed = failed === 0 && steps.length === 9;

  // Capture screenshot only if any step failed
  let screenshotUrl: string | null = null;
  if (!allPassed) {
    try {
      const buffer = await page.screenshot({ fullPage: true });
      screenshotUrl = await uploadSessionScreenshot(buffer, "fail");
    } catch (e) {
      console.log(`[SessionTerm] Screenshot upload failed: ${(e as Error).message}`);
    }
  }

  if (context) await context.close().catch(() => {});
  await closeBrowser();

  const stepsSummary = steps.map(s =>
    `${s.step}.${shortenStepName(s.name)}:${s.status === "pass" ? "✅" : "❌"}`
  ).join(" | ");

  const message = allPassed
    ? `All ${steps.length} session security checks passed`
    : `${passed}/${steps.length} passed — ${failed} security check(s) failed`;

  return {
    status: allPassed ? "success" : "failed",
    message,
    username,
    total_steps: 9,
    passed,
    failed,
    steps,
    steps_summary: stepsSummary,
    assertion_match: allPassed,
    screenshot_url: screenshotUrl,
  };
}

function shortenStepName(name: string): string {
  // Take first 2-3 keywords for compact summary
  const words = name.split(" ");
  if (words.length <= 3) return name;
  return words.slice(0, 3).join(" ");
}