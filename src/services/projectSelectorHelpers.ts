// ─────────────────────────────────────────────────────────────────────────────
// projectSelectorHelpers.ts
// TC_Project_Selector — UI inspection helpers.
//
// These read state from the project selector without mutating it:
//   - readSelectorLabel()    : current visible label on the selector button
//   - readDropdownItems()    : project names visible in the dropdown menu
//   - readLocalStorage()     : key/value snapshot of localStorage
//   - countRisksOnPage()     : visible risk row count on /risks
//
// Switching itself stays in `projectSwitchService.ts` (existing helper).
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";

/**
 * Reads the visible text of the project selector button.
 * Falls back gracefully if the button isn't found or has no text.
 */
export async function readSelectorLabel(page: Page): Promise<string | null> {
  try {
    const btn = page.getByTestId("button-project-selector");
    const text = await btn.textContent({ timeout: 5_000 });
    return text?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens the project selector dropdown and returns the visible project names.
 * IMPORTANT: this leaves the dropdown OPEN. Caller should either select an
 * item to close it, or press Escape afterwards.
 *
 * Strategy:
 *   1. Click `button-project-selector`
 *   2. Wait for first `[role="menuitem"]` to render
 *   3. Collect all menu item texts that look like project names
 */
export async function readDropdownItems(page: Page): Promise<string[]> {
  try {
    const btn = page.getByTestId("button-project-selector");
    await btn.click();
    // Wait for the menu to render
    await page.locator('[role="menuitem"]').first().waitFor({ state: "visible", timeout: 5_000 });
    // Slight pause to let all items render
    await page.waitForTimeout(300);

    const items = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[role="menuitem"]'));
      return els
        .map((el) => (el as HTMLElement).innerText?.trim() ?? "")
        .filter((t) => t.length > 0);
    });
    return items;
  } catch {
    return [];
  }
}

/**
 * Closes the project selector dropdown if it's open.
 * Call this after readDropdownItems() if you don't want to select anything.
 */
export async function closeDropdown(page: Page): Promise<void> {
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } catch {
    // best-effort
  }
}

/**
 * Snapshot localStorage as an object. Used to verify the selected project
 * is being persisted somewhere in localStorage (we don't assume an exact
 * key name — we look for any entry whose value contains the project's
 * display name or code).
 */
export async function readLocalStorage(page: Page): Promise<Record<string, string>> {
  try {
    return await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null) {
          out[key] = localStorage.getItem(key) ?? "";
        }
      }
      return out;
    });
  } catch {
    return {};
  }
}

/**
 * Searches every localStorage value for a substring (case-insensitive).
 * Used to detect persistence of the selected project across reloads.
 */
export function localStorageContains(
  snapshot: Record<string, string>,
  needle: string
): { found: boolean; keys: string[] } {
  const needleLc = needle.toLowerCase();
  const matchingKeys: string[] = [];
  for (const [k, v] of Object.entries(snapshot)) {
    if (v.toLowerCase().includes(needleLc)) {
      matchingKeys.push(k);
    }
  }
  return { found: matchingKeys.length > 0, keys: matchingKeys };
}

/**
 * Count visible risk rows on the /risks page using the known testid pattern.
 * Returns 0 if no rows or if the page hasn't loaded the table yet.
 */
export async function countRisksOnPage(page: Page): Promise<number> {
  try {
    const count = await page.locator('[data-testid^="row-risk-"]').count();
    return count;
  } catch {
    return 0;
  }
}

/**
 * Wait for a `/api/risks` network response to occur within `timeoutMs`.
 * Used to verify a project switch triggers a data reload.
 *
 * Returns true if at least one matching response fired in the window.
 */
export async function waitForRisksApiCall(
  page: Page,
  timeoutMs: number = 5_000
): Promise<boolean> {
  try {
    await page.waitForResponse(
      (resp) => /\/api\/risks/.test(resp.url()) && resp.status() < 400,
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
}
