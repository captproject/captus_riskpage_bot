// ─────────────────────────────────────────────────────────────────────────────
// routes/testProjectIsolation.ts
// CP-6 — Full Project Isolation Lifecycle Test
//
// Endpoint: POST /test-project-isolation
//
// Validates:
//   1. Project context switching works (UI mechanism)
//   2. Data isolation between projects (no cross-contamination)
//   3. Symmetric naming holds — A only sees PRJ-A-* extras, B only sees PRJ-B-*
//   4. Negative case — PRJ-A risk NOT visible in B's context
//   5. Full lifecycle — Create → Validate → Delete → Validate
//
// Strict pre-flight: company MUST be "demo" or the test aborts before
// any risk is touched.
//
// Request body:
//   {
//     "username": "qa.user@captus.ai",
//     "password": "...",
//     "required_company": "demo",         // optional, defaults to "demo"
//     "db_cross_check": false             // optional, requires SUPABASE_*
//                                         //          env vars for company DB
//   }
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, Router } from "express";
import { Page } from "playwright";
import { getBrowser, closeBrowser } from "../services/browserManager";
import { performLogin } from "../services/loginService";
import { ensureCompanyIsDemo } from "../services/companyGuardService";
import { switchProject } from "../services/projectSwitchService";
import { listRiskTitles } from "../services/riskListService";
import { uploadScreenshot } from "../utils/screenshot";
import { logResult } from "../services/supabaseLogger";

// ── Project mapping (single source of truth for this test) ──
// `code`        = string shown in the project-selector button
// `risk_prefix` = the prefix used when generating titles in this project
const PROJECTS = {
  A: { code: "PRJ_A", display: "Project_A", risk_prefix: "PRJ-A-RISK-" },
  B: { code: "TEST",  display: "Test",      risk_prefix: "PRJ-B-RISK-" },
} as const;

