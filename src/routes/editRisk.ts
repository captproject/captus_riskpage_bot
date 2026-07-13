// ─── Edit Risk Route — risk detail view flow ──────────────────────────────────
// UI change 2026-07-08: the per-card edit button (button-edit-heatmap-risk-*)
// was removed. Clicking the risk card now opens an editable detail view with
// "Save Risk" (button-save-risk-detail) and "Close" (button-close-risk-detail).
import { BrowserContext } from "playwright";
import { EditRiskInput, RiskResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskDetailForm, searchRisk, openRiskDetail, saveRiskDetail, closeRiskDetail } from "../services/riskHelpers";
import { validateRiskAction } from "../services/validationService";
import { safeClose } from "../services/browserManager";
import { captureFailure, uploadScreenshot } from "../utils/screenshot";

export async function performEditRisk(input: EditRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const editedTitle = input.newTitle || input.searchTitle;
  const result: RiskResult = {
    status: "error", message: "", username: input.username, riskTitle: editedTitle,
    assertion: { expected: "Risk updated successfully", actual: null, match: false },
    checks: { toast_confirmed: false, dashboard_visible: false, table_search: false, fields_valid: false },
    failure_type: null, field_mismatches: [], table_data: null, screenshots: {},
  };

  try {
    console.log(`[Edit] Starting — search: "${input.searchTitle}", user: ${input.username}`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Navigate to dashboard and search for risk
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2_000);
    await searchRisk(page, input.searchTitle);

    // Open the risk detail view by clicking the risk card (replaces removed edit button)
    if (!(await openRiskDetail(page, input.searchTitle))) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "risk_detail_not_opened");
      result.status = "failed";
      result.message = `Risk detail view did not open for: "${input.searchTitle}"`;
      result.failure_type = "RISK_DETAIL_NOT_OPENED";
      return result;
    }

    // Fill fields in the detail view with new values
    await fillRiskDetailForm(page, {
      title: input.newTitle, description: input.newDescription,
      category: input.newCategory, status: input.newStatus,
      impact: input.newImpact, likelihood: input.newLikelihood,
      owner: input.newOwner, dueDate: input.newDueDate,
      potentialCost: input.newPotentialCost, mitigationPlan: input.newMitigationPlan,
    });

    // Click "Save Risk" — only mounts after a change is committed (Tab-blur handled inside)
    if (!(await saveRiskDetail(page))) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "save_risk_btn_not_found");
      result.status = "failed";
      result.message = `Save Risk button did not appear for: "${input.searchTitle}"`;
      result.failure_type = "SAVE_BUTTON_NOT_FOUND";
      return result;
    }
    console.log("[Edit] Save Risk submitted — closing detail view");

    // Let the save request fire, then close the detail view.
    // The sonner toaster is global, so the success toast survives the panel close
    // and is picked up by validation Layer 1 below.
    await page.waitForTimeout(500);
    await closeRiskDetail(page);

    // Centralized 4-layer validation with specific toast message
    const validation = await validateRiskAction(page, {
      title: editedTitle,
      category: input.newCategory,
      status: input.newStatus,
      owner: input.newOwner,
      potentialCost: input.newPotentialCost,
    }, "edit", "Risk updated successfully");

    result.checks = {
      toast_confirmed: validation.toast_confirmed,
      dashboard_visible: validation.dashboard_visible,
      table_search: validation.table_search,
      fields_valid: validation.fields_valid,
    };
    result.failure_type = validation.failure_type;
    result.field_mismatches = validation.field_mismatches;
    result.table_data = validation.table_data;

    if (!validation.failure_type) {
      result.status = "success";
      result.message = "Risk updated successfully";
      result.assertion = { expected: "Risk updated successfully", actual: "Risk updated successfully", match: true };
    } else {
      result.status = "failed";
      result.message = `Risk edit validation failed: ${validation.failure_type}`;
      result.assertion = { expected: "Risk updated successfully", actual: validation.failure_type, match: false };
      result.screenshots.failure = await captureFailure(context, "edit_risk_fail");
    }

    const c = result.checks;
    result.message += ` | Toast:${c.toast_confirmed ? "✓" : "✗"} Dashboard:${c.dashboard_visible ? "✓" : "✗"} Table:${c.table_search ? "✓" : "✗"} Fields:${c.fields_valid ? "✓" : "✗"}`;
    console.log(`[Edit] Result: ${result.status} — ${result.message}`);
    return result;
  } catch (err) {
    result.status = "error"; result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "edit_error");
    return result;
  } finally { await safeClose(context); }
}