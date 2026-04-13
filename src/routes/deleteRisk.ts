// ─── Delete Risk Route ────────────────────────────────────────────────────────
// POST /delete-risk — Deletes a risk and validates removal

import { BrowserContext } from "playwright";
import { DeleteRiskInput, RiskResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { validateRiskAction } from "../services/validationService";
import { safeClose } from "../services/browserManager";
import { captureFailure } from "../utils/screenshot";

export async function performDeleteRisk(input: DeleteRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;

  const result: RiskResult = {
    status: "error",
    message: "",
    username: input.username,
    riskTitle: input.searchTitle,
    assertion: { expected: "Risk deleted successfully", actual: null, match: false },
    checks: { toast_confirmed: false, dashboard_visible: false, table_search: false, fields_valid: false },
    failure_type: null,
    field_mismatches: [],
    table_data: null,
    screenshots: {},
  };

  try {
    console.log(`[Delete] Starting — "${input.searchTitle}" by ${input.username}`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Navigate to table
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    // Find and click delete
    const found = await page.evaluate((searchTitle) => {
      const rows = document.querySelectorAll("tr");
      for (const row of rows) {
        if (row.textContent?.includes(searchTitle)) {
          const deleteBtn = row.querySelector('[data-testid*="delete"], button[aria-label*="delete"]');
          if (deleteBtn) {
            (deleteBtn as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    }, input.searchTitle);

    if (!found) {
      result.status = "failed";
      result.message = `Risk "${input.searchTitle}" not found`;
      result.failure_type = "NOT_FOUND_TABLE";
      return result;
    }

    await page.waitForTimeout(1000);

    // Confirm delete dialog
    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Delete"), [data-testid="confirm-delete"]');
    const hasConfirm = await confirmBtn.isVisible().catch(() => false);
    if (hasConfirm) {
      await confirmBtn.click();
      console.log("[Delete] Confirmed deletion");
    }

    // Validate using centralized service
    const validation = await validateRiskAction(page, { title: input.searchTitle }, "delete");

    result.checks = {
      toast_confirmed: validation.toast_confirmed,
      dashboard_visible: validation.dashboard_visible,
      table_search: validation.table_search,
      fields_valid: validation.fields_valid,
    };
    result.failure_type = validation.failure_type;

    if (!validation.failure_type) {
      result.status = "success";
      result.message = "Risk deleted — all validations passed";
      result.assertion = { expected: "Risk deleted successfully", actual: "Deleted and verified", match: true };
    } else {
      result.status = "failed";
      result.message = `Delete validation failed: ${validation.failure_type}`;
      result.assertion = { expected: "Risk deleted successfully", actual: validation.failure_type, match: false };
      result.screenshots.failure = await captureFailure(context, "delete_risk_fail");
    }

    console.log(`[Delete] Result: ${result.status} — ${result.message}`);
    return result;
  } catch (err) {
    result.status = "error";
    result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "delete_risk_error");
    return result;
  } finally {
    await safeClose(context);
  }
}
