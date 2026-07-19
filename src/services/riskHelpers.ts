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
  // UI change (CAP-138): input-search-risks was removed from the dashboard and
  // now lives on the table page. Name kept for backwards compatibility.
  await navigateTo(page, config.tableUrl);
  return searchRisk(page, title);
}

// ─── Find Risk Row by Title (table page, row-risk-{id} testids) ──────────────
// Returns the row locator and the numeric risk id extracted from its testid.

export async function findRiskRow(
  page: Page,
  title: string
): Promise<{ row: import("playwright").Locator; riskId: string } | null> {
  try {
    await navigateTo(page, config.tableUrl);
    await searchRisk(page, title);
    const row = page.locator('tr[data-testid^="row-risk-"]', { hasText: title }).first();
    await row.waitFor({ state: "visible", timeout: 7_000 });
    const testId = (await row.getAttribute("data-testid")) || "";
    const riskId = testId.replace("row-risk-", "");
    console.log(`[FindRow] "${title}" → row-risk-${riskId}`);
    return { row, riskId };
  } catch {
    console.log(`[FindRow] No row found for "${title}"`);
    return null;
  }
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
              !/^#\d+$/.test(t) && // CAP-138: table now shows an ID column ("#15979") — never mistake it for owner
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
    // UI change (CAP-138): clicking the risk NAME now navigates to /risks/:id.
    // The per-row delete button (button-delete-risk-{id}) is revealed on the
    // row itself — hover first, then click a non-title cell if still hidden.
    const found = await findRiskRow(page, title);
    if (!found) throw new Error(`Row not found for "${title}"`);
    const { row, riskId } = found;
    const deleteBtn = row.getByTestId(`button-delete-risk-${riskId}`);
    await row.hover();
    await page.waitForTimeout(500);
    if (!(await deleteBtn.isVisible().catch(() => false))) {
      // Click the row body (category cell area), never the title link
      await row.locator("td").nth(2).click();
      await page.waitForTimeout(1_000);
      // If that navigated to the detail view, close it and retry via hover
      const closeBtn = page.getByTestId("button-close-risk-detail");
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(800);
        await row.hover();
      }
    }
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

// ─── Risk Detail View Flow (UI change 2026-07-08: edit button removed) ───────
// Clicking the risk card on the dashboard now opens an editable detail view.
// "Save Risk" (button-save-risk-detail) only mounts after a change is committed:
// dropdown selections commit immediately, but text inputs (title/owner/cost/etc.)
// require a blur before the button appears — handled via Tab presses below.

export async function openRiskDetail(page: Page, title: string): Promise<boolean> {
  try {
    // Primary path (CAP-138 UI): table page → search → click the risk title
    // link (link-risk-title-{id}) which navigates to the /risks/:id detail view.
    // With 1500+ risks in the registry, a fresh risk may never surface on the
    // dashboard heatmap, so the table is the only reliable route.
    const found = await findRiskRow(page, title);
    if (found) {
      await found.row.getByTestId(`link-risk-title-${found.riskId}`).click();
    } else {
      // Fallback: legacy dashboard heatmap card
      const card = page.locator('[data-testid^="heatmap-risk-card-"]', { hasText: title }).first();
      try {
        await card.waitFor({ state: "visible", timeout: 5_000 });
        await card.click();
      } catch {
        const cardTitle = page.locator("h4", { hasText: title }).first();
        await cardTitle.waitFor({ state: "visible", timeout: 3_000 });
        await cardTitle.click();
      }
    }
    // Detail view detection (CAP-138): the deep-linked /risks/:id page may not
    // carry button-close-risk-detail (that testid came from the old dashboard
    // panel). Accept ANY of: URL becomes /risks/:id, the editable title field
    // (text-detail-title) appears, or the legacy close button appears.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (/\/risks\/\d+/.test(page.url())) break;
      if (await page.getByTestId("text-detail-title").isVisible().catch(() => false)) break;
      if (await page.getByTestId("button-close-risk-detail").isVisible().catch(() => false)) break;
      await page.waitForTimeout(400);
    }
    const opened =
      /\/risks\/\d+/.test(page.url()) ||
      (await page.getByTestId("text-detail-title").isVisible().catch(() => false)) ||
      (await page.getByTestId("button-close-risk-detail").isVisible().catch(() => false));
    if (!opened) throw new Error("detail view not detected");
    console.log(`[Detail] Opened risk detail for "${title}" (url: ${page.url()})`);
    return true;
  } catch {
    console.log(`[Detail] Could not open risk detail for "${title}"`);
    return false;
  }
}

// ─── Fill Risk Detail Form (detail view testids, -detail naming scheme) ──────
// text-detail-* elements are inline click-to-edit; input-detail-* are plain
// inputs; select-detail-* reuse the standard dropdown pattern.