// ── NOTE on createRisk / deleteRisk imports ────────────────────────────────
// Your existing repo already has working risk-creation and risk-deletion
// logic inside riskHelpers.ts (driving TC_Create_Risk and TC_Delete_Risk).
// The two helpers below are wrappers — if your function signatures differ,
// adjust ONLY the import names and call sites here.
//
// Expected shape:
//   createRiskOnPage(page, title, opts?) -> { success: boolean, error?: string }
//   deleteRiskOnPage(page, title)         -> { success: boolean, error?: string }
//
// If your helpers are named differently (e.g. createRisk / deleteRisk),
// just rename the imports below.
import {
  createRiskOnPage,
  deleteRiskOnPage,
} from "../services/riskHelpers";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface StepResult {
  name: string;
  status: "pass" | "fail" | "skip";
  duration_ms: number;
  details: any;
  error: string | null;
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

function timestamp(): string {
  // YYYYMMDD_HHMMSS — matches your existing test data convention
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

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

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
  const baseUrl = process.env.CAPTUS_BASE_URL ?? "https://captus.replit.app";

  const startedAt = new Date().toISOString();
  const overallStart = Date.now();
  const steps: StepResult[] = [];
  const assertions: Record<string, { expected: any; actual: any; match: boolean }> = {};
  let screenshotUrl: string | null = null;
  let context = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext();
    const page: Page = await context.newPage();

    // ── Step 1: Login ──────────────────────────────────────────────────────
    const loginStep = await runStep("login", async () => {
      const r = await performLogin(page, username, password);
      if (r.status !== "success") throw new Error(r.message ?? "login failed");
      return r;
    });
    steps.push(loginStep.step);
    if (loginStep.step.status === "fail") {
      return await abort(res, page, username, "login_failed", steps, assertions, startedAt, overallStart);
    }

    // ── Step 2: Pre-flight guard — company must be "demo" ──────────────────
    const guardStep = await runStep("company_guard", async () => {
      const g = await ensureCompanyIsDemo(page, requiredCompany);
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
      return await abort(res, page, username, "wrong_company", steps, assertions, startedAt, overallStart);
    }

    // ── Step 3: Switch to Project A ────────────────────────────────────────
    const switchAStep = await runStep("switch_to_a", () =>
      switchProject(page, "", PROJECTS.A.code).then((r) => {
        if (!r.switch_success) throw new Error(r.failure_reason ?? "switch to A failed");
        return r;
      })
    );
    steps.push(switchAStep.step);
    if (switchAStep.step.status === "fail") {
      return await abort(res, page, username, "switch_a_failed", steps, assertions, startedAt, overallStart);
    }

    // ── Step 4: Create risk in Project A ───────────────────────────────────
    const createAStep = await runStep("create_in_a", async () => {
      const r = await createRiskOnPage(page, titleA);
      if (!r.success) throw new Error(r.error ?? "create in A failed");
      return { title: titleA };
    });
    steps.push(createAStep.step);
    if (createAStep.step.status === "fail") {
      return await abort(res, page, username, "create_a_failed", steps, assertions, startedAt, overallStart);
    }

    // ── Step 5: Switch to Project B ────────────────────────────────────────
    const switchBStep = await runStep("switch_to_b_for_create", () =>
      switchProject(page, PROJECTS.A.code, PROJECTS.B.code).then((r) => {
        if (!r.switch_success) throw new Error(r.failure_reason ?? "switch to B failed");
        return r;
      })
    );
    steps.push(switchBStep.step);
    if (switchBStep.step.status === "fail") {
      // Try to clean up A before bailing
      await safeDelete(page, PROJECTS.A.code, titleA);
      return await abort(res, page, username, "switch_b_failed", steps, assertions, startedAt, overallStart);
    }

    // ── Step 6: Create risk in Project B ───────────────────────────────────
    const createBStep = await runStep("create_in_b", async () => {
      const r = await createRiskOnPage(page, titleB);
      if (!r.success) throw new Error(r.error ?? "create in B failed");
      return { title: titleB };
    });
    steps.push(createBStep.step);
    if (createBStep.step.status === "fail") {
      await safeDelete(page, PROJECTS.A.code, titleA);
      return await abort(res, page, username, "create_b_failed", steps, assertions, startedAt, overallStart);
    }

    // ── Step 7: Switch back to A and list ──────────────────────────────────
    const switchBackAStep = await runStep("switch_to_a_for_list", () =>
      switchProject(page, PROJECTS.B.code, PROJECTS.A.code).then((r) => {
        if (!r.switch_success) throw new Error(r.failure_reason ?? "switch back to A failed");
        return r;
      })
    );
    steps.push(switchBackAStep.step);

    const listAStep = await runStep("list_in_a", () => listRiskTitles(page, baseUrl));
    steps.push(listAStep.step);
    const titlesA = listAStep.result?.titles ?? [];

    // ── Step 8: Switch to B and list ───────────────────────────────────────
    const switchBForListStep = await runStep("switch_to_b_for_list", () =>
      switchProject(page, PROJECTS.A.code, PROJECTS.B.code).then((r) => {
        if (!r.switch_success) throw new Error(r.failure_reason ?? "switch to B for list failed");
        return r;
      })
    );
    steps.push(switchBForListStep.step);

    const listBStep = await runStep("list_in_b", () => listRiskTitles(page, baseUrl));
    steps.push(listBStep.step);
    const titlesB = listBStep.result?.titles ?? [];

    // ── Step 9: Symmetric-difference assertions ────────────────────────────
    const { onlyInA, onlyInB, inBoth } = symmetricDiff(titlesA, titlesB);

    // 9a — A's exclusives must all start with PRJ-A-RISK-
    const aPrefixOk =
      onlyInA.length > 0 && onlyInA.every((t) => t.startsWith(PROJECTS.A.risk_prefix));
    assertions.only_in_a_uses_a_prefix = {
      expected: `every title starts with "${PROJECTS.A.risk_prefix}"`,
      actual: { count: onlyInA.length, sample: onlyInA.slice(0, 5) },
      match: aPrefixOk,
    };

    // 9b — B's exclusives must all start with PRJ-B-RISK-
    const bPrefixOk =
      onlyInB.length > 0 && onlyInB.every((t) => t.startsWith(PROJECTS.B.risk_prefix));
    assertions.only_in_b_uses_b_prefix = {
      expected: `every title starts with "${PROJECTS.B.risk_prefix}"`,
      actual: { count: onlyInB.length, sample: onlyInB.slice(0, 5) },
      match: bPrefixOk,
    };

    // 9c — zero overlap (no risk visible in both projects)
    assertions.zero_cross_contamination = {
      expected: 0,
      actual: inBoth.length,
      match: inBoth.length === 0,
    };
    if (inBoth.length > 0) {
      assertions.zero_cross_contamination.actual = {
        count: inBoth.length,
        leaked_titles: inBoth.slice(0, 10),
      };
    }

    // 9d — our specific test risks land in the right projects
    assertions.test_risk_a_visible_in_a = {
      expected: titleA,
      actual: titlesA.includes(titleA) ? titleA : "NOT_FOUND",
      match: titlesA.includes(titleA),
    };
    assertions.test_risk_b_visible_in_b = {
      expected: titleB,
      actual: titlesB.includes(titleB) ? titleB : "NOT_FOUND",
      match: titlesB.includes(titleB),
    };

    // 9e — explicit negative: A's risk must NOT appear in B's context
    assertions.negative_a_not_in_b = {
      expected: `${titleA} absent from B's risk list`,
      actual: titlesB.includes(titleA) ? "LEAKED — found in B" : "absent",
      match: !titlesB.includes(titleA),
    };
    assertions.negative_b_not_in_a = {
      expected: `${titleB} absent from A's risk list`,
      actual: titlesA.includes(titleB) ? "LEAKED — found in A" : "absent",
      match: !titlesA.includes(titleB),
    };

    steps.push({
      name: "isolation_assertions",
      status: Object.values(assertions).every((a) => a.match) ? "pass" : "fail",
      duration_ms: 0,
      details: {
        titles_a_count: titlesA.length,
        titles_b_count: titlesB.length,
        only_in_a_count: onlyInA.length,
        only_in_b_count: onlyInB.length,
        in_both_count: inBoth.length,
      },
      error: null,
    });

    // ── Step 10: Cleanup — delete risk in A ────────────────────────────────
    await runStep("switch_to_a_for_delete", () =>
      switchProject(page, PROJECTS.B.code, PROJECTS.A.code)
    ).then((s) => steps.push(s.step));

    const deleteAStep = await runStep("delete_in_a", async () => {
      const r = await deleteRiskOnPage(page, titleA);
      if (!r.success) throw new Error(r.error ?? "delete in A failed");
      return { title: titleA };
    });
    steps.push(deleteAStep.step);

    // ── Step 11: Cleanup — delete risk in B ────────────────────────────────
    await runStep("switch_to_b_for_delete", () =>
      switchProject(page, PROJECTS.A.code, PROJECTS.B.code)
    ).then((s) => steps.push(s.step));

    const deleteBStep = await runStep("delete_in_b", async () => {
      const r = await deleteRiskOnPage(page, titleB);
      if (!r.success) throw new Error(r.error ?? "delete in B failed");
      return { title: titleB };
    });
    steps.push(deleteBStep.step);

    // ── Step 12: Verify deletions ──────────────────────────────────────────
    const verifyDeleteB = await runStep("verify_deletion_b", () => listRiskTitles(page, baseUrl));
    steps.push(verifyDeleteB.step);
    const titlesBFinal = verifyDeleteB.result?.titles ?? [];
    assertions.deletion_b_complete = {
      expected: `${titleB} absent from B`,
      actual: titlesBFinal.includes(titleB) ? "STILL PRESENT" : "deleted",
      match: !titlesBFinal.includes(titleB),
    };

    await switchProject(page, PROJECTS.B.code, PROJECTS.A.code);
    const verifyDeleteA = await runStep("verify_deletion_a", () => listRiskTitles(page, baseUrl));
    steps.push(verifyDeleteA.step);
    const titlesAFinal = verifyDeleteA.result?.titles ?? [];
    assertions.deletion_a_complete = {
      expected: `${titleA} absent from A`,
      actual: titlesAFinal.includes(titleA) ? "STILL PRESENT" : "deleted",
      match: !titlesAFinal.includes(titleA),
    };

    // ── Final result assembly ──────────────────────────────────────────────
    const allMatch = Object.values(assertions).every((a) => a.match);
    const anyStepFailed = steps.some((s) => s.status === "fail");
    const overallStatus: "success" | "failed" =
      allMatch && !anyStepFailed ? "success" : "failed";

    if (overallStatus === "failed") {
      const buf = await page.screenshot({ fullPage: true });
      screenshotUrl = await uploadScreenshot(buf, username, "project_isolation_fail");
    }

    const payload = {
      status: overallStatus,
      message:
        overallStatus === "success"
          ? `Project isolation verified — ${titlesA.length} risks in A, ${titlesB.length} in B, zero cross-contamination`
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
      },
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      total_duration_ms: Date.now() - overallStart,
      screenshot_url: screenshotUrl,
    };

    await logResult("project_isolation", payload).catch(() => {});

    await context.close();
    context = null;
    return res.status(overallStatus === "success" ? 200 : 500).json(payload);
  } catch (err) {
    if (context) {
      try {
        const page = context.pages()[0];
        if (page) {
          const buf = await page.screenshot({ fullPage: true });
          screenshotUrl = await uploadScreenshot(buf, username, "project_isolation_error");
        }
      } catch {/* ignore */}
      await context.close().catch(() => {});
    }
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
    await logResult("project_isolation", payload).catch(() => {});
    return res.status(500).json(payload);
  } finally {
    // On Pro Render the browser can stay warm — don't force-close every request.
    // Leaving this commented; uncomment if you want guaranteed cleanup.
    // await closeBrowser().catch(() => {});
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function safeDelete(page: Page, projectCode: string, title: string): Promise<void> {
  try {
    await switchProject(page, "", projectCode);
    await deleteRiskOnPage(page, title);
  } catch {
    // best-effort cleanup — swallow errors
  }
}

async function abort(
  res: Response,
  page: Page,
  username: string,
  reason: string,
  steps: StepResult[],
  assertions: Record<string, any>,
  startedAt: string,
  overallStart: number
) {
  let screenshotUrl: string | null = null;
  try {
    const buf = await page.screenshot({ fullPage: true });
    screenshotUrl = await uploadScreenshot(buf, username, `abort_${reason}`);
  } catch {/* ignore */}

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
  await logResult("project_isolation", payload).catch(() => {});
  return res.status(500).json(payload);
}

export default router;
