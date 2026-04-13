// ─── Score Matrix Route — matches old server.ts exactly ───────────────────────
import { BrowserContext, Page } from "playwright";
import { ScoreMatrixInput, ScoreMatrixResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { fillRiskForm, searchRisk, detectToast, riskVisibleInPage } from "../services/riskHelpers";
import { safeClose } from "../services/browserManager";
import { captureFailure, uploadScreenshot } from "../utils/screenshot";
import { withRetry } from "../utils/retry";

async function navigateTo(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(2_000);
}

async function readScoreFromTable(page: Page, title: string): Promise<number | null> {
  const score = await withRetry(async () => {
    await navigateTo(page, config.tableUrl);
    await searchRisk(page, title);
    await page.waitForTimeout(1_500);
    const s = await page.evaluate((riskTitle) => {
      const rows = document.querySelectorAll("tr, [class*='border-b'], [class*='row']");
      for (const row of rows) {
        if (!row.textContent?.includes(riskTitle)) continue;
        const allElements = row.querySelectorAll("*");
        for (const el of allElements) {
          const text = el.textContent?.trim() || "";
          if (el.children.length === 0 && /^\d{1,2}$/.test(text) && parseInt(text) >= 1 && parseInt(text) <= 25) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 100) return parseInt(text);
          }
        }
      }
      return null;
    }, title);
    if (s === null) throw new Error("Score not found in table");
    console.log(`[ScoreMatrix] Read score: ${s} for "${title}"`);
    return s;
  }, 2, 2_000, "Read score from table");
  return score;
}

async function deleteTestRisk(page: Page, title: string): Promise<boolean> {
  try {
    await navigateTo(page, config.tableUrl);
    await searchRisk(page, title);
    const riskRow = page.locator("text=" + title).first();
    await riskRow.waitFor({ state: "visible", timeout: 5_000 });
    await riskRow.click();
    await page.waitForTimeout(1_500);
    const deleteBtn = page.locator('[data-testid^="button-delete-risk-"]').first();
    await deleteBtn.waitFor({ state: "visible", timeout: 5_000 });
    await deleteBtn.click();
    const toast = await detectToast(page, "Risk deleted successfully");
    if (toast.detected) { console.log(`[ScoreMatrix] Cleanup: deleted "${title}"`); return true; }
    await searchRisk(page, title);
    const stillExists = await riskVisibleInPage(page, title);
    return !stillExists;
  } catch (err) {
    console.log(`[ScoreMatrix] Cleanup failed: ${(err as Error).message}`);
    return false;
  }
}

export async function performScoreMatrix(input: ScoreMatrixInput): Promise<ScoreMatrixResult> {
  let context: BrowserContext | null = null;
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 15);
  const impactShort = input.impact.split(" - ")[1] || input.impact;
  const likelihoodShort = input.likelihood.split(" - ")[1] || input.likelihood;
  const riskTitle = `ScoreTest_${impactShort}_${likelihoodShort}_${timestamp}`;
  const result: ScoreMatrixResult = {
    status: "error", message: "", username: input.username,
    impact: input.impact, likelihood: input.likelihood,
    expected_score: input.expectedScore, actual_score: null,
    score_match: false, risk_title: riskTitle, cleaned_up: false,
    screenshots: { failure: null },
  };

  try {
    console.log(`[ScoreMatrix] Testing: ${input.impact} × ${input.likelihood} = ${input.expectedScore}`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Navigate to table page and create risk from there
    await navigateTo(page, config.tableUrl);
    const addBtn = page.locator('text=Add Risk').first();
    await addBtn.waitFor({ state: "visible", timeout: 10_000 });
    await addBtn.click();
    await page.getByTestId("input-risk-title").waitFor({ state: "visible", timeout: 5_000 });
    await fillRiskForm(page, {
      title: riskTitle,
      description: `Score matrix test: ${input.impact} × ${input.likelihood}`,
      category: "Technical", status: "Open",
      impact: input.impact, likelihood: input.likelihood,
    });
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await saveBtn.click();

    const toast = await detectToast(page, "Risk created successfully");
    if (!toast.detected) {
      const visible = await riskVisibleInPage(page, riskTitle);
      if (!visible) {
        result.status = "fail"; result.message = "Risk creation failed";
        result.screenshots.failure = await captureFailure(context, "score_create_failed");
        return result;
      }
    }

    // Read score
    const actualScore = await readScoreFromTable(page, riskTitle);
    result.actual_score = actualScore !== null ? String(actualScore) : null;
    if (actualScore === null) {
      result.status = "fail"; result.message = `Could not read score from table for "${riskTitle}"`;
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "score_read_failed");
      result.cleaned_up = await deleteTestRisk(page, riskTitle);
      return result;
    }

    result.score_match = String(actualScore) === String(input.expectedScore);
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

    result.cleaned_up = await deleteTestRisk(page, riskTitle);
    return result;
  } catch (err) {
    result.status = "error"; result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "score_error");
    return result;
  } finally { await safeClose(context); }
}
