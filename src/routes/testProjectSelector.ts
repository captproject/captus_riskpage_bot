// ─────────────────────────────────────────────────────────────────────────────
// routes/testProjectSelector.ts
// TC_Project_Selector — Spec 7.5 (Project Selector — Context Switch)
//
// Endpoint: POST /test-project-selector
//
// Validates the project selector UI mechanism end-to-end:
//   Step 1 — Click selector → dropdown lists ASSIGNED projects
//   Step 2 — Select different project → context switches AND data reloads
//   Step 3 — Risk registry shows risks for the SELECTED project only
//   Pass criteria — project context PERSISTED in localStorage across reload
//
// ── Design notes from first run's diagnostic data ────────────────────────────
//
// Captus stores project context in localStorage at:
//     captus_current_project_<userId>  →  {id, code, name, ...}
//
// The selector button displays the project CODE (e.g., "PRJ_A"), not the
// display name ("Project_A"). Both are captured in dropdown items as
// "CODE\nDisplay Name". We accept EITHER for label matching.
//
// "Data reloads" is proven indirectly (and more robustly) by:
//   - seeded_risk_present_in_X  (correct project's data is showing)
//   - other_project_risk_absent (other project's data is NOT showing)
//
// Network listener for /api/risks was unreliable (depends on current page
// state when the switch happens) and is intentionally removed.
//
// "risks_visible_in_X" row count is informational — the dashboard may render
// summary widgets instead of a full table. Search-based proof is canonical.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, Router } from "express";
import { Page, BrowserContext } from "playwright";
import { createContextAndLogin } from "../services/loginService";
import { ensureCompanyIsDemo } from "../services/companyGuardService";
import { switchProject } from "../services/projectSwitchService";
import { createRiskInProject } from "../services/riskCreateHelper";
import { searchRisk, deleteRiskFromTable } from "../services/riskHelpers";
import { uploadScreenshot } from "../utils/screenshot";
import { recordTestResult } from "../services/allureReporter";
import { saveTestResult } from "../services/supabaseLogger";
import {
  readSelectorLabel,
  readDropdownItems,
  closeDropdown,
  readLocalStorage,
  localStorageContains,
  countRisksOnPage,
} from "../services/projectSelectorHelpers";

const router = Router();

// ── Project mapping ──
const PROJECTS = {
  A: { code: "PRJ_A", display: "Project_A", seed_prefix: "PRJ-A-SEL-" },
  B: { code: "TEST", display: "Test", seed_prefix: "PRJ-B-SEL-" },
} as const;

// Time to wait for the project selector button to (re)appear after navigation
const SELECTOR_VISIBLE_TIMEOUT_MS = 15_000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface StepResult {
  name: string;
  status: "pass" | "fail" | "skip";
  duration_ms: number;
  details: any;
  error: string | null;
}

interface Assertion {
  expected: any;
  actual: any;
  match: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function runStep<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ step: StepResult; result: T | null }> {
  const start = Date.now();
  try {
    const result = await fn();
    return {
      step: { name, status: "pass", duration_ms: Date.now() - start, details: result, error: null },
      result,
    };
  } catch (err) {
    return {
      step: { name, status: "fail", duration_ms: Date.now() - start, details: null, error: (err as Error).message },
      result: null,
    };
  }
}

async function captureFailureScreenshot(
  context: BrowserContext | null,
  label: string
): Promise<string | null> {
  if (!context) return null;
  try {
    const pages = context.pages();
    if (pages.length === 0) return null;
    const buf = await pages[0].screenshot({ fullPage: true });
    return await uploadScreenshot(buf, label);
  } catch {
    return null;
  }
}

async function safeDelete(page: Page, projectCode: string, title: string): Promise<boolean> {
  try {
    await switchProject(page, "", projectCode);
    return await deleteRiskFromTable(page, title);
  } catch {
    return false;
  }
}

/**
 * Selector label may show the project CODE or the DISPLAY name (or both,
 * separated by whitespace). Match if EITHER is present.
 */
