// ─── Bulk Operations Route (INT 3.9) — v2 with API auth ──────────────────────
// Schedule-triggered variant of "Webhook Bulk Operations" (spec 13.9).
//
// Validates:
//   Batch A — 10 valid risks  → all 201, UI count == 10
//   Batch B — 100 valid risks → all 201, spot-check first/middle/last
//   Batch C — 10 valid + 3 invalid → valid pass, invalid rejected with errors
//   Cleanup — every captured id deleted; orphan prefixes purged too

import { BrowserContext, Page } from "playwright";
import { config } from "../server";
import { createContextAndLogin } from "../services/loginService";
import { safeClose } from "../services/browserManager";
import { captureFailure } from "../utils/screenshot";
import {
  buildRiskPayload,
  buildInvalidPayload,
  authenticateApi,
  createRisk,
  deleteRisk,
  purgeRisksByPrefix,
  sleep,
  invalidateApiAuth,
  ApiAuth,
} from "../services/riskApiClient";

const PREFIX_A = "INT39A-RISK-";
const PREFIX_B = "INT39B-RISK-";
const PREFIX_C = "INT39C-RISK-";
const PAUSE_MS = 100;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BulkOperationsInput {
  username: string;
  password: string;
}

interface BatchOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
  ids: string[];
  failures: Array<{ index: number; status: number; error?: string }>;
}

export interface BulkOperationsResult {
  status: "pass" | "fail" | "error";
  message: string;
  username: string;
  pre_cleanup: { a: any; b: any; c: any };
  batch_a: { attempted: number; succeeded: number; failed: number; ui_count: number };
  batch_b: {
    attempted: number;
    succeeded: number;
    failed: number;
    spot_check: { first: boolean; middle: boolean; last: boolean };
  };
  batch_c: {
    valid_succeeded: number;
    valid_failed: number;
    invalid_rejected: number;
    invalid_results: Array<{ variant: string; status: number; rejected: boolean; error?: string }>;
  };
  cleanup: { ids_total: number; deleted: number; failed: number; final_purge: any };
  assertions: Record<string, boolean>;
  screenshots: { failure: string | null };
}

// ─── Batch Runners ───────────────────────────────────────────────────────────

async function runValidBatch(
  page: Page,
  prefix: string,
  runTs: number,
  count: number,
  auth: ApiAuth
): Promise<BatchOutcome> {
  const out: BatchOutcome = { attempted: count, succeeded: 0, failed: 0, ids: [], failures: [] };
  for (let i = 0; i < count; i++) {
    const title = `${prefix}${runTs}-${i}`;
    const payload = buildRiskPayload({ title });
    const r = await createRisk(page, payload, auth);
    if (r.ok) {
      const id = String(r.body?.id ?? r.body?.uuid ?? "");
      if (id) out.ids.push(id);
      out.succeeded++;
    } else {
      out.failed++;
      out.failures.push({ index: i, status: r.status, error: r.error });
    }
    if (i % 25 === 24) console.log(`[INT39]   ...${prefix} ${i + 1}/${count}`);
    await sleep(PAUSE_MS);
  }
  return out;
}

