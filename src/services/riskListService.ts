// ─────────────────────────────────────────────────────────────────────────────
// riskListService.ts
// Reads ALL risk titles visible on the /risks page for the currently active
// project context. CP-6 uses this to compute symmetric difference between
// Project A and Project B risk lists.
//
// Strategy: mirrors the row-detection approach in riskHelpers.ts'
// readRiskRowFromTable() — uses "tr, [class*='border-b']" to handle both
// table-based and div-based row rendering, and extracts the title from the
// first cell text content. Runs as a single page.evaluate() for speed
// (matters when the table has 100+ rows).
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";
import { config } from "../server";

export interface RiskListResult {
  titles: string[];
  count: number;
  page_url: string;
  duration_ms: number;
  failure_reason: string | null;
}

export async function listRiskTitles(page: Page): Promise<RiskListResult> {
  const start = Date.now();
  const result: RiskListResult = {
    titles: [],
    count: 0,
    page_url: "",
    duration_ms: 0,
    failure_reason: null,
  };

  try {
    await page.goto(config.tableUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout ?? 30_000,
    });
    result.page_url = page.url();
    await page.waitForTimeout(1_500); // settle after data fetch

    const titles = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll("tr, [class*='border-b']")
      );
      const knownStatuses = ["Open", "In Review", "Mitigated", "Closed"];
      const knownCategories = [
        "Budget", "Schedule", "Safety", "Quality",
        "Environmental", "Legal", "Technical", "Resource", "Other",
      ];

      const seen = new Set<string>();
      const out: string[] = [];

      for (const row of rows) {
        if (row.querySelector("th")) continue;            // header row
        const cells = row.querySelectorAll("td");
        if (cells.length === 0) continue;                 // structural row

        const firstCellText = cells[0]?.textContent?.trim() ?? "";

        if (
          !firstCellText ||
          firstCellText.length > 200 ||
          knownStatuses.includes(firstCellText) ||
          knownCategories.includes(firstCellText) ||
          /^\d+$/.test(firstCellText)
        ) {
          continue;
        }

        if (!seen.has(firstCellText)) {
          seen.add(firstCellText);
          out.push(firstCellText);
        }
      }
      return out;
    });

    result.titles = titles;
    result.count = titles.length;
    result.duration_ms = Date.now() - start;
    return result;
  } catch (err) {
    result.failure_reason = (err as Error).message;
    result.duration_ms = Date.now() - start;
    return result;
  }
}