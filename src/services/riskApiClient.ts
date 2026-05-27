// ─────────────────────────────────────────────────────────────────────────────
// riskApiClient.ts
//
// In-browser fetch helpers for the Captus /api/risks endpoint.
//
// Why in-browser fetch (not Node http client)?
//   - Captus uses three layered credentials: JWT (localStorage),
//     session cookie (HttpOnly), and a CSRF token returned as a
//     response header on authenticated calls.
//   - Letting the live Playwright page issue the fetch means the SPA's
//     own request interceptors auto-attach all three. Zero token plumbing.
//   - Trade-off: this is a "user-via-browser" test, not a pure external-
//     client test. Functionally equivalent for INT 3.1 / 3.9 assertions.
//
// Used by:
//   - routes/testRiskIngestion.ts   (INT 3.1)
//   - routes/testBulkOperations.ts  (INT 3.9)
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RiskPayload {
  title: string;
  description: string;
  category: string;        // e.g. "Technical"
  impact: number;          // 1..5
  likelihood: number;      // 1..5
  score: number;           // impact * likelihood
  dueDate: string;         // ISO timestamp
  mitigationPlan: string;
  owner: string;
  potentialCost: string;   // numeric string, e.g. "100000.00"
  projectName: string;
  projectUuid: string;
  status: string;          // "open"
}

export interface ApiCallResult {
  ok: boolean;
  status: number;
  body: any;
  error?: string;
  duration_ms: number;
}

// ─── Payload factory ─────────────────────────────────────────────────────────

const PROJECT_TEST_UUID = "061197b1-546e-4ab7-81b3-43c015db6ece";
const PROJECT_TEST_NAME = "Test";

/**
 * Build a complete risk payload from minimal inputs.
 * Score is always derived from impact * likelihood for safety.
 * Due date defaults to 7 days from now.
 */
export function buildRiskPayload(opts: {
  title: string;
  impact?: number;
  likelihood?: number;
  description?: string;
  projectUuid?: string;
  projectName?: string;
}): RiskPayload {
  const impact = opts.impact ?? 3;
  const likelihood = opts.likelihood ?? 4;
  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  return {
    title: opts.title,
    description: opts.description ?? "Created by integration test automation",
    category: "Technical",
    impact,
    likelihood,
    score: impact * likelihood,
    dueDate,
    mitigationPlan: "Auto-generated test risk — safe to delete",
    owner: "QA Bot",
    potentialCost: "100000.00",
    projectName: opts.projectName ?? PROJECT_TEST_NAME,
    projectUuid: opts.projectUuid ?? PROJECT_TEST_UUID,
    status: "open",
  };
}

/**
 * Build a deliberately INVALID payload for partial-failure testing (INT 3.9 Batch C).
 * Variant selects which validation rule to break.
 */
export function buildInvalidPayload(
  variant: "empty_title" | "bad_category" | "missing_project",
  index: number
): Partial<RiskPayload> {
  const base = buildRiskPayload({ title: `INVALID-${variant}-${index}` });

  switch (variant) {
    case "empty_title":
      return { ...base, title: "" };
    case "bad_category":
      return { ...base, category: "NOT_A_REAL_CATEGORY_xyz" };
    case "missing_project":
      const { projectUuid, projectName, ...withoutProject } = base;
      return withoutProject;
  }
}

// ─── Core fetch helpers (executed inside the browser context) ────────────────

/**
 * POST /api/risks via the live SPA's fetch. Inherits JWT + cookie + CSRF.
 */
export async function createRisk(
  page: Page,
  payload: Partial<RiskPayload>
): Promise<ApiCallResult> {
  const start = Date.now();
  try {
    const result = await page.evaluate(async (body) => {
      try {
        const res = await fetch("/api/risks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        return { status: res.status, body: parsed };
      } catch (e: any) {
        return { status: 0, body: null, error: String(e?.message ?? e) };
      }
    }, payload as any);

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      body: result.body,
      error: (result as any).error,
      duration_ms: Date.now() - start,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: String(e?.message ?? e),
      duration_ms: Date.now() - start,
    };
  }
}

/**
 * DELETE /api/risks/<id> via the live SPA's fetch.
 */
export async function deleteRisk(page: Page, id: string): Promise<ApiCallResult> {
  const start = Date.now();
  try {
    const result = await page.evaluate(async (riskId) => {
      try {
        const res = await fetch(`/api/risks/${encodeURIComponent(riskId)}`, {
          method: "DELETE",
          credentials: "include",
        });
        let parsed: any = null;
        try { parsed = await res.json(); } catch { /* empty body is fine */ }
        return { status: res.status, body: parsed };
      } catch (e: any) {
        return { status: 0, body: null, error: String(e?.message ?? e) };
      }
    }, id);

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      body: result.body,
      error: (result as any).error,
      duration_ms: Date.now() - start,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: String(e?.message ?? e),
      duration_ms: Date.now() - start,
    };
  }
}

/**
 * GET /api/risks (list) — used by pre-cleanup to find orphan test data.
 * Returns the array of risks for the currently selected project.
 */
export async function listRisks(page: Page): Promise<ApiCallResult> {
  const start = Date.now();
  try {
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch("/api/risks", {
          method: "GET",
          credentials: "include",
        });
        const text = await res.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        return { status: res.status, body: parsed };
      } catch (e: any) {
        return { status: 0, body: null, error: String(e?.message ?? e) };
      }
    });

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      body: result.body,
      error: (result as any).error,
      duration_ms: Date.now() - start,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: String(e?.message ?? e),
      duration_ms: Date.now() - start,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pause between calls — politeness for the server during 100-row bulk loops.
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pre-cleanup: delete any pre-existing risks whose title matches a prefix.
 * Makes each test run idempotent regardless of how the previous one ended.
 */
export async function purgeRisksByPrefix(
  page: Page,
  prefix: string
): Promise<{ found: number; deleted: number; failed: number }> {
  const listed = await listRisks(page);
  if (!listed.ok || !Array.isArray(listed.body)) {
    return { found: 0, deleted: 0, failed: 0 };
  }

  const matches = listed.body.filter(
    (r: any) => typeof r?.title === "string" && r.title.startsWith(prefix)
  );

  let deleted = 0;
  let failed = 0;
  for (const r of matches) {
    const id = r?.id ?? r?.uuid;
    if (!id) { failed++; continue; }
    const result = await deleteRisk(page, String(id));
    if (result.ok) deleted++; else failed++;
    await sleep(50);
  }

  return { found: matches.length, deleted, failed };
}
