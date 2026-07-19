// ─── Delete Risk Route — matches old server.ts exactly ────────────────────────
import { BrowserContext } from "playwright";
import { DeleteRiskInput, RiskResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { searchRisk, detectToast, riskVisibleInPage, findRiskRow } from "../services/riskHelpers";
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

    // CAP-138: clicking the risk NAME navigates to /risks/:id now. Locate the
    // row (row-risk-{id}) via table search and use ITS delete button
    // (button-delete-risk-{id}) — hover to reveal, body-cell click as fallback.
    const found = await findRiskRow(page, input.searchTitle);
    if (!found) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "delete_not_found");
      result.status = "failed";
      result.message = `Risk not found in table: "${input.searchTitle}"`;
      result.failure_type = "NOT_FOUND_TABLE";
      return result;
    }
    const { row, riskId } = found;
    const deleteBtn = row.getByTestId(`button-delete-risk-${riskId}`);
    try {
      await row.hover();
      await page.waitForTimeout(500);
      if (!(await deleteBtn.isVisible().catch(() => false))) {
        await row.locator("td").nth(2).click();
        await page.waitForTimeout(1_000);
        const closeBtn = page.getByTestId("button-close-risk-detail");
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click();
          await page.waitForTimeout(800);
          await row.hover();
        }
      }
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