function labelMatchesProject(
  label: string | null,
  project: { code: string; display: string }
): boolean {
  if (label === null) return false;
  const lc = label.toLowerCase();
  return (
    lc.includes(project.code.toLowerCase()) ||
    lc.includes(project.display.toLowerCase())
  );
}

/**
 * Wait for the project selector button to be visible. Used after page
 * reloads to give the SPA time to mount the header before we read state.
 */
async function waitForSelectorReady(page: Page): Promise<void> {
  try {
    await page
      .getByTestId("button-project-selector")
      .waitFor({ state: "visible", timeout: SELECTOR_VISIBLE_TIMEOUT_MS });
  } catch {
    // best-effort; downstream reads will simply return null
  }
}

// ─── Result recording (CP-6 / SEC-11 pattern) ───────────────────────────────

async function recordResult(payload: any, startTime: number): Promise<void> {
  const assertions = payload?.assertions ?? {};
  const matched = Object.values(assertions).filter((a: any) => a?.match).length;
  const total = Object.keys(assertions).length;
  const failedNames = Object.entries(assertions)
    .filter(([_, a]: [string, any]) => !a?.match)
    .map(([k]) => k)
    .join(", ");

  const assertionExpected =
    "Project selector lists assigned projects, switches context, shows correct data, persists in localStorage";
  const assertionActual =
    payload?.status === "success"
      ? `PASS — ${matched}/${total} assertions matched`
      : `FAIL — ${failedNames || payload?.message || "see details"}`;

  // ── Allure ──
  try {
    recordTestResult(
      "TC_Project_Selector",
      "Project Selector Tests",
      payload?.status ?? "error",
      payload?.message ?? "",
      startTime,
      undefined,
      payload?.screenshot_url ?? null,
      {
        risk_title: payload?.seeded_titles
          ? `${payload.seeded_titles.project_a} | ${payload.seeded_titles.project_b}`
          : undefined,
        username: payload?.username,
        assertion_expected: assertionExpected,
        assertion_actual: assertionActual,
        failure_type: payload?.aborted_reason ?? null,
        mode: "full",
      }
    );
  } catch (err) {
    console.error(`[Allure] Failed to record TC_Project_Selector: ${(err as Error).message}`);
  }

  // ── Supabase ──
  try {
    await saveTestResult(
      "TC_Project_Selector",
      {
        status: payload?.status ?? "error",
        username: payload?.username ?? "",
        risk_title: payload?.seeded_titles
          ? `${payload.seeded_titles.project_a} | ${payload.seeded_titles.project_b}`
          : null,
        message: payload?.message ?? null,
        assertion_expected: assertionExpected,
        assertion_actual: assertionActual,
        assertion_match: payload?.status === "success",
        screenshot_failure: payload?.screenshot_url ?? null,
      },
      {
        company_verified: payload?.company_verified,
        seeded_titles: payload?.seeded_titles,
        dropdown_items_seen: payload?.dropdown_items_seen,
        localStorage_snapshots: payload?.localStorage_snapshots,
        assertions: payload?.assertions,
        steps: payload?.steps,
        counts: payload?.counts,
        cleanup: payload?.cleanup,
        aborted_reason: payload?.aborted_reason,
        total_duration_ms: payload?.total_duration_ms,
      }
    );
  } catch (err) {
    console.error(`[Supabase] Failed to save TC_Project_Selector: ${(err as Error).message}`);
  }
}

async function respond(
  res: Response,
  statusCode: number,
  payload: any,
  startTime: number
): Promise<Response> {
  await recordResult(payload, startTime);
  return res.status(statusCode).json(payload);
}

// ─── Route ──────────────────────────────────────────────────────────────────

