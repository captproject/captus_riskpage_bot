// ─── Audit Log Route ──────────────────────────────────────────────────────────
// POST /audit-log
// Performs 6 actions (Login, Create, Update, Delete, Message, Logout)
// Then verifies each action's audit trail entry using filters.

import { BrowserContext, Page } from "playwright";
import { AuditLogInput, AuditStepResult, AuditLogResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskForm, selectDropdown, detectToast } from "../services/riskHelpers";
import { safeClose } from "../services/browserManager";
import { captureFailure } from "../utils/screenshot";

// ─── Audit Trail Helpers ─────────────────────────────────────────────────────

async function navigateToAuditTrail(page: Page): Promise<void> {
  console.log("[Audit] Navigating to audit trail");
  await page.goto(config.auditUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(2500);
  await page.waitForSelector('[data-testid^="row-audit-log-"]', { timeout: 15_000 }).catch(() => {
    console.log("[Audit] No audit rows visible yet");
  });
}

async function filterAuditByAction(page: Page, actionName: string): Promise<void> {
  try {
    const filterTrigger = page.getByTestId("select-filter-action");
    const isVisible = await filterTrigger.isVisible().catch(() => false);
    if (isVisible) {
      await filterTrigger.click();
      await page.waitForTimeout(500);
      await page.getByRole("option", { name: actionName }).click();
      await page.waitForTimeout(1500);
    }
  } catch {
    console.log(`[Audit] Could not filter by "${actionName}"`);
  }
}

async function readTopAuditRow(page: Page): Promise<{
  action: string | null;
  entity: string | null;
  severity: string | null;
  summary: string | null;
}> {
  return page.evaluate(() => {
    const firstRow = document.querySelector('[data-testid^="row-audit-log-"]');
    if (!firstRow) return { action: null, entity: null, severity: null, summary: null };

    const cells = firstRow.querySelectorAll("td");
    return {
      action: cells[1]?.textContent?.trim() || null,
      entity: cells[2]?.textContent?.trim() || null,
      severity: cells[3]?.textContent?.trim() || null,
      summary: cells[4]?.textContent?.trim() || null,
    };
  });
}

async function clearAuditFilter(page: Page): Promise<void> {
  try {
    const clearBtn = page.locator('[data-testid="btn-clear-filters"], button:has-text("Clear")');
    const isVisible = await clearBtn.isVisible().catch(() => false);
    if (isVisible) {
      await clearBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    // Refresh page to clear
    await page.goto(config.auditUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);
  }
}

// ─── Step Definitions ────────────────────────────────────────────────────────

interface AuditVerifyStep {
  key: string;
  label: string;
  filterAction: string;
  expectedAction: string;
  expectedEntity: string;
  expectedSeverity: string;
  summaryContains: string;
}

const AUDIT_STEPS: AuditVerifyStep[] = [
  { key: "login", label: "Login", filterAction: "Login", expectedAction: "Login", expectedEntity: "Session", expectedSeverity: "Info", summaryContains: "logged in" },
  { key: "create_risk", label: "Create", filterAction: "Create", expectedAction: "Create", expectedEntity: "Risk", expectedSeverity: "Info", summaryContains: "risk" },
  { key: "update_risk", label: "Update", filterAction: "Update", expectedAction: "Update", expectedEntity: "Risk", expectedSeverity: "Info", summaryContains: "risk" },
  { key: "delete_risk", label: "Delete", filterAction: "Delete", expectedAction: "Delete", expectedEntity: "Risk", expectedSeverity: "Warning", summaryContains: "risk" },
  { key: "chat_message", label: "Message", filterAction: "Message", expectedAction: "Message", expectedEntity: "Chat Message", expectedSeverity: "Info", summaryContains: "message" },
  { key: "logout", label: "Logout", filterAction: "Logout", expectedAction: "Logout", expectedEntity: "Session", expectedSeverity: "Info", summaryContains: "logged out" },
];

// ─── Main Function ───────────────────────────────────────────────────────────

export async function performAuditLog(input: AuditLogInput): Promise<AuditLogResult> {
  let context: BrowserContext | null = null;

  const riskTitle = input.risk_title || `AuditTest-${Date.now()}`;
  const result: AuditLogResult = {
    status: "error",
    message: "",
    username: input.username,
    risk_title: riskTitle,
    total_steps: 6,
    passed: 0,
    failed: 0,
    steps_summary: "",
    steps: {},
    screenshots: {},
  };

  try {
    console.log(`[AuditLog] Starting 6-step audit verification for ${input.username}`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // ── Action 1: Login (already done via createContextAndLogin) ──
    console.log("[AuditLog] Step 1: Login — already completed");

    // ── Action 2: Create Risk ──
    console.log("[AuditLog] Step 2: Creating risk");
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    const createBtn = page.getByTestId("btn-create-risk");
    await createBtn.waitFor({ state: "visible", timeout: 10_000 });
    await createBtn.click();
    await page.waitForTimeout(1000);

    await fillRiskForm(page, {
      title: riskTitle,
      description: input.risk_description || "Audit test risk",
      category: input.risk_category || "Technical",
      impact: input.risk_impact || "3 - Medium",
      likelihood: input.risk_likelihood || "3 - Medium",
    });

    const submitBtn = page.getByTestId("btn-submit-risk");
    await submitBtn.click();
    await page.waitForTimeout(2000);
    await detectToast(page, "successfully");

    // ── Action 3: Update Risk ──
    console.log("[AuditLog] Step 3: Updating risk");
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    await page.evaluate((title) => {
      const rows = document.querySelectorAll("tr");
      for (const row of rows) {
        if (row.textContent?.includes(title)) {
          const editBtn = row.querySelector('[data-testid*="edit"], button[aria-label*="edit"]');
          if (editBtn) { (editBtn as HTMLElement).click(); break; }
        }
      }
    }, riskTitle);
    await page.waitForTimeout(1500);

    await fillRiskForm(page, { description: "Updated by audit test" });
    const updateSubmit = page.getByTestId("btn-submit-risk");
    await updateSubmit.click();
    await page.waitForTimeout(2000);
    await detectToast(page, "successfully");

    // ── Action 4: Delete Risk ──
    console.log("[AuditLog] Step 4: Deleting risk");
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    await page.evaluate((title) => {
      const rows = document.querySelectorAll("tr");
      for (const row of rows) {
        if (row.textContent?.includes(title)) {
          const deleteBtn = row.querySelector('[data-testid*="delete"], button[aria-label*="delete"]');
          if (deleteBtn) { (deleteBtn as HTMLElement).click(); break; }
        }
      }
    }, riskTitle);
    await page.waitForTimeout(1000);

    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Delete"), [data-testid="confirm-delete"]');
    const hasConfirm = await confirmBtn.isVisible().catch(() => false);
    if (hasConfirm) {
      await confirmBtn.click();
      await page.waitForTimeout(2000);
    }
    await detectToast(page, "successfully");

    // ── Action 5: Send Chat Message ──
    console.log("[AuditLog] Step 5: Sending chat message");
    try {
      const chatInput = page.locator('[data-testid="chat-input"], textarea[placeholder*="message"], input[placeholder*="message"]');
      const chatVisible = await chatInput.isVisible().catch(() => false);
      if (chatVisible) {
        await chatInput.fill(input.chat_message || "Audit test message");
        const sendBtn = page.locator('[data-testid="btn-send-message"], button[aria-label*="send"]');
        await sendBtn.click();
        await page.waitForTimeout(2000);
      } else {
        console.log("[AuditLog] Chat input not found — skipping");
      }
    } catch {
      console.log("[AuditLog] Chat message step skipped");
    }

    // ── Action 6: Logout ──
    console.log("[AuditLog] Step 6: Logging out");
    try {
      const logoutBtn = page.locator('[data-testid="btn-logout"], button:has-text("Logout"), button:has-text("Sign out")');
      const logoutVisible = await logoutBtn.isVisible().catch(() => false);
      if (logoutVisible) {
        await logoutBtn.click();
        await page.waitForTimeout(3000);
      }
    } catch {
      console.log("[AuditLog] Logout step skipped");
    }

    // ── Verification Phase: Re-login and check audit trail ──
    console.log("[AuditLog] Re-logging in to verify audit trail");
    const verifySession = await createContextAndLogin(input.username, input.password);
    await safeClose(context);
    context = verifySession.context;
    const verifyPage = verifySession.page;

    await navigateToAuditTrail(verifyPage);

    // Verify each step
    for (const step of AUDIT_STEPS) {
      console.log(`[AuditLog] Verifying: ${step.label}`);
      await clearAuditFilter(verifyPage);
      await filterAuditByAction(verifyPage, step.filterAction);

      const row = await readTopAuditRow(verifyPage);

      const stepResult: AuditStepResult = {
        status: "fail",
        filter_used: step.filterAction,
        expected_action: step.expectedAction,
        actual_action: row.action,
        expected_entity: step.expectedEntity,
        actual_entity: row.entity,
        expected_severity: step.expectedSeverity,
        actual_severity: row.severity,
        summary_contains: step.summaryContains,
        summary_found: row.summary?.toLowerCase().includes(step.summaryContains.toLowerCase()) || false,
        action_match: row.action?.toLowerCase() === step.expectedAction.toLowerCase(),
        entity_match: row.entity?.toLowerCase() === step.expectedEntity.toLowerCase(),
        severity_match: row.severity?.toLowerCase() === step.expectedSeverity.toLowerCase(),
      };

      stepResult.status = (stepResult.action_match && stepResult.entity_match && stepResult.severity_match)
        ? "pass" : "fail";

      result.steps[step.key] = stepResult;

      if (stepResult.status === "pass") result.passed++;
      else result.failed++;

      console.log(`[AuditLog] ${step.label}: ${stepResult.status} (action: ${row.action}, entity: ${row.entity})`);
    }

    // Final assessment
    result.status = result.failed === 0 ? "pass" : "fail";
    const stepLabels = ["Login", "Create", "Update", "Delete", "Message", "Logout"];
    const stepKeys = ["login", "create_risk", "update_risk", "delete_risk", "chat_message", "logout"];
    result.steps_summary = stepLabels.map((label, i) => {
      const s = result.steps[stepKeys[i]];
      return `${label}:${s?.status === "pass" ? "✅" : "❌"}`;
    }).join(" ");
    result.message = result.steps_summary;

    if (result.failed > 0) {
      result.screenshots.failure = await captureFailure(context, "audit_verification_fail");
    }

    console.log(`[AuditLog] Result: ${result.status} (${result.passed}/${result.total_steps}) — ${result.message}`);
    return result;
  } catch (err) {
    result.status = "error";
    result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "audit_error");
    return result;
  } finally {
    await safeClose(context);
  }
}
