// ─── Risk Helpers ─────────────────────────────────────────────────────────────
// All selectors verified against old server.ts line by line.
// Search: input-search-risks (line 624)
// Toast: locator .or() chain (line 636)
// Form: button-risk-due-date calendar (line 580), input-risk-potential-cost (line 693)
// Save: button-save-risk (line 920)
// Edit: button-edit-heatmap-risk-* (line 789)
// Delete: button-delete-risk-* (line 1014)
// Dropdown: getByRole option + evaluate fallback (line 540)

import { Page } from "playwright";
import { config } from "../server";
import { ToastResult } from "../utils/types";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const KNOWN_STATUSES = ["Open", "In Review", "Mitigated", "Closed"];
const KNOWN_CATEGORIES = ["Budget", "Schedule", "Safety", "Quality", "Environmental", "Legal", "Technical", "Resource", "Other"];

// ─── Dropdown Selection (old server.ts line 540) ─────────────────────────────

export async function selectDropdown(page: Page, triggerTestId: string, optionText: string): Promise<boolean> {
  try {
    const trigger = page.getByTestId(triggerTestId);
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    await trigger.click();
    const option = page.getByRole("option", { name: optionText });
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click();
    await page.getByRole("listbox").waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
    return true;
  } catch {
    console.log(`[Dropdown] Locator failed for "${triggerTestId}" → "${optionText}", using evaluate fallback`);
  }
  const clicked = await page.evaluate((testId) => {
    const btn = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
    if (btn) { btn.click(); return true; }
    return false;
  }, triggerTestId);
  if (!clicked) return false;
  await page.getByRole("option").first().waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
  const selected = await page.evaluate((text) => {
    const options = document.querySelectorAll('[role="option"]');
    for (const opt of options) {
      if (opt.textContent?.trim().includes(text)) { (opt as HTMLElement).click(); return true; }
    }
    return false;
  }, optionText);
  return selected;
}

// ─── Toast Detection (old server.ts line 633) ────────────────────────────────

export async function detectToast(page: Page, expectedText: string = "successfully"): Promise<ToastResult> {
  console.log(`[Toast] Watching for: "${expectedText}"`);
  const result: ToastResult = { detected: false, actualText: null, expectedText, match: false };
  const toastLocator = page.locator('[data-sonner-toast]')
    .or(page.locator('[role="status"]'))
    .or(page.locator('[data-radix-toast-viewport] > *'))
    .or(page.locator('[class*="Toastify"]'));
  try {
    await toastLocator.first().waitFor({ state: "visible", timeout: 6_000 });
    const toastText = await toastLocator.first().textContent();
    if (toastText?.trim()) {
      result.detected = true;
      result.actualText = toastText.trim();
      result.match = result.actualText.toLowerCase().includes(expectedText.toLowerCase());
    }
  } catch {
    const fallbackText = await page.evaluate(() => {
      const allEls = document.querySelectorAll("*");
      for (const el of allEls) {
        const t = el.textContent?.trim() || "";
        if (el.children.length <= 2 && t.toLowerCase().includes("successfully") && t.length < 100) return t;
      }
      return null;
    });
    if (fallbackText) {
      result.detected = true;
      result.actualText = fallbackText;
      result.match = fallbackText.toLowerCase().includes(expectedText.toLowerCase());
    }
  }
  console.log(`[Toast] Detected: ${result.detected} | Actual: "${result.actualText}" | Match: ${result.match}`);
  return result;
}

// ─── Set Due Date — Calendar Picker (old server.ts line 572) ─────────────────

