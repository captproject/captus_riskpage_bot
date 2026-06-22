import type { Request, Response } from "express";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { expect } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION POINTS — wire these to the real modules in captus_riskpage_bot.
//   1. respond()         → your wrapper that writes Supabase + Allure before res.json()
//   2. saveAllureResult  → exported from ./allureReporter
//   3. loginViaApi()     → if you already have a shared Approach-B login helper,
//                          replace the local one below with it (same return shape).
// ─────────────────────────────────────────────────────────────────────────────
import { saveAllureResult } from "./allureReporter";
// import { respond } from "./respond"; // <-- adjust path to your wrapper

// Tunables -------------------------------------------------------------------
const LOGIN_API = "/api/auth/login";       // confirm field name below
const LOGIN_FIELD: "email" | "username" = "email";
const ME_API = "/api/auth/user";
// Success-toast matcher. Adjust to your real toast selector/text if different.
const SUCCESS_TOAST = /password.*(updated|changed|success)|success/i;

const TEST_NAME = "TC_Password_Change";
const ASSERTION_EXPECTED =
  "Profile menu opens; Change Password modal visible; success toast shown; " +
  "session stays authenticated after update; logout succeeds; login with NEW " +
  "password succeeds; login with OLD password is rejected.";

// ─── Login helper (Approach B): API login, then inject JWT + reuse cookies ───
async function loginViaApi(
  context: BrowserContext,
  page: Page,
  appUrl: string,
  username: string,
  password: string
): Promise<{ ok: boolean; status: number; token: string | null }> {
  const resp = await context.request.post(`${appUrl}${LOGIN_API}`, {
    data: { [LOGIN_FIELD]: username, password },
    failOnStatusCode: false,
  });
  const status = resp.status();
  if (status !== 200) return { ok: false, status, token: null };

  const body: any = await resp.json().catch(() => ({}));
  const token: string | null = body.token ?? body.accessToken ?? body.jwt ?? null;
  // connect.sid (HttpOnly) is already in the context cookie jar from the call above.
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  if (token) {
    await page.evaluate((t: string) => localStorage.setItem("captus_auth_token", t), token);
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  return { ok: true, status, token };
}

// Clear auth between logins — reuse the SAME context, never spawn a second one.
async function clearAuth(context: BrowserContext, page: Page, appUrl: string) {
  await context.clearCookies();
  await page.goto(appUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.evaluate(() => localStorage.clear()).catch(() => {});
}

async function openUserMenu(page: Page) {
  await page.locator('[data-testid="text-username"]').click();
}

export async function changePassword(req: Request, res: Response) {
  const { username, current_password, new_password, app_url } = req.body ?? {};
  const appUrl: string = (app_url || "https://app.captus.ai").replace(/\/+$/, "");

  // Step ledger -> drives passed / total_steps / assertion_actual.
  const steps: { n: number; label: string; pass: boolean; note: string }[] = [];
  const record = (n: number, label: string, pass: boolean, note = "") =>
    steps.push({ n, label, pass, note });

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let screenshotUrl = "";

  // Lockout-safety: track which credential is live so n8n can persist it.
  let curPw: string = current_password;
  let tgtPw: string = new_password;
  let modalSuccess = false;
  let newLoginSuccess = false;

  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    context = await browser.newContext();
    const page = await context.newPage();

    // ── Initial login (with self-heal if a prior run already rotated) ──
    let init = await loginViaApi(context, page, appUrl, username, curPw);
    if (!init.ok) {
      const alt = await loginViaApi(context, page, appUrl, username, tgtPw);
      if (alt.ok) {
        [curPw, tgtPw] = [tgtPw, curPw]; // swap: account is already on the other pw
        init = alt;
      }
    }
    if (!init.ok) {
      throw new Error(
        `Initial login failed for ${username} with both candidate passwords (status ${init.status}).`
      );
    }
    await expect(page.locator('[data-testid="text-username"]')).toBeVisible({ timeout: 15000 });

    // ── 1. Settings/Profile menu loaded ──
    await openUserMenu(page);
    await expect(page.locator('[data-testid="menu-item-change-password"]')).toBeVisible({ timeout: 10000 });
    record(1, "Profile menu loaded", true);

    // ── 2. Change Password modal visible ──
    await page.locator('[data-testid="menu-item-change-password"]').click();
    await expect(page.locator('[data-testid="input-current-password"]')).toBeVisible({ timeout: 10000 });
    record(2, "Change Password modal visible", true);

    // Fill + submit (UI-driven so the SPA handles CSRF automatically).
    await page.locator('[data-testid="input-current-password"]').fill(curPw);
    await page.locator('[data-testid="input-new-password"]').fill(tgtPw);
    await page.locator('[data-testid="input-confirm-password"]').fill(tgtPw);
    await page.locator('[data-testid="button-save-password"]').click();

    // ── 3. Success toast / message visible ──
    const toast = page
      .locator('[data-testid*="toast"], [role="status"], [role="alert"]')
      .filter({ hasText: SUCCESS_TOAST })
      .first();
    await expect(toast).toBeVisible({ timeout: 10000 });
    record(3, "Success toast visible", true);
    modalSuccess = true;

    // ── 4. Session still authenticated after update ──
    const me = await context.request.get(`${appUrl}${ME_API}`, { failOnStatusCode: false });
    expect(me.status()).toBe(200);
    await expect(page.locator('[data-testid="text-username"]')).toBeVisible();
    record(4, "Session still authenticated", true);

    // ── 5. Logout ──
    await openUserMenu(page);
    await page.getByText("Sign out", { exact: true }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
    record(5, "Logout succeeded", true);

    // ── 6. Login with NEW password → success ──
    await clearAuth(context, page, appUrl);
    const newLogin = await loginViaApi(context, page, appUrl, username, tgtPw);
    expect(newLogin.ok).toBe(true);
    await expect(page.locator('[data-testid="text-username"]')).toBeVisible({ timeout: 15000 });
    record(6, "Login with NEW password succeeded", true);
    newLoginSuccess = true;

    // ── 7. Login with OLD password → failure ──
    const oldLogin = await context.request.post(`${appUrl}${LOGIN_API}`, {
      data: { [LOGIN_FIELD]: username, password: curPw },
      failOnStatusCode: false,
    });
    expect(oldLogin.status()).not.toBe(200); // expect 401
    record(7, "Login with OLD password rejected", true, `status ${oldLogin.status()}`);
  } catch (err: any) {
    // Mark the first not-yet-recorded step as the failure and capture evidence.
    const failedStepNo = steps.length + 1;
    record(failedStepNo, "FAILED", false, String(err?.message || err));
    try {
      if (context) {
        const page = context.pages()[0];
        const buf = await page?.screenshot({ fullPage: true });
        // saveAllureResult / your storage helper returns a hosted URL for the shot.
        if (buf) screenshotUrl = await saveAllureResult(TEST_NAME, buf).catch(() => "");
      }
    } catch {
      /* best-effort screenshot only */
    }
  } finally {
    // BrowserContext.close() needs the explicit cast (TS flow analysis limitation).
    if (context) await (context as BrowserContext).close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  // ── Build result ──
  const TOTAL_STEPS = 7;
  const passed = steps.filter((s) => s.pass).length;
  const allPass = passed === TOTAL_STEPS;
  const assertionActual = steps
    .map((s) => `Step ${s.n}: ${s.label}${s.note ? ` (${s.note})` : ""} ${s.pass ? "✓" : "✗"}`)
    .join(" | ");

  // Live credential after the run — n8n persists this to SignIn_Task.password.
  const activePassword = modalSuccess && newLoginSuccess ? tgtPw : curPw;

  const result = {
    status: allPass ? "passed" : "failed",
    message: allPass
      ? "Password change verified end-to-end; new password active."
      : `Password change verification failed at step ${passed + 1}.`,
    assertion_expected: ASSERTION_EXPECTED,
    assertion_actual: assertionActual,
    assertion_match: allPass ? "yes" : "no",
    passed,
    total_steps: TOTAL_STEPS,
    screenshot_url: screenshotUrl,
    active_password: activePassword,
  };

  // respond() should write Supabase + Allure, then res.json(result).
  // return respond(res, TEST_NAME, result);
  return res.json(result);
}
