// ─── Change Password Route (TC 1.6) — change-and-revert ───────────────────────
// Flow (account always ends on BASELINE, so the test is repeatable):
//   login(baseline) → change to TEMP → verify TEMP works → verify BASELINE
//   rejected → revert TEMP→BASELINE → verify BASELINE restored.
//
// Lockout-safe: returns `active_password` = the credential that is live AFTER the
// run (the last password that successfully logged in). n8n persists it to
// SignIn_Task.password, so even a failed revert self-heals on the next run.
// Self-heals on start: if the stored password fails, tries baseline then temp,
// and normalises back to baseline before the assertions run.

import { BrowserContext, Page } from "playwright";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { safeClose, invalidateSession } from "../services/browserManager";
import { detectToast } from "../services/riskHelpers";
import { captureFailure } from "../utils/screenshot";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChangePasswordInput {
  username: string;
  current_password: string;     // what SignIn_Task currently holds (normally = baseline)
  baseline_password: string;    // the password the account must end on (John$John)
  temp_password: string;        // throwaway password used mid-test (Temp@123)
  app_url?: string;             // accepted but unused — bot logs in via config.loginUrl
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function openUserMenu(page: Page): Promise<void> {
  const avatar = page
    .locator("div.rounded-full span.text-white")
    .filter({ hasText: /^[A-Z]{1,2}$/ })
    .first();
  const anyItem = page
    .locator('[data-testid="menu-item-change-password"]')
    .or(page.getByRole("menuitem", { name: /sign out/i }));
  // Click, then CONFIRM the dropdown opened; retry the click if it didn't.
  // Never re-click an already-open menu (that would toggle it shut).
  for (let attempt = 0; attempt < 3; attempt++) {
    await avatar.waitFor({ state: "visible", timeout: 8_000 });
    await avatar.click();
    const opened = await anyItem
      .first()
      .waitFor({ state: "visible", timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    await page.waitForTimeout(800);
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

// Open the modal and change fromPw → toPw. Returns whether the modal opened and
// whether a success toast appeared.
async function changePasswordViaModal(
  page: Page,
  fromPw: string,
  toPw: string
): Promise<{ modalOk: boolean; toastOk: boolean; toastText: string }> {
  await openUserMenu(page);
  const cpItem = page.locator('[data-testid="menu-item-change-password"]');
  const menuOk = await cpItem.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
  if (!menuOk) return { modalOk: false, toastOk: false, toastText: "change-password menu item not found" };

  await cpItem.click();
  const curInput = page.locator('[data-testid="input-current-password"]');
  const modalOk = await curInput.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
  if (!modalOk) return { modalOk: false, toastOk: false, toastText: "modal did not open" };

  await curInput.fill(fromPw);
  await page.locator('[data-testid="input-new-password"]').fill(toPw);
  await page.locator('[data-testid="input-confirm-password"]').fill(toPw);
  await page.locator('[data-testid="button-save-password"]').click();

  const toast = await detectToast(page, "password");
  const SUCCESS = /updated|changed|success|saved/i;
  const toastOk = toast.detected && SUCCESS.test(toast.actualText || "");
  return {
    modalOk: true,
    toastOk,
    toastText: toast.actualText || (toast.detected ? "toast (no success text)" : "no toast"),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function performChangePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
  const username = input.username;
  const BASELINE = input.baseline_password;
  const TEMP = input.temp_password;

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

  // Tracks the last password that actually logged in → what we persist.
  let lastWorkingPw = input.current_password;
  let context: BrowserContext | null = null;
  let firstFailureCaptured = false;

  const addStep = async (name: string, expected: string, actual: string, pass: boolean) => {
    result.steps.push({ step: result.steps.length + 1, name, expected, actual, status: pass ? "pass" : "fail" });
    if (!pass && !firstFailureCaptured) {
      firstFailureCaptured = true;
      result.screenshot_url = await captureFailure(context, `pwchange_step${result.steps.length}_fail`);
    }
  };

  try {
    // ── Establish session; self-heal across [stored, baseline, temp] ──
    const candidates = [input.current_password, BASELINE, TEMP].filter((v, i, a) => a.indexOf(v) === i);
    let session: { context: BrowserContext; page: Page } | null = null;
    let livePw = "";
    for (const pw of candidates) {
      try {
        invalidateSession();
        session = await createContextAndLogin(username, pw);
        livePw = pw;
        break;
      } catch {
        /* try next candidate */
      }
    }
    if (!session) {
      throw new Error(`Login failed for ${username} with all candidate passwords.`);
    }
    context = session.context;
    const page = session.page;
    lastWorkingPw = livePw;

    // ── Normalise to baseline if a prior run left us on temp (recovery setup) ──
    if (livePw !== BASELINE) {
      console.log("[PwChange] Recovery: account was on TEMP; reverting to baseline before test.");
      await changePasswordViaModal(page, livePw, BASELINE);
      invalidateSession();
      const restored = await performFreshLogin(page, username, BASELINE);
      if (!restored) throw new Error("Recovery failed: could not restore baseline from temp.");
      lastWorkingPw = BASELINE;
    }

    // ── 1. Login with baseline ──
    const avatarVisible = await page
      .locator("div.rounded-full span.text-white")
      .first()
      .isVisible()
      .catch(() => false);
    await addStep("Login with baseline", "dashboard loaded", avatarVisible ? "logged in" : "no avatar", avatarVisible);

    // ── 2 + 3. Change baseline → TEMP ──
    const toTemp = await changePasswordViaModal(page, BASELINE, TEMP);
    await addStep("Change Password modal opens", "modal visible", toTemp.modalOk ? "visible" : "not visible", toTemp.modalOk);
    await addStep("Change to temp → success toast", "success toast", toTemp.toastText, toTemp.toastOk);

    // ── 4. New password (TEMP) works ──
    invalidateSession();
    const tempWorks = await performFreshLogin(page, username, TEMP);
    if (tempWorks) lastWorkingPw = TEMP;
    await addStep("New password works", "login with temp succeeds", tempWorks ? "success" : "failed", tempWorks);

    // ── 5. Old password (BASELINE) rejected ──
    await context.clearCookies().catch(() => {});
    invalidateSession();
    const baselineStillWorks = await performFreshLogin(page, username, BASELINE);
    if (baselineStillWorks) lastWorkingPw = BASELINE;
    await addStep("Old password rejected", "login with baseline fails", baselineStillWorks ? "unexpectedly worked" : "rejected", !baselineStillWorks);

    // ── 6. Revert TEMP → BASELINE ──
    invalidateSession();
    const tempSession = await performFreshLogin(page, username, TEMP);
    if (tempSession) lastWorkingPw = TEMP;
    let revert = { modalOk: false, toastOk: false, toastText: "could not log in as temp to revert" };
    if (tempSession) revert = await changePasswordViaModal(page, TEMP, BASELINE);
    await addStep("Revert to baseline → success toast", "success toast", revert.toastText, revert.toastOk);

    // ── 7. Account restored ──
    invalidateSession();
    const restored = await performFreshLogin(page, username, BASELINE);
    if (restored) lastWorkingPw = BASELINE;
    await addStep("Account restored", "login with baseline succeeds", restored ? "success" : "failed", restored);

    // ── Tally ──
    result.passed = result.steps.filter((s) => s.status === "pass").length;
    result.failed = result.total_steps - result.passed;
    result.status = result.failed === 0 ? "passed" : "failed";
    result.assertion_match = result.failed === 0 ? "pass" : "fail";
    result.assertion_actual = result.steps
      .map((s) => `Step ${s.step}: ${s.name} ${s.status === "pass" ? "✓" : "✗"}`)
      .join(" | ");
    result.message = `${result.passed}/${result.total_steps} steps passed`;
    result.active_password = lastWorkingPw;

    if (result.failed > 0 && !result.screenshot_url) {
      result.screenshot_url = await captureFailure(context, "pwchange_fail");
    }
    console.log(`[PwChange] RESULT ${result.status.toUpperCase()} (${result.passed}/${result.total_steps}) | active=${result.active_password === BASELINE ? "BASELINE" : result.active_password === TEMP ? "TEMP" : "OTHER"}`);
    return result;
  } catch (err) {
    result.status = "error";
    result.message = (err as Error).message;
    result.assertion_actual =
      result.steps.map((s) => `Step ${s.step}: ${s.name} ${s.status === "pass" ? "✓" : "✗"}`).join(" | ") || result.message;
    result.passed = result.steps.filter((s) => s.status === "pass").length;
    result.failed = result.total_steps - result.passed;
    result.active_password = lastWorkingPw; // last good credential — lockout-safe
    if (!result.screenshot_url) result.screenshot_url = await captureFailure(context, "pwchange_error");
    console.log(`[PwChange] ERROR: ${result.message}`);
    return result;
  } finally {
    await safeClose(context);
  }
}