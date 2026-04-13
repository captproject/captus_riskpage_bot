// ─── Filter Risk Route ────────────────────────────────────────────────────────
// POST /filter-risks — Applies status/category filters and validates results

import { BrowserContext } from "playwright";
import { FilterRiskInput, FilterRiskResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { selectDropdown } from "../services/riskHelpers";
import { safeClose } from "../services/browserManager";
import { captureFailure } from "../utils/screenshot";

export async function performFilterRisks(input: FilterRiskInput): Promise<FilterRiskResult> {
  let context: BrowserContext | null = null;

  const result: FilterRiskResult = {
    status: "error",
    message: "",
    username: input.username,
    filters_applied: { status: input.statusFilter, category: input.categoryFilter },
    rows_found: 0,
    rows: [],
    validation: { all_match: false, mismatches: [] },
    screenshots: {},
  };

  try {
    console.log(`[Filter] Starting — status: "${input.statusFilter}", category: "${input.categoryFilter}"`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // Navigate to table
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    // Apply status filter
    if (input.statusFilter && input.statusFilter !== "All Status") {
      await selectDropdown(page, "select-status-filter", input.statusFilter);
      await page.waitForTimeout(1500);
      console.log(`[Filter] Applied status filter: ${input.statusFilter}`);
    }

    // Apply category filter
    if (input.categoryFilter && input.categoryFilter !== "All") {
      await selectDropdown(page, "select-category-filter", input.categoryFilter);
      await page.waitForTimeout(1500);
      console.log(`[Filter] Applied category filter: ${input.categoryFilter}`);
    }

    // Extract filtered rows
    const rows = await page.evaluate(() => {
      const results: Record<string, string>[] = [];
      const tableRows = document.querySelectorAll("tr");
      tableRows.forEach((row, i) => {
        if (i === 0) return; // skip header
        const cells = row.querySelectorAll("td");
        if (cells.length >= 4) {
          results.push({
            title: cells[0]?.textContent?.trim() || "",
            category: cells[1]?.textContent?.trim() || "",
            status: cells[2]?.textContent?.trim() || "",
            owner: cells[3]?.textContent?.trim() || "",
          });
        }
      });
      return results;
    });

    result.rows = rows;
    result.rows_found = rows.length;

    // Validate rows match filters
    const mismatches: string[] = [];
    for (const row of rows) {
      if (input.statusFilter && input.statusFilter !== "All Status") {
        if (row.status?.toLowerCase() !== input.statusFilter.toLowerCase()) {
          mismatches.push(`Row "${row.title}" has status "${row.status}" (expected "${input.statusFilter}")`);
        }
      }
      if (input.categoryFilter && input.categoryFilter !== "All") {
        if (row.category?.toLowerCase() !== input.categoryFilter.toLowerCase()) {
          mismatches.push(`Row "${row.title}" has category "${row.category}" (expected "${input.categoryFilter}")`);
        }
      }
    }

    result.validation = { all_match: mismatches.length === 0, mismatches };

    if (mismatches.length === 0) {
      result.status = "success";
      result.message = `Filter applied — ${rows.length} rows found, all match`;
    } else {
      result.status = "failed";
      result.message = `Filter validation failed — ${mismatches.length} mismatch(es)`;
      result.screenshots.failure = await captureFailure(context, "filter_fail");
    }

    console.log(`[Filter] Result: ${result.status} — ${result.message}`);
    return result;
  } catch (err) {
    result.status = "error";
    result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "filter_error");
    return result;
  } finally {
    await safeClose(context);
  }
}
