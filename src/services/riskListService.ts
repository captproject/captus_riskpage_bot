// ─────────────────────────────────────────────────────────────────────────────
// riskListService.ts
// Reads the list of risk titles visible on the /risks page for the CURRENTLY
// active project context. Used by CP-6 to validate data isolation between
// projects.
//
// ── Selectors ────────────────────────────────────────────────────────────────
// These are educated guesses based on the table styling in your other test
// cases (TC_Filter_Risks, TC_Edit_Risk). VERIFY before deploying:
//
//   1. Open https://captus.replit.app/risks
//   2. Right-click a risk row → Inspect
//   3. Look for the <tr> or row container's data-testid
//   4. Look for the title cell's data-testid
//
// The two SEL_* constants below are the only things to adjust if the
// markup differs.
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";

// CHANGE THESE TWO IF YOUR /risks TABLE USES DIFFERENT TESTIDS
const SEL_ROW = '[data-testid^="row-risk-"]';
const SEL_TITLE_IN_ROW = '[data-testid^="text-risk-title-"], td:first-child a, td:nth-child(1)';

// Fallback selector if the testid pattern doesn't exist — generic table row
const SEL_ROW_FALLBACK = "table tbody tr";

export interface RiskListResult {
  titles: string[];
  count: number;
  page_url: string;
  duration_ms: number;
  failure_reason: string | null;
}

/**
 * Navigate to /risks and return every visible risk title.
 *
 * Important: the caller is responsible for setting the project context
 * BEFORE calling this. This function only reads what's currently rendered.
 */
export async function listRiskTitles(
  page: Page,
  baseUrl: string
): Promise<RiskListResult> {
  const start = Date.now();
  const result: RiskListResult = {
    titles: [],
    count: 0,
    page_url: "",
    duration_ms: 0,
    failure_reason: null,
  };

  try {
    const risksUrl = `${baseUrl.replace(/\/$/, "")}/risks`;
    await page.goto(risksUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    result.page_url = page.url();

    // Wait for either: rows to appear, OR an "empty state" indicator
    await Promise.race([
      page.waitForSelector(SEL_ROW, { state: "visible", timeout: 10_000 }).catch(() => null),
      page.waitForSelector(SEL_ROW_FALLBACK, { state: "visible", timeout: 10_000 }).catch(() => null),
      page.waitForTimeout(10_000),
    ]);

    // Settle — give the table a moment to finish rendering after data fetch
    await page.waitForTimeout(1_000);

    // Try the testid selector first
    let rows = await page.locator(SEL_ROW).all();

    // If nothing matches the testid pattern, fall back to generic table rows
    if (rows.length === 0) {
      rows = await page.locator(SEL_ROW_FALLBACK).all();
    }

    for (const row of rows) {
      // Try testid title first, then fall back to first cell text
      let title: string | null = null;

      const testidTitle = row.locator(SEL_TITLE_IN_ROW).first();
      if (await testidTitle.count()) {
        title = (await testidTitle.textContent())?.trim() ?? null;
      }

      if (!title) {
        // Last-ditch fallback: first <td> in the row
        title = (await row.locator("td").first().textContent())?.trim() ?? null;
      }

      if (title) result.titles.push(title);
    }

    result.count = result.titles.length;
    result.duration_ms = Date.now() - start;
    return result;
  } catch (err) {
    result.failure_reason = (err as Error).message;
    result.duration_ms = Date.now() - start;
    return result;
  }
}