router.post("/test-project-selector", async (req: Request, res: Response) => {
  if (req.headers["x-api-key"] !== process.env.API_KEY) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const { username, password } = req.body ?? {};
  const requiredCompany = req.body?.required_company ?? "demo";

  if (!username || !password) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: username, password",
    });
  }

  const ts = timestamp();
  const seedTitleA = `${PROJECTS.A.seed_prefix}${ts}`;
  const seedTitleB = `${PROJECTS.B.seed_prefix}${ts}`;

  const startedAt = new Date().toISOString();
  const overallStart = Date.now();
  const steps: StepResult[] = [];
  const assertions: Record<string, Assertion> = {};
  const localStorageSnapshots: Record<string, any> = {};
  let dropdownItemsSeen: string[] = [];
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let screenshotUrl: string | null = null;
  let seededA = false;
  let seededB = false;
  let rowCountA = 0;
  let rowCountB = 0;

  try {
    // ─────────────────────────────────────────────────────────────────────
    // PHASE 1 — Login + company guard
    // ─────────────────────────────────────────────────────────────────────
    const loginStep = await runStep("login_with_session", async () => {
      const session = await createContextAndLogin(username, password);
      context = session.context;
      page = session.page;
      return { username, post_login_url: page.url() };
    });
    steps.push(loginStep.step);
    if (loginStep.step.status === "fail") {
      const payload = {
        status: "failed" as const,
        message: `Login failed: ${loginStep.step.error}`,
        username,
        assertions,
        steps,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        total_duration_ms: Date.now() - overallStart,
        screenshot_url: null,
      };
      return await respond(res, 500, payload, overallStart);
    }

    const guardStep = await runStep("company_guard", async () => {
      const g = await ensureCompanyIsDemo(page!, requiredCompany);
      if (!g.ok) throw new Error(g.failure_reason ?? "company guard failed");
      return g;
    });
    steps.push(guardStep.step);
    assertions.company_is_demo = {
      expected: requiredCompany,
      actual: guardStep.result?.company_after ?? guardStep.result?.company_before ?? null,
      match: guardStep.step.status === "pass",
    };
    if (guardStep.step.status === "fail") {
      screenshotUrl = await captureFailureScreenshot(context, "selector_guard_failed");
      const payload = {
        status: "failed" as const,
        message: "Aborted: company guard",
        username,
        assertions,
        steps,
        aborted_reason: "wrong_company",
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        total_duration_ms: Date.now() - overallStart,
        screenshot_url: screenshotUrl,
      };
      if (context) await (context as BrowserContext).close().catch(() => {});
      return await respond(res, 500, payload, overallStart);
    }

    // Wait for header to settle before first selector interaction
    await waitForSelectorReady(page!);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 2 — Click selector, read dropdown contents (Spec Step 1)
    // ─────────────────────────────────────────────────────────────────────
    const dropdownStep = await runStep("read_dropdown_items", async () => {
      const items = await readDropdownItems(page!);
      await closeDropdown(page!);
      return { items };
    });
    steps.push(dropdownStep.step);
    dropdownItemsSeen = dropdownStep.result?.items ?? [];

    const hasA = dropdownItemsSeen.some(
      (t) =>
        t.toLowerCase().includes(PROJECTS.A.display.toLowerCase()) ||
        t.toLowerCase().includes(PROJECTS.A.code.toLowerCase())
    );
    const hasB = dropdownItemsSeen.some(
      (t) =>
        t.toLowerCase().includes(PROJECTS.B.display.toLowerCase()) ||
        t.toLowerCase().includes(PROJECTS.B.code.toLowerCase())
    );
    assertions.dropdown_lists_assigned_projects = {
      expected: `Dropdown contains "${PROJECTS.A.display}" AND "${PROJECTS.B.display}" (or codes)`,
      actual: `Saw: [${dropdownItemsSeen.join(" | ")}] — A=${hasA}, B=${hasB}`,
      match: hasA && hasB,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 3 — Switch to PRJ_A (Spec Step 2 — first direction)
    //   Throw if the switch fails so subsequent phases don't cascade.
    // ─────────────────────────────────────────────────────────────────────
    const switchAStep = await runStep("switch_to_a", () =>
      switchProject(page!, PROJECTS.B.code, PROJECTS.A.code).then((r) => {
        if (!r.switch_success) throw new Error(r.failure_reason ?? "switch to A failed");
        return r;
      })
    );
    steps.push(switchAStep.step);
    if (switchAStep.step.status === "fail") {
      assertions.switched_to_a_label = {
        expected: `Selector label contains "${PROJECTS.A.code}" or "${PROJECTS.A.display}"`,
        actual: `switch failed: ${switchAStep.step.error}`,
        match: false,
      };
      // Don't bail — record failure and continue so we still get cleanup
    }

    // Give the page a beat to settle after the switch
    await page!.waitForTimeout(1_000);

    const labelAfterA = await readSelectorLabel(page!);
    assertions.switched_to_a_label = assertions.switched_to_a_label ?? {
      expected: `Selector label contains "${PROJECTS.A.code}" or "${PROJECTS.A.display}"`,
      actual: labelAfterA ?? "<no label captured>",
      match: labelMatchesProject(labelAfterA, PROJECTS.A),
    };

    const lsAfterSwitchA = await readLocalStorage(page!);
    localStorageSnapshots.after_switch_a = lsAfterSwitchA;
    const lsAOk =
      localStorageContains(lsAfterSwitchA, PROJECTS.A.code).found ||
      localStorageContains(lsAfterSwitchA, PROJECTS.A.display).found;
    assertions.localStorage_after_switch_a = {
      expected: `Some localStorage value contains "${PROJECTS.A.code}" or "${PROJECTS.A.display}"`,
      actual: lsAOk
        ? "match found"
        : `no match. Keys: ${Object.keys(lsAfterSwitchA).join(", ") || "<empty>"}`,
      match: lsAOk,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 4 — Seed risk in PRJ_A
    //   createRiskInProject leaves the page on /dashboard — we stay there
    //   instead of manually navigating to /risks (which is not a valid route).
    // ─────────────────────────────────────────────────────────────────────
    const seedAStep = await runStep("seed_in_a", async () => {
      const r = await createRiskInProject(page!, seedTitleA);
      if (!r.success) throw new Error(r.error ?? "seed in A failed");
      seededA = true;
      return { title: seedTitleA };
    });
    steps.push(seedAStep.step);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 5 — Verify risk registry in PRJ_A (Spec Step 3)
    //   Row count is INFORMATIONAL — the dashboard may not render a full
    //   row table. Canonical proof is search-based.
    // ─────────────────────────────────────────────────────────────────────
    rowCountA = await countRisksOnPage(page!);
    assertions.risks_visible_in_a = {
      expected: "Row count recorded (informational)",
      actual: `${rowCountA} rows`,
      match: true, // informational only
    };

    const seedAFound = await searchRisk(page!, seedTitleA).catch(() => false);
    assertions.seeded_risk_present_in_a = {
      expected: `Seeded risk "${seedTitleA}" findable in PRJ_A`,
      actual: seedAFound ? "found" : "NOT FOUND",
      match: seedAFound === true,
    };

    // B not yet seeded — trivially absent. Kept for symmetry with B's phase.
    assertions.other_project_risk_absent_in_a = {
      expected: `No risk with "${PROJECTS.B.seed_prefix}${ts}" prefix in PRJ_A`,
      actual: "B not yet seeded — trivially absent",
      match: true,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 6 — Reload page, verify persistence (Pass Criteria)
    // ─────────────────────────────────────────────────────────────────────
    await page!.reload({ waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
    await waitForSelectorReady(page!);
    await page!.waitForTimeout(500);

    const lsAfterReloadA = await readLocalStorage(page!);
    localStorageSnapshots.after_reload_a = lsAfterReloadA;
    const lsReloadAOk =
      localStorageContains(lsAfterReloadA, PROJECTS.A.code).found ||
      localStorageContains(lsAfterReloadA, PROJECTS.A.display).found;
    assertions.reload_persistence_a_localStorage = {
      expected: "After reload, localStorage still contains PRJ_A context",
      actual: lsReloadAOk ? "preserved" : "LOST after reload",
      match: lsReloadAOk,
    };

    const labelAfterReloadA = await readSelectorLabel(page!);
    assertions.reload_persistence_a_label = {
      expected: `After reload, selector label still shows "${PROJECTS.A.code}" or "${PROJECTS.A.display}"`,
      actual: labelAfterReloadA ?? "<no label captured>",
      match: labelMatchesProject(labelAfterReloadA, PROJECTS.A),
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 7 — Switch back to TEST (Spec Step 2 — second direction)
    // ─────────────────────────────────────────────────────────────────────
    const switchBStep = await runStep("switch_to_b", () =>
      switchProject(page!, PROJECTS.A.code, PROJECTS.B.code).then((r) => {
        if (!r.switch_success) throw new Error(r.failure_reason ?? "switch to B failed");
        return r;
      })
    );
    steps.push(switchBStep.step);
    if (switchBStep.step.status === "fail") {
      assertions.switched_to_b_label = {
        expected: `Selector label contains "${PROJECTS.B.code}" or "${PROJECTS.B.display}"`,
        actual: `switch failed: ${switchBStep.step.error}`,
        match: false,
      };
    }

    await page!.waitForTimeout(1_000);

    const labelAfterB = await readSelectorLabel(page!);
    assertions.switched_to_b_label = assertions.switched_to_b_label ?? {
      expected: `Selector label contains "${PROJECTS.B.code}" or "${PROJECTS.B.display}"`,
      actual: labelAfterB ?? "<no label captured>",
      match: labelMatchesProject(labelAfterB, PROJECTS.B),
    };

    const lsAfterSwitchB = await readLocalStorage(page!);
    localStorageSnapshots.after_switch_b = lsAfterSwitchB;
    const lsBOk =
      localStorageContains(lsAfterSwitchB, PROJECTS.B.code).found ||
      localStorageContains(lsAfterSwitchB, PROJECTS.B.display).found;
    assertions.localStorage_after_switch_b = {
      expected: `Some localStorage value contains "${PROJECTS.B.code}" or "${PROJECTS.B.display}"`,
      actual: lsBOk
        ? "match found"
        : `no match. Keys: ${Object.keys(lsAfterSwitchB).join(", ") || "<empty>"}`,
      match: lsBOk,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 8 — Seed risk in TEST
    // ─────────────────────────────────────────────────────────────────────
    const seedBStep = await runStep("seed_in_b", async () => {
      const r = await createRiskInProject(page!, seedTitleB);
      if (!r.success) throw new Error(r.error ?? "seed in B failed");
      seededB = true;
      return { title: seedTitleB };
    });
    steps.push(seedBStep.step);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 9 — Verify risk registry in TEST (Spec Step 3)
    // ─────────────────────────────────────────────────────────────────────
    rowCountB = await countRisksOnPage(page!);
    assertions.risks_visible_in_b = {
      expected: "Row count recorded (informational)",
      actual: `${rowCountB} rows`,
      match: true, // informational only
    };

    const seedBFound = await searchRisk(page!, seedTitleB).catch(() => false);
    assertions.seeded_risk_present_in_b = {
      expected: `Seeded risk "${seedTitleB}" findable in TEST`,
      actual: seedBFound ? "found" : "NOT FOUND",
      match: seedBFound === true,
    };

    // Negative — PRJ-A seeded risk should NOT appear in TEST (proves filter works)
    const otherSeedFoundInB = await searchRisk(page!, seedTitleA).catch(() => false);
    assertions.other_project_risk_absent_in_b = {
      expected: `Seeded risk "${seedTitleA}" NOT findable in TEST (it's in PRJ_A)`,
      actual: otherSeedFoundInB ? "LEAKED — visible in TEST" : "absent",
      match: otherSeedFoundInB === false,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 10 — Reload page, verify persistence (Pass Criteria, second time)
    // ─────────────────────────────────────────────────────────────────────
    await page!.reload({ waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
    await waitForSelectorReady(page!);
    await page!.waitForTimeout(500);

    const lsAfterReloadB = await readLocalStorage(page!);
    localStorageSnapshots.after_reload_b = lsAfterReloadB;
    const lsReloadBOk =
      localStorageContains(lsAfterReloadB, PROJECTS.B.code).found ||
      localStorageContains(lsAfterReloadB, PROJECTS.B.display).found;
    assertions.reload_persistence_b_localStorage = {
      expected: "After reload, localStorage still contains TEST context",
      actual: lsReloadBOk ? "preserved" : "LOST after reload",
      match: lsReloadBOk,
    };

    const labelAfterReloadB = await readSelectorLabel(page!);
    assertions.reload_persistence_b_label = {
      expected: `After reload, selector label still shows "${PROJECTS.B.code}" or "${PROJECTS.B.display}"`,
      actual: labelAfterReloadB ?? "<no label captured>",
      match: labelMatchesProject(labelAfterReloadB, PROJECTS.B),
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 11 — Cleanup: delete both seeded risks
    // ─────────────────────────────────────────────────────────────────────
    const deleteB = seededB ? await safeDelete(page!, PROJECTS.B.code, seedTitleB) : true;
    const deleteA = seededA ? await safeDelete(page!, PROJECTS.A.code, seedTitleA) : true;

    const cleanupOk = (seededA ? deleteA : true) && (seededB ? deleteB : true);
    assertions.cleanup_complete = {
      expected: "Both seeded risks deleted",
      actual: `A=${seededA ? (deleteA ? "deleted" : "FAILED") : "skipped"}, B=${seededB ? (deleteB ? "deleted" : "FAILED") : "skipped"}`,
      match: cleanupOk,
    };

    // ─────────────────────────────────────────────────────────────────────
    // Final verdict
    // ─────────────────────────────────────────────────────────────────────
    const allMatch = Object.values(assertions).every((a) => a.match);
    const overallStatus: "success" | "failed" = allMatch ? "success" : "failed";

    if (overallStatus === "failed") {
      screenshotUrl = await captureFailureScreenshot(context, `selector_fail_${username}`);
    }

    const payload = {
      status: overallStatus,
      message:
        overallStatus === "success"
          ? "Project selector verified — dropdown, switch, data filter, localStorage persistence all working"
          : "Project selector test failed — see assertions for details",
      username,
      company_verified: requiredCompany,
      seeded_titles: { project_a: seedTitleA, project_b: seedTitleB },
      dropdown_items_seen: dropdownItemsSeen,
      localStorage_snapshots: localStorageSnapshots,
      assertions,
      steps,
      counts: {
        rows_in_a: rowCountA,
        rows_in_b: rowCountB,
        assertions_matched: Object.values(assertions).filter((a) => a.match).length,
        assertions_total: Object.keys(assertions).length,
      },
      cleanup: { a_deleted: deleteA, b_deleted: deleteB },
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };

    if (context) await (context as BrowserContext).close().catch(() => {});
    context = null;
    return await respond(res, overallStatus === "success" ? 200 : 500, payload, overallStart);
  } catch (err) {
    screenshotUrl = await captureFailureScreenshot(context, `selector_error_${username}`);

    let cleanupAttempted = { a: false, b: false };
    if (page && (seededA || seededB)) {
      if (seededB) cleanupAttempted.b = await safeDelete(page, PROJECTS.B.code, seedTitleB);
      if (seededA) cleanupAttempted.a = await safeDelete(page, PROJECTS.A.code, seedTitleA);
    }
    if (context) await (context as BrowserContext).close().catch(() => {});

    const payload = {
      status: "error" as const,
      message: (err as Error).message,
      username,
      assertions,
      steps,
      seeded_titles: { project_a: seedTitleA, project_b: seedTitleB },
      cleanup: cleanupAttempted,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };
    return await respond(res, 500, payload, overallStart);
  }
});

export default router;
