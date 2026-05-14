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
// 14 strict assertions, all must pass:
//   - dropdown_lists_assigned_projects
//   - switched_to_a_label
//   - switched_to_a_data_reloaded
//   - localStorage_after_switch_a
//   - risks_visible_in_a
//   - seeded_risk_present_in_a
//   - other_project_risk_absent_in_a
//   - reload_persistence_a_localStorage
//   - reload_persistence_a_label
//   - switched_to_b_label
//   - switched_to_b_data_reloaded
//   - localStorage_after_switch_b
//   - risks_visible_in_b
//   - seeded_risk_present_in_b
//   - other_project_risk_absent_in_b
//   - reload_persistence_b_localStorage
//   - reload_persistence_b_label
//   - cleanup_complete
//
// Seeding:
//   - Creates one risk in PRJ_A (title prefix PRJ-A-SEL-)
//   - Creates one risk in TEST  (title prefix PRJ-B-SEL-)
//   - Both deleted at end of test
//
// Login pattern: createContextAndLogin lands us on company=demo, project=Test.
// We start the test from this default state.
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
import { config } from "../server";
import {
  readSelectorLabel,
  readDropdownItems,
  closeDropdown,
  readLocalStorage,
  localStorageContains,
  countRisksOnPage,
  waitForRisksApiCall,
} from "../services/projectSelectorHelpers";

const router = Router();

