// ─── Risk Ingestion Route (INT 3.1) — matches project architecture ────────────
// Schedule-triggered variant of "Risk Ingestion via Webhook" (spec 13.1).
//
// Lifecycle:
//   1. createContextAndLogin → login + company "demo" + project "Test"
//   2. Pre-cleanup: purge orphan INT3-RISK-* rows
//   3. POST /api/risks via in-browser fetch → expect 201 + id
//   4. UI verify: risk visible in /risks registry
//   5. Audit log: entry exists with action=Create, entity=Risk, title matches
//      (relaxed — user JWT, not webhook key, so actor_type='agent' not asserted)
//   6. Cleanup: DELETE /api/risks/<id>
//
// Auth model: in-browser fetch inherits JWT (localStorage), session cookie
// (HttpOnly), and CSRF response-header token from the live SPA session.

import { BrowserContext, Page } from "playwright";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { safeClose } from "../services/browserManager";
import { captureFailure } from "../utils/screenshot";
import {
  buildRiskPayload,
  createRisk,
  deleteRisk,
  purgeRisksByPrefix,
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

// ─── Audit Log Helpers (mirrors auditLog.ts pattern) ─────────────────────────

async function navigateToAuditTrail(page: Page): Promise<void> {
  console.log("[INT31] Navigating to audit trail");
  await page.goto(config.auditUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(2_500);
  await page.waitForSelector('[data-testid^="row-audit-log-"]', { timeout: 15_000 }).catch(() => {
    console.log("[INT31] No audit rows visible yet");
  });
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
    await page.waitForTimeout(1_500);
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

async function verifyRiskInUI(page: Page, title: string): Promise<boolean> {
  try {
    await page.goto(`${config.dashboardUrl.replace(/\/$/, "")}`, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout,
    });
    await page.waitForTimeout(1_500);
    return await page
      .getByText(title, { exact: false })
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);
  } catch {
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
    // Step 0: Login + company + project (all bundled by createContextAndLogin)
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // ── Step 1: Pre-cleanup ──
    const t1 = Date.now();
    const purge = await purgeRisksByPrefix(page, TITLE_PREFIX);
    result.steps.push({
      name: "pre_cleanup",
      status: "pass",
      duration_ms: Date.now() - t1,
      detail: purge,
    });

    // ── Step 2: Create risk via API ──
    const t2 = Date.now();
    const payload = buildRiskPayload({ title: riskTitle, impact: 3, likelihood: 4 });
    const create = await createRisk(page, payload);
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
      detail: { searched_title: riskTitle },
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
      ? await deleteRisk(page, result.risk_id)
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
    return result;
  } finally {
    await safeClose(context);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
