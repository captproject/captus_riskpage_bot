// ─── Score Matrix Route ───────────────────────────────────────────────────────
// POST /score-matrix
// Creates a risk with specific impact/likelihood, reads score from table,
// compares against expected score, then cleans up (deletes the test risk).

import { BrowserContext } from "playwright";
import { ScoreMatrixInput, ScoreMatrixResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskForm, detectToast, deleteRiskFromTable } from "../services/riskHelpers";
import { safeClose } from "../services/browserManager";
import { captureFailure, uploadScreenshot } from "../utils/screenshot";

export async function performScoreMatrix(input: ScoreMatrixInput): Promise<ScoreMatrixResult> {
  let context: BrowserContext | null = null;

  const result: ScoreMatrixResult = {
    status: "error",
    message: "",
    username: input.username,
    risk_title: input.title,
    impact: input.impact,
    likelihood: input.likelihood,
    expected_score: input.expectedScore,
    actual_score: null,
    score_match: false,
    cleaned_up: false,
    screenshots: {},
  };

  try {
    console.log(`[ScoreMatrix] Starting — ${input.impact} × ${input.likelihood} → expected ${input.expectedScore}`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Step 1: Create risk
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

const createBtn = page.getByTestId("button-add-risk");
    await createBtn.waitFor({ state: "visible", timeout: 10_000 });
    await createBtn.click();
    await page.waitForTimeout(1000);

    await fillRiskForm(page, {
      title: input.title,
      description: input.description,
      category: input.category,
      impact: input.impact,
      likelihood: input.likelihood,
      owner: input.owner,
      dueDate: input.dueDate,
      potentialCost: input.potentialCost,
      mitigationPlan: input.mitigationPlan,
    });

    const submitBtn = page.getByTestId("btn-submit-risk");
    await submitBtn.click();
    await page.waitForTimeout(2000);

    const toast = await detectToast(page, "successfully");
    if (!toast.detected) {
      result.status = "fail";
      result.message = "Failed to create test risk for score validation";
      result.screenshots.failure = await captureFailure(context, "score_create_fail");
      return result;
    }

    // Step 2: Navigate to table and read score
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    const actualScore = await page.evaluate((searchTitle) => {
      const rows = document.querySelectorAll("tr");
      for (const row of rows) {
        if (row.textContent?.includes(searchTitle)) {
          const cells = row.querySelectorAll("td");
          // Score is typically in the last or second-to-last column
          for (let i = cells.length - 1; i >= 0; i--) {
            const text = cells[i]?.textContent?.trim() || "";
            if (/^\d+(\.\d+)?$/.test(text) && Number(text) <= 25) {
              return text;
            }
          }
        }
      }
      return null;
    }, input.title);

    result.actual_score = actualScore;

    if (!actualScore) {
      result.status = "fail";
      result.message = `Could not read score for "${input.title}" from table`;
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "score_read_failed");
      result.cleaned_up = await deleteRiskFromTable(page, input.title);
      return result;
    }

    // Step 3: Compare
    result.score_match = actualScore === input.expectedScore;

    if (result.score_match) {
      result.status = "pass";
      result.message = `${input.impact} × ${input.likelihood} = ${actualScore} (expected ${input.expectedScore})`;
      console.log(`[ScoreMatrix] PASS: ${result.message}`);
    } else {
      result.status = "fail";
      result.message = `Score mismatch: got ${actualScore}, expected ${input.expectedScore}`;
      console.log(`[ScoreMatrix] FAIL: ${result.message}`);
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "score_mismatch");
    }

    // Step 4: Cleanup — delete test risk
    result.cleaned_up = await deleteRiskFromTable(page, input.title);
    console.log(`[ScoreMatrix] Cleanup: ${result.cleaned_up ? "deleted" : "not deleted"}`);

    return result;
  } catch (err) {
    result.status = "error";
    result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "score_error");
    return result;
  } finally {
    await safeClose(context);
  }
}
