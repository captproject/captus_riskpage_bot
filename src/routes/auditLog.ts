// ─── Audit Log Route — matches old server.ts exactly ──────────────────────────
import { BrowserContext, Page } from "playwright";
import { AuditLogInput, AuditStepResult, AuditLogResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskForm, searchRisk, detectToast, clickFirstEditButton, riskVisibleInPage } from "../services/riskHelpers";
import { safeClose, invalidateSession } from "../services/browserManager";
import { captureFailure } from "../utils/screenshot";

// ─── Audit Helpers (exact from old server.ts) ────────────────────────────────

async function navigateTo(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(2_000);
}

async function navigateToAuditTrail(page: Page): Promise<void> {
  console.log("[Audit] Navigating to audit trail");
  await page.goto(config.auditUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(2_500);
  await page.waitForSelector('[data-testid^="row-audit-log-"]', { timeout: 15_000 }).catch(() => {
    console.log("[Audit] No audit rows visible yet");
  });
}

async function applyAuditActionFilter(page: Page, actionName: string): Promise<void> {
  try {
    const trigger = page.getByTestId("select-filter-action");
    await trigger.waitFor({ state: "visible", timeout: 5_000 });
    await trigger.click();
    await page.waitForTimeout(500);
    const option = page.getByRole("option", { name: actionName });
    await option.waitFor({ state: "visible", timeout: 3_000 });
    await option.click();
    await page.waitForTimeout(1_500);
    console.log(`[Audit] Applied action filter: "${actionName}"`);
  } catch (err) {
    console.log(`[Audit] Failed to apply filter "${actionName}": ${(err as Error).message}`);
  }
}

async function clearAuditFilters(page: Page): Promise<void> {
  const clearBtn = page.getByTestId("button-clear-audit-filters")
    .or(page.locator('button:has-text("Clear")'))
    .or(page.locator('button:has-text("Reset")'));
  const isVisible = await clearBtn.first().isVisible().catch(() => false);
  if (isVisible) {
    await clearBtn.first().click();
    await page.waitForTimeout(1_500);
    console.log("[Audit] Filters cleared");
  }
}

async function verifyAuditEntry(
  page: Page, filterAction: string, expectedAction: string,
  expectedEntity: string, expectedSeverity: string, summaryContains: string,
): Promise<AuditStepResult> {
  const result: AuditStepResult = {
    status: "fail", filter_used: filterAction, expected_action: expectedAction,
    actual_action: null, expected_entity: expectedEntity, actual_entity: null,
    expected_severity: expectedSeverity, actual_severity: null,
    summary_contains: summaryContains, summary_found: false,
    action_match: false, entity_match: false, severity_match: false,
  };
  try {
    await navigateToAuditTrail(page);
    await clearAuditFilters(page);
    await applyAuditActionFilter(page, filterAction);

    const rows = page.locator('[data-testid^="row-audit-log-"]');
    const rowCount = await rows.count();
    console.log(`[Audit] ${filterAction}: ${rowCount} rows visible`);
    if (rowCount === 0) return result;

    for (let i = 0; i < Math.min(rowCount, 20); i++) {
      const row = rows.nth(i);
      const summaryText = await row.locator("td:nth-child(5)").textContent().catch(() => "") || "";
      if (summaryText.toLowerCase().includes(summaryContains.toLowerCase())) {
        result.summary_found = true;
        result.actual_action = (await row.locator("td:nth-child(3)").textContent().catch(() => "") || "").trim();
        const entityEl = row.locator("td:nth-child(4) .capitalize").first();
        result.actual_entity = (await entityEl.textContent().catch(() => "") || "").trim();
        result.actual_severity = (await row.locator("td:nth-child(6)").textContent().catch(() => "") || "").trim().toLowerCase();
        result.action_match = result.actual_action?.toLowerCase() === expectedAction.toLowerCase();
        result.entity_match = result.actual_entity?.toLowerCase() === expectedEntity.toLowerCase();
        result.severity_match = result.actual_severity === expectedSeverity.toLowerCase();
        result.status = (result.action_match && result.entity_match && result.severity_match) ? "pass" : "fail";
        console.log(`[Audit] ${filterAction}: action="${result.actual_action}"(${result.action_match ? "✅" : "❌"}) entity="${result.actual_entity}"(${result.entity_match ? "✅" : "❌"}) severity="${result.actual_severity}"(${result.severity_match ? "✅" : "❌"}) → ${result.status}`);
        return result;
      }
    }
    console.log(`[Audit] ${filterAction}: No row with summary containing: "${summaryContains}"`);
    return result;
  } catch (err) {
    console.log(`[Audit] ${filterAction} error: ${(err as Error).message}`);
    return result;
  }
}

async function sendChatMessage(page: Page, message: string): Promise<boolean> {
  try {
    console.log(`[Chat] Sending: "${message}"`);
    const chatBtn = page.locator('[data-testid="button-chat-widget"]');
    await chatBtn.waitFor({ state: "visible", timeout: 10_000 });
    await chatBtn.click();
    await page.waitForTimeout(1_500);
    const chatInput = page.locator('input[placeholder="Type a message..."]');
    await chatInput.waitFor({ state: "visible", timeout: 5_000 });
    await chatInput.fill(message);
    await page.waitForTimeout(500);
    const sendBtn = page.locator('button[type="submit"].rounded-full');
    await sendBtn.waitFor({ state: "visible", timeout: 5_000 });
    await sendBtn.click();
    await page.waitForTimeout(5_000);
    console.log("[Chat] Message sent");
    return true;
  } catch (err) {
    console.log(`[Chat] Failed: ${(err as Error).message}`);
    return false;
  }
}

async function performLogout(page: Page): Promise<boolean> {
  try {
    console.log("[Logout] Starting");
    const avatar = page.locator("div.rounded-full span.text-white").filter({ hasText: /^[A-Z]{1,2}$/ }).first();
    await avatar.waitFor({ state: "visible", timeout: 5_000 });
    await avatar.click();
    await page.waitForTimeout(1_000);
    const logoutBtn = page.locator('[data-testid="menu-item-logout"]');
    await logoutBtn.waitFor({ state: "visible", timeout: 5_000 });
    await logoutBtn.click();
    await page.waitForTimeout(3_000);
    const url = page.url();
    const success = url.includes("/login") || url.includes("/sign-in");
    console.log(`[Logout] ${success ? "Success" : "Failed"} — URL: ${url}`);
    return success;
  } catch (err) {
    console.log(`[Logout] Failed: ${(err as Error).message}`);
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
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15_000 }).catch(() => {});
    return !page.url().includes("/login");
  } catch { return false; }
}

