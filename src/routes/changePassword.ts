// ─── Change Password Route (TC 1.6) ──────────────────────────────────────────
// Flow: login (current) → open profile menu → Change Password modal →
//       fill + Save → success toast → session still authenticated → logout →
//       login with NEW password (must succeed) → login with OLD password (must fail).
//
// Lockout-safe: returns `active_password` = the credential that is live AFTER the
// run (NEW if the new-password login succeeded, else CURRENT). n8n persists it to
// SignIn_Task.password. Self-heals if the stored password is already rotated.

import { BrowserContext, Page } from "playwright";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { safeClose, invalidateSession } from "../services/browserManager";
import { detectToast } from "../services/riskHelpers";
import { captureFailure } from "../utils/screenshot";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChangePasswordInput {
  username: string;
  current_password: string;
  new_password: string;
  app_url?: string; // accepted but not used — bot logs in via config.loginUrl (env LOGIN_URL)
}

export interface ChangePasswordStep {
  step: number;
  name: string;
  expected: string;
  actual: string;
  status: "pass" | "fail";
}

export interface ChangePasswordResult {
  status: "passed" | "failed" | "error";
  username: string;
  message: string;
  total_steps: number;
  passed: number;
  failed: number;
  assertion_actual: string;
  assertion_match: "pass" | "fail";
  screenshot_url: string | null;
  active_password: string;
  steps: ChangePasswordStep[];
}

// ─── Local helpers (mirrors auditLog.ts; those copies aren't exported) ────────

async function openUserMenu(page: Page): Promise<void> {
  const avatar = page
    .locator("div.rounded-full span.text-white")
    .filter({ hasText: /^[A-Z]{1,2}$/ })
    .first();
  await avatar.waitFor({ state: "visible", timeout: 8_000 });
  await avatar.click();
  await page.waitForTimeout(1_000);
}

async function performLogout(page: Page): Promise<boolean> {
  try {
    await openUserMenu(page);
    // Logout entry varies by build: a "Sign out" span (current UI) or a
    // menu-item-logout testid (older). Try testid, then text, then reopen+text.
    const byTestId = page.locator('[data-testid="menu-item-logout"]');
    const byText = page.getByText("Sign out", { exact: true });
    if (await byTestId.first().isVisible().catch(() => false)) {
      await byTestId.first().click();
    } else if (await byText.first().isVisible().catch(() => false)) {
      await byText.first().click();
    } else {
      await openUserMenu(page); // menu may have collapsed — reopen and retry
      await byText.first().click({ timeout: 5_000 });
    }
    // Reliable signal: the login form reappears (don't rely on URL alone).
    const backToLogin = await page
      .locator('input[name="email"]')
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const url = page.url();
    return backToLogin || url.includes("/login") || url.includes("/sign-in");
  } catch (err) {
    console.log(`[PwChange] Logout failed: ${(err as Error).message}`);
    return false;
  }
}

