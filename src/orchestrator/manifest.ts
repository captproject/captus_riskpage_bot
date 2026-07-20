// ─── Task Manifest: 1:1 port of every scheduled n8n workflow ─────────────────
// Every task mirrors its n8n source workflow exactly: same endpoint, same
// payload fields, same timeout. Schedules are documented here and implemented
// as Render Cron Jobs (see RENDER_CRON_MIGRATION.md).
//
// n8n source                          → task id
// 00_Wake_Render                      → wake_render
// TC_Create_Risk                      → tc_create_risk
// TC_Edit_Risk                        → tc_edit_risk
// TC_Delete_Risk                      → tc_delete_risk
// TC_Score_Matrix                     → tc_score_matrix        (25 combos, sequential)
// SEC-1_Rate_Limiting                 → sec1_rate_limiting
// TC_Project_Selector                 → tc_project_selector
// TC_Risk_Registry_Load               → tc_risk_registry_load
// TC_Chat_Message                     → tc_chat_message
// SEC-2_Unauthorized_Access_Partial   → sec2_unauthorized_access (direct API probe, no bot)
// TC_Get_Current_User                 → tc_get_current_user
// SEC-6_Invalid_Webhook_Auth          → sec6_invalid_webhook_auth
// SEC-8_Webhook_Payload_Validation    → sec8_payload_validation
// SEC-11_Injection_Protection         → sec11_injection
// TC_Filter_Risks                     → tc_filter_risks
// TC_Risk_Status_Workflow             → tc_risk_status_workflow
// TC_Session_Termination              → tc_session_termination
// TC_Integration_Tests                → tc_integration_tests   (ingestion + bulk)
// TC_Audit_Log                        → tc_audit_log           (+ generate-report + Slack)
// 01B_Login_Bot                       → login_bot_refresh      (see loginBot.ts)
// 01_Login_Module                     → tc_login_module        (manual subworkflow; on-demand)
// 98_Critical_Test_Runner             → suite: critical        (manual; on-demand)
// TC_Create_Dependency                → tc_create_dependency   (unscheduled in n8n; on-demand)

import { OrchestratorConfig } from "./config";
import { callBot, BotCallResult, nowStamp, duePlus30, logOrchestratorResult } from "./support";

export interface TaskOutcome {
  task: string;
  status: "pass" | "fail" | "error";
  detail: string;
  durationMs: number;
}

type TaskFn = (cfg: OrchestratorConfig) => Promise<TaskOutcome>;

function outcomeFromBot(task: string, res: BotCallResult): TaskOutcome {
  // The bot writes its own workflow_results row; the orchestrator only needs
  // pass/fail for sequencing and the Slack summary. Bot returns status "pass"
  // (the historic n8n SET_RESULT "success" mismatch is now irrelevant).
  const botStatus = typeof res.body === "object" && res.body ? String(res.body.status || "") : "";
  // Routes are inconsistent: most return "pass" but some (e.g. create/edit/delete
  // RiskResult routes) return "success". Accept the family.
  const pass = res.ok && ["pass", "passed", "success"].includes(botStatus.toLowerCase());
  return {
    task,
    status: res.timedOut || res.httpStatus === 0 ? "error" : pass ? "pass" : "fail",
    detail: res.error || (typeof res.body === "object" ? (res.body?.message || botStatus || `HTTP ${res.httpStatus}`) : `HTTP ${res.httpStatus}`),
    durationMs: res.durationMs,
  };
}

// ── Standard bot-backed tasks ─────────────────────────────────────────────────

const tc_create_risk: TaskFn = async (cfg) => {
  const res = await callBot(`${cfg.riskBot.baseUrl}/create-risk`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs: 180_000,
    body: {
      username: cfg.users.qa_user.email, password: cfg.users.qa_user.password,
      title: `Automation Risk ${nowStamp()}`,
      description: "Created by QA automation framework",
      category: "Technical", status: "Open",
      impact: "4 - High", likelihood: "3 - Medium",
      owner: "Attic Lab", dueDate: duePlus30(),
      potentialCost: "50000", mitigationPlan: "Automated mitigation plan for testing",
    },
  });
  return outcomeFromBot("TC_Create_Risk", res);
};