async function selectCompanyForAudit(page: Page, companyName = "demo"): Promise<void> {
  try {
    const companyBtn = page.getByTestId("button-company-selector");
    await companyBtn.waitFor({ state: "visible", timeout: 10_000 });
    await companyBtn.click();
    const option = page.locator('[role="menuitem"]').filter({ hasText: companyName }).first();
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click();
    await page.waitForTimeout(2_000);
  } catch {}
}

// ─── Main Function ───────────────────────────────────────────────────────────

export async function performAuditLog(input: AuditLogInput): Promise<AuditLogResult> {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 15);
  const riskTitle = `AuditTest_${timestamp}`;
  const chatMsg = input.chat_message || "audit test message";
  const result: AuditLogResult = {
    status: "error", message: "", username: input.username, risk_title: riskTitle,
    steps_summary: "", total_steps: 6, passed: 0, failed: 0,
    steps: {} as Record<string, AuditStepResult>, screenshots: { failure: null },
  };
  let context: BrowserContext | null = null;

  try {
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // ACTION 1: Login (already done)
    console.log("[AuditLog] === ACTION 1: Login ===");

    // ACTION 2: Create Risk
    console.log("[AuditLog] === ACTION 2: Create Risk ===");
    await navigateTo(page, config.dashboardUrl);
    await page.waitForTimeout(1_500);
    const addBtn = page.getByTestId("button-add-risk");
    await addBtn.waitFor({ state: "visible", timeout: 10_000 });
    await addBtn.click();
    await page.getByTestId("input-risk-title").waitFor({ state: "visible", timeout: 5_000 });
    await fillRiskForm(page, { title: riskTitle, description: "Audit log test risk", category: "Technical", status: "Open", impact: "3 - Medium", likelihood: "3 - Medium" });
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await saveBtn.click();
    const createToast = await detectToast(page, "Risk created successfully");
    console.log(`[AuditLog] Create: ${createToast.match ? "OK" : "FAIL"}`);
    await page.waitForTimeout(2_000);

    // ACTION 3: Edit Risk
    console.log("[AuditLog] === ACTION 3: Edit Risk ===");
    await navigateTo(page, config.dashboardUrl);
    await page.waitForTimeout(1_500);
    await searchRisk(page, riskTitle);
    if (await clickFirstEditButton(page)) {
      await fillRiskForm(page, { description: "Updated by audit log test" });
      const updateBtn = page.getByTestId("button-save-risk");
      await updateBtn.waitFor({ state: "visible", timeout: 5_000 });
      await updateBtn.click();
      const editToast = await detectToast(page, "Risk updated successfully");
      console.log(`[AuditLog] Edit: ${editToast.match ? "OK" : "FAIL"}`);
    } else { console.log("[AuditLog] Edit: SKIP — edit button not found"); }
    await page.waitForTimeout(2_000);

    // ACTION 4: Delete Risk
    console.log("[AuditLog] === ACTION 4: Delete Risk ===");
    await navigateTo(page, config.tableUrl);
    await page.waitForTimeout(1_500);
    await searchRisk(page, riskTitle);
    const riskRow = page.locator("text=" + riskTitle).first();
    try {
      await riskRow.waitFor({ state: "visible", timeout: 5_000 });
      await riskRow.click();
      await page.waitForTimeout(1_500);
      const deleteBtn = page.locator('[data-testid^="button-delete-risk-"]').first();
      await deleteBtn.waitFor({ state: "visible", timeout: 5_000 });
      await deleteBtn.click();
      const deleteToast = await detectToast(page, "Risk deleted successfully");
      console.log(`[AuditLog] Delete: ${deleteToast.match ? "OK" : "FAIL"}`);
    } catch { console.log("[AuditLog] Delete: SKIP — risk not found in table"); }
    await page.waitForTimeout(2_000);

    // ACTION 5: Chat Message
    console.log("[AuditLog] === ACTION 5: Chat Message ===");
    await navigateTo(page, config.dashboardUrl);
    await page.waitForTimeout(1_500);
    const chatOk = await sendChatMessage(page, chatMsg);
    console.log(`[AuditLog] Chat: ${chatOk ? "OK" : "FAIL"}`);
    await page.waitForTimeout(2_000);

    // ACTION 6: Logout
    console.log("[AuditLog] === ACTION 6: Logout ===");
    const logoutOk = await performLogout(page);
    console.log(`[AuditLog] Logout: ${logoutOk ? "OK" : "FAIL"}`);

    // RE-LOGIN for verification
    console.log("[AuditLog] === RE-LOGIN for verification ===");
    invalidateSession();
    const reloginOk = await performFreshLogin(page, input.username, input.password);
    if (!reloginOk) {
      result.status = "error"; result.message = "Re-login failed for audit verification";
      result.screenshots.failure = await captureFailure(context, "audit_relogin_fail");
      return result;
    }
    await selectCompanyForAudit(page, "demo");
    await page.waitForTimeout(2_000);

    // VERIFICATION PHASE
    console.log("[AuditLog] === VERIFICATION PHASE ===");
    result.steps.login = await verifyAuditEntry(page, "Login", "Login", "Session", "Info", input.username);
    result.steps.create_risk = await verifyAuditEntry(page, "Create", "Create", "Risk", "Info", riskTitle);
    result.steps.edit_risk = await verifyAuditEntry(page, "Update", "Update", "Risk", "Info", riskTitle);
    result.steps.delete_risk = await verifyAuditEntry(page, "Delete", "Delete", "Risk", "Warning", riskTitle);
    result.steps.chat_message = await verifyAuditEntry(page, "Message", "Message", "Chat Message", "Info", "user message");
    result.steps.logout = await verifyAuditEntry(page, "Logout", "Logout", "Session", "Info", "User logged out");

    // Calculate results
    const stepKeys = ["login", "create_risk", "edit_risk", "delete_risk", "chat_message", "logout"];
    const stepLabels = ["Login", "Create", "Update", "Delete", "Message", "Logout"];
    result.passed = stepKeys.filter((k) => result.steps[k]?.status === "pass").length;
    result.failed = result.total_steps - result.passed;
    result.status = result.failed === 0 ? "pass" : "fail";
    result.steps_summary = stepLabels.map((label, i) => {
      const s = result.steps[stepKeys[i]];
      return `${label}:${s?.status === "pass" ? "✅" : "❌"}`;
    }).join(" ");
    result.message = result.steps_summary;

    if (result.failed > 0 && !result.screenshots.failure) {
      result.screenshots.failure = await captureFailure(context, "audit_verification_fail");
    }
    console.log(`[AuditLog] === RESULT: ${result.status.toUpperCase()} (${result.passed}/${result.total_steps}) ===`);
    console.log(`[AuditLog] ${result.steps_summary}`);
    return result;
  } catch (err) {
    result.screenshots.failure = await captureFailure(context, "audit_error");
    result.status = "error"; result.message = (err as Error).message;
    console.log(`[AuditLog] Error: ${result.message}`);
    return result;
  } finally { await safeClose(context); }
}
