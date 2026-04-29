// ─────────────────────────────────────────────────────────────────────────────
// projectSwitchService.ts
// CP-6: Project Switch — handles the UI flow for switching the active project
// in the Captus header bar.
//
// Notes on selectors (verified from inspected HTML 2026-04):
//   - Button:        [data-testid="button-project-selector"]
//   - Button label:  [data-testid="button-project-selector"] span.truncate
//   - Menu items:    [role="menuitem"][data-testid^="menu-item-project-"]
//                    NOTE: the trailing number is the DB id, do NOT hardcode.
//   - Item label:    span.font-medium  (e.g. "TEST", "PRJ_A")
//   - Item subtext:  span.text-xs      (e.g. "Test", "Project_A")
//   - NAME header:   the static label at the top showing the project name
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";

const SEL_BUTTON = '[data-testid="button-project-selector"]';
const SEL_BUTTON_LABEL = `${SEL_BUTTON} span.truncate`;
const SEL_MENU_ITEM = '[role="menuitem"][data-testid^="menu-item-project-"]';

export interface ProjectSwitchResult {
  project_before: string | null;
  project_after: string | null;
  switch_success: boolean;
  available_projects: string[];
  failure_reason: string | null;
}

/**
 * Switch the active project from `fromProject` to `toProject`.
 * Assumes the user is already logged in and on a page where the
 * project selector is visible (dashboard, risks, etc.).
 *
 * Match strategy: locate menu items by their visible name (span.font-medium),
 * NOT by data-testid suffix (which contains a mutable DB id).
 */
export async function switchProject(
  page: Page,
  fromProject: string,
  toProject: string
): Promise<ProjectSwitchResult> {
  const result: ProjectSwitchResult = {
    project_before: null,
    project_after: null,
    switch_success: false,
    available_projects: [],
    failure_reason: null,
  };

  try {
    // ── 1. Wait for the project selector button to be visible ──
    await page.waitForSelector(SEL_BUTTON, { state: "visible", timeout: 10_000 });

    // ── 2. Read the currently-active project label ──
    const before = (await page.locator(SEL_BUTTON_LABEL).textContent())?.trim() ?? null;
    result.project_before = before;

    // Optional sanity check: are we starting on the project we expect?
    if (fromProject && before !== fromProject) {
      result.failure_reason =
        `Starting project mismatch — expected "${fromProject}", found "${before}"`;
      return result;
    }

    // ── 3. Open the dropdown ──
    await page.locator(SEL_BUTTON).click();
    await page.waitForSelector(SEL_MENU_ITEM, { state: "visible", timeout: 5_000 });

    // ── 4. Capture the list of available projects (for logging / debugging) ──
    const items = await page.locator(SEL_MENU_ITEM).all();
    for (const item of items) {
      const name = (await item.locator("span.font-medium").textContent())?.trim();
      if (name) result.available_projects.push(name);
    }

    // ── 5. Verify the target project exists in the dropdown ──
    if (!result.available_projects.includes(toProject)) {
      result.failure_reason =
        `Target project "${toProject}" not found in dropdown. ` +
        `Available: [${result.available_projects.join(", ")}]`;
      // Close the menu before returning
      await page.keyboard.press("Escape").catch(() => {});
      return result;
    }

    // ── 6. Click the target menu item by its visible name ──
    const target = page
      .locator(SEL_MENU_ITEM, { hasText: toProject })
      .filter({ has: page.locator(`span.font-medium`, { hasText: new RegExp(`^${escapeRegex(toProject)}$`) }) })
      .first();

    await target.click();

    // ── 7. Wait for the button label to reflect the new project ──
    await page.waitForFunction(
      ({ sel, expected }) => {
        const el = document.querySelector(sel);
        return el?.textContent?.trim() === expected;
      },
      { sel: SEL_BUTTON_LABEL, expected: toProject },
      { timeout: 10_000 }
    );

    // Small settle window — let dashboard data reload before any downstream check
    await page.waitForTimeout(1_500);

    // ── 8. Re-read the button label as final confirmation ──
    const after = (await page.locator(SEL_BUTTON_LABEL).textContent())?.trim() ?? null;
    result.project_after = after;
    result.switch_success = after === toProject;

    if (!result.switch_success) {
      result.failure_reason =
        `Selector clicked but label did not update — still showing "${after}"`;
    }

    return result;
  } catch (err) {
    result.failure_reason = (err as Error).message;
    return result;
  }
}

/**
 * Helper: list all available projects for a logged-in user, without switching.
 * Useful for /list-projects diagnostic endpoint or for parameterising tests.
 */
export async function listAvailableProjects(page: Page): Promise<string[]> {
  await page.waitForSelector(SEL_BUTTON, { state: "visible", timeout: 10_000 });
  await page.locator(SEL_BUTTON).click();
  await page.waitForSelector(SEL_MENU_ITEM, { state: "visible", timeout: 5_000 });

  const items = await page.locator(SEL_MENU_ITEM).all();
  const names: string[] = [];
  for (const item of items) {
    const name = (await item.locator("span.font-medium").textContent())?.trim();
    if (name) names.push(name);
  }
  await page.keyboard.press("Escape").catch(() => {});
  return names;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