const tc_edit_risk: TaskFn = async (cfg) => {
  const title = `Edit Test Risk ${nowStamp()}`;
  const create = await callBot(`${cfg.riskBot.baseUrl}/create-risk`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs: 180_000,
    body: {
      username: cfg.users.qa_user.email, password: cfg.users.qa_user.password,
      title, description: "Risk created for edit test",
      category: "Quality", status: "Open",
      impact: "3 - Medium", likelihood: "3 - Medium",
      owner: "Attic Lab", dueDate: duePlus30(),
      potentialCost: "50000", mitigationPlan: "Original mitigation plan",
    },
  });
  const createdTitle = (create.body && create.body.riskTitle) || title;
  if (!create.ok) return outcomeFromBot("TC_Edit_Risk", create);
  const edit = await callBot(`${cfg.riskBot.baseUrl}/edit-risk`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs: 180_000,
    body: {
      username: cfg.users.qa_user.email, password: cfg.users.qa_user.password,
      searchTitle: createdTitle,
      newTitle: `EDITED - ${createdTitle}`,
      newStatus: "In Review", newImpact: "5 - Very High",
      newDescription: "Updated by QA automation framework",
    },
  });
  return outcomeFromBot("TC_Edit_Risk", edit);
};

const tc_delete_risk: TaskFn = async (cfg) => {
  const title = `Delete Test Risk ${nowStamp()}`;
  const create = await callBot(`${cfg.riskBot.baseUrl}/create-risk`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs: 180_000,
    body: {
      username: cfg.users.qa_user.email, password: cfg.users.qa_user.password,
      title, description: "Risk created for delete test",
      category: "Quality", status: "Open",
      impact: "3 - Medium", likelihood: "3 - Medium",
      owner: "Attic Lab", dueDate: duePlus30(),
      potentialCost: "50000", mitigationPlan: "Temporary risk for deletion test",
    },
  });
  const createdTitle = (create.body && create.body.riskTitle) || title;
  if (!create.ok) return outcomeFromBot("TC_Delete_Risk", create);
  const del = await callBot(`${cfg.riskBot.baseUrl}/delete-risk`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs: 180_000,
    body: { username: cfg.users.qa_user.email, password: cfg.users.qa_user.password, searchTitle: createdTitle },
  });
  return outcomeFromBot("TC_Delete_Risk", del);
};

const tc_score_matrix: TaskFn = async (cfg) => {
  // Port of GENERATE_25_COMBINATIONS: 5×5 impact/likelihood grid, sequential calls.
  const levels = ["1 - Very Low", "2 - Low", "3 - Medium", "4 - High", "5 - Very High"];
  let failures = 0; let last = "";
  const started = Date.now();
  for (let i = 1; i <= 5; i++) {
    for (let l = 1; l <= 5; l++) {
      const res = await callBot(`${cfg.riskBot.baseUrl}/score-matrix`, {
        apiKey: cfg.riskBot.apiKey, timeoutMs: 180_000,
        body: {
          username: cfg.users.qa_user.email, password: cfg.users.qa_user.password,
          impact: levels[i - 1], likelihood: levels[l - 1], expectedScore: i * l,
        },
      });
      const o = outcomeFromBot("TC_Score_Matrix", res);
      if (o.status !== "pass") { failures++; last = `${levels[i - 1]} × ${levels[l - 1]}: ${o.detail}`; }
    }
  }
  return {
    task: "TC_Score_Matrix",
    status: failures === 0 ? "pass" : "fail",
    detail: failures === 0 ? "25/25 combinations passed" : `${failures}/25 failed. Last: ${last}`,
    durationMs: Date.now() - started,
  };
};

const simpleBotTask = (task: string, path: string, timeoutMs: number): TaskFn => async (cfg) => {
  const res = await callBot(`${cfg.riskBot.baseUrl}${path}`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs,
    body: { username: cfg.users.qa_user.email, password: cfg.users.qa_user.password },
  });
  return outcomeFromBot(task, res);
};

