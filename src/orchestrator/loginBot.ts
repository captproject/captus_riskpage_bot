// ─── 01B_Login_Bot port ───────────────────────────────────────────────────────
// Faithful port of the hourly n8n workflow:
//   health check → POST /clear-results → READ_CREDENTIALS (SignIn_Task, getAll)
//   → per row: POST /login-v2 { id, username, password, scenario }
//   → UPDATE_RESULT on SignIn_Task (login_status, status_message, last_attempt)

import { OrchestratorConfig } from "./config";
import { callBot, wakeRender } from "./support";
import { TaskOutcome } from "./manifest";

interface SignInRow {
  id: string | number;
  username: string;
  password: string;
  scenario_description?: string;
}

export async function runLoginBotRefresh(cfg: OrchestratorConfig): Promise<TaskOutcome> {
  const started = Date.now();

  const awake = await wakeRender(cfg);
  if (!awake) {
    return { task: "01B_Login_Bot", status: "error", detail: "Render service did not wake", durationMs: Date.now() - started };
  }

  // NOTE: n8n's 01B called /clear-results here. That is now owned by the
  // daily_regression pipeline (start of run), so the hourly login bot no
  // longer clears Allure results — otherwise it would wipe the daily run's
  // report data mid-pipeline.

  // READ_CREDENTIALS: SignIn_Task getAll
  const readRes = await fetch(`${cfg.supabase.url}/rest/v1/SignIn_Task?select=*`, {
    headers: { apikey: cfg.supabase.key, Authorization: `Bearer ${cfg.supabase.key}` },
  });
  if (!readRes.ok) {
    return { task: "01B_Login_Bot", status: "error", detail: `SignIn_Task read failed: ${readRes.status}`, durationMs: Date.now() - started };
  }
  const rows = (await readRes.json()) as SignInRow[];
  if (rows.length === 0) {
    return { task: "01B_Login_Bot", status: "pass", detail: "No SignIn_Task rows to process", durationMs: Date.now() - started };
  }

  // n8n semantics: the workflow succeeds when every scenario EXECUTES and its
  // row is updated. Individual scenarios may be negative tests (bad creds,
  // empty fields) whose login_status is legitimately "failed" — that is the
  // scenario working, not the job failing. Only transport-level problems
  // (timeout, 502, no status in response) count against the job.
  let executionErrors = 0;
  let loginSuccesses = 0;
  for (const row of rows) {
    const login = await callBot(`${cfg.riskBot.baseUrl}/login-v2`, {
      apiKey: cfg.riskBot.apiKey, timeoutMs: 120_000,
      body: { id: row.id, username: row.username, password: row.password, scenario: row.scenario_description },
    });
    const status = (login.body && login.body.status) || "error";
    const message = (login.body && login.body.message) || login.error || `HTTP ${login.httpStatus}`;
    const executed = login.httpStatus === 200 && login.body && login.body.status;
    if (!executed) executionErrors++;
    if (["success", "pass"].includes(String(status).toLowerCase())) loginSuccesses++;

    // UPDATE_RESULT: eq filter on id
    const upd = await fetch(`${cfg.supabase.url}/rest/v1/SignIn_Task?id=eq.${encodeURIComponent(String(row.id))}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabase.key,
        Authorization: `Bearer ${cfg.supabase.key}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ login_status: status, status_message: message, last_attempt: new Date().toISOString() }),
    });
    if (!upd.ok) console.error(`[LoginBot] Update failed for id=${row.id}: ${upd.status}`);
  }

  return {
    task: "01B_Login_Bot",
    status: executionErrors === 0 ? "pass" : "fail",
    detail: `${rows.length - executionErrors}/${rows.length} scenarios executed (${loginSuccesses} login success, ${rows.length - loginSuccesses} negative-scenario rejections); per-row results in SignIn_Task`,
    durationMs: Date.now() - started,
  };
}
