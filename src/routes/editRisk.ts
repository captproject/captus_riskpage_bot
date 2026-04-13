// ─── Edit Risk Route — matches old server.ts exactly ──────────────────────────
import { BrowserContext } from "playwright";
import { EditRiskInput, RiskResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskForm, searchRisk, clickFirstEditButton, detectToast, riskVisibleInPage } from "../services/riskHelpers";
import { validateRiskAction } from "../services/validationService";
import { safeClose } from "../services/browserManager";
import { captureFailure, uploadScreenshot } from "../utils/screenshot";

export async function performEditRisk(input: EditRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const editedTitle = input.newTitle || input.searchTitle;
  const result: RiskResult = {
    status: "error", message: "", username: input.username, riskTitle: editedTitle,
    assertion: { expected: "All validations pass", actual: null, match: false },
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

    // Click edit button on heatmap
    if (!(await clickFirstEditButton(page))) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "edit_btn_not_found");
      result.status = "failed";
      result.message = `Edit button not found for: "${input.searchTitle}"`;
      result.failure_type = "EDIT_BUTTON_NOT_FOUND";
      return result;
    }

    // Fill form with new values
    await fillRiskForm(page, {
      title: input.newTitle, description: input.newDescription,
      category: input.newCategory, status: input.newStatus,
      impact: input.newImpact, likelihood: input.newLikelihood,
      owner: input.newOwner, dueDate: input.newDueDate,
      potentialCost: input.newPotentialCost, mitigationPlan: input.newMitigationPlan,
    });

    // Click save
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await saveBtn.click();
    console.log("[Edit] Form submitted — starting validation");

    // Centralized 4-layer validation
    const validation = await validateRiskAction(page, {
      title: editedTitle,
      category: input.newCategory,
      status: input.newStatus,
      owner: input.newOwner,
      potentialCost: input.newPotentialCost,
    }, "edit");

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
      result.message = "Risk edited — all validations passed";
      result.assertion = { expected: "All validations pass", actual: "All passed", match: true };
    } else {
      result.status = "failed";
      result.message = `Risk edit validation failed: ${validation.failure_type}`;
      result.assertion = { expected: "All validations pass", actual: validation.failure_type, match: false };
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