async function fillDetailTextField(page: Page, testId: string, value: string): Promise<void> {
  const el = page.getByTestId(testId);
  await el.waitFor({ state: "visible", timeout: 5_000 });

  for (const mode of ["click", "dblclick"] as const) {
    if (mode === "click") await el.click(); else await el.dblclick();
    await page.waitForTimeout(400);

    // The element itself may be (or become) an input/textarea
    const tag = await page.evaluate((tid) => {
      const node = document.querySelector(`[data-testid="${tid}"]`);
      return node ? node.tagName.toLowerCase() : null;
    }, testId);
    if (tag === "input" || tag === "textarea") {
      await page.getByTestId(testId).fill(value);
      return;
    }

    // An input/textarea may be nested inside it after activation
    const nested = page.locator(`[data-testid="${testId}"] input, [data-testid="${testId}"] textarea`).first();
    if ((await nested.count()) > 0) {
      await nested.fill(value);
      return;
    }

    // Focused editable (contenteditable or a swapped-in input elsewhere)
    const editableFocused = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      if (!a) return false;
      const t = a.tagName.toLowerCase();
      return t === "input" || t === "textarea" || a.isContentEditable;
    });
    if (editableFocused) {
      await page.keyboard.press("Control+a");
      await page.keyboard.type(value);
      return;
    }
    console.log(`[Form] "${testId}" not editable after ${mode} — ${mode === "click" ? "trying dblclick" : "giving up"}`);
  }
  throw new Error(`Detail field "${testId}" did not become editable`);
}

export async function fillRiskDetailForm(page: Page, data: {
  title?: string; description?: string; category?: string; status?: string;
  impact?: string; likelihood?: string; owner?: string; dueDate?: string;
  potentialCost?: string; mitigationPlan?: string;
}): Promise<void> {
  if (data.title) {
    console.log(`[Form] Detail title: "${data.title}"`);
    await fillDetailTextField(page, "text-detail-title", data.title);
  }
  if (data.description) {
    console.log("[Form] Detail description");
    await fillDetailTextField(page, "text-detail-description", data.description);
  }
  if (data.category) { console.log(`[Form] Detail category: "${data.category}"`); await selectDropdown(page, "select-detail-category", data.category); }
  if (data.status) { console.log(`[Form] Detail status: "${data.status}"`); await selectDropdown(page, "select-detail-status", data.status); }
  if (data.impact) { console.log(`[Form] Detail impact: "${data.impact}"`); await selectDropdown(page, "select-detail-impact", data.impact); }
  if (data.likelihood) { console.log(`[Form] Detail likelihood: "${data.likelihood}"`); await selectDropdown(page, "select-detail-likelihood", data.likelihood); }
  if (data.owner) {
    console.log(`[Form] Detail owner: "${data.owner}"`);
    const f = page.getByTestId("input-detail-owner");
    await f.waitFor({ state: "visible", timeout: 5_000 });
    await f.fill(data.owner);
  }
  if (data.potentialCost) {
    console.log(`[Form] Detail cost: "${data.potentialCost}"`);
    const f = page.getByTestId("input-detail-cost");
    await f.waitFor({ state: "visible", timeout: 5_000 });
    await f.fill(data.potentialCost);
  }
  if (data.mitigationPlan) {
    console.log("[Form] Detail mitigation plan");
    await fillDetailTextField(page, "text-detail-mitigation", data.mitigationPlan);
  }
  if (data.dueDate) {
    console.log(`[Form] WARNING: due date field not present in risk detail view — skipping "${data.dueDate}"`);
  }
}

export async function saveRiskDetail(page: Page): Promise<boolean> {
  const saveBtn = page.getByTestId("button-save-risk-detail");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await saveBtn.waitFor({ state: "visible", timeout: 3_000 });
      await saveBtn.click();
      console.log(`[Detail] Save Risk clicked (attempt ${attempt})`);
      return true;
    } catch {
      // Text inputs need a blur before Save Risk mounts — Tab moves focus off the field
      console.log(`[Detail] Save Risk not visible yet — pressing Tab to commit fields (attempt ${attempt})`);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(500);
    }
  }
  console.log("[Detail] Save Risk button never appeared");
  return false;
}

export async function closeRiskDetail(page: Page): Promise<void> {
  try {
    const closeBtn = page.getByTestId("button-close-risk-detail");
    await closeBtn.waitFor({ state: "visible", timeout: 5_000 });
    await closeBtn.click();
    await closeBtn.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
    console.log("[Detail] Detail view closed");
  } catch {
    console.log("[Detail] Close button not found — continuing");
  }
}

// ─── Normalize Values for Comparison ─────────────────────────────────────────

export function normalize(v: any): string {
  return v?.toString().replace(/[$,]/g, "").trim().toLowerCase() || "";
}