const sec1_rate_limiting     = simpleBotTask("SEC-1_Rate_Limiting", "/test-rate-limit", 300_000);
const tc_project_selector    = simpleBotTask("TC_Project_Selector", "/test-project-selector", 240_000);
const tc_risk_registry_load  = simpleBotTask("TC_Risk_Registry_Load", "/test-risk-registry-load", 240_000);
const tc_chat_message        = simpleBotTask("TC_Chat_Message", "/test-chat-message", 240_000);
const tc_get_current_user    = simpleBotTask("TC_Get_Current_User", "/test-current-user", 180_000);
const sec11_injection        = simpleBotTask("SEC-11_Injection_Protection", "/test-injection", 600_000);
const tc_session_termination = simpleBotTask("TC_Session_Termination", "/session-termination", 300_000);

const tc_filter_risks: TaskFn = async (cfg) => {
  const res = await callBot(`${cfg.riskBot.baseUrl}/filter-risks`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs: 180_000,
    body: {
      username: cfg.users.qa_user.email, password: cfg.users.qa_user.password,
      statusFilter: "Open", categoryFilter: "Technical",
    },
  });
  return outcomeFromBot("TC_Filter_Risks", res);
};

const tc_risk_status_workflow: TaskFn = async (cfg) => {
  const res = await callBot(`${cfg.riskBot.baseUrl}/risk-status-workflow`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs: 300_000,
    body: {
      username: cfg.users.qa_user.email, password: cfg.users.qa_user.password,
      title: `Workflow Test Risk ${nowStamp()}`,
      description: "Risk for status workflow validation",
      category: "Technical", impact: "3 - Medium", likelihood: "3 - Medium",
      owner: "Attic Lab", dueDate: duePlus30(),
      potentialCost: "50000", mitigationPlan: "Status workflow test mitigation plan",
    },
  });
  return outcomeFromBot("TC_Risk_Status_Workflow", res);
};

const tc_integration_tests: TaskFn = async (cfg) => {
  const started = Date.now();
  const creds = { username: cfg.users.qa_user.email, password: cfg.users.qa_user.password };
  const ingest = await callBot(`${cfg.riskBot.baseUrl}/test-risk-ingestion`, { apiKey: cfg.riskBot.apiKey, timeoutMs: 180_000, body: creds });
  const bulk = await callBot(`${cfg.riskBot.baseUrl}/test-bulk-operations`, { apiKey: cfg.riskBot.apiKey, timeoutMs: 600_000, body: creds });
  const oi = outcomeFromBot("TC_Risk_Ingestion", ingest);
  const ob = outcomeFromBot("TC_Bulk_Operations", bulk);
  const pass = oi.status === "pass" && ob.status === "pass";
  return {
    task: "TC_Integration_Tests",
    status: pass ? "pass" : (oi.status === "error" || ob.status === "error") ? "error" : "fail",
    detail: `ingestion=${oi.status} (${oi.detail}); bulk=${ob.status} (${ob.detail})`,
    durationMs: Date.now() - started,
  };
};

const tc_audit_log: TaskFn = async (cfg) => {
  // Core audit functionality test. Allure report generation + Slack delivery
  // happen once at the end of the run (see runTask.ts), not per task.
  const res = await callBot(`${cfg.riskBot.baseUrl}/audit-log`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs: 300_000,
    body: {
      username: cfg.users.qa_user.email, password: cfg.users.qa_user.password,
      chatMessage: "audit test message from QA automation",
    },
  });
  return outcomeFromBot("TC_Audit_Log", res);
};

// ── SEC tasks that assert on responses (bot never logs these — orchestrator does) ──

