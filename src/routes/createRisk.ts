// ─── Create Risk Route ────────────────────────────────────────────────────────
// POST /create-risk — Creates a risk and validates with 4-layer validation

import { Page, BrowserContext } from "playwright";
import { RiskInput, RiskResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskForm } from "../services/riskHelpers";
import { validateRiskAction } from "../services/validationService";
import { safeClose } from "../services/browserManager";
import { captureFailure } from "../utils/screenshot";

export async function performCreateRisk(input: RiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;

  const result: RiskResult = {
    status: "error",
    message: "",
    username: input.username,
    riskTitle: input.title,
    assertion: { expected: "All validations pass", actual: null, match: false },
    checks: { toast_confirmed: false, dashboard_visible: false, table_search: false, fields_valid: false },
    failure_type: null,
    field_mismatches: [],
    table_data: null,
    screenshots: {},
  };

  try {
    // Step 1: Login
    console.log(`[Create] Starting for "${input.title}" by ${input.username}`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Step 2: Navigate to dashboard and open create form
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

const createBtn = page.getByTestId("button-add-risk");
    await createBtn.waitFor({ state: "visible", timeout: 10_000 });
    await createBtn.click();
    await page.waitForTimeout(1000);

    // Step 3: Fill form
    await fillRiskForm(page, {
      title: input.title,
      description: input.description,
      category: input.category,
      status: input.status,
      impact: input.impact,
      likelihood: input.likelihood,
      owner: input.owner,
      dueDate: input.dueDate,
      potentialCost: input.potentialCost,
      mitigationPlan: input.mitigationPlan,
    });

    // Step 4: Submit
    const submitBtn = page.getByTestId("btn-submit-risk");
    await submitBtn.waitFor({ state: "visible", timeout: 5_000 });
    await submitBtn.click();
    console.log("[Create] Form submitted — starting validation");

    // Step 5: Centralized 4-layer validation
    const validation = await validateRiskAction(page, input, "create");

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

    // Determine final status
    if (!validation.failure_type) {
      result.status = "success";
      result.message = "Risk created — all validations passed";
      result.assertion = { expected: "All validations pass", actual: "All passed", match: true };
    } else {
      result.status = "failed";
      result.message = `Risk create validation failed: ${validation.failure_type}`;
      result.assertion = {
        expected: "All validations pass",
        actual: validation.failure_type,
        match: false,
      };
      result.screenshots.failure = await captureFailure(context, "create_risk_fail");
    }

    // Human-readable summary
    const checks = result.checks;
    result.message += ` | Toast:${checks.toast_confirmed ? "✓" : "✗"} Dashboard:${checks.dashboard_visible ? "✓" : "✗"} Table:${checks.table_search ? "✓" : "✗"} Fields:${checks.fields_valid ? "✓" : "✗"}`;

    console.log(`[Create] Result: ${result.status} — ${result.message}`);
    return result;
  } catch (err) {
    result.status = "error";
    result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "create_risk_error");
    console.error(`[Create] Error: ${result.message}`);
    return result;
  } finally {
    await safeClose(context);
  }
}
