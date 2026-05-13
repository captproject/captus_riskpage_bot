// ─────────────────────────────────────────────────────────────────────────────
// injectionCleanup.ts
// SEC-11 helper: removes all risks created during the test run.
//
// Strategy:
//   1. Navigate to /risks
//   2. Search for "INJECTION_TEST_" (our prefix)
//   3. For each matching row, click → delete
//   4. Loop until search returns empty
//
// Best-effort: cleanup failures don't fail the security test itself.
// They're logged so we know to investigate orphans manually.
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";
import { searchRisk, deleteRiskFromTable } from "./riskHelpers";

const CLEANUP_PREFIX = "INJECTION_TEST_";
const MAX_SWEEP_ITERATIONS = 25; // safety cap — never loop infinitely

export interface CleanupResult {
  attempted: number;
  succeeded: number;
  failed_titles: string[];
  duration_ms: number;
}

/**
 * Delete every test risk we know we created.
 *
 * The caller passes the array of titles it actually used. We delete each
 * one explicitly rather than scanning the table — that's safer (no risk of
 * accidentally nuking something with a similar prefix that wasn't ours).
 */
export async function cleanupInjectionRisks(
  page: Page,
  createdTitles: string[]
): Promise<CleanupResult> {
  const start = Date.now();
  const result: CleanupResult = {
    attempted: createdTitles.length,
    succeeded: 0,
    failed_titles: [],
    duration_ms: 0,
  };

  for (const title of createdTitles) {
    try {
      const ok = await deleteRiskFromTable(page, title);
      if (ok) {
        result.succeeded++;
      } else {
        // Maybe creation failed and there's nothing to delete — verify
        const stillThere = await searchRisk(page, title).catch(() => false);
        if (stillThere) {
          result.failed_titles.push(title);
        } else {
          // Wasn't there anyway → not a real failure
          result.succeeded++;
        }
      }
    } catch (err) {
      console.log(`[Cleanup] Error deleting "${title}": ${(err as Error).message}`);
      result.failed_titles.push(title);
    }
  }

  result.duration_ms = Date.now() - start;
  console.log(
    `[Cleanup] ${result.succeeded}/${result.attempted} deleted (${result.failed_titles.length} failed) in ${result.duration_ms}ms`
  );
  return result;
}

export { CLEANUP_PREFIX, MAX_SWEEP_ITERATIONS };
