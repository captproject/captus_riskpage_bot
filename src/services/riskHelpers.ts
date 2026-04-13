// ─── Risk Helpers ─────────────────────────────────────────────────────────────
// Shared UI interaction functions used by multiple route handlers

import { Page } from "playwright";
import { config } from "../server";
import { ToastResult } from "../utils/types";

// ─── Dropdown Selection ──────────────────────────────────────────────────────

export async function selectDropdown(
  page: Page,
  testId: string,
  value: string
): Promise<void> {
  const trigger = page.getByTestId(testId);
  await trigger.waitFor({ state: "visible", timeout: 5_000 });
  await trigger.click();
  await page.waitForTimeout(500);

  // Primary: use getByRole('option')
  try {
    const option = page.getByRole("option", { name: value });
    await option.waitFor({ state: "visible", timeout: 3_000 });
    await option.click();
    await page.waitForTimeout(300);
    return;
  } catch {
    // Fallback: evaluate DOM
    console.log(`[Dropdown] Role-based select failed for "${value}", trying evaluate`);
  }

  await page.evaluate((val) => {
    const options = document.querySelectorAll('[role="option"], [data-radix-select-item]');
    for (const opt of options) {
      if (opt.textContent?.trim().toLowerCase() === val.toLowerCase()) {
        (opt as HTMLElement).click();
        return;
      }
    }
  }, value);
  await page.waitForTimeout(300);
}

// ─── Toast Detection ─────────────────────────────────────────────────────────

export async function detectToast(
  page: Page,
  expectedText: string = "successfully"
): Promise<ToastResult> {
  const result: ToastResult = {
    detected: false,
    actualText: null,
    expectedText,
    match: false,
  };

  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);

    const toastText = await page.evaluate(() => {
      const selectors = [
        '[data-sonner-toast] [data-content]',
        '[data-sonner-toast]',
        '[role="status"]',
        '[data-radix-toast-viewport] > *',
        '.toast-message',
        '[class*="toast"] [class*="title"]',
        '[class*="toast"] [class*="description"]',
        '[class*="Toastify"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent?.trim()) return el.textContent.trim();
      }
      // Fallback: scan for "successfully" text
      const allElements = document.querySelectorAll("*");
      for (const el of allElements) {
        const text = el.textContent?.trim() || "";
        const isSmall = el.children.length === 0 || el.children.length <= 2;
        if (isSmall && text.toLowerCase().includes("successfully") && text.length < 100) return text;
      }
      return null;
    });

    if (toastText) {
      result.detected = true;
      result.actualText = toastText;
      result.match = toastText.toLowerCase().includes(expectedText.toLowerCase());
      console.log(`[Toast] Captured after ${(i + 1) * 500}ms: "${toastText}" | Match: ${result.match}`);
      return result;
    }
  }

  console.log("[Toast] Not detected within 5 seconds");
  return result;
}

// ─── Fill Risk Form ──────────────────────────────────────────────────────────

export async function fillRiskForm(
  page: Page,
  data: {
    title?: string;
    description?: string;
    category?: string;
    status?: string;
    impact?: string;
    likelihood?: string;
    owner?: string;
    dueDate?: string;
    potentialCost?: string;
    mitigationPlan?: string;
  }
): Promise<void> {
  if (data.title) {
    const titleField = page.getByTestId("input-risk-title");
    await titleField.waitFor({ state: "visible", timeout: 5_000 });
    await titleField.clear();
    await titleField.fill(data.title);
    console.log(`[Form] Title: "${data.title}"`);
  }

  if (data.description) {
    const descField = page.getByTestId("input-risk-description");
    await descField.waitFor({ state: "visible", timeout: 5_000 });
    await descField.clear();
    await descField.fill(data.description);
    console.log("[Form] Description filled");
  }

  if (data.category) {
    await selectDropdown(page, "select-risk-category", data.category);
    console.log(`[Form] Category: "${data.category}"`);
  }

  if (data.status) {
    await selectDropdown(page, "select-risk-status", data.status);
    console.log(`[Form] Status: "${data.status}"`);
  }

  if (data.impact) {
    await selectDropdown(page, "select-risk-impact", data.impact);
    console.log(`[Form] Impact: "${data.impact}"`);
  }

  if (data.likelihood) {
    await selectDropdown(page, "select-risk-likelihood", data.likelihood);
    console.log(`[Form] Likelihood: "${data.likelihood}"`);
  }

  if (data.owner) {
    const ownerField = page.getByTestId("input-risk-owner");
    await ownerField.clear();
    await ownerField.fill(data.owner);
  }

  if (data.dueDate) {
    const dateField = page.getByTestId("input-risk-due-date");
    await dateField.clear();
    await dateField.fill(data.dueDate);
  }

  if (data.potentialCost) {
    const costField = page.getByTestId("input-risk-cost");
    await costField.clear();
    await costField.fill(data.potentialCost);
  }

  if (data.mitigationPlan) {
    const planField = page.getByTestId("input-risk-mitigation");
    await planField.clear();
    await planField.fill(data.mitigationPlan);
  }
}

