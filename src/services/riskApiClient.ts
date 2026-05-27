// ─────────────────────────────────────────────────────────────────────────────
// riskApiClient.ts  (v2 — Approach B: API-level auth)
//
// In-browser fetch helpers for the Captus /api/risks endpoint.
//
// Auth model:
//   The Captus SPA's request interceptor injects two headers on every
//   write that we cannot replicate from a plain page.evaluate(fetch):
//     - Authorization: Bearer <jwt>     (from localStorage.captus_auth_token)
//     - x-csrf-token:  <csrfToken>      (held in SPA memory, never persisted)
//
//   The CSRF token comes from the POST /api/auth/login RESPONSE BODY,
//   field `csrfToken`. Same response also contains `token` (the JWT).
//
//   So this client performs its OWN /api/auth/login call up front,
//   captures both tokens from the response body, and explicitly attaches
//   them as headers on every subsequent risk-API call.
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

export interface ApiAuth {
  token: string;        // JWT for Authorization: Bearer header
  csrfToken: string;    // for x-csrf-token header
  userId: string;
  acquiredAt: number;   // epoch ms — for staleness check
}

export interface ApiCallResult {
  ok: boolean;
  status: number;
  body: any;
  error?: string;
  duration_ms: number;
}

// ─── Auth cache ──────────────────────────────────────────────────────────────
// One process-wide cache. Reuses tokens across back-to-back tests so the
// 2-test n8n workflow (INT 3.1 → INT 3.9) doesn't login to the API twice.

const AUTH_TTL_MS = 5 * 60 * 1000;   // 5 min safety margin (JWT itself lasts 7d)
let cachedAuth: ApiAuth | null = null;

export function invalidateApiAuth(): void {
  cachedAuth = null;
}

/**
 * POST /api/auth/login from inside the Playwright page context.
 * Captures `token` + `csrfToken` from the response body.
 * Returns cached auth if still within TTL.
 */
export async function authenticateApi(
  page: Page,
  username: string,
  password: string
): Promise<ApiAuth> {
  if (
    cachedAuth &&
    Date.now() - cachedAuth.acquiredAt < AUTH_TTL_MS
  ) {
    console.log("[ApiAuth] Reusing cached auth");
    return cachedAuth;
  }

  console.log("[ApiAuth] Logging in via /api/auth/login");
  const result = await page.evaluate(
    async ({ u, p }) => {
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email: u, password: p }),
        });
        const text = await res.text();
        let body: any = null;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: res.status, body };
      } catch (e: any) {
        return { status: 0, body: null, error: String(e?.message ?? e) };
      }
    },
    { u: username, p: password }
  );

  if (result.status !== 200 || !result.body?.token || !result.body?.csrfToken) {
    const detail = JSON.stringify(result).slice(0, 200);
    throw new Error(`API login failed: HTTP ${result.status} — ${detail}`);
  }

  cachedAuth = {
    token: result.body.token,
    csrfToken: result.body.csrfToken,
    userId: result.body.id ?? result.body.userId ?? "",
    acquiredAt: Date.now(),
  };
  console.log(`[ApiAuth] Acquired token + csrfToken for userId=${cachedAuth.userId}`);
  return cachedAuth;
}

// ─── Payload factory ─────────────────────────────────────────────────────────

const PROJECT_TEST_UUID = "061197b1-546e-4ab7-81b3-43c015db6ece";
const PROJECT_TEST_NAME = "Test";

/**
 * Build a complete risk payload from minimal inputs.
 * Score is always derived from impact * likelihood.
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

// ─── Core fetch helpers (with auth headers attached) ─────────────────────────

/**
 * POST /api/risks with Bearer + CSRF headers.
 */
export async function createRisk(
  page: Page,
  payload: Partial<RiskPayload>,
  auth: ApiAuth
): Promise<ApiCallResult> {
  const start = Date.now();
  try {
    const result = await page.evaluate(
      async ({ body, token, csrf }) => {
        try {
          const res = await fetch("/api/risks", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
              "x-csrf-token": csrf,
            },
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
      },
      { body: payload as any, token: auth.token, csrf: auth.csrfToken }
    );

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
 * DELETE /api/risks/<id> with Bearer + CSRF headers.
 */
export async function deleteRisk(
  page: Page,
  id: string,
  auth: ApiAuth
): Promise<ApiCallResult> {
  const start = Date.now();
  try {
    const result = await page.evaluate(
      async ({ riskId, token, csrf }) => {
        try {
          const res = await fetch(`/api/risks/${encodeURIComponent(riskId)}`, {
            method: "DELETE",
            headers: {
              "Authorization": `Bearer ${token}`,
              "x-csrf-token": csrf,
            },
            credentials: "include",
          });
          let parsed: any = null;
          try { parsed = await res.json(); } catch { /* empty body fine */ }
          return { status: res.status, body: parsed };
        } catch (e: any) {
          return { status: 0, body: null, error: String(e?.message ?? e) };
        }
      },
      { riskId: id, token: auth.token, csrf: auth.csrfToken }
    );

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
 * GET /api/risks (list) for pre-cleanup. Bearer header sufficient — no CSRF on reads.
 */
export async function listRisks(page: Page, auth: ApiAuth): Promise<ApiCallResult> {
  const start = Date.now();
  try {
    const result = await page.evaluate(
      async ({ token }) => {
        try {
          const res = await fetch("/api/risks", {
            method: "GET",
            headers: { "Authorization": `Bearer ${token}` },
            credentials: "include",
          });
          const text = await res.text();
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          return { status: res.status, body: parsed };
        } catch (e: any) {
          return { status: 0, body: null, error: String(e?.message ?? e) };
        }
      },
      { token: auth.token }
    );

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

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pre-cleanup: delete any pre-existing risks whose title matches a prefix.
 * Makes each test run idempotent regardless of how the previous one ended.
 */
export async function purgeRisksByPrefix(
  page: Page,
  prefix: string,
  auth: ApiAuth
): Promise<{ found: number; deleted: number; failed: number }> {
  const listed = await listRisks(page, auth);
  if (!listed.ok) {
    return { found: 0, deleted: 0, failed: 0 };
  }

  // API can return either an array OR { risks: [...] } depending on endpoint shape
  const all: any[] = Array.isArray(listed.body)
    ? listed.body
    : (listed.body?.risks ?? listed.body?.data ?? []);

  const matches = all.filter(
    (r: any) => typeof r?.title === "string" && r.title.startsWith(prefix)
  );

  let deleted = 0;
  let failed = 0;
  for (const r of matches) {
    const id = r?.id ?? r?.uuid;
    if (!id) { failed++; continue; }
    const result = await deleteRisk(page, String(id), auth);
    if (result.ok) deleted++; else failed++;
    await sleep(50);
  }

  return { found: matches.length, deleted, failed };
}
