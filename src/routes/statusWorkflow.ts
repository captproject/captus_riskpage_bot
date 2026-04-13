// ─── Status Workflow Route — matches old server.ts exactly ────────────────────
import { BrowserContext, Page } from "playwright";
import { StatusWorkflowInput, StepResult, StatusWorkflowResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskForm, selectDropdown, detectToast, searchRisk, clickFirstEditButton, riskVisibleInPage } from "../services/riskHelpers";
import { safeClose } from "../services/browserManager";
import { captureFailure, uploadScreenshot } from "../utils/screenshot";

const KNOWN_STATUSES = ["Open", "In Review", "Mitigated", "Closed"];

async function navigateTo(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(2_000);
}

async function verifyRiskStatus(page: Page, title: string, expectedStatus: string): Promise<{ actual: string | null; versionCount: number }> {
  await navigateTo(page, config.tableUrl);
  await searchRisk(page, title);
  const statusBadge = page.locator("div.inline-flex").filter({ hasText: new RegExp(`^(${KNOWN_STATUSES.join("|")})$`) }).first();
  let actual: string | null = null;
  try {
    await statusBadge.waitFor({ state: "visible", timeout: 5_000 });
    actual = (await statusBadge.textContent())?.trim() || null;
  } catch { console.log("[Status] Could not find status badge"); }
  console.log(`[Status] Badge found: "${actual}" (expected: "${expectedStatus}")`);

  const riskRow = page.locator("text=" + title).first();
  await riskRow.click().catch(() => {});
  await page.waitForTimeout(1_500);
  const versionCount = await page.evaluate(() => {
    const allText = document.body.innerText;
    const match = allText.match(/Version History\s*\((\d+)\)/i);
    if (match) return parseInt(match[1]);
    return document.querySelectorAll('[data-testid^="version-entry-"]').length;
  });
  console.log(`[Status] Version count: ${versionCount}`);
  return { actual, versionCount };
}

async function updateRiskStatus(page: Page, title: string, newStatus: string): Promise<{ success: boolean; toastText: string | null }> {
  await navigateTo(page, config.dashboardUrl);
  await searchRisk(page, title);
  if (!(await clickFirstEditButton(page))) {
    console.log("[Status] Edit button not found");
    return { success: false, toastText: null };
  }
  const dropdownSelected = await selectDropdown(page, "select-risk-status", newStatus);
  if (!dropdownSelected) {
    console.log(`[Status] Failed to select status: "${newStatus}"`);
    return { success: false, toastText: null };
  }
  const updateBtn = page.getByTestId("button-save-risk");
  await updateBtn.waitFor({ state: "visible", timeout: 5_000 });
  await updateBtn.click();
  const toast = await detectToast(page, "Risk updated successfully");
  return { success: toast.detected, toastText: toast.actualText };
}

export async function performStatusWorkflow(input: StatusWorkflowInput): Promise<StatusWorkflowResult> {
  let context: BrowserContext | null = null;
  const statusSequence = ["Open", "In Review", "Mitigated", "Closed"];
  const steps: StepResult[] = [];
  const actualSequence: string[] = [];
  const result: StatusWorkflowResult = {
    status: "error", message: "", riskTitle: input.title,
    assertion: { expected: statusSequence.join(" -> "), actual: "", match: false },
    steps: [], versions_created: 0, screenshots: { final_status: null, failure: null },
  };

  try {
    console.log(`[Workflow] Starting for "${input.title}"`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Create risk
    await navigateTo(page, config.dashboardUrl);
    const addBtn = page.getByTestId("button-add-risk");
    await addBtn.waitFor({ state: "visible", timeout: 10_000 });
    await addBtn.click();
    await page.getByTestId("input-risk-title").waitFor({ state: "visible", timeout: 5_000 });
    await fillRiskForm(page, {
      title: input.title, description: input.description, category: input.category,
      status: "Open", impact: input.impact, likelihood: input.likelihood,
      owner: input.owner, dueDate: input.dueDate, potentialCost: input.potentialCost,
      mitigationPlan: input.mitigationPlan,
    });
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await saveBtn.click();

    const createToast = await detectToast(page, "Risk created successfully");
    if (!createToast.detected) {
      const visible = await riskVisibleInPage(page, input.title);
      if (!visible) {
        result.status = "fail"; result.message = "Risk creation failed";
        result.screenshots.failure = await captureFailure(context, "status_create_failed");
        result.steps = steps; return result;
      }
    }

    // Verify Open
    console.log("[Workflow] Step 1: Verify Open");
    const openCheck = await verifyRiskStatus(page, input.title, "Open");
    steps.push({ step: "create", status: openCheck.actual === "Open" ? "pass" : "fail", expected_status: "Open", actual_status: openCheck.actual, version: openCheck.versionCount });
    if (openCheck.actual === "Open") { actualSequence.push("Open"); console.log("[Workflow] OK: Open"); }
    else console.log(`[Workflow] FAIL: Expected Open, got "${openCheck.actual}"`);

    // Transitions
    const transitions = [
      { step: "update_in_review", target: "In Review" },
      { step: "update_mitigated", target: "Mitigated" },
      { step: "update_closed", target: "Closed" },
    ];
    for (const { step, target } of transitions) {
      console.log(`[Workflow] Transitioning to: "${target}"`);
      const updateResult = await updateRiskStatus(page, input.title, target);
      if (!updateResult.success) {
        steps.push({ step, status: "fail", expected_status: target, actual_status: null, version: null });
        result.screenshots.failure = await captureFailure(context, `status_${target.toLowerCase().replace(" ", "_")}_failed`);
        continue;
      }
      const check = await verifyRiskStatus(page, input.title, target);
      steps.push({ step, status: check.actual === target ? "pass" : "fail", expected_status: target, actual_status: check.actual, version: check.versionCount });
      if (check.actual === target) { actualSequence.push(target); console.log(`[Workflow] OK: ${target}`); }
      else console.log(`[Workflow] FAIL: Expected "${target}", got "${check.actual}"`);
      if (step === "update_closed") result.versions_created = check.versionCount;
    }

    const finalShot = await page.screenshot({ fullPage: true });
    result.screenshots.final_status = await uploadScreenshot(finalShot, "status_final");
    result.steps = steps;
    result.assertion.actual = actualSequence.join(" -> ");
    result.assertion.match = result.assertion.expected === result.assertion.actual;
    const allPassed = steps.every((s) => s.status === "pass");
    result.status = allPassed ? "pass" : "fail";
    result.message = allPassed ? "All status transitions completed successfully" : `Some transitions failed. Actual: ${result.assertion.actual}`;
    return result;
  } catch (err) {
    result.status = "error"; result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "status_error");
    result.steps = steps; return result;
  } finally { await safeClose(context); }
}