// ─── Search Risk in Dashboard ────────────────────────────────────────────────

export async function searchRisk(
  page: Page,
  title: string
): Promise<boolean> {
  try {
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    // Use search box if available
    const searchBox = page.getByTestId("search-risks");
    const hasSearch = await searchBox.isVisible().catch(() => false);
    if (hasSearch) {
      await searchBox.clear();
      await searchBox.fill(title);
      await page.waitForTimeout(1500);
    }

    // Check visibility
    const visible = await page.evaluate((t) => {
      const rows = document.querySelectorAll('[data-testid^="row-risk-"], tr, [class*="risk-card"]');
      for (const row of rows) {
        if (row.textContent?.includes(t)) return true;
      }
      return false;
    }, title);

    console.log(`[Search] "${title}" visible on dashboard: ${visible}`);
    return visible;
  } catch (err) {
    console.error(`[Search] Error: ${(err as Error).message}`);
    return false;
  }
}

// ─── Read Risk Row from Table ────────────────────────────────────────────────

export async function readRiskRowFromTable(
  page: Page,
  title: string
): Promise<Record<string, string> | null> {
  try {
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    // Search if available
    const searchBox = page.getByTestId("search-risks");
    const hasSearch = await searchBox.isVisible().catch(() => false);
    if (hasSearch) {
      await searchBox.clear();
      await searchBox.fill(title);
      await page.waitForTimeout(1500);
    }

    // Extract row data
    const rowData = await page.evaluate((searchTitle) => {
      const rows = document.querySelectorAll("tr");
      for (const row of rows) {
        if (row.textContent?.includes(searchTitle)) {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 4) {
            return {
              title: cells[0]?.textContent?.trim() || "",
              category: cells[1]?.textContent?.trim() || "",
              status: cells[2]?.textContent?.trim() || "",
              owner: cells[3]?.textContent?.trim() || "",
              cost: cells[4]?.textContent?.trim() || "",
              score: cells[5]?.textContent?.trim() || "",
            };
          }
        }
      }
      return null;
    }, title);

    if (rowData) {
      console.log(`[Table] Found row for "${title}": ${JSON.stringify(rowData)}`);
    } else {
      console.log(`[Table] No row found for "${title}"`);
    }
    return rowData;
  } catch (err) {
    console.error(`[Table] Error: ${(err as Error).message}`);
    return null;
  }
}

// ─── Delete Risk from Table (Cleanup) ────────────────────────────────────────

export async function deleteRiskFromTable(
  page: Page,
  title: string
): Promise<boolean> {
  try {
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    // Find and click delete for the risk
    const deleted = await page.evaluate((searchTitle) => {
      const rows = document.querySelectorAll("tr");
      for (const row of rows) {
        if (row.textContent?.includes(searchTitle)) {
          const deleteBtn = row.querySelector('[data-testid*="delete"], button[aria-label*="delete"]');
          if (deleteBtn) {
            (deleteBtn as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    }, title);

    if (deleted) {
      await page.waitForTimeout(1000);
      // Confirm delete dialog if present
      const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Delete"), [data-testid="confirm-delete"]');
      const hasConfirm = await confirmBtn.isVisible().catch(() => false);
      if (hasConfirm) {
        await confirmBtn.click();
        await page.waitForTimeout(2000);
      }
      console.log(`[Cleanup] Deleted risk "${title}"`);
      return true;
    }

    console.log(`[Cleanup] Risk "${title}" not found for deletion`);
    return false;
  } catch (err) {
    console.error(`[Cleanup] Error: ${(err as Error).message}`);
    return false;
  }
}

// ─── Normalize Values for Comparison ─────────────────────────────────────────

export function normalize(v: any): string {
  return v?.toString().replace(/[$,]/g, "").trim().toLowerCase() || "";
}
