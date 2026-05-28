// ─────────────────────────────────────────────────────────────────────────────
// riskApiClient.ts  (v3)
//
// In-browser fetch helpers for the Captus /api/risks endpoint.
//
// Auth model (Approach B): the SPA's request interceptor injects
//   - Authorization: Bearer <jwt>   (from localStorage.captus_auth_token)
//   - x-csrf-token:  <csrfToken>    (held in SPA memory, never persisted)
//
// Both tokens come from POST /api/auth/login response body (fields
// `token` and `csrfToken`). This client performs its own /api/auth/login
// and attaches both headers explicitly on writes.
//
// v3 changes:
//   - Invalid-variant payloads swapped to ones that actually fail server validation.
//     Previous variants (bad_category, missing_project) were accepted by Captus,
//     leaving orphan rows. New variants stress validators we know exist.
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RiskPayload {
  title: string;
  description: string;
  category: string;
  impact: number;
  likelihood: number;
  score: number;
  dueDate: string;
  mitigationPlan: string;
  owner: string;
  potentialCost: string;
  projectName: string;
  projectUuid: string;
  status: string;
}

export interface ApiAuth {
  token: string;
  csrfToken: string;
  userId: string;
  acquiredAt: number;
}

export interface ApiCallResult {
  ok: boolean;
  status: number;
  body: any;
  error?: string;
  duration_ms: number;
}

// ─── Auth cache ──────────────────────────────────────────────────────────────

const AUTH_TTL_MS = 5 * 60 * 1000;
let cachedAuth: ApiAuth | null = null;

export function invalidateApiAuth(): void {
  cachedAuth = null;
}

export async function authenticateApi(
  page: Page,
  username: string,
  password: string
): Promise<ApiAuth> {
  if (cachedAuth && Date.now() - cachedAuth.acquiredAt < AUTH_TTL_MS) {
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
 * v4: invalid variants — all confirmed or expected to fail server validation.
 *
 *   empty_title             — title:""        → 400 (title required)         ✅ confirmed 2026-05-27
 *   impact_out_of_range     — impact:99       → 400 (impact must be 1..5)    ✅ confirmed 2026-05-27
 *   likelihood_out_of_range — likelihood:99   → 400 (mirror of impact rule)  expected
 *
 * Variants tried and accepted by Captus (DO NOT REUSE without server fix):
 *   - bad_category        (category: arbitrary string)  → 201
 *   - missing_project     (projectUuid omitted)         → 201
 *   - negative_score      (score: -50)                  → 201
 * These represent real product validation gaps; see findings log.
 */
export function buildInvalidPayload(
  variant: "empty_title" | "impact_out_of_range" | "likelihood_out_of_range",
  index: number
): Partial<RiskPayload> {
  const base = buildRiskPayload({ title: `INVALID-${variant}-${index}` });

  switch (variant) {
    case "empty_title":
      return { ...base, title: "" };
    case "impact_out_of_range":
      return { ...base, impact: 99 };
    case "likelihood_out_of_range":
      return { ...base, likelihood: 99 };
  }
}

// ─── Core fetch helpers ──────────────────────────────────────────────────────

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
      ok: false, status: 0, body: null,
      error: String(e?.message ?? e),
      duration_ms: Date.now() - start,
    };
  }
}

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
      ok: false, status: 0, body: null,
      error: String(e?.message ?? e),
      duration_ms: Date.now() - start,
    };
  }
}

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
      ok: false, status: 0, body: null,
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
  if (!listed.ok) return { found: 0, deleted: 0, failed: 0 };

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
