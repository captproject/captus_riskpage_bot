// ─── Status Workflow Route ─────────────────────────────────────────────────────
// POST /risk-status-workflow
// Creates ONE risk, transitions through Open → In Review → Mitigated → Closed
// All in a single browser session. Validates each transition.

import { BrowserContext, Page } from "playwright";
import { StatusWorkflowInput, StepResult, StatusWorkflowResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskForm, selectDropdown, detectToast } from "../services/riskHelpers";
import { safeClose } from "../services/browserManager";
import { captureFailure, uploadScreenshot } from "../utils/screenshot";

const STATUS_FLOW = ["Open", "In Review", "Mitigated", "Closed"];

async function verifyRiskStatus(page: Page, title: string, expectedStatus: string): Promise<StepResult> {
  const step: StepResult = {
    step: expectedStatus,
    status: "fail",
    expected_status: expectedStatus,
    actual_status: null,
    version: null,
  };

  try {
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    const rowData = await page.evaluate((searchTitle) => {
      const rows = document.querySelectorAll("tr");
      for (const row of rows) {
        if (row.textContent?.includes(searchTitle)) {
          const cells = row.querySelectorAll("td");
          return { status: cells[2]?.textContent?.trim() || "" };
        }
      }
      return null;
    }, title);

    if (rowData) {
      step.actual_status = rowData.status;
      step.status = rowData.status.toLowerCase() === expectedStatus.toLowerCase() ? "pass" : "fail";
    }
  } catch (err) {
    console.error(`[StatusWF] Verify error: ${(err as Error).message}`);
  }

  console.log(`[StatusWF] Verify ${expectedStatus}: ${step.status} (actual: ${step.actual_status})`);
  return step;
}

async function updateRiskStatus(page: Page, title: string, newStatus: string): Promise<boolean> {
  try {
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    const found = await page.evaluate((searchTitle) => {
      const rows = document.querySelectorAll("tr");
      for (const row of rows) {
        if (row.textContent?.includes(searchTitle)) {
          const editBtn = row.querySelector('[data-testid*="edit"], button[aria-label*="edit"]');
          if (editBtn) { (editBtn as HTMLElement).click(); return true; }
        }
      }
      return false;
    }, title);

    if (!found) return false;
    await page.waitForTimeout(1500);

    await selectDropdown(page, "select-risk-status", newStatus);
    const submitBtn = page.getByTestId("btn-submit-risk");
    await submitBtn.click();
    await page.waitForTimeout(2000);

    const toast = await detectToast(page, "successfully");
    return toast.detected;
  } catch (err) {
    console.error(`[StatusWF] Update error: ${(err as Error).message}`);
    return false;
  }
}

export async function performStatusWorkflow(input: StatusWorkflowInput): Promise<StatusWorkflowResult> {
  let context: BrowserContext | null = null;

  const result: StatusWorkflowResult = {
    status: "error",
    message: "",
    riskTitle: input.title,
    assertion: { expected: "All 4 status transitions pass", actual: "", match: false },
    steps: [],
    versions_created: 0,
    screenshots: { final_status: null, failure: null },
  };

  try {
    console.log(`[StatusWF] Starting for "${input.title}"`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Step 1: Create risk (starts as Open)
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    const createBtn = page.getByTestId("btn-create-risk");
    await createBtn.waitFor({ state: "visible", timeout: 10_000 });
    await createBtn.click();
    await page.waitForTimeout(1000);

    await fillRiskForm(page, {
      title: input.title, description: input.description, category: input.category,
      impact: input.impact, likelihood: input.likelihood, owner: input.owner,
      dueDate: input.dueDate, potentialCost: input.potentialCost, mitigationPlan: input.mitigationPlan,
    });

    const submitBtn = page.getByTestId("btn-submit-risk");
    await submitBtn.click();
    await page.waitForTimeout(2000);

    const createToast = await detectToast(page, "successfully");
    if (!createToast.detected) {
      result.status = "fail";
      result.message = "Failed to create risk";
      result.screenshots.failure = await captureFailure(context, "status_wf_create_fail");
      return result;
    }

    // Step 2: Verify Open
    const openStep = await verifyRiskStatus(page, input.title, "Open");
    result.steps.push(openStep);

    // Step 3-5: Transition through remaining statuses
    for (let i = 1; i < STATUS_FLOW.length; i++) {
      const newStatus = STATUS_FLOW[i];
      console.log(`[StatusWF] Transitioning to ${newStatus}`);

      const updated = await updateRiskStatus(page, input.title, newStatus);
      if (!updated) {
        result.steps.push({ step: newStatus, status: "fail", expected_status: newStatus, actual_status: null, version: null });
        continue;
      }

      const verifyStep = await verifyRiskStatus(page, input.title, newStatus);
      result.steps.push(verifyStep);
      if (verifyStep.status === "pass") result.versions_created++;
    }

    // Final assessment
    const allPassed = result.steps.every((s) => s.status === "pass");
    result.status = allPassed ? "pass" : "fail";
    result.assertion = {
      expected: "All 4 status transitions pass",
      actual: `${result.steps.filter((s) => s.status === "pass").length}/4 passed`,
      match: allPassed,
    };
    result.message = result.steps.map((s) => `${s.step}:${s.status === "pass" ? "✅" : "❌"}`).join(" ");

    if (!allPassed) {
      result.screenshots.failure = await captureFailure(context, "status_wf_fail");
    }

    console.log(`[StatusWF] Result: ${result.status} — ${result.message}`);
    return result;
  } catch (err) {
    result.status = "error";
    result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "status_wf_error");
    return result;
  } finally {
    await safeClose(context);
  }
}
