// ─────────────────────────────────────────────────────────────────────────────
// companyGuardService.ts
// Pre-flight guard for CP-6.
//
// Hard requirement from QA: every project-isolation test MUST run inside
// company "demo". If the logged-in user lands in any other company, the
// test must abort BEFORE any risk is created — otherwise we pollute the
// wrong tenant.
//
// This service:
//   1. Reads the current company label from the header
//   2. If it's already "demo", returns ok
//   3. If a different company is selected, attempts to switch via the
//      company dropdown
//   4. If "demo" is not even available to this user, returns a hard fail
//
// ── Selectors ────────────────────────────────────────────────────────────────
// The PROJECT switcher uses [data-testid="button-project-selector"] (verified
// from inspected HTML). The COMPANY switcher follows the same naming pattern,
// so we use [data-testid="button-company-selector"]. If your COMPANY testid
// differs, override SEL_BUTTON below — it's the only thing that needs to change.
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";

const SEL_BUTTON = '[data-testid="button-company-selector"]';
const SEL_BUTTON_LABEL = `${SEL_BUTTON} span.truncate, ${SEL_BUTTON} span.font-medium`;
const SEL_MENU_ITEM = '[role="menuitem"][data-testid^="menu-item-company-"]';

export interface CompanyGuardResult {
  ok: boolean;
  company_before: string | null;
  company_after: string | null;
  switched: boolean;
  available_companies: string[];
  failure_reason: string | null;
}

export async function ensureCompanyIsDemo(
  page: Page,
  required: string = "demo"
): Promise<CompanyGuardResult> {
  const result: CompanyGuardResult = {
    ok: false,
    company_before: null,
    company_after: null,
    switched: false,
    available_companies: [],
    failure_reason: null,
  };

  try {
    await page.waitForSelector(SEL_BUTTON, { state: "visible", timeout: 10_000 });

    const before = (await page.locator(SEL_BUTTON_LABEL).first().textContent())?.trim() ?? null;
    result.company_before = before;

    // Already on the right company — done
    if (before === required) {
      result.ok = true;
      result.company_after = before;
      return result;
    }

    // Need to switch — open dropdown
    await page.locator(SEL_BUTTON).click();
    await page.waitForSelector(SEL_MENU_ITEM, { state: "visible", timeout: 5_000 });

    // Capture available companies
    const items = await page.locator(SEL_MENU_ITEM).all();
    for (const item of items) {
      const name = (await item.locator("span.font-medium, span").first().textContent())?.trim();
      if (name) result.available_companies.push(name);
    }

    if (!result.available_companies.includes(required)) {
      result.failure_reason =
        `Required company "${required}" not available to this user. ` +
        `Available: [${result.available_companies.join(", ")}]`;
      await page.keyboard.press("Escape").catch(() => {});
      return result;
    }

    // Click the demo entry
    await page
      .locator(SEL_MENU_ITEM, { hasText: required })
      .first()
      .click();

    // Wait for the label to update
    await page.waitForFunction(
      ({ sel, expected }) => {
        const el = document.querySelector(sel);
        return el?.textContent?.trim() === expected;
      },
      { sel: SEL_BUTTON_LABEL.split(",")[0].trim(), expected: required },
      { timeout: 10_000 }
    );

    // Settle — company switch usually triggers a project-list reload too
    await page.waitForTimeout(2_000);

    const after = (await page.locator(SEL_BUTTON_LABEL).first().textContent())?.trim() ?? null;
    result.company_after = after;
    result.switched = true;
    result.ok = after === required;

    if (!result.ok) {
      result.failure_reason =
        `Clicked "${required}" but label did not update — still showing "${after}"`;
    }

    return result;
  } catch (err) {
    result.failure_reason = (err as Error).message;
    return result;
  }
}