const sec2_unauthorized_access: TaskFn = async (cfg) => {
  // Verbatim port of SEC-2: two direct probes against the application API.
  // Expectation: both must be rejected (401/403). NOTE: target URL is the
  // legacy Replit host, carried over 1:1 — update post-cutover.
  const url = `${cfg.legacyApp.apiBase}/api/risks?companyId=3&page=Dashboard`;
  const started = Date.now();
  const noAuth = await callBot(url, { method: "GET", timeoutMs: 30_000 });
  const tampered = await callBot(url, {
    method: "GET", timeoutMs: 30_000,
    extraHeaders: { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.tampered_payload_here.invalid_signature_xyz" },
  });
  const rejected = (s: number) => s === 401 || s === 403;
  const pass = rejected(noAuth.httpStatus) && rejected(tampered.httpStatus);
  const outcome: TaskOutcome = {
    task: "SEC-2_Unauthorized_Access",
    status: noAuth.httpStatus === 0 || tampered.httpStatus === 0 ? "error" : pass ? "pass" : "fail",
    detail: `no-auth=${noAuth.httpStatus}, tampered-jwt=${tampered.httpStatus} (expected 401/403)`,
    durationMs: Date.now() - started,
  };
  await logOrchestratorResult(cfg, "SEC-2_Unauthorized_Access", outcome.status, {
    message: outcome.detail,
    assertion_expected: "401/403 for both probes",
    assertion_actual: `no-auth=${noAuth.httpStatus}, tampered=${tampered.httpStatus}`,
    assertion_match: pass,
  });
  return outcome;
};

const sec6_invalid_webhook_auth: TaskFn = async (cfg) => {
  // Port of SEC-6: bot endpoint must reject missing and wrong x-api-key.
  const url = `${cfg.riskBot.baseUrl}/test-project-selector`;
  const started = Date.now();
  const noKey = await callBot(url, { apiKey: null, timeoutMs: 30_000, body: { username: "test", password: "test" } });
  const wrongKey = await callBot(url, { apiKey: "wrong-key-12345-bogus", timeoutMs: 30_000, body: { username: "test", password: "test" } });
  const pass = noKey.httpStatus === 401 && wrongKey.httpStatus === 401;
  const outcome: TaskOutcome = {
    task: "SEC-6_Invalid_Webhook_Auth",
    status: noKey.httpStatus === 0 || wrongKey.httpStatus === 0 ? "error" : pass ? "pass" : "fail",
    detail: `missing-key=${noKey.httpStatus}, wrong-key=${wrongKey.httpStatus} (expected 401)`,
    durationMs: Date.now() - started,
  };
  await logOrchestratorResult(cfg, "SEC-6_Invalid_Webhook_Auth", outcome.status, {
    message: outcome.detail,
    assertion_expected: "401 for both",
    assertion_actual: outcome.detail,
    assertion_match: pass,
  });
  return outcome;
};

const sec8_payload_validation: TaskFn = async (cfg) => {
  // Port of SEC-8: valid key but malformed payloads must be rejected (400).
  const url = `${cfg.riskBot.baseUrl}/test-project-selector`;
  const started = Date.now();
  const empty = await callBot(url, { apiKey: cfg.riskBot.apiKey, timeoutMs: 30_000, body: {} });
  const noPassword = await callBot(url, { apiKey: cfg.riskBot.apiKey, timeoutMs: 30_000, body: { username: "test" } });
  const noUsername = await callBot(url, { apiKey: cfg.riskBot.apiKey, timeoutMs: 30_000, body: { password: "test" } });
  const bad = (s: number) => s === 400;
  const pass = bad(empty.httpStatus) && bad(noPassword.httpStatus) && bad(noUsername.httpStatus);
  const outcome: TaskOutcome = {
    task: "SEC-8_Webhook_Payload_Validation",
    status: [empty, noPassword, noUsername].some((r) => r.httpStatus === 0) ? "error" : pass ? "pass" : "fail",
    detail: `empty=${empty.httpStatus}, no-password=${noPassword.httpStatus}, no-username=${noUsername.httpStatus} (expected 400)`,
    durationMs: Date.now() - started,
  };
  await logOrchestratorResult(cfg, "SEC-8_Webhook_Payload_Validation", outcome.status, {
    message: outcome.detail,
    assertion_expected: "400 for all three",
    assertion_actual: outcome.detail,
    assertion_match: pass,
  });
  return outcome;
};

// ── On-demand tasks (unscheduled in n8n, preserved as invocable) ─────────────

const tc_login_module: TaskFn = async (cfg) => {
  // Port of 01_Login_Module subworkflow (POST /login, distinct API key).
  const res = await callBot(`${cfg.riskBot.baseUrl}/login`, {
    apiKey: cfg.loginBot.apiKey || cfg.riskBot.apiKey, timeoutMs: 120_000,
    body: { username: cfg.users.qa_user.email, password: cfg.users.qa_user.password },
  });
  return outcomeFromBot("01_Login_Module", res);
};

const tc_create_dependency: TaskFn = async (cfg) => {
  // Port of TC_Create_Dependency (no schedule in n8n; Dependencies UI removed via CAP-137).
  const res = await callBot(`${cfg.dependencyBot.baseUrl}/create-dependency`, {
    apiKey: cfg.dependencyBot.apiKey, timeoutMs: 300_000,
    body: {
      username: cfg.users.qa_user.email, password: cfg.users.qa_user.password,
      sourceTitle: "", targetTitle: "", relationshipType: "", description: "",
    },
  });
  return outcomeFromBot("TC_Create_Dependency", res);
};

// ── Registry ──────────────────────────────────────────────────────────────────

export const TASKS: Record<string, TaskFn> = {
  tc_create_risk, tc_edit_risk, tc_delete_risk, tc_score_matrix,
  sec1_rate_limiting, tc_project_selector, tc_risk_registry_load,
  tc_chat_message, sec2_unauthorized_access, tc_get_current_user,
  sec6_invalid_webhook_auth, sec8_payload_validation, sec11_injection,
  tc_filter_risks, tc_risk_status_workflow, tc_session_termination,
  tc_integration_tests, tc_audit_log, tc_login_module, tc_create_dependency,
};

// One sequential pipeline replaces n8n's scattered day of schedules.
// Every TC executes strictly one after another (guaranteed serialization
// against the shared browser singleton), followed by a single Allure report
// generation + Slack delivery and a run-summary row in workflow_results
// (handled in runTask.ts).
//
// Order follows the old n8n day chronologically (integration → morning
// cluster → CRUD cycle → evening), with TC_Session_Termination second-to-last
// because it deliberately kills the session, and TC_Audit_Log last as the
// final core-functionality check before the report is produced.
export const SUITES: Record<string, string[]> = {
  // Reordered 2026-07-20: the three tests that crash the bot web service under
  // memory pressure — sec11_injection, tc_score_matrix, tc_integration_tests
  // (bulk ops) — are moved to the END. Previously a crash mid-sequence poisoned
  // whichever functional test ran next (false 502s on create/status/etc.).
  // Running the killers last means their crashes have nothing after them to
  // corrupt; all functional results are captured before they run. The bot
  // memory issue itself is a separate post-cutover investigation.
  daily_regression: [
    // ── Functional + light security first (bot healthy) ──
    "tc_project_selector",
    "tc_risk_registry_load",
    "tc_chat_message",
    "tc_get_current_user",
    "tc_create_risk",
    "tc_edit_risk",
    "tc_delete_risk",
    "tc_filter_risks",
    "tc_risk_status_workflow",
    "sec2_unauthorized_access",
    "sec6_invalid_webhook_auth",
    "sec8_payload_validation",
    "sec1_rate_limiting",
    "tc_session_termination",    // kills session — after the other functional tests
    "tc_audit_log",              // core audit check
    // ── Known bot-crashers last (a crash here corrupts nothing downstream) ──
    "tc_integration_tests",      // bulk operations — memory heavy
    "tc_score_matrix",           // 25 sequential creates — memory heavy
    "sec11_injection",           // ~5-min injection sweep — reliably crashes the bot
  ],

  // Manual (was: 98_Critical_Test_Runner, manual trigger only)
  critical: ["tc_login_module", "tc_create_risk", "tc_edit_risk", "tc_delete_risk"],
};
