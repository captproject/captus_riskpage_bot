// ─── Supabase Logger ──────────────────────────────────────────────────────────
// Structured logging to Supabase workflow_results table.
// Stores real boolean values from validation — no string parsing.

import { config } from "../server";

export async function saveTestResult(
  workflowName: string,
  common: {
    status: string;
    username: string;
    risk_title?: string | null;
    message?: string | null;
    assertion_expected?: string | null;
    assertion_actual?: string | null;
    assertion_match?: boolean;
    screenshot_failure?: string | null;
  },
  details: Record<string, any> = {}
): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.log("[Result] Supabase not configured — skipping save");
    return;
  }

  try {
    const row = {
      workflow_name: workflowName,
      status: common.status,
      username: common.username,
      risk_title: common.risk_title || null,
      message: common.message || null,
      assertion_expected: common.assertion_expected || null,
      assertion_actual: common.assertion_actual || null,
      assertion_match: common.assertion_match ?? false,
      screenshot_failure: common.screenshot_failure || null,
      details: JSON.stringify(details),
      executed_at: new Date().toISOString(),
    };

    const response = await fetch(`${config.supabaseUrl}/rest/v1/workflow_results`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (response.ok) {
      console.log(`[Result] Saved ${workflowName} → ${common.status}`);
    } else {
      console.error(`[Result] Failed: ${await response.text()}`);
    }
  } catch (err) {
    console.error(`[Result] Error: ${(err as Error).message}`);
  }
}

export async function saveStepResult(
  runId: string,
  workflowName: string,
  stepName: string,
  stepOrder: number,
  data: {
    status: string;
    username: string;
    risk_title?: string | null;
    message?: string | null;
    assertion_expected?: string | null;
    assertion_actual?: string | null;
    assertion_match?: boolean;
    screenshot_failure?: string | null;
  },
  details: Record<string, any> = {}
): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseKey) return;

  try {
    const row = {
      run_id: runId,
      workflow_name: workflowName,
      step_name: stepName,
      step_order: stepOrder,
      status: data.status,
      username: data.username,
      risk_title: data.risk_title || null,
      message: data.message || null,
      assertion_expected: data.assertion_expected || null,
      assertion_actual: data.assertion_actual || null,
      assertion_match: data.assertion_match ?? false,
      screenshot_failure: data.screenshot_failure || null,
      details: JSON.stringify(details),
      executed_at: new Date().toISOString(),
    };

    const response = await fetch(`${config.supabaseUrl}/rest/v1/workflow_results`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (response.ok) {
      console.log(`[Result] Saved step ${stepOrder}: ${stepName} (${data.status})`);
    } else {
      console.error(`[Result] Failed step ${stepName}: ${await response.text()}`);
    }
  } catch (err) {
    console.error(`[Result] Error step ${stepName}: ${(err as Error).message}`);
  }
}
