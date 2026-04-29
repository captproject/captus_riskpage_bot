// ─────────────────────────────────────────────────────────────────────────────
// routes/testProjectIsolation.ts
// CP-6 — Full Project Isolation Lifecycle Test
//
// Endpoint: POST /test-project-isolation
//
// Validates:
//   1. Project context switching (UI mechanism)
//   2. Data isolation between projects (no cross-contamination)
//   3. Symmetric naming holds — A only sees PRJ-A-* extras, B only sees PRJ-B-*
//   4. Negative case — PRJ-A risk NOT visible in B's context
//   5. Full lifecycle — Create → Validate → Delete → Validate
//
// IMPORTANT — separation of concerns:
//   - This route DOES NOT write to Supabase. It returns rich JSON.
//   - The downstream n8n SET_RESULT node handles all DB writes.
//   - This matches the existing pattern (other test routes follow the same
//     contract: API returns data, n8n stores).
//
// Login pattern: uses createContextAndLogin() which handles login + company
// "demo" + project "Test" in one call. After login we land on Project B.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, Router } from "express";
import { Page, BrowserContext } from "playwright";
import { createContextAndLogin } from "../services/loginService";
import { ensureCompanyIsDemo } from "../services/companyGuardService";
import { switchProject } from "../services/projectSwitchService";
import { listRiskTitles } from "../services/riskListService";
import { createRiskInProject } from "../services/riskCreateHelper";
import { deleteRiskFromTable, searchRisk } from "../services/riskHelpers";
import { uploadScreenshot } from "../utils/screenshot";

// ── Project mapping (single source of truth) ──
const PROJECTS = {
  A: { code: "PRJ_A", display: "Project_A", risk_prefix: "PRJ-A-RISK-" },
  B: { code: "TEST",  display: "Test",      risk_prefix: "PRJ-B-RISK-" },
} as const;

const router = Router();

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

