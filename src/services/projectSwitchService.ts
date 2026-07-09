// ─────────────────────────────────────────────────────────────────────────────
// projectSwitchService.ts
// CP-6: Project Switch — handles the UI flow for switching the active project
// in the Captus header bar.
//
// Notes on selectors (updated 2026-07-09 after menu label class change):
//   - Button:        [data-testid="button-project-selector"]
//   - Button label:  [data-testid="button-project-selector"] span.truncate
//   - Menu items:    [role="menuitem"][data-testid^="menu-item-project-"]
//                    NOTE: the trailing number is the DB id, do NOT hardcode.
//   - Item label:    read via innerText first line (e.g. "TEST", "PRJ_A").
//                    Verified DOM 2026-07-09: <span class="font-sans font-light">
//                    holds the code, <span class="text-xs text-muted-foreground">
//                    the display name. We intentionally do NOT depend on these
//                    classes (font-medium → font-light already broke us once).
//
// Performance notes:
//   - Labels are read with a single allInnerTexts() call (one protocol
//     round-trip) instead of a per-item loop; click is by nth() index,
//     which matches allInnerTexts() ordering.
//   - No fixed settle sleep. After clicking, we wait for the actual
//     /api/risks reload response (listener armed BEFORE the click to avoid
//     missing a fast response), falling through silently if none fires.
//   - Every read carries an explicit short timeout. The browser context has
//     a 60s default (setDefaultTimeout in loginService); an unbounded read
//     here previously burned the full 60s on a failure path and pushed the
//     run past n8n's 240s HTTP timeout.
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";

const SEL_BUTTON = '[data-testid="button-project-selector"]';
const SEL_BUTTON_LABEL = `${SEL_BUTTON} span.truncate`;
const SEL_MENU_ITEM = '[role="menuitem"][data-testid^="menu-item-project-"]';

/** Max time for any single label/text read inside the dropdown. */
const READ_TIMEOUT_MS = 5_000;

/** Max time to wait for the post-switch /api/risks data reload. */
const RELOAD_TIMEOUT_MS = 8_000;

export interface ProjectSwitchResult {
  project_before: string | null;
  project_after: string | null;
  switch_success: boolean;
  available_projects: string[];
  failure_reason: string | null;
}

/** First non-empty line of a menu item's innerText is the project code. */
function firstLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  return line ?? null;
}

/**
 * Open the project dropdown and return the visible project codes, in DOM
 * order (index-aligned with locator(SEL_MENU_ITEM).nth(i)).
 * Assumes SEL_BUTTON is already visible.
 */
async function openAndReadMenu(page: Page): Promise<string[]> {
  await page.locator(SEL_BUTTON).click();
  await page.waitForSelector(SEL_MENU_ITEM, {
    state: "visible",
    timeout: 5_000,
  });

  // Single round-trip for all item texts (vs. one innerText call per item).
  const texts = await page.locator(SEL_MENU_ITEM).allInnerTexts();
  return texts.map((t) => firstLine(t) ?? "");
}

/**
 * Switch the active project from `fromProject` to `toProject`.
 * Assumes the user is already logged in and on a page where the
 * project selector is visible (dashboard, risks, etc.).
 *
 * Match strategy: locate menu items by their visible code (first line of
 * innerText), NOT by data-testid suffix (mutable DB id) and NOT by styling
 * classes (changed once already).
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
    await page.waitForSelector(SEL_BUTTON, {
      state: "visible",
      timeout: 10_000,
    });

    // ── 2. Read the currently-active project label ──
    const before =
      (
        await page
          .locator(SEL_BUTTON_LABEL)
          .textContent({ timeout: READ_TIMEOUT_MS })
      )?.trim() ?? null;
    result.project_before = before;

    // Optional sanity check: are we starting on the project we expect?
    if (fromProject && before !== fromProject) {
      result.failure_reason =
        `Starting project mismatch — expected "${fromProject}", found "${before}"`;
      return result;
    }

    // ── 3+4. Open the dropdown and read available projects ──
    const codes = await openAndReadMenu(page);
    result.available_projects = codes.filter((c) => c.length > 0);

    // ── 5. Verify the target project exists in the dropdown ──
    const targetIndex = codes.indexOf(toProject);
    if (targetIndex === -1) {
      result.failure_reason =
        `Target project "${toProject}" not found in dropdown. ` +
        `Available: [${result.available_projects.join(", ")}]`;
      // Close the menu before returning
      await page.keyboard.press("Escape").catch(() => {});
      return result;
    }

    // ── 6. Click the target menu item by index (matches allInnerTexts order).
    // Arm the /api/risks reload listener BEFORE clicking so a fast response
    // can't slip past between click and wait.
    const reload = page
      .waitForResponse(
        (resp) => /\/api\/risks/.test(resp.url()) && resp.status() < 400,
        { timeout: RELOAD_TIMEOUT_MS }
      )
      .catch(() => null);

    await page.locator(SEL_MENU_ITEM).nth(targetIndex).click();

    // ── 7. Wait for the button label to reflect the new project ──
    await page.waitForFunction(
      ({ sel, expected }) => {
        const el = document.querySelector(sel);
        return el?.textContent?.trim() === expected;
      },
      { sel: SEL_BUTTON_LABEL, expected: toProject },
      { timeout: 10_000 }
    );

    // Event-based settle: proceed as soon as risks data has reloaded
    // (replaces the previous fixed 1500ms sleep). Capped at 2s so a switch
    // that fires no /api/risks request (cached data) can't block longer
    // than the old sleep did. Typical cost: ~0ms (response usually lands
    // during the label wait above).
    await Promise.race([reload, page.waitForTimeout(2_000)]);

    // ── 8. Re-read the button label as final confirmation ──
    const after =
      (
        await page
          .locator(SEL_BUTTON_LABEL)
          .textContent({ timeout: READ_TIMEOUT_MS })
      )?.trim() ?? null;
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
  const codes = await openAndReadMenu(page);
  await page.keyboard.press("Escape").catch(() => {});
  return codes.filter((c) => c.length > 0);
}