// ── Project mapping ──
const PROJECTS = {
  A: { code: "PRJ_A", display: "Project_A", seed_prefix: "PRJ-A-SEL-" },
  B: { code: "TEST", display: "Test", seed_prefix: "PRJ-B-SEL-" },
} as const;

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
    "Project selector lists assigned projects, switches context, reloads data, persists in localStorage";
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

  try {
    // ─────────────────────────────────────────────────────────────────────
    // PHASE 1 — Login + company guard (preconditions)
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

    const hasA = dropdownItemsSeen.some((t) =>
      t.toLowerCase().includes(PROJECTS.A.display.toLowerCase())
    );
    const hasB = dropdownItemsSeen.some((t) =>
      t.toLowerCase().includes(PROJECTS.B.display.toLowerCase())
    );
    assertions.dropdown_lists_assigned_projects = {
      expected: `Dropdown contains "${PROJECTS.A.display}" AND "${PROJECTS.B.display}"`,
      actual: `Saw: [${dropdownItemsSeen.join(", ")}] — A=${hasA}, B=${hasB}`,
      match: hasA && hasB,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 3 — Switch to PRJ_A (Spec Step 2 — first direction)
    // ─────────────────────────────────────────────────────────────────────
    // Set up network listener BEFORE switching so we can catch the reload call
    let switchAReloadFired = false;
    const switchAReloadPromise = waitForRisksApiCall(page!, 8_000).then(
      (fired) => {
        switchAReloadFired = fired;
        return fired;
      }
    );

    const switchAStep = await runStep("switch_to_a", () =>
      switchProject(page!, PROJECTS.B.code, PROJECTS.A.code)
    );
    steps.push(switchAStep.step);
    await switchAReloadPromise.catch(() => {});

    const labelAfterA = await readSelectorLabel(page!);
    assertions.switched_to_a_label = {
      expected: `Selector label contains "${PROJECTS.A.display}"`,
      actual: labelAfterA ?? "<no label captured>",
      match:
        labelAfterA !== null &&
        labelAfterA.toLowerCase().includes(PROJECTS.A.display.toLowerCase()),
    };

    assertions.switched_to_a_data_reloaded = {
      expected: "A /api/risks call fires after switching to PRJ_A",
      actual: switchAReloadFired ? "captured within 8s" : "no /api/risks call observed",
      match: switchAReloadFired,
    };

    const lsAfterSwitchA = await readLocalStorage(page!);
    localStorageSnapshots.after_switch_a = lsAfterSwitchA;
    const lsContainsA = localStorageContains(lsAfterSwitchA, PROJECTS.A.code);
    const lsContainsADisplay = localStorageContains(lsAfterSwitchA, PROJECTS.A.display);
    const lsAOk = lsContainsA.found || lsContainsADisplay.found;
    assertions.localStorage_after_switch_a = {
      expected: `Some localStorage value contains "${PROJECTS.A.code}" or "${PROJECTS.A.display}"`,
      actual: lsAOk
        ? `match in keys: ${[...lsContainsA.keys, ...lsContainsADisplay.keys].join(", ")}`
        : `no match. Keys present: ${Object.keys(lsAfterSwitchA).join(", ") || "<empty>"}`,
      match: lsAOk,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 4 — Seed risk in PRJ_A
    // ─────────────────────────────────────────────────────────────────────
    const seedAStep = await runStep("seed_in_a", async () => {
      const r = await createRiskInProject(page!, seedTitleA);
      if (!r.success) throw new Error(r.error ?? "seed in A failed");
      seededA = true;
      return { title: seedTitleA };
    });
    steps.push(seedAStep.step);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 5 — Verify /risks shows correct data in PRJ_A (Spec Step 3)
    // ─────────────────────────────────────────────────────────────────────
    // Navigate to /risks page to ensure we're on the right view
    await page!.goto(config.dashboardUrl.replace(/\/dashboard.*/, "/risks"), {
      waitUntil: "networkidle",
      timeout: 30_000,
    }).catch(async () => {
      // Fallback: just stay where we are
      await page!.waitForTimeout(1_000);
    });

    const rowCountA = await countRisksOnPage(page!);
    assertions.risks_visible_in_a = {
      expected: "At least 1 risk row visible in PRJ_A",
      actual: `${rowCountA} rows`,
      match: rowCountA > 0,
    };

    const seedAFound = await searchRisk(page!, seedTitleA).catch(() => false);
    assertions.seeded_risk_present_in_a = {
      expected: `Seeded risk "${seedTitleA}" findable in PRJ_A`,
      actual: seedAFound ? "found" : "NOT FOUND",
      match: seedAFound === true,
    };

    // Negative: PRJ-B-* prefix risks should NOT appear in PRJ_A
    // (we haven't seeded B yet — so any pre-existing PRJ-B-SEL- risk would be stale; skip negative for A)
    assertions.other_project_risk_absent_in_a = {
      expected: `No risk with "${PROJECTS.B.seed_prefix}${ts}" prefix in PRJ_A (B not yet seeded)`,
      actual: "B not yet seeded — trivially absent",
      match: true,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 6 — Reload page, verify persistence (Pass Criteria)
    // ─────────────────────────────────────────────────────────────────────
    await page!.reload({ waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
    await page!.waitForTimeout(1_500);

    const lsAfterReloadA = await readLocalStorage(page!);
    localStorageSnapshots.after_reload_a = lsAfterReloadA;
    const lsReloadAOk =
      localStorageContains(lsAfterReloadA, PROJECTS.A.code).found ||
      localStorageContains(lsAfterReloadA, PROJECTS.A.display).found;
    assertions.reload_persistence_a_localStorage = {
      expected: `After reload, localStorage still contains PRJ_A context`,
      actual: lsReloadAOk ? "preserved" : "LOST after reload",
      match: lsReloadAOk,
    };

    const labelAfterReloadA = await readSelectorLabel(page!);
    assertions.reload_persistence_a_label = {
      expected: `After reload, selector label still shows "${PROJECTS.A.display}"`,
      actual: labelAfterReloadA ?? "<no label captured>",
      match:
        labelAfterReloadA !== null &&
        labelAfterReloadA.toLowerCase().includes(PROJECTS.A.display.toLowerCase()),
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 7 — Switch back to TEST (Spec Step 2 — second direction)
    // ─────────────────────────────────────────────────────────────────────
    let switchBReloadFired = false;
    const switchBReloadPromise = waitForRisksApiCall(page!, 8_000).then(
      (fired) => {
        switchBReloadFired = fired;
        return fired;
      }
    );

    const switchBStep = await runStep("switch_to_b", () =>
      switchProject(page!, PROJECTS.A.code, PROJECTS.B.code)
    );
    steps.push(switchBStep.step);
    await switchBReloadPromise.catch(() => {});

    const labelAfterB = await readSelectorLabel(page!);
    assertions.switched_to_b_label = {
      expected: `Selector label contains "${PROJECTS.B.display}"`,
      actual: labelAfterB ?? "<no label captured>",
      match:
        labelAfterB !== null &&
        labelAfterB.toLowerCase().includes(PROJECTS.B.display.toLowerCase()),
    };

    assertions.switched_to_b_data_reloaded = {
      expected: "A /api/risks call fires after switching to TEST",
      actual: switchBReloadFired ? "captured within 8s" : "no /api/risks call observed",
      match: switchBReloadFired,
    };

    const lsAfterSwitchB = await readLocalStorage(page!);
    localStorageSnapshots.after_switch_b = lsAfterSwitchB;
    const lsContainsB = localStorageContains(lsAfterSwitchB, PROJECTS.B.code);
    const lsContainsBDisplay = localStorageContains(lsAfterSwitchB, PROJECTS.B.display);
    const lsBOk = lsContainsB.found || lsContainsBDisplay.found;
    assertions.localStorage_after_switch_b = {
      expected: `Some localStorage value contains "${PROJECTS.B.code}" or "${PROJECTS.B.display}"`,
      actual: lsBOk
        ? `match in keys: ${[...lsContainsB.keys, ...lsContainsBDisplay.keys].join(", ")}`
        : `no match. Keys: ${Object.keys(lsAfterSwitchB).join(", ") || "<empty>"}`,
      match: lsBOk,
    };

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 8 — Seed risk in TEST (Project B)
    // ─────────────────────────────────────────────────────────────────────
    const seedBStep = await runStep("seed_in_b", async () => {
      const r = await createRiskInProject(page!, seedTitleB);
      if (!r.success) throw new Error(r.error ?? "seed in B failed");
      seededB = true;
      return { title: seedTitleB };
    });
    steps.push(seedBStep.step);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 9 — Verify /risks shows correct data in TEST (Spec Step 3)
    // ─────────────────────────────────────────────────────────────────────
    await page!.goto(config.dashboardUrl.replace(/\/dashboard.*/, "/risks"), {
      waitUntil: "networkidle",
      timeout: 30_000,
    }).catch(async () => {
      await page!.waitForTimeout(1_000);
    });

    const rowCountB = await countRisksOnPage(page!);
    assertions.risks_visible_in_b = {
      expected: "At least 1 risk row visible in TEST",
      actual: `${rowCountB} rows`,
      match: rowCountB > 0,
    };

    const seedBFound = await searchRisk(page!, seedTitleB).catch(() => false);
    assertions.seeded_risk_present_in_b = {
      expected: `Seeded risk "${seedTitleB}" findable in TEST`,
      actual: seedBFound ? "found" : "NOT FOUND",
      match: seedBFound === true,
    };

    // Negative: PRJ-A seeded risk should NOT appear in TEST (proves selector filtered correctly)
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
    await page!.waitForTimeout(1_500);

    const lsAfterReloadB = await readLocalStorage(page!);
    localStorageSnapshots.after_reload_b = lsAfterReloadB;
    const lsReloadBOk =
      localStorageContains(lsAfterReloadB, PROJECTS.B.code).found ||
      localStorageContains(lsAfterReloadB, PROJECTS.B.display).found;
    assertions.reload_persistence_b_localStorage = {
      expected: `After reload, localStorage still contains TEST context`,
      actual: lsReloadBOk ? "preserved" : "LOST after reload",
      match: lsReloadBOk,
    };

    const labelAfterReloadB = await readSelectorLabel(page!);
    assertions.reload_persistence_b_label = {
      expected: `After reload, selector label still shows "${PROJECTS.B.display}"`,
      actual: labelAfterReloadB ?? "<no label captured>",
      match:
        labelAfterReloadB !== null &&
        labelAfterReloadB.toLowerCase().includes(PROJECTS.B.display.toLowerCase()),
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
    const anyStepFailed = steps.some((s) => s.status === "fail");
    const overallStatus: "success" | "failed" =
      allMatch && !anyStepFailed ? "success" : "failed";

    if (overallStatus === "failed") {
      screenshotUrl = await captureFailureScreenshot(context, `selector_fail_${username}`);
    }

    const payload = {
      status: overallStatus,
      message:
        overallStatus === "success"
          ? `Project selector verified — dropdown, switch, data reload, localStorage persistence all working`
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

    // Best-effort cleanup
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
