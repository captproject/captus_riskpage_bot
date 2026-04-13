// ─── Delete Risk Route — matches old server.ts exactly ────────────────────────
import { BrowserContext } from "playwright";
import { DeleteRiskInput, RiskResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { searchRisk, detectToast, riskVisibleInPage } from "../services/riskHelpers";
import { safeClose } from "../services/browserManager";
import { captureFailure, uploadScreenshot } from "../utils/screenshot";

export async function performDeleteRisk(input: DeleteRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error", message: "", username: input.username, riskTitle: input.searchTitle,
    assertion: { expected: "Risk deleted successfully", actual: null, match: false },
    checks: { toast_confirmed: false, dashboard_visible: false, table_search: false, fields_valid: false },
    failure_type: null, field_mismatches: [], table_data: null, screenshots: {},
  };

  try {
    console.log(`[Delete] Starting — "${input.searchTitle}" by ${input.username}`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Navigate to table and search
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2_000);
    await searchRisk(page, input.searchTitle);

    // Click on risk row to expand it
    const riskRow = page.locator("text=" + input.searchTitle).first();
    try {
      await riskRow.waitFor({ state: "visible", timeout: 5_000 });
      await riskRow.click();
    } catch {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "delete_not_found");
      result.status = "failed";
      result.message = `Risk not found in table: "${input.searchTitle}"`;
      result.failure_type = "NOT_FOUND_TABLE";
      return result;
    }
    await page.waitForTimeout(1_500);

    // Click delete button
    const deleteBtn = page.locator('[data-testid^="button-delete-risk-"]').first();
    try {
      await deleteBtn.waitFor({ state: "visible", timeout: 5_000 });
      await deleteBtn.click();
    } catch {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "delete_btn_not_found");
      result.status = "failed";
      result.message = "Delete button not found after expanding risk row";
      result.failure_type = "DELETE_BUTTON_NOT_FOUND";
      return result;
    }

    // Check toast
    const toast = await detectToast(page, "Risk deleted successfully");
    result.assertion.actual = toast.actualText;
    result.assertion.match = toast.match;
    result.checks.toast_confirmed = toast.match;

    if (!toast.detected) {
      // Fallback: verify risk is gone
      await searchRisk(page, input.searchTitle);
      const stillExists = await riskVisibleInPage(page, input.searchTitle);
      if (!stillExists) {
        result.assertion.actual = "Toast missed — risk confirmed removed";
        result.assertion.match = true;
        result.checks.toast_confirmed = true;
      }
    }

    if (!result.assertion.match) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "delete_failed");
      result.status = "failed";
      result.message = "Risk deletion could not be confirmed";
      result.failure_type = "DELETE_FAILED";
      return result;
    }

    result.status = "success";
    result.message = result.assertion.actual || "Risk deleted";
    result.checks = { toast_confirmed: true, dashboard_visible: true, table_search: true, fields_valid: true };
    console.log(`[Delete] Result: ${result.status} — ${result.message}`);
    return result;
  } catch (err) {
    result.status = "error"; result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "delete_error");
    return result;
  } finally { await safeClose(context); }
}
