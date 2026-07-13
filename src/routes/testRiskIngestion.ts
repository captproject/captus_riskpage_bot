// ─── Risk Ingestion Route (INT 3.1) — v3 ─────────────────────────────────────
// Schedule-triggered variant of "Risk Ingestion via Webhook" (spec 13.1).
//
// v3 changes:
//   - UI verification now navigates to config.tableUrl (the actual risk
//     registry) instead of config.dashboardUrl (a summary page that has
//     no risk list). Previous version was looking at the wrong page.
//   - UI verification now includes a search-by-title step + one retry
//     with hard reload to tolerate UI cache lag.

import { BrowserContext, Page } from "playwright";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { safeClose } from "../services/browserManager";
import { captureFailure } from "../utils/screenshot";
import {
  buildRiskPayload,
  authenticateApi,
  createRisk,
  deleteRisk,
  purgeRisksByPrefix,
  invalidateApiAuth,
} from "../services/riskApiClient";

const TITLE_PREFIX = "INT3-RISK-";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RiskIngestionInput {
  username: string;
  password: string;
}

export interface RiskIngestionStep {
  name: string;
  status: "pass" | "fail" | "skip";
  duration_ms: number;
  detail?: any;
  error?: string;
}

export interface RiskIngestionResult {
  status: "pass" | "fail" | "error";
  message: string;
  username: string;
  risk_id: string | null;
  risk_title: string;
  total_steps: number;
  passed: number;
  failed: number;
  steps_summary: string;
  steps: RiskIngestionStep[];
  screenshots: { failure: string | null };
}

// ─── UI Verification (v3 — tableUrl + search + retry) ────────────────────────

async function searchRiskInTable(page: Page, title: string): Promise<boolean> {
  try {
    // Try the search input on the table page if it exists
    const searchInput = page
      .getByPlaceholder(/search/i)
      .or(page.locator('input[type="search"]'))
      .or(page.locator('[data-testid="input-search"]'))
      .first();
    const visible = await searchInput.isVisible({ timeout: 3_000 }).catch(() => false);
    if (visible) {
      await searchInput.fill(title);
      await page.waitForTimeout(1_500);
    }
    // Whether or not search was filled, look for the title anywhere on the page
    return await page
      .getByText(title, { exact: false })
      .first()
      .isVisible({ timeout: 8_000 })
      .catch(() => false);
  } catch {
    return false;
  }
}

async function verifyRiskInUI(page: Page, title: string): Promise<boolean> {
  // First attempt — normal navigation
  try {
    await page.goto(config.tableUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeout,
    });
    await page.waitForTimeout(2_000);
    const found = await searchRiskInTable(page, title);
    if (found) return true;

    // Second attempt — hard reload (defeats cache)
    console.log("[INT31] UI verify miss — retrying with reload");
    await page.reload({ waitUntil: "domcontentloaded", timeout: config.navigationTimeout });
    await page.waitForTimeout(2_000);
    return await searchRiskInTable(page, title);
  } catch (err) {
    console.log(`[INT31] verifyRiskInUI error: ${(err as Error).message}`);
    return false;
  }
}

// ─── Audit Log Helpers (mirrors auditLog.ts) ─────────────────────────────────

async function navigateToAuditTrail(page: Page): Promise<void> {
  console.log("[INT31] Navigating to audit trail");
  await page.goto(config.auditUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await waitForAuditTableSettled(page);
  await page.waitForSelector('[data-testid^="row-audit-log-"]', { timeout: 15_000 }).catch(() => {
    console.log("[INT31] No audit rows visible yet");
  });
}

/**
 * v2 (2026-07-13, Vercel/Render migration): filter changes now trigger a
 * cross-origin fetch to the Render backend; the old fixed 1.5s wait counted
 * rows while the table still showed "Loading audit logs...", reading 0.
 * Wait for the loading indicator to clear before counting.
 */
async function waitForAuditTableSettled(page: Page, timeoutMs = 20_000): Promise<void> {
  const loading = page.getByText(/loading audit logs/i).first();
  await loading.waitFor({ state: "visible", timeout: 2_000 }).catch(() => {});
  const stillLoading = await loading.isVisible().catch(() => false);
  if (stillLoading) {
    await loading.waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => {
      console.log("[INT31] Loading indicator still visible after wait — counting anyway");
    });
  }
  await page.waitForTimeout(500);
}

async function applyCreateActionFilter(page: Page): Promise<void> {
  try {
    const filterToggle = page.getByTestId("button-toggle-filters");
    const toggleVisible = await filterToggle.isVisible().catch(() => false);
    if (toggleVisible) {
      const dropdownVisible = await page.getByTestId("select-filter-action").isVisible().catch(() => false);
      if (!dropdownVisible) {
        await filterToggle.click();
        await page.waitForTimeout(1_000);
      }
    }
    const trigger = page.getByTestId("select-filter-action");
    await trigger.waitFor({ state: "visible", timeout: 5_000 });
    await trigger.click();
    await page.waitForTimeout(500);
    const option = page.getByRole("option", { name: "Create", exact: true });
    await option.waitFor({ state: "visible", timeout: 3_000 });
    await option.click();
    await waitForAuditTableSettled(page);
    console.log(`[INT31] Applied Create filter`);
  } catch (err) {
    console.log(`[INT31] Failed to apply filter: ${(err as Error).message}`);
  }
}

