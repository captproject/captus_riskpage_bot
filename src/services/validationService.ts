// ─── Validation Service ───────────────────────────────────────────────────────
// Centralized 4-layer validation engine.
// Layer 1: Toast detection
// Layer 2: Dashboard search (navigates to dashboard + uses search box)
// Layer 3: Table search (navigates to table + reads row data)
// Layer 4: Field validation (compares input vs table data)

import { Page } from "playwright";
import { ValidationResult, FieldMismatch } from "../utils/types";
import { withRetry } from "../utils/retry";
import { detectToast, searchRiskOnDashboard, readRiskRowFromTable, searchRisk, riskVisibleInPage, normalize } from "./riskHelpers";

export async function validateRiskAction(
  page: Page,
  input: { title: string; category?: string; status?: string; owner?: string; potentialCost?: string },
  action: "create" | "edit" | "delete",
  expectedToast: string = "successfully"
): Promise<ValidationResult> {
  const result: ValidationResult = {
    toast_confirmed: false,
    dashboard_visible: false,
    table_search: false,
    fields_valid: false,
    failure_type: null,
    field_mismatches: [],
    table_data: null,
  };

  // ── Layer 1: Toast Detection ──
  console.log(`[Validation] Layer 1: Toast detection for ${action}`);
  const toast = await detectToast(page, expectedToast);
  result.toast_confirmed = toast.detected && toast.match;

  if (!result.toast_confirmed) {
    // Fallback: check if risk is visible in page
    const visible = await riskVisibleInPage(page, input.title);
    if (visible) {
      result.toast_confirmed = true;
      console.log("[Validation] Toast missed but risk visible in page — proceeding");
    } else {
      result.failure_type = `${action.toUpperCase()}_FAILED`;
      console.log(`[Validation] FAIL at Layer 1 — toast not confirmed`);
      return result;
    }
  }

  // For delete, verify record is gone
  if (action === "delete") {
    const stillVisible = await withRetry(
      async () => {
        const found = await searchRiskOnDashboard(page, input.title);
        return found ? null : true;
      },
      3, 1000, "delete-verify"
    );
    result.dashboard_visible = true;
    result.table_search = true;
    result.fields_valid = true;
    if (!stillVisible) {
      result.failure_type = "DELETE_NOT_CONFIRMED";
      result.dashboard_visible = false;
    }
    return result;
  }

  // ── Layer 2: Dashboard Visibility ──
  console.log(`[Validation] Layer 2: Dashboard visibility`);
  const dashboardVisible = await withRetry(
    () => searchRiskOnDashboard(page, input.title),
    3, 2000, "dashboard-search"
  );
  result.dashboard_visible = !!dashboardVisible;

  if (!result.dashboard_visible) {
    result.failure_type = "NOT_VISIBLE_DASHBOARD";
    console.log(`[Validation] FAIL at Layer 2 — not visible on dashboard`);
    return result;
  }

  // ── Layer 3: Table Search ──
  console.log(`[Validation] Layer 3: Table search`);
  const tableData = await withRetry(
    () => readRiskRowFromTable(page, input.title),
    3, 2000, "table-search"
  );
  result.table_search = !!tableData;
  result.table_data = tableData;

  if (!result.table_search) {
    result.failure_type = "NOT_FOUND_TABLE";
    console.log(`[Validation] FAIL at Layer 3 — not found in table`);
    return result;
  }

  // ── Layer 4: Field Validation ──
  console.log(`[Validation] Layer 4: Field validation`);
  const mismatches: FieldMismatch[] = [];

  if (input.title && tableData) {
    const fieldsToCheck: Array<{ field: string; expected: string; actual: string }> = [
      { field: "title", expected: input.title, actual: tableData.title || "" },
    ];
    if (input.category) {
      fieldsToCheck.push({ field: "category", expected: input.category, actual: tableData.category || "" });
    }
    if (input.status) {
      fieldsToCheck.push({ field: "status", expected: input.status, actual: tableData.status || "" });
    }
    if (input.owner) {
      fieldsToCheck.push({ field: "owner", expected: input.owner, actual: tableData.owner || "" });
    }
    if (input.potentialCost) {
      fieldsToCheck.push({ field: "cost", expected: input.potentialCost, actual: tableData.cost || "" });
    }

    for (const check of fieldsToCheck) {
      if (normalize(check.expected) !== normalize(check.actual)) {
        mismatches.push({ field: check.field, expected: check.expected, actual: check.actual });
      }
    }
  }

  result.field_mismatches = mismatches;
  result.fields_valid = mismatches.length === 0;

  if (!result.fields_valid) {
    result.failure_type = "DATA_MISMATCH";
    console.log(`[Validation] FAIL at Layer 4 — ${mismatches.length} field mismatch(es)`);
    mismatches.forEach((m) => console.log(`  ${m.field}: expected "${m.expected}" got "${m.actual}"`));
  } else {
    console.log(`[Validation] ALL LAYERS PASSED for ${action}`);
  }

  return result;
}