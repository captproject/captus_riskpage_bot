// ─────────────────────────────────────────────────────────────────────────────
// riskCreateHelper.ts
// Reusable wrapper around fillRiskForm() + button-save-risk + detectToast.
// CP-6 needs to create risks inline as part of the lifecycle test.
// All testids verified against live Captus DOM (2026-04-29):
//   - Add button:  button-add-risk        ✓ verified
//   - Title input: input-risk-title       ✓ from riskHelpers
//   - Save button: button-save-risk       ✓ from riskHelpers
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";
import { config } from "../server";
import { fillRiskForm, detectToast } from "./riskHelpers";

const SEL_ADD_RISK = '[data-testid="button-add-risk"]';

export interface CreateRiskResult {
  success: boolean;
  toast_detected: boolean;
  toast_text: string | null;
  error: string | null;
}

/**
 * Create a risk in the currently-active project context.
 *
 * IMPORTANT: caller is responsible for setting the project context BEFORE
 * calling this. Whatever project is selected when this runs is where the
 * risk will land.
 *
 * Flow:
 *   1. Navigate to dashboard (where + Add Risk lives)
 *   2. Click the Add Risk button
 *   3. Fill the form (title at minimum; pass extraFields for any required
 *      validation in your form)
 *   4. Click Save
 *   5. Verify success toast
 */
export async function createRiskInProject(
  page: Page,
  title: string,
  extraFields: Parameters<typeof fillRiskForm>[1] = {}
): Promise<CreateRiskResult> {
  const result: CreateRiskResult = {
    success: false,
    toast_detected: false,
    toast_text: null,
    error: null,
  };

  try {
    // ── 1. Land on dashboard so the Add button is in view ──
    await page.goto(config.dashboardUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout ?? 30_000,
    });

    // ── 2. Click + Add Risk ──
    const addBtn = page.locator(SEL_ADD_RISK);
    await addBtn.waitFor({ state: "visible", timeout: 10_000 });
    await addBtn.click();

    // ── 3. Wait for form, then fill ──
    await page.getByTestId("input-risk-title").waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await fillRiskForm(page, { title, ...extraFields });

    // ── 4. Save ──
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await saveBtn.click();

    // ── 5. Verify via toast ──
    const toast = await detectToast(page, "successfully");
    result.toast_detected = toast.detected;
    result.toast_text = toast.actualText;
    result.success = toast.match;

    if (!toast.match) {
      result.error = toast.detected
        ? `Toast appeared but did not confirm success. Got: "${toast.actualText}"`
        : "No success toast detected after save click";
    }

    // Settle so the next action sees fresh state
    await page.waitForTimeout(1_500);
    return result;
  } catch (err) {
    result.error = (err as Error).message;
    return result;
  }
}