async function runPartialFailureBatch(page: Page, prefix: string, runTs: number, auth: ApiAuth) {
  const valid: BatchOutcome = { attempted: 10, succeeded: 0, failed: 0, ids: [], failures: [] };
  const invalidVariants: Array<"empty_title" | "bad_category" | "missing_project"> = [
    "empty_title", "bad_category", "missing_project",
  ];
  const invalid_results: Array<{ variant: string; status: number; rejected: boolean; error?: string }> = [];

  for (let i = 0; i < 10; i++) {
    const title = `${prefix}${runTs}-${i}`;
    const r = await createRisk(page, buildRiskPayload({ title }), auth);
    if (r.ok) {
      const id = String(r.body?.id ?? r.body?.uuid ?? "");
      if (id) valid.ids.push(id);
      valid.succeeded++;
    } else {
      valid.failed++;
      valid.failures.push({ index: i, status: r.status, error: r.error });
    }
    await sleep(PAUSE_MS);
  }

  for (let i = 0; i < invalidVariants.length; i++) {
    const v = invalidVariants[i];
    const r = await createRisk(page, buildInvalidPayload(v, i), auth);
    const rejected = !r.ok && r.status >= 400 && r.status < 500;
    invalid_results.push({
      variant: v,
      status: r.status,
      rejected,
      error: typeof r.body === "object" ? r.body?.message ?? r.body?.error : undefined,
    });
    await sleep(PAUSE_MS);
  }

  return {
    valid,
    invalid_rejected: invalid_results.filter((x) => x.rejected).length,
    invalid_results,
  };
}

// ─── UI Assertions ───────────────────────────────────────────────────────────

async function countRisksInUiByPrefix(page: Page, fullPrefix: string): Promise<number> {
  try {
    await page.goto(config.dashboardUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout,
    });
    await page.waitForTimeout(1_500);
    return await page.evaluate((p) => {
      const text = document.body.innerText ?? "";
      const matches = text.match(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
      return matches ? matches.length : 0;
    }, fullPrefix);
  } catch {
    return -1;
  }
}

async function spotCheckTitles(
  page: Page,
  titles: string[]
): Promise<{ first: boolean; middle: boolean; last: boolean }> {
  try {
    await page.goto(config.dashboardUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout,
    });
    await page.waitForTimeout(1_500);
    const results = await Promise.all(
      titles.map((t) =>
        page.getByText(t, { exact: false }).first().isVisible({ timeout: 8_000 }).catch(() => false)
      )
    );
    return { first: results[0], middle: results[1], last: results[2] };
  } catch {
    return { first: false, middle: false, last: false };
  }
}

// ─── Main Function ───────────────────────────────────────────────────────────