async function setDueDate(page: Page, dateString: string): Promise<void> {
  const [yearStr, monthStr, dayStr] = dateString.split("-");
  const targetYear = parseInt(yearStr);
  const targetMonth = parseInt(monthStr);
  const targetDay = parseInt(dayStr).toString();
  const targetMonthYear = `${MONTH_NAMES[targetMonth - 1]} ${targetYear}`;
  console.log(`[DueDate] Target: ${targetMonthYear}, day ${targetDay}`);

  const dateButton = page.getByTestId("button-risk-due-date");
  await dateButton.waitFor({ state: "visible", timeout: 10_000 });
  await dateButton.click();
  await page.locator('[role="grid"]').first().waitFor({ state: "visible", timeout: 5_000 });

  for (let i = 0; i < 24; i++) {
    const headingText = await page.locator('[class*="rdp"], [id^="react-day-picker"]').first().textContent().catch(() => "");
    if (headingText?.includes(targetMonthYear)) { console.log("[DueDate] Correct month found"); break; }
    const nextBtn = page.locator('button[name="next-month"]')
      .or(page.locator('button[aria-label="Go to next month"]'))
      .or(page.locator('button[aria-label="Go to the next month"]'))
      .or(page.locator(".rdp-nav button:last-child"));
    const nextVisible = await nextBtn.first().isVisible().catch(() => false);
    if (nextVisible) await nextBtn.first().click();
    else { console.log("[DueDate] Could not find next-month button"); break; }
    await page.waitForTimeout(300);
  }

  console.log(`[DueDate] Clicking day: ${targetDay}`);
  const dayButton = page.locator('[role="gridcell"] button')
    .filter({ hasText: new RegExp(`^${targetDay}$`) })
    .and(page.locator(":not([disabled])"));
  const dayCount = await dayButton.count();
  if (dayCount > 0) await dayButton.first().click();
  else {
    await page.evaluate((day) => {
      const cells = document.querySelectorAll('[role="gridcell"]');
      for (const cell of cells) {
        const button = cell.querySelector("button");
        const textEl = button || cell;
        if (textEl.textContent?.trim() === day && !button?.hasAttribute("disabled") && cell.getAttribute("aria-disabled") !== "true") {
          (button || (cell as HTMLElement)).click(); return;
        }
      }
    }, targetDay);
  }
  await page.locator('[role="grid"]').first().waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
  console.log("[DueDate] Due date set");
}

// ─── Fill Risk Form (old server.ts line 669) ─────────────────────────────────

export async function fillRiskForm(page: Page, data: {
  title?: string; description?: string; category?: string; status?: string;
  impact?: string; likelihood?: string; owner?: string; dueDate?: string;
  potentialCost?: string; mitigationPlan?: string;
}): Promise<void> {
  if (data.title) {
    console.log(`[Form] Title: "${data.title}"`);
    const f = page.getByTestId("input-risk-title");
    await f.waitFor({ state: "visible", timeout: 5_000 });
    await f.clear(); await f.fill(data.title);
  }
  if (data.description) {
    console.log("[Form] Description");
    const f = page.getByTestId("input-risk-description");
    await f.waitFor({ state: "visible", timeout: 5_000 });
    await f.clear(); await f.fill(data.description);
  }
  if (data.category) { console.log(`[Form] Category: "${data.category}"`); await selectDropdown(page, "select-risk-category", data.category); }
  if (data.status) { console.log(`[Form] Status: "${data.status}"`); await selectDropdown(page, "select-risk-status", data.status); }
  if (data.impact) { console.log(`[Form] Impact: "${data.impact}"`); await selectDropdown(page, "select-risk-impact", data.impact); }
  if (data.likelihood) { console.log(`[Form] Likelihood: "${data.likelihood}"`); await selectDropdown(page, "select-risk-likelihood", data.likelihood); }
  if (data.owner) {
    console.log(`[Form] Owner: "${data.owner}"`);
    const f = page.getByTestId("input-risk-owner");
    await f.waitFor({ state: "visible", timeout: 5_000 });
    await f.clear(); await f.fill(data.owner);
  }
  if (data.dueDate) { console.log(`[Form] Due date: "${data.dueDate}"`); await setDueDate(page, data.dueDate); }
  if (data.potentialCost) {
    console.log(`[Form] Cost: "${data.potentialCost}"`);
    const f = page.getByTestId("input-risk-potential-cost");
    await f.waitFor({ state: "visible", timeout: 5_000 });
    await f.clear(); await f.fill(data.potentialCost);
  }
  if (data.mitigationPlan) {
    console.log("[Form] Mitigation plan");
    const f = page.getByTestId("input-risk-mitigation");
    await f.waitFor({ state: "visible", timeout: 5_000 });
    await f.clear(); await f.fill(data.mitigationPlan);
  }
}

// ─── Navigate with Retry ─────────────────────────────────────────────────────

