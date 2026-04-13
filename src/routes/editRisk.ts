// ─── Edit Risk Route ──────────────────────────────────────────────────────────
// POST /edit-risk — Edits a risk and validates with 4-layer validation

import { BrowserContext } from "playwright";
import { EditRiskInput, RiskResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskForm, searchRisk } from "../services/riskHelpers";
import { validateRiskAction } from "../services/validationService";
import { safeClose } from "../services/browserManager";
import { captureFailure } from "../utils/screenshot";

export async function performEditRisk(input: EditRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;

  const editedTitle = input.newTitle || input.searchTitle;
  const result: RiskResult = {
    status: "error",
    message: "",
    username: input.username,
    riskTitle: editedTitle,
    assertion: { expected: "All validations pass", actual: null, match: false },
    checks: { toast_confirmed: false, dashboard_visible: false, table_search: false, fields_valid: false },
    failure_type: null,
    field_mismatches: [],
    table_data: null,
    screenshots: {},
  };

  try {
    console.log(`[Edit] Starting — search: "${input.searchTitle}", user: ${input.username}`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Navigate to table
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    // Find and click the risk row to edit
    const found = await page.evaluate((searchTitle) => {
      const rows = document.querySelectorAll("tr");
      for (const row of rows) {
        if (row.textContent?.includes(searchTitle)) {
          const editBtn = row.querySelector('[data-testid*="edit"], button[aria-label*="edit"]');
          if (editBtn) {
            (editBtn as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    }, input.searchTitle);

    if (!found) {
      result.status = "failed";
      result.message = `Risk "${input.searchTitle}" not found in table`;
      result.failure_type = "NOT_FOUND_TABLE";
      result.screenshots.failure = await captureFailure(context, "edit_risk_not_found");
      return result;
    }

    await page.waitForTimeout(1500);

    // Fill edit form with new values
    await fillRiskForm(page, {
      title: input.newTitle,
      description: input.newDescription,
      category: input.newCategory,
      status: input.newStatus,
      impact: input.newImpact,
      likelihood: input.newLikelihood,
      owner: input.newOwner,
      dueDate: input.newDueDate,
      potentialCost: input.newPotentialCost,
      mitigationPlan: input.newMitigationPlan,
    });

    // Submit edit
    const submitBtn = page.getByTestId("btn-submit-risk");
    await submitBtn.waitFor({ state: "visible", timeout: 5_000 });
    await submitBtn.click();
    console.log("[Edit] Form submitted — starting validation");

    // Centralized 4-layer validation
    const validation = await validateRiskAction(
      page,
      {
        title: editedTitle,
        category: input.newCategory,
        status: input.newStatus,
        owner: input.newOwner,
        potentialCost: input.newPotentialCost,
      },
      "edit"
    );

    // Map validation to result
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

    const checks = result.checks;
    result.message += ` | Toast:${checks.toast_confirmed ? "✓" : "✗"} Dashboard:${checks.dashboard_visible ? "✓" : "✗"} Table:${checks.table_search ? "✓" : "✗"} Fields:${checks.fields_valid ? "✓" : "✗"}`;

    console.log(`[Edit] Result: ${result.status} — ${result.message}`);
    return result;
  } catch (err) {
    result.status = "error";
    result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "edit_risk_error");
    return result;
  } finally {
    await safeClose(context);
  }
}
