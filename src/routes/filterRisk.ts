// ─── Filter Risk Route — matches old server.ts exactly ────────────────────────
import { BrowserContext, Page } from "playwright";
import { FilterRiskInput, FilterRiskResult } from "../utils/types";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { selectDropdown } from "../services/riskHelpers";
import { safeClose } from "../services/browserManager";
import { captureFailure, uploadScreenshot } from "../utils/screenshot";

const KNOWN_STATUSES = ["Open", "In Review", "Mitigated", "Closed"];
const KNOWN_CATEGORIES = ["Budget", "Schedule", "Safety", "Quality", "Environmental", "Legal", "Technical", "Resource", "Other"];

interface FilterRowData { title: string; category: string | null; status: string | null; }

async function extractTableRows(page: Page): Promise<FilterRowData[]> {
  console.log("[Filter] Extracting table rows");
  const rows: FilterRowData[] = await page.evaluate(({ statuses, categories }) => {
    const results: { title: string; category: string | null; status: string | null }[] = [];
    const allBadges = document.querySelectorAll("div.inline-flex");
    const processedRows = new Set<Element>();
    for (const badge of allBadges) {
      let rowEl: HTMLElement | null = badge.parentElement;
      while (rowEl && rowEl.tagName !== "TR" && !rowEl.className?.includes("border-b") && !rowEl.className?.includes("row")) rowEl = rowEl.parentElement;
      if (!rowEl || processedRows.has(rowEl)) continue;
      const rowBadges = rowEl.querySelectorAll("div.inline-flex");
      let rowStatus: string | null = null;
      let rowCategory: string | null = null;
      let rowTitle = "";
      for (const rb of rowBadges) {
        const rbText = rb.textContent?.trim() || "";
        if (statuses.includes(rbText)) rowStatus = rbText;
        if (categories.includes(rbText)) rowCategory = rbText;
      }
      if (rowStatus || rowCategory) {
        const textEls = rowEl.querySelectorAll("*");
        for (const el of textEls) {
          const elText = el.textContent?.trim() || "";
          if (el.children.length === 0 && elText.length > 3 && elText.length < 300 && !statuses.includes(elText) && !categories.includes(elText) && !/^\d+$/.test(elText) && !elText.startsWith("$") && elText !== "—" && !elText.includes("Risk")) {
            rowTitle = elText; break;
          }
        }
        processedRows.add(rowEl);
        results.push({ title: rowTitle, category: rowCategory, status: rowStatus });
      }
    }
    return results;
  }, { statuses: KNOWN_STATUSES, categories: KNOWN_CATEGORIES });
  console.log(`[Filter] Extracted ${rows.length} rows`);
  return rows;
}

export async function performFilterRisks(input: FilterRiskInput): Promise<FilterRiskResult> {
  let context: BrowserContext | null = null;
  const statusFilter = input.statusFilter || "All Status";
  const categoryFilter = input.categoryFilter || "All";
  const result: FilterRiskResult = {
    status: "error", message: "", username: input.username,
    filters_applied: { status: statusFilter, category: categoryFilter },
    rows_found: 0, rows: [],
    validation: { all_match: false, mismatches: [] },
    screenshots: {},
  };

  try {
    console.log(`[Filter] Starting — status: "${statusFilter}", category: "${categoryFilter}"`);
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2_000);

    if (statusFilter !== "All Status") {
      console.log(`[Filter] Status filter: "${statusFilter}"`);
      await selectDropdown(page, "select-status-filter", statusFilter);
      await page.waitForTimeout(1_500);
    }
    if (categoryFilter !== "All") {
      console.log(`[Filter] Category filter: "${categoryFilter}"`);
      await selectDropdown(page, "select-category-filter", categoryFilter);
      await page.waitForTimeout(1_500);
    }
    await page.waitForTimeout(1_000);

    const rows = await extractTableRows(page);
    result.rows_found = rows.length;

    if (rows.length === 0) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "filter_no_rows");
      result.status = "failed";
      result.message = "No rows found after applying filters";
      return result;
    }

    const mismatches: string[] = [];
    for (const row of rows) {
      const statusOk = statusFilter === "All Status" || row.status === statusFilter;
      const categoryOk = categoryFilter === "All" || row.category === categoryFilter;
      if (!statusOk || !categoryOk) {
        mismatches.push(`"${row.title}" status=${row.status} category=${row.category}`);
        console.log(`[Filter] MISMATCH: "${row.title}" status=${row.status} category=${row.category}`);
      }
    }

    result.validation = { all_match: mismatches.length === 0, mismatches };
    if (mismatches.length === 0) {
      result.status = "success";
      result.message = `All ${rows.length} rows matched filters`;
    } else {
      result.status = "failed";
      result.message = `${mismatches.length} of ${rows.length} rows did not match`;
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "filter_mismatch");
    }

    // Reset filters
    if (statusFilter !== "All Status") await selectDropdown(page, "select-status-filter", "All Status");
    if (categoryFilter !== "All") await selectDropdown(page, "select-category-filter", "All");

    console.log(`[Filter] Result: ${result.status} — ${result.message}`);
    return result;
  } catch (err) {
    result.status = "error"; result.message = (err as Error).message;
    result.screenshots.failure = await captureFailure(context, "filter_error");
    return result;
  } finally { await safeClose(context); }
}