async function navigateTo(page: Page, url: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: config.navigationTimeout });
      await page.waitForTimeout(2_000);
      return;
    } catch (err) {
      console.log(`[Navigate] Attempt ${attempt}/2 failed for ${url}: ${(err as Error).message}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// ─── Search Risk (old server.ts line 622) ────────────────────────────────────
// Used by both dashboard search AND as standalone helper

export async function searchRisk(page: Page, title: string): Promise<boolean> {
  try {
    console.log(`[Search] Searching for: "${title}"`);
    const searchInput = page.getByTestId("input-search-risks");
    await searchInput.waitFor({ state: "visible", timeout: 10_000 });
    await searchInput.fill(title);
    await page.waitForTimeout(1_500);

    // Check if risk is visible
    const visible = await page.evaluate((t) => {
      const body = document.body.textContent || "";
      return body.includes(t);
    }, title);

    console.log(`[Search] "${title}" visible: ${visible}`);
    return visible;
  } catch (err) {
    console.error(`[Search] Error: ${(err as Error).message}`);
    return false;
  }
}

// ─── Search Risk on Dashboard (navigates first) ─────────────────────────────

export async function searchRiskOnDashboard(page: Page, title: string): Promise<boolean> {
  await navigateTo(page, config.dashboardUrl);
  return searchRisk(page, title);
}

// ─── Read Risk Row from Table (old server.ts line 843) ───────────────────────
// Uses badge-based extraction for category/status, smart score/owner/cost detection

export async function readRiskRowFromTable(page: Page, title: string): Promise<Record<string, string> | null> {
  try {
    await navigateTo(page, config.tableUrl);
    await searchRisk(page, title);
    await page.waitForTimeout(1_500);

    const rowData = await page.evaluate((riskTitle) => {
      const allRows = document.querySelectorAll("tr, [class*='border-b']");
      for (const row of allRows) {
        if (!row.textContent?.includes(riskTitle)) continue;
        const badges = row.querySelectorAll("div.inline-flex");
        let category: string | null = null;
        let status: string | null = null;
        const knownStatuses = ["Open", "In Review", "Mitigated", "Closed"];
        const knownCategories = ["Budget", "Schedule", "Safety", "Quality", "Environmental", "Legal", "Technical", "Resource", "Other"];
        for (const badge of badges) {
          const badgeText = badge.textContent?.trim() || "";
          if (knownStatuses.includes(badgeText)) status = badgeText;
          if (knownCategories.includes(badgeText)) category = badgeText;
        }
        let score: string | null = null;
        const allEls = row.querySelectorAll("*");
        for (const el of allEls) {
          const t = el.textContent?.trim() || "";
          if (el.children.length === 0 && /^\d{1,2}$/.test(t) && parseInt(t) >= 1 && parseInt(t) <= 25) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 80) { score = t; break; }
          }
        }
        let owner: string | null = null;
        let cost: string | null = null;
        for (const el of allEls) {
          const t = el.textContent?.trim() || "";
          if (el.children.length === 0 && t.length > 0) {
            if (t.startsWith("$") || t.includes(",")) cost = t;
            else if (
              t !== riskTitle && t !== "—" &&
              !knownStatuses.includes(t) && !knownCategories.includes(t) &&
              !/^\d{1,2}$/.test(t) && t.length > 1 && t.length < 50 &&
              !t.includes("Risk") && !t.includes(">")
            ) {
              if (!owner) owner = t;
            }
          }
        }
        return {
          title: riskTitle, category: category || "", status: status || "",
          score: score || "", owner: owner || "—", cost: cost || "—",
        };
      }
      return null;
    }, title);

    if (rowData) console.log(`[TableRead] Row found: title="${rowData.title}" cat="${rowData.category}" status="${rowData.status}" score="${rowData.score}"`);
    else console.log(`[TableRead] Row not found for "${title}"`);
    return rowData;
  } catch (err) {
    console.error(`[TableRead] Error: ${(err as Error).message}`);
    return null;
  }
}

// ─── Delete Risk from Table (old server.ts line 1260) ────────────────────────

export async function deleteRiskFromTable(page: Page, title: string): Promise<boolean> {
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
    if (toast.detected) { console.log(`[Cleanup] Deleted "${title}"`); return true; }
    await searchRisk(page, title);
    const stillExists = await riskVisibleInPage(page, title);
    return !stillExists;
  } catch (err) {
    console.log(`[Cleanup] Failed: ${(err as Error).message}`);
    return false;
  }
}

// ─── Assert Risk Visible in Page (old server.ts line 804) ────────────────────

export async function riskVisibleInPage(page: Page, title: string): Promise<boolean> {
  try {
    await page.locator("body").filter({ hasText: title }).waitFor({ state: "visible", timeout: 3_000 });
    return true;
  } catch { return false; }
}

// ─── Click First Edit Button (old server.ts line 789) ────────────────────────

export async function clickFirstEditButton(page: Page): Promise<boolean> {
  const editBtn = page.locator('[data-testid^="button-edit-heatmap-risk-"]').first();
  try {
    await editBtn.waitFor({ state: "visible", timeout: 5_000 });
    await editBtn.click();
    await page.getByTestId("input-risk-title").waitFor({ state: "visible", timeout: 5_000 });
    return true;
  } catch {
    console.log("[Edit] Edit button not found or form didn't open");
    return false;
  }
}

// ─── Normalize Values for Comparison ─────────────────────────────────────────

export function normalize(v: any): string {
  return v?.toString().replace(/[$,]/g, "").trim().toLowerCase() || "";
}