export async function performBulkOperations(input: BulkOperationsInput): Promise<BulkOperationsResult> {
  const runTs = Date.now();
  const allCreatedIds: string[] = [];
  const result: BulkOperationsResult = {
    status: "error",
    message: "",
    username: input.username,
    pre_cleanup: { a: null, b: null, c: null },
    batch_a: { attempted: 0, succeeded: 0, failed: 0, ui_count: 0 },
    batch_b: { attempted: 0, succeeded: 0, failed: 0, spot_check: { first: false, middle: false, last: false } },
    batch_c: { valid_succeeded: 0, valid_failed: 0, invalid_rejected: 0, invalid_results: [] },
    cleanup: { ids_total: 0, deleted: 0, failed: 0, final_purge: null },
    assertions: {},
    screenshots: { failure: null },
  };
  let context: BrowserContext | null = null;

  try {
    const session = await createContextAndLogin(input.username, input.password);
    context = session.context;
    const page = session.page;

    // API auth — fetch token + csrfToken
    const auth = await authenticateApi(page, input.username, input.password);

    // ── Pre-cleanup of all three prefixes ──
    result.pre_cleanup = {
      a: await purgeRisksByPrefix(page, PREFIX_A, auth),
      b: await purgeRisksByPrefix(page, PREFIX_B, auth),
      c: await purgeRisksByPrefix(page, PREFIX_C, auth),
    };

    // ── Batch A — 10 valid risks ──
    console.log(`[INT39] Batch A starting (10 risks)`);
    const batchA = await runValidBatch(page, PREFIX_A, runTs, 10, auth);
    allCreatedIds.push(...batchA.ids);
    const uiCountA = await countRisksInUiByPrefix(page, `${PREFIX_A}${runTs}-`);
    result.batch_a = {
      attempted: batchA.attempted,
      succeeded: batchA.succeeded,
      failed: batchA.failed,
      ui_count: uiCountA,
    };
    console.log(`[INT39] Batch A done — created ${batchA.succeeded}/10, UI count ${uiCountA}`);

    // ── Batch B — 100 valid risks ──
    console.log(`[INT39] Batch B starting (100 risks)`);
    const batchB = await runValidBatch(page, PREFIX_B, runTs, 100, auth);
    allCreatedIds.push(...batchB.ids);
    const spotCheckB = await spotCheckTitles(page, [
      `${PREFIX_B}${runTs}-0`,
      `${PREFIX_B}${runTs}-49`,
      `${PREFIX_B}${runTs}-99`,
    ]);
    result.batch_b = {
      attempted: batchB.attempted,
      succeeded: batchB.succeeded,
      failed: batchB.failed,
      spot_check: spotCheckB,
    };
    console.log(`[INT39] Batch B done — created ${batchB.succeeded}/100`);

    // ── Batch C — partial failure ──
    console.log(`[INT39] Batch C starting (10 valid + 3 invalid)`);
    const batchC = await runPartialFailureBatch(page, PREFIX_C, runTs, auth);
    allCreatedIds.push(...batchC.valid.ids);
    result.batch_c = {
      valid_succeeded: batchC.valid.succeeded,
      valid_failed: batchC.valid.failed,
      invalid_rejected: batchC.invalid_rejected,
      invalid_results: batchC.invalid_results,
    };
    console.log(`[INT39] Batch C done — valid ${batchC.valid.succeeded}/10, invalid rejected ${batchC.invalid_rejected}/3`);

    // ── Cleanup ──
    console.log(`[INT39] Cleanup starting — ${allCreatedIds.length} ids`);
    let cleanupDeleted = 0;
    let cleanupFailed = 0;
    for (const id of allCreatedIds) {
      const d = await deleteRisk(page, id, auth);
      if (d.ok) cleanupDeleted++; else cleanupFailed++;
      await sleep(50);
    }
    const finalPurge = {
      a: await purgeRisksByPrefix(page, PREFIX_A, auth),
      b: await purgeRisksByPrefix(page, PREFIX_B, auth),
      c: await purgeRisksByPrefix(page, PREFIX_C, auth),
    };
    result.cleanup = {
      ids_total: allCreatedIds.length,
      deleted: cleanupDeleted,
      failed: cleanupFailed,
      final_purge: finalPurge,
    };
    console.log(`[INT39] Cleanup done — deleted ${cleanupDeleted}, failed ${cleanupFailed}`);

    // ── Assertions ──
    result.assertions = {
      batch_a_all_succeeded: batchA.succeeded === 10,
      batch_a_ui_count_match: uiCountA === 10,
      batch_b_all_succeeded: batchB.succeeded === 100,
      batch_b_spot_check_pass: spotCheckB.first && spotCheckB.middle && spotCheckB.last,
      batch_c_valid_pass: batchC.valid.succeeded === 10,
      batch_c_invalid_rejected: batchC.invalid_rejected === 3,
      cleanup_complete: cleanupFailed === 0,
    };
    const allPass = Object.values(result.assertions).every(Boolean);
    result.status = allPass ? "pass" : "fail";
    result.message = allPass
      ? "All bulk operation assertions passed"
      : `Failed assertions: ${Object.entries(result.assertions).filter(([_, v]) => !v).map(([k]) => k).join(", ")}`;

    if (!allPass) {
      result.screenshots.failure = await captureFailure(context, "int39_failed");
    }
    console.log(`[INT39] === RESULT: ${result.status.toUpperCase()} ===`);
    return result;
  } catch (err) {
    result.screenshots.failure = await captureFailure(context, "int39_error");
    result.status = "error";
    result.message = (err as Error).message;
    console.log(`[INT39] Error: ${result.message}`);
    if (result.message.toLowerCase().includes("api login")) invalidateApiAuth();
    return result;
  } finally {
    await safeClose(context);
  }
}