async function performFreshLogin(page: Page, username: string, password: string): Promise<boolean> {
  try {
    await page.goto(config.loginUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    const emailInput = page.locator('input[name="email"]');
    await emailInput.waitFor({ state: "visible", timeout: 15_000 });
    await emailInput.fill(username);
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.waitFor({ state: "visible", timeout: 5_000 });
    await passwordInput.fill(password);
    const loginBtn = page.getByTestId("button-login");
    await loginBtn.waitFor({ state: "visible", timeout: 5_000 });
    await loginBtn.click();
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 }).catch(() => {});
    return !page.url().includes("/login");
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function performChangePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
  const username = input.username;
  // Rotation direction; may be swapped by self-heal below.
  let curPw = input.current_password;
  let tgtPw = input.new_password;

  const result: ChangePasswordResult = {
    status: "error",
    username,
    message: "",
    total_steps: 7,
    passed: 0,
    failed: 7,
    assertion_actual: "",
    assertion_match: "fail",
    screenshot_url: null,
    active_password: input.current_password, // safe default — never blanks the stored pw
    steps: [],
  };

  const addStep = (name: string, expected: string, actual: string, pass: boolean) =>
    result.steps.push({ step: result.steps.length + 1, name, expected, actual, status: pass ? "pass" : "fail" });

  let context: BrowserContext | null = null;

  try {
    // ── Login (with self-heal if the stored password is already rotated) ──
    let session: { context: BrowserContext; page: Page };
    try {
      session = await createContextAndLogin(username, curPw);
    } catch {
      invalidateSession();
      session = await createContextAndLogin(username, tgtPw); // throws if this also fails
      [curPw, tgtPw] = [tgtPw, curPw]; // account was already on the other password
      console.log("[PwChange] Self-heal: stored password was already rotated; swapped direction.");
    }
    context = session.context;
    const page = session.page;

    // ── 1. Profile menu loaded ──
    await openUserMenu(page);
    const cpItem = page.locator('[data-testid="menu-item-change-password"]');
    const menuOk = await cpItem.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
    addStep("Profile menu loaded", "Change Password item visible", menuOk ? "visible" : "not visible", menuOk);
    if (!menuOk) throw new Error("Profile menu / Change Password item not found");

    // ── 2. Change Password modal visible ──
    await cpItem.click();
    const curInput = page.locator('[data-testid="input-current-password"]');
    const modalOk = await curInput.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
    addStep("Change Password modal visible", "current-password input visible", modalOk ? "visible" : "not visible", modalOk);
    if (!modalOk) throw new Error("Change Password modal did not open");

    // Fill + save (UI-driven → SPA handles CSRF).
    await curInput.fill(curPw);
    await page.locator('[data-testid="input-new-password"]').fill(tgtPw);
    await page.locator('[data-testid="input-confirm-password"]').fill(tgtPw);
    await page.locator('[data-testid="button-save-password"]').click();

    // ── 3. Success toast / message visible ──
    const toast = await detectToast(page, "password");
    const SUCCESS = /updated|changed|success|saved/i;
    const toastOk = toast.detected && SUCCESS.test(toast.actualText || "");
    addStep(
      "Success toast visible",
      "success toast after Save",
      toast.actualText || (toast.detected ? "toast (no success text)" : "no toast"),
      toastOk
    );

    // ── 4. Session still authenticated after update ──
    await page.waitForTimeout(1_500);
    const stillIn = !page.url().includes("/login");
    const avatarPresent = await page
      .locator("div.rounded-full span.text-white")
      .first()
      .isVisible()
      .catch(() => false);
    const sessionOk = stillIn && avatarPresent;
    addStep("Session still authenticated", "logged in after update", `url=${page.url()}, avatar=${avatarPresent}`, sessionOk);

    // ── 5. Logout ──
    const logoutOk = await performLogout(page);
    addStep("Logout", "redirect to /login", logoutOk ? "logged out" : "logout failed", logoutOk);
    // Capture evidence NOW (menu state) — by the end of the run the page is on
    // the login screen and a late screenshot wouldn't show the logout problem.
    if (!logoutOk) {
      result.screenshot_url = await captureFailure(context, "pwchange_logout_fail");
    }

    // ── 6. Login with NEW password → success (this is the real proof) ──
    invalidateSession();
    const newLoginOk = await performFreshLogin(page, username, tgtPw);
    addStep("Login with NEW password", "login succeeds", newLoginOk ? "success" : "failed", newLoginOk);

    // ── 7. Login with OLD password → failure ──
    await context.clearCookies().catch(() => {});
    invalidateSession();
    const oldLoginWorks = await performFreshLogin(page, username, curPw);
    addStep("Login with OLD password rejected", "old login fails", oldLoginWorks ? "unexpectedly succeeded" : "rejected", !oldLoginWorks);

    // ── Tally ──
    result.passed = result.steps.filter((s) => s.status === "pass").length;
    result.failed = result.total_steps - result.passed;
    result.status = result.failed === 0 ? "passed" : "failed";
    result.assertion_match = result.failed === 0 ? "pass" : "fail";
    result.assertion_actual = result.steps
      .map((s) => `Step ${s.step}: ${s.name} ${s.status === "pass" ? "✓" : "✗"}`)
      .join(" | ");
    result.message = `${result.passed}/${result.total_steps} steps passed`;

    // The login test is the source of truth for which credential is live.
    result.active_password = newLoginOk ? tgtPw : curPw;

    if (result.failed > 0 && !result.screenshot_url) {
      result.screenshot_url = await captureFailure(context, "pwchange_fail");
    }
    console.log(`[PwChange] RESULT ${result.status.toUpperCase()} (${result.passed}/${result.total_steps}) | active=${result.active_password === input.new_password ? "NEW" : "CURRENT"}`);
    return result;
  } catch (err) {
    result.status = "error";
    result.message = (err as Error).message;
    result.assertion_actual =
      result.steps.map((s) => `Step ${s.step}: ${s.name} ${s.status === "pass" ? "✓" : "✗"}`).join(" | ") ||
      result.message;
    result.passed = result.steps.filter((s) => s.status === "pass").length;
    result.failed = result.total_steps - result.passed;
    // Logged-in credential (curPw) stays the safe fallback; self-heal recovers next run if the change had applied.
    result.active_password = curPw;
    result.screenshot_url = await captureFailure(context, "pwchange_error");
    console.log(`[PwChange] ERROR: ${result.message}`);
    return result;
  } finally {
    await safeClose(context);
  }
}