async function verifyCreateInAuditLog(page: Page, title: string): Promise<boolean> {
  try {
    await navigateToAuditTrail(page);
    await applyCreateActionFilter(page);
    const rows = page.locator('[data-testid^="row-audit-log-"]');
    const rowCount = await rows.count();
    console.log(`[INT31] Audit: ${rowCount} rows visible after Create filter`);
    if (rowCount === 0) return false;

    for (let i = 0; i < Math.min(rowCount, 20); i++) {
      const row = rows.nth(i);
      const summaryText = (await row.locator("td:nth-child(5)").textContent().catch(() => "")) || "";
      if (summaryText.toLowerCase().includes(title.toLowerCase())) {
        const action = ((await row.locator("td:nth-child(3)").textContent().catch(() => "")) || "").trim();
        const entityEl = row.locator("td:nth-child(4) .capitalize").first();
        const entity = ((await entityEl.textContent().catch(() => "")) || "").trim();
        const actionMatch = action.toLowerCase() === "create";
        const entityMatch = entity.toLowerCase() === "risk";
        console.log(`[INT31] Audit row matched: action="${action}"(${actionMatch ? "✅" : "❌"}) entity="${entity}"(${entityMatch ? "✅" : "❌"})`);
        return actionMatch && entityMatch;
      }
    }
    console.log(`[INT31] Audit: no row contains title "${title}"`);
    return false;
  } catch (err) {
    console.log(`[INT31] Audit verify error: ${(err as Error).message}`);
    return false;
  }
}

// ─── Main Function ───────────────────────────────────────────────────────────

export async function performRiskIngestion(input: RiskIngestionInput): Promise<RiskIngestionResult> {
  const riskTitle = `${TITLE_PREFIX}${Date.now()}`;
  const result: RiskIngestionResult = {
    status: "error",
    message: "",
    username: input.username,
    risk_id: null,
    risk_title: riskTitle,
    total_steps: 5,
    passed: 0,
    failed: 0,
    steps_summary: "",
    steps: [],
    screenshots: { failure: null },
  };
  let context: BrowserContext | null = null;

  try {
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;
    const auth = await authenticateApi(page, input.username, input.password);

    // ── Step 1: Pre-cleanup ──
    const t1 = Date.now();
    const purge = await purgeRisksByPrefix(page, TITLE_PREFIX, auth);
    result.steps.push({
      name: "pre_cleanup",
      status: "pass",
      duration_ms: Date.now() - t1,
      detail: purge,
    });

    // ── Step 2: Create risk via API ──
    const t2 = Date.now();
    const payload = buildRiskPayload({ title: riskTitle, impact: 3, likelihood: 4 });
    const create = await createRisk(page, payload, auth);
    const createStep: RiskIngestionStep = {
      name: "api_create_risk",
      status: create.ok ? "pass" : "fail",
      duration_ms: Date.now() - t2,
      detail: { http_status: create.status, response_id: create.body?.id ?? null },
    };
    if (!create.ok) createStep.error = create.error ?? `HTTP ${create.status}`;
    result.steps.push(createStep);

    if (!create.ok) {
      result.screenshots.failure = await captureFailure(context, "int31_create_fail");
      return finalize(result, "API create failed");
    }
    result.risk_id = String(create.body?.id ?? create.body?.uuid ?? "");

    // ── Step 3: UI verification ──
    const t3 = Date.now();
    const uiVisible = await verifyRiskInUI(page, riskTitle);
    result.steps.push({
      name: "ui_verify",
      status: uiVisible ? "pass" : "fail",
      duration_ms: Date.now() - t3,
      detail: { searched_title: riskTitle, page: config.tableUrl },
    });

    // ── Step 4: Audit log verification ──
    const t4 = Date.now();
    const auditMatch = await verifyCreateInAuditLog(page, riskTitle);
    result.steps.push({
      name: "audit_log_verify",
      status: auditMatch ? "pass" : "fail",
      duration_ms: Date.now() - t4,
      detail: { searched_title: riskTitle, assertion: "action=Create, entity=Risk" },
    });

    // ── Step 5: Cleanup ──
    const t5 = Date.now();
    const del = result.risk_id
      ? await deleteRisk(page, result.risk_id, auth)
      : { ok: false, status: 0, body: null, duration_ms: 0 };
    result.steps.push({
      name: "cleanup",
      status: del.ok ? "pass" : "fail",
      duration_ms: Date.now() - t5,
      detail: { http_status: del.status, risk_id: result.risk_id },
    });

    // ── Tally ──
    result.passed = result.steps.filter((s) => s.status === "pass").length;
    result.failed = result.steps.filter((s) => s.status === "fail").length;
    result.status = result.failed === 0 ? "pass" : "fail";
    result.steps_summary = result.steps
      .map((s) => `${s.name}:${s.status === "pass" ? "✅" : "❌"}`)
      .join(" ");
    result.message = result.steps_summary;

    if (result.failed > 0 && !result.screenshots.failure) {
      result.screenshots.failure = await captureFailure(context, "int31_step_fail");
    }
    console.log(`[INT31] === RESULT: ${result.status.toUpperCase()} (${result.passed}/${result.total_steps}) ===`);
    return result;
  } catch (err) {
    result.screenshots.failure = await captureFailure(context, "int31_error");
    result.status = "error";
    result.message = (err as Error).message;
    console.log(`[INT31] Error: ${result.message}`);
    if (result.message.toLowerCase().includes("api login")) invalidateApiAuth();
    return result;
  } finally {
    await safeClose(context);
  }
}

function finalize(result: RiskIngestionResult, message: string): RiskIngestionResult {
  result.passed = result.steps.filter((s) => s.status === "pass").length;
  result.failed = result.steps.filter((s) => s.status === "fail").length;
  result.status = result.failed === 0 ? "pass" : "fail";
  result.steps_summary = result.steps
    .map((s) => `${s.name}:${s.status === "pass" ? "✅" : "❌"}`)
    .join(" ");
  result.message = `${message} — ${result.steps_summary}`;
  return result;
}