function timestamp(): string {
  // YYYYMMDD_HHMMSS — matches the convention used in TC_Create_Risk
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function symmetricDiff<T>(a: T[], b: T[]): { onlyInA: T[]; onlyInB: T[]; inBoth: T[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: a.filter((x) => !setB.has(x)),
    onlyInB: b.filter((x) => !setA.has(x)),
    inBoth: a.filter((x) => setB.has(x)),
  };
}

async function probeProject(
  page: Page,
  titleA: string,
  titleB: string
): Promise<{ titles: string[]; aFound: boolean; bFound: boolean; listError: string | null }> {
  const listed = await listRiskTitles(page);
  const aFound = await searchRisk(page, titleA);
  const bFound = await searchRisk(page, titleB);
  return {
    titles: listed.titles,
    aFound,
    bFound,
    listError: listed.failure_reason,
  };
}

async function safeDelete(page: Page, projectCode: string, title: string): Promise<void> {
  try {
    await switchProject(page, "", projectCode);
    await deleteRiskFromTable(page, title);
  } catch {
    // best-effort cleanup
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

async function abort(
  res: Response,
  context: BrowserContext | null,
  username: string,
  reason: string,
  steps: StepResult[],
  assertions: Record<string, Assertion>,
  startedAt: string,
  overallStart: number
) {
  const screenshotUrl = await captureFailureScreenshot(context, `abort_${reason}_${username}`);
  const payload = {
    status: "failed" as const,
    message: `Aborted: ${reason}`,
    username,
    assertions,
    steps,
    aborted_reason: reason,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    total_duration_ms: Date.now() - overallStart,
    screenshot_url: screenshotUrl,
  };
  if (context) await context.close().catch(() => {});
  return res.status(500).json(payload);
}

// ─── Route ──────────────────────────────────────────────────────────────────

router.post("/test-project-isolation", async (req: Request, res: Response) => {
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
  const titleA = `${PROJECTS.A.risk_prefix}${ts}`;
  const titleB = `${PROJECTS.B.risk_prefix}${ts}`;

  const startedAt = new Date().toISOString();
  const overallStart = Date.now();
  const steps: StepResult[] = [];
  const assertions: Record<string, Assertion> = {};
  let screenshotUrl: string | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // ── Step 1: Login (handles browser+context+page+login+demo+Test in one) ──
    const loginStep = await runStep("login_with_session", async () => {
      const result = await createContextAndLogin(username, password);
      context = result.context;
      page = result.page;
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
      return res.status(500).json(payload);
    }

    // ── Step 2: Strict pre-flight — company MUST be demo ──
    // createContextAndLogin attempts demo selection but only WARNS on failure.
    // We require strict verification before touching any data.
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
      return await abort(res, context, username, "wrong_company", steps, assertions, startedAt, overallStart);
    }

    // ── Step 3: Switch to Project A (we're on B by default after login) ──
    const switchAStep = await runStep("switch_to_a", () =>
      switchProject(page!, PROJECTS.B.code, PROJECTS.A.code).then((r) => {
        if (!r.switch_success) throw new Error(r.failure_reason ?? "switch to A failed");
        return r;
      })
    );
    steps.push(switchAStep.step);
    if (switchAStep.step.status === "fail") {
      return await abort(res, context, username, "switch_a_failed", steps, assertions, startedAt, overallStart);
    }

    // ── Step 4: Create risk in Project A ──
    const createAStep = await runStep("create_in_a", async () => {
      const r = await createRiskInProject(page!, titleA);
      if (!r.success) throw new Error(r.error ?? "create in A failed");
      return { title: titleA, toast: r.toast_text };
    });
    steps.push(createAStep.step);
    if (createAStep.step.status === "fail") {
      return await abort(res, context, username, "create_a_failed", steps, assertions, startedAt, overallStart);
    }

    // ── Step 5: Switch to Project B ──
    const switchBStep = await runStep("switch_to_b_for_create", () =>
      switchProject(page!, PROJECTS.A.code, PROJECTS.B.code).then((r) => {
        if (!r.switch_success) throw new Error(r.failure_reason ?? "switch to B failed");
        return r;
      })
    );
    steps.push(switchBStep.step);
    if (switchBStep.step.status === "fail") {
      await safeDelete(page!, PROJECTS.A.code, titleA);
      return await abort(res, context, username, "switch_b_failed", steps, assertions, startedAt, overallStart);
    }

    // ── Step 6: Create risk in Project B ──
    const createBStep = await runStep("create_in_b", async () => {
      const r = await createRiskInProject(page!, titleB);
      if (!r.success) throw new Error(r.error ?? "create in B failed");
      return { title: titleB, toast: r.toast_text };
    });
    steps.push(createBStep.step);
    if (createBStep.step.status === "fail") {
      await safeDelete(page!, PROJECTS.A.code, titleA);
      return await abort(res, context, username, "create_b_failed", steps, assertions, startedAt, overallStart);
    }

    // ── Step 7: Probe Project A (back-switch + list + 2 searches) ──
    const probeAStep = await runStep("probe_a", async () => {
      const sw = await switchProject(page!, PROJECTS.B.code, PROJECTS.A.code);
      if (!sw.switch_success) throw new Error(sw.failure_reason ?? "switch back to A failed");
      return await probeProject(page!, titleA, titleB);
    });
    steps.push(probeAStep.step);
    const probeA = probeAStep.result;

    // ── Step 8: Probe Project B (switch + list + 2 searches) ──
    const probeBStep = await runStep("probe_b", async () => {
      const sw = await switchProject(page!, PROJECTS.A.code, PROJECTS.B.code);
      if (!sw.switch_success) throw new Error(sw.failure_reason ?? "switch to B for probe failed");
      return await probeProject(page!, titleA, titleB);
    });
    steps.push(probeBStep.step);
    const probeB = probeBStep.result;

    // ── Step 9: Assertions ──
    assertions.test_risk_a_visible_in_a = {
      expected: `${titleA} found via search in A`,
      actual: probeA?.aFound ? "found" : "NOT FOUND",
      match: probeA?.aFound === true,
    };
    assertions.test_risk_b_visible_in_b = {
      expected: `${titleB} found via search in B`,
      actual: probeB?.bFound ? "found" : "NOT FOUND",
      match: probeB?.bFound === true,
    };
    assertions.negative_a_not_in_b = {
      expected: `${titleA} NOT findable in B's context`,
      actual: probeB?.aFound ? "LEAKED — found in B" : "absent",
      match: probeB?.aFound === false,
    };
    assertions.negative_b_not_in_a = {
      expected: `${titleB} NOT findable in A's context`,
      actual: probeA?.bFound ? "LEAKED — found in A" : "absent",
      match: probeA?.bFound === false,
    };

    const titlesA = probeA?.titles ?? [];
    const titlesB = probeB?.titles ?? [];
    const haveLists = titlesA.length > 0 && titlesB.length > 0;
    let onlyInA: string[] = [];
    let onlyInB: string[] = [];
    let inBoth: string[] = [];

    if (haveLists) {
      const diff = symmetricDiff(titlesA, titlesB);
      onlyInA = diff.onlyInA;
      onlyInB = diff.onlyInB;
      inBoth = diff.inBoth;

      const aPrefixOk =
        onlyInA.length > 0 && onlyInA.every((t) => t.startsWith(PROJECTS.A.risk_prefix));
      assertions.only_in_a_uses_a_prefix = {
        expected: `every title unique to A starts with "${PROJECTS.A.risk_prefix}"`,
        actual: { count: onlyInA.length, sample: onlyInA.slice(0, 5) },
        match: aPrefixOk,
      };

      const bPrefixOk =
        onlyInB.length > 0 && onlyInB.every((t) => t.startsWith(PROJECTS.B.risk_prefix));
      assertions.only_in_b_uses_b_prefix = {
        expected: `every title unique to B starts with "${PROJECTS.B.risk_prefix}"`,
        actual: { count: onlyInB.length, sample: onlyInB.slice(0, 5) },
        match: bPrefixOk,
      };

      assertions.zero_cross_contamination = {
        expected: 0,
        actual: inBoth.length === 0
          ? 0
          : { count: inBoth.length, leaked_titles: inBoth.slice(0, 10) },
        match: inBoth.length === 0,
      };
    }

    steps.push({
      name: "isolation_assertions",
      status: Object.values(assertions).every((a) => a.match) ? "pass" : "fail",
      duration_ms: 0,
      details: {
        titles_a_count: titlesA.length,
        titles_b_count: titlesB.length,
        list_based_assertions_run: haveLists,
      },
      error: null,
    });

    // ── Step 10: Cleanup — delete risk in A ──
    const switchToADel = await runStep("switch_to_a_for_delete", () =>
      switchProject(page!, PROJECTS.B.code, PROJECTS.A.code)
    );
    steps.push(switchToADel.step);

    const deleteAStep = await runStep("delete_in_a", async () => {
      const ok = await deleteRiskFromTable(page!, titleA);
      if (!ok) throw new Error("delete in A failed (toast not detected and risk still present)");
      return { title: titleA };
    });
    steps.push(deleteAStep.step);

    // ── Step 11: Cleanup — delete risk in B ──
    const switchToBDel = await runStep("switch_to_b_for_delete", () =>
      switchProject(page!, PROJECTS.A.code, PROJECTS.B.code)
    );
    steps.push(switchToBDel.step);

    const deleteBStep = await runStep("delete_in_b", async () => {
      const ok = await deleteRiskFromTable(page!, titleB);
      if (!ok) throw new Error("delete in B failed (toast not detected and risk still present)");
      return { title: titleB };
    });
    steps.push(deleteBStep.step);

    // ── Step 12: Verify deletions via search ──
    const verifyB = await runStep("verify_deletion_b", async () => {
      const stillThere = await searchRisk(page!, titleB);
      return { title: titleB, still_there: stillThere };
    });
    steps.push(verifyB.step);
    assertions.deletion_b_complete = {
      expected: `${titleB} not findable in B after delete`,
      actual: verifyB.result?.still_there ? "STILL PRESENT" : "deleted",
      match: verifyB.result?.still_there === false,
    };

    await switchProject(page!, PROJECTS.B.code, PROJECTS.A.code);
    const verifyA = await runStep("verify_deletion_a", async () => {
      const stillThere = await searchRisk(page!, titleA);
      return { title: titleA, still_there: stillThere };
    });
    steps.push(verifyA.step);
    assertions.deletion_a_complete = {
      expected: `${titleA} not findable in A after delete`,
      actual: verifyA.result?.still_there ? "STILL PRESENT" : "deleted",
      match: verifyA.result?.still_there === false,
    };

    // ── Final assembly ──
    const allMatch = Object.values(assertions).every((a) => a.match);
    const anyStepFailed = steps.some((s) => s.status === "fail");
    const overallStatus: "success" | "failed" =
      allMatch && !anyStepFailed ? "success" : "failed";

    if (overallStatus === "failed") {
      screenshotUrl = await captureFailureScreenshot(context, `project_isolation_fail_${username}`);
    }

    const payload = {
      status: overallStatus,
      message:
        overallStatus === "success"
          ? `Project isolation verified — both test risks correctly isolated, zero cross-contamination`
          : "Project isolation test failed — see assertions and steps",
      username,
      company_verified: requiredCompany,
      test_risks: { project_a: titleA, project_b: titleB },
      assertions,
      steps,
      counts: {
        titles_a: titlesA.length,
        titles_b: titlesB.length,
        only_in_a: onlyInA.length,
        only_in_b: onlyInB.length,
        in_both: inBoth.length,
        list_based_diff_ran: haveLists,
      },
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };

    if (context) await (context as BrowserContext).close().catch(() => {});
    context = null;
    return res.status(overallStatus === "success" ? 200 : 500).json(payload);
  } catch (err) {
    screenshotUrl = await captureFailureScreenshot(context, `project_isolation_error_${username}`);
    if (context) await (context as BrowserContext).close().catch(() => {});

    const payload = {
      status: "error" as const,
      message: (err as Error).message,
      username,
      assertions,
      steps,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };
    return res.status(500).json(payload);
  }
});

export default router;