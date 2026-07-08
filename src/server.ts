// ─── Captus Risk Bot — Modular Server v2.3 ────────────────────────────────────
// Includes: All risk page routes + login-v2 + session-termination + Allure reporting
import testProjectSelectorRouter from "./routes/testProjectSelector";
import express, { Request, Response, NextFunction } from "express";
import { Config } from "./utils/types";
import { executionQueue, closeBrowser, invalidateSession,isBrowserConnected, getCachedSessionUsername,} from "./services/browserManager";
import { withTimeout } from "./utils/retry";
import { saveTestResult } from "./services/supabaseLogger";
import { recordTestResult, saveAllureResult } from "./services/allureReporter";
import { allureRouter } from "./services/allureRoutes";
import testRateLimitRouter from "./routes/testRateLimit";
import testRiskRegistryLoadRouter from "./routes/testRiskRegistryLoad";

import { performChangePassword } from "./routes/changePassword";
import { performCreateRisk } from "./routes/createRisk";
import { performEditRisk } from "./routes/editRisk";
import { performDeleteRisk } from "./routes/deleteRisk";
import { performStatusWorkflow } from "./routes/statusWorkflow";
import { performFilterRisks } from "./routes/filterRisk";
import { performScoreMatrix } from "./routes/scoreMatrix";
import { performAuditLog } from "./routes/auditLog";
import { performLoginBot } from "./routes/loginBot";
import { performSessionTermination } from "./routes/sessionTermination";
import testInjectionRouter from "./routes/testInjection";
import testChatMessageRouter from "./routes/testChatMessage";
import { performRiskIngestion } from "./routes/testRiskIngestion";
import { performBulkOperations } from "./routes/testBulkOperations";
import getCurrentUserRouter from "./routes/getCurrentUser";




export const config: Config = {
  loginUrl: process.env.LOGIN_URL || "https://captus.replit.app/login",
  dashboardUrl: process.env.DASHBOARD_URL || "https://captus.replit.app/dashboard",
  tableUrl: process.env.TABLE_URL || "https://captus.replit.app/table",
  auditUrl: process.env.AUDIT_URL || "https://captus.replit.app/admin/audit",
  apiKey: process.env.API_KEY || "",
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_KEY || "",
  port: Number(process.env.PORT) || 3000,
  navigationTimeout: 60_000,
  executionTimeout: 180_000,
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/", testProjectSelectorRouter);
app.use("/", testInjectionRouter);
app.use("/", testRateLimitRouter);
app.use("/", testRiskRegistryLoadRouter);
app.use("/", testChatMessageRouter);
app.use("/", getCurrentUserRouter);




function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) { next(); return; }
  if (req.headers["x-api-key"] !== config.apiKey) {
    res.status(401).json({ status: "error", message: "Unauthorized" }); return;
  }
  next();
}

app.use("/", allureRouter);

// ─── POST /create-risk ───────────────────────────────────────────────────────
app.post("/create-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.title) {
    res.status(400).json({ status: "error", message: "Missing: username, password, title" }); return;
  }
  const startTime = Date.now();
  try {
    const fullInput = {
      username: input.username, password: input.password, title: input.title,
      description: input.description || "", category: input.category || "Technical",
      status: input.status || "Open", impact: input.impact || "3 - Medium",
      likelihood: input.likelihood || "3 - Medium", owner: input.owner || "",
      dueDate: input.dueDate || "", potentialCost: input.potentialCost || "",
      mitigationPlan: input.mitigationPlan || "",
    };
    const result = await executionQueue.add(() =>
      withTimeout(() => performCreateRisk(fullInput), config.executionTimeout, "create-risk")
    );
    await saveTestResult("TC_Create_Risk", {
      status: result.status, username: result.username, risk_title: result.riskTitle,
      message: result.message, assertion_expected: "Risk created successfully",
      assertion_actual: result.failure_type || "Risk created successfully",
      assertion_match: !result.failure_type, screenshot_failure: result.screenshots.failure || null,
    }, { failure_type: result.failure_type, checks: result.checks, field_mismatches: result.field_mismatches, table_data: result.table_data });
    recordTestResult("TC_Create_Risk", "CRUD Tests", result.status, result.message, startTime, result.checks, result.screenshots.failure, {
      assertion_expected: "Risk created successfully", assertion_actual: result.failure_type || "Risk created successfully",
      failure_type: result.failure_type, field_mismatches: result.field_mismatches, table_data: result.table_data,
      risk_title: result.riskTitle, username: result.username,
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Create_Risk", { status: "error", username: input.username, risk_title: input.title, message: (err as Error).message, assertion_match: false }, { failure_type: "EXECUTION_ERROR" });
    recordTestResult("TC_Create_Risk", "CRUD Tests", "error", (err as Error).message, startTime, undefined, undefined, { assertion_expected: "Risk created successfully", assertion_actual: (err as Error).message, failure_type: "EXECUTION_ERROR", username: input.username, risk_title: input.title });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── POST /edit-risk ─────────────────────────────────────────────────────────
app.post("/edit-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.searchTitle) {
    res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" }); return;
  }
  const startTime = Date.now();
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performEditRisk(input), config.executionTimeout, "edit-risk")
    );
    await saveTestResult("TC_Edit_Risk", {
      status: result.status, username: result.username, risk_title: result.riskTitle,
      message: result.message, assertion_expected: "Risk updated successfully",
      assertion_actual: result.failure_type || "Risk updated successfully",
      assertion_match: !result.failure_type, screenshot_failure: result.screenshots.failure || null,
    }, { failure_type: result.failure_type, checks: result.checks, field_mismatches: result.field_mismatches, table_data: result.table_data });
    recordTestResult("TC_Edit_Risk", "CRUD Tests", result.status, result.message, startTime, result.checks, result.screenshots.failure, {
      assertion_expected: "Risk updated successfully", assertion_actual: result.failure_type || "Risk updated successfully",
      failure_type: result.failure_type, field_mismatches: result.field_mismatches, table_data: result.table_data,
      risk_title: result.riskTitle, username: result.username,
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Edit_Risk", { status: "error", username: input.username, message: (err as Error).message, assertion_match: false }, { failure_type: "EXECUTION_ERROR" });
    recordTestResult("TC_Edit_Risk", "CRUD Tests", "error", (err as Error).message, startTime, undefined, undefined, { assertion_expected: "Risk updated successfully", assertion_actual: (err as Error).message, failure_type: "EXECUTION_ERROR", username: input.username });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── POST /delete-risk ───────────────────────────────────────────────────────
app.post("/delete-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.searchTitle) {
    res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" }); return;
  }
  const startTime = Date.now();
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performDeleteRisk(input), config.executionTimeout, "delete-risk")
    );
    await saveTestResult("TC_Delete_Risk", {
      status: result.status, username: result.username, risk_title: result.riskTitle,
      message: result.message, assertion_match: !result.failure_type, screenshot_failure: result.screenshots.failure || null,
    }, { failure_type: result.failure_type, checks: result.checks });
    recordTestResult("TC_Delete_Risk", "CRUD Tests", result.status, result.message, startTime, result.checks, result.screenshots.failure, {
      assertion_expected: "Risk deleted successfully", assertion_actual: result.failure_type || "Risk deleted successfully",
      failure_type: result.failure_type, risk_title: result.riskTitle, username: result.username,
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    recordTestResult("TC_Delete_Risk", "CRUD Tests", "error", (err as Error).message, startTime, undefined, undefined, { assertion_expected: "Risk deleted successfully", assertion_actual: (err as Error).message, failure_type: "EXECUTION_ERROR" });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── POST /risk-status-workflow ──────────────────────────────────────────────
app.post("/risk-status-workflow", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.title) {
    res.status(400).json({ status: "error", message: "Missing: username, password, title" }); return;
  }
  const startTime = Date.now();
  try {
    const full = {
      username: input.username, password: input.password, title: input.title,
      description: input.description || "Status workflow test risk",
      category: input.category || "Technical", impact: input.impact || "3 - Medium",
      likelihood: input.likelihood || "3 - Medium", owner: input.owner || "",
      dueDate: input.dueDate || "", potentialCost: input.potentialCost || "",
      mitigationPlan: input.mitigationPlan || "",
    };
    const result = await executionQueue.add(() =>
      withTimeout(() => performStatusWorkflow(full), config.executionTimeout, "status-workflow")
    );
    await saveTestResult("TC_Risk_Status_Workflow", {
      status: result.status, username: input.username, risk_title: result.riskTitle,
      message: result.message, assertion_expected: result.assertion.expected,
      assertion_actual: result.assertion.actual, assertion_match: result.assertion.match,
      screenshot_failure: result.screenshots.failure || null,
    }, { steps: result.steps, versions_created: result.versions_created });
    recordTestResult("TC_Risk_Status_Workflow", "Workflow Tests", result.status, result.message, startTime, undefined, result.screenshots.failure, {
      assertion_expected: result.assertion.expected, assertion_actual: result.assertion.actual,
      risk_title: result.riskTitle, username: input.username,
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    recordTestResult("TC_Risk_Status_Workflow", "Workflow Tests", "error", (err as Error).message, startTime);
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── POST /filter-risks ──────────────────────────────────────────────────────
app.post("/filter-risks", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password) {
    res.status(400).json({ status: "error", message: "Missing: username, password" }); return;
  }
  const startTime = Date.now();
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performFilterRisks(input), config.executionTimeout, "filter-risks")
    );
    await saveTestResult("TC_Filter_Risk", {
      status: result.status, username: result.username, message: result.message,
      assertion_match: result.validation.all_match, screenshot_failure: result.screenshots.failure || null,
    }, { filters: result.filters_applied, rows_found: result.rows_found, validation: result.validation });
    recordTestResult("TC_Filter_Risk", "Validation Tests", result.status, result.message, startTime, undefined, result.screenshots.failure, {
      assertion_expected: "All rows match filters", assertion_actual: result.message, username: result.username,
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    recordTestResult("TC_Filter_Risk", "Validation Tests", "error", (err as Error).message, startTime);
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── POST /score-matrix ──────────────────────────────────────────────────────
app.post("/score-matrix", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.impact || !input.likelihood || input.expectedScore === undefined) {
    res.status(400).json({ status: "error", message: "Missing: username, password, impact, likelihood, expectedScore" }); return;
  }
  const startTime = Date.now();
  try {
    const full = {
      username: input.username, password: input.password, title: input.title || "",
      description: input.description || "", category: input.category || "Technical",
      impact: input.impact, likelihood: input.likelihood,
      owner: input.owner || "", dueDate: input.dueDate || "",
      potentialCost: input.potentialCost || "", mitigationPlan: input.mitigationPlan || "",
      expectedScore: input.expectedScore,
    };
    const result = await executionQueue.add(() =>
      withTimeout(() => performScoreMatrix(full), config.executionTimeout, "score-matrix")
    );
    await saveTestResult("TC_Score_Matrix", {
      status: result.status, username: result.username, risk_title: result.risk_title,
      message: result.message, assertion_expected: `Score = ${result.expected_score}`,
      assertion_actual: `Score = ${result.actual_score}`, assertion_match: result.score_match,
      screenshot_failure: result.screenshots.failure || null,
    }, { impact: result.impact, likelihood: result.likelihood, score_match: result.score_match, cleaned_up: result.cleaned_up });
    recordTestResult(`TC_Score_Matrix (${result.impact} × ${result.likelihood})`, "Score Matrix Tests", result.status, result.message, startTime, undefined, result.screenshots.failure, {
      assertion_expected: `Score = ${result.expected_score}`, assertion_actual: `Score = ${result.actual_score}`,
      risk_title: result.risk_title, username: result.username,
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    recordTestResult("TC_Score_Matrix", "Score Matrix Tests", "error", (err as Error).message, startTime);
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── POST /audit-log ─────────────────────────────────────────────────────────
app.post("/audit-log", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password) {
    res.status(400).json({ status: "error", message: "Missing: username, password" }); return;
  }
  const startTime = Date.now();
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performAuditLog(input), 300_000, "audit-log")
    );
    await saveTestResult("TC_Audit_Log", {
      status: result.status, username: result.username, risk_title: result.risk_title,
      message: result.steps_summary || result.message,
      assertion_expected: `All ${result.total_steps} audit entries verified`,
      assertion_actual: `${result.passed}/${result.total_steps} passed`,
      assertion_match: result.failed === 0, screenshot_failure: result.screenshots.failure || null,
    }, { total_steps: result.total_steps, passed: result.passed, failed: result.failed, steps: result.steps });
    recordTestResult("TC_Audit_Log", "Audit Tests", result.status, result.steps_summary || result.message, startTime, undefined, result.screenshots.failure, {
      assertion_expected: `All ${result.total_steps} audit entries verified`,
      assertion_actual: `${result.passed}/${result.total_steps} passed`,
      risk_title: result.risk_title, username: result.username,
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Audit_Log", { status: "error", username: input.username, message: (err as Error).message, assertion_match: false }, {});
    recordTestResult("TC_Audit_Log", "Audit Tests", "error", (err as Error).message, startTime, undefined, undefined, { assertion_expected: "All 6 audit entries verified", assertion_actual: (err as Error).message, failure_type: "EXECUTION_ERROR" });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});
app.post("/test-risk-ingestion", async (req, res) => {
  const startTime = Date.now();
  const input = req.body ?? {};
  try {
    const result = await performRiskIngestion(req.body);

    await saveTestResult("TC_Integration_Tests", {
      status: result.status,
      username: input.username || "",
      risk_title: result.risk_title || null,
      message: `INT-3.1 | ${result.steps_summary || result.message}`,
      assertion_expected: "API-created risk visible in UI and audit log within 5 steps",
      assertion_actual: `${result.passed || 0} of ${result.total_steps || 5} steps passed`,
      assertion_match: result.status === "pass",
      screenshot_failure: result.screenshots?.failure || null,
    }, { test_case: "INT-3.1", steps: result.steps });

    recordTestResult("INT-3.1 Risk Ingestion (API→UI→Audit)", "Integration Tests", result.status, result.steps_summary || result.message, startTime, undefined, result.screenshots?.failure, {
      assertion_expected: "API-created risk visible in UI and audit log within 5 steps",
      assertion_actual: `${result.passed || 0} of ${result.total_steps || 5} steps passed`,
      username: input.username, risk_title: result.risk_title || undefined,
    });

    res.json(result);
  } catch (err) {
    await saveTestResult("TC_Integration_Tests", { status: "error", username: input.username || "", message: `INT-3.1 | ${(err as Error).message}`, assertion_match: false }, { test_case: "INT-3.1", failure_type: "EXECUTION_ERROR" });
    recordTestResult("INT-3.1 Risk Ingestion (API→UI→Audit)", "Integration Tests", "error", (err as Error).message, startTime, undefined, undefined, { assertion_expected: "API-created risk visible in UI and audit log within 5 steps", assertion_actual: (err as Error).message, failure_type: "EXECUTION_ERROR", username: input.username });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.post("/test-bulk-operations", async (req, res) => {
  const startTime = Date.now();
  const input = req.body ?? {};
  try {
    const result = await performBulkOperations(req.body);

    const failedAssertions = Object.entries(result.assertions || {}).filter(([, v]) => !v).map(([k]) => k);
    await saveTestResult("TC_Integration_Tests", {
      status: result.status,
      username: input.username || "",
      risk_title: null,
      message: `INT-3.9 | ${result.message}`,
      assertion_expected: "All bulk operation assertions pass (batches A/B/C + cleanup)",
      assertion_actual: failedAssertions.length === 0 ? "All assertions passed" : `Failed: ${failedAssertions.join(", ")}`,
      assertion_match: result.status === "pass",
      screenshot_failure: result.screenshots?.failure || null,
    }, { test_case: "INT-3.9", batch_a: result.batch_a, batch_b: result.batch_b, batch_c: result.batch_c, cleanup: result.cleanup, assertions: result.assertions });

    recordTestResult("INT-3.9 Bulk Operations (10/100/mixed)", "Integration Tests", result.status, result.message, startTime, undefined, result.screenshots?.failure, {
      assertion_expected: "All bulk operation assertions pass (batches A/B/C + cleanup)",
      assertion_actual: failedAssertions.length === 0 ? "All assertions passed" : `Failed: ${failedAssertions.join(", ")}`,
      username: input.username,
    });

    res.json(result);
  } catch (err) {
    await saveTestResult("TC_Integration_Tests", { status: "error", username: input.username || "", message: `INT-3.9 | ${(err as Error).message}`, assertion_match: false }, { test_case: "INT-3.9", failure_type: "EXECUTION_ERROR" });
    recordTestResult("INT-3.9 Bulk Operations (10/100/mixed)", "Integration Tests", "error", (err as Error).message, startTime, undefined, undefined, { assertion_expected: "All bulk operation assertions pass (batches A/B/C + cleanup)", assertion_actual: (err as Error).message, failure_type: "EXECUTION_ERROR", username: input.username });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── REPLACE ONLY THE /login-v2 ROUTE IN src/server.ts ─────────────────────────

app.post("/login-v2", authMiddleware, async (req: Request, res: Response) => {
const input = req.body ?? {};
  // Empty / null username or password is a VALID input here — it IS the TC 1.3
  // empty-field scenario. Only reject a body missing BOTH keys entirely.
  if (!("username" in input) && !("password" in input)) {
    res.status(400).json({ status: "error", message: "Missing: username, password" }); return;
  }
  // Normalize null → "" so performLoginBot always gets strings (it treats "" as empty).
  input.username = input.username ?? "";
  input.password = input.password ?? "";
    const startTime = Date.now();
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performLoginBot(input), config.executionTimeout, "login-v2")
    );
    await saveTestResult("01B_Login_Bot", {
      status: result.status, username: result.username,
      message: result.message,
      assertion_expected: result.status_expected,
      assertion_actual: result.status_actual,
      assertion_match: result.assertion_match === "pass",
      screenshot_failure: result.screenshot_url,
    }, {
      id: result.id,
      scenario: result.scenario,
      currentUrl: result.currentUrl,
      pageTitle: result.pageTitle,
      landing_page: result.landing_page,
      logo_validated: result.logo_validated,
    });

    // Allure status based on assertion_match (not raw status)
    const allureStatus = result.assertion_match === "pass" ? "success" : "failed";
    
    // Use scenario description as the test name
    const testName = result.scenario 
      ? `01B_Login_Bot — ${result.scenario}` 
      : `01B_Login_Bot — ${result.username}`;

    // Minimal mode: only ID, Scenario, Match in Allure report
    recordTestResult(testName, "Login Tests", allureStatus, result.message, startTime, undefined, result.screenshot_url, {
      id: result.id,
      scenario: result.scenario,
      username: result.username,
      mode: "minimal",
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    const testName = input.scenario 
      ? `01B_Login_Bot — ${input.scenario}` 
      : `01B_Login_Bot — ${input.username}`;
    recordTestResult(testName, "Login Tests", "error", (err as Error).message, startTime, undefined, undefined, {
      id: input.id,
      scenario: input.scenario,
      username: input.username,
      mode: "minimal",
    });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── POST /session-termination ───────────────────────────────────────────────
app.post("/session-termination", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password) {
    res.status(400).json({ status: "error", message: "Missing: username, password" }); return;
  }
  const startTime = Date.now();
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performSessionTermination(input), 300_000, "session-termination")
    );

    await saveTestResult("TC_Session_Termination", {
      status: result.status,
      username: result.username,
      message: result.steps_summary || result.message,
      assertion_expected: `All ${result.total_steps} session security checks pass`,
      assertion_actual: `${result.passed}/${result.total_steps} passed`,
      assertion_match: result.assertion_match,
      screenshot_failure: result.screenshot_url,
    }, {
      total_steps: result.total_steps,
      passed: result.passed,
      failed: result.failed,
      steps: result.steps,
    });

    // Build Allure-format steps from session steps
    const stopTime = Date.now();
    const stepDuration = Math.floor((stopTime - startTime) / Math.max(result.steps.length, 1));
    const allureSteps = result.steps.map((s, i) => ({
      name: `Step ${s.step}: ${s.name}`,
      status: s.status === "pass" ? "passed" as const : "failed" as const,
      stage: "finished" as const,
      start: startTime + stepDuration * i,
      stop: startTime + stepDuration * (i + 1),
      statusDetails: {
        message: s.status === "pass"
          ? `✅ Expected: ${s.expected} | Actual: ${s.actual}`
          : `❌ Expected: ${s.expected} | Actual: ${s.actual}`,
      },
    }));

    let description = `<h4>Session Termination Security Test</h4>`;
    description += `<p><b>Status:</b> ${result.assertion_match ? "✅ ALL PASSED" : "❌ FAILED"}</p>`;
    description += `<p><b>Result:</b> ${result.passed}/${result.total_steps} checks passed</p>`;
    description += `<p><b>User:</b> ${result.username}</p>`;
    description += `<hr/><h4>Step-by-Step Verification</h4>`;
    description += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">`;
    description += `<tr><th>#</th><th>Check</th><th>Expected</th><th>Actual</th><th>Result</th></tr>`;
    for (const s of result.steps) {
      description += `<tr><td>${s.step}</td><td>${s.name}</td><td>${s.expected}</td><td>${s.actual}</td><td>${s.status === "pass" ? "✅ PASS" : "❌ FAIL"}</td></tr>`;
    }
    description += `</table>`;

    saveAllureResult({
      name: "TC_Session_Termination",
      fullName: "Security Tests > TC_Session_Termination",
      status: result.assertion_match ? "passed" : "failed",
      stage: "finished",
      start: startTime,
      stop: stopTime,
      description,
      descriptionHtml: description,
      labels: [
        { name: "suite", value: "Security Tests" },
        { name: "parentSuite", value: "Captus QA Automation" },
        { name: "subSuite", value: "TC_Session_Termination" },
        { name: "epic", value: "Risk Management" },
        { name: "feature", value: "Security Tests" },
        { name: "story", value: "Session Termination" },
        { name: "severity", value: "critical" },
        { name: "framework", value: "Playwright" },
        { name: "host", value: "Render" },
      ],
      statusDetails: result.assertion_match
        ? { message: result.message }
        : { message: result.message, trace: result.steps_summary },
      steps: allureSteps,
      parameters: [
        { name: "Username", value: result.username },
        { name: "Total Checks", value: String(result.total_steps) },
        { name: "Passed", value: String(result.passed) },
        { name: "Failed", value: String(result.failed) },
      ],
      attachments: result.screenshot_url
        ? [{ name: "Failure Screenshot", source: result.screenshot_url, type: "text/uri-list" }]
        : undefined,
    });

    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Session_Termination", {
      status: "error", username: input.username, message: (err as Error).message, assertion_match: false,
    }, {});
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── Utility Routes ──────────────────────────────────────────────────────────

app.post("/reset-browser", authMiddleware, async (_req: Request, res: Response) => {
  await closeBrowser(); invalidateSession();
  if (global.gc) { global.gc(); }
  res.json({ status: "ok", message: "Browser closed, session cleared", timestamp: new Date().toISOString() });
});

app.get("/health", (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  res.json({
    status: "running", service: "captus-risk-bot", version: "2.3.0-session-termination",
    endpoints: [
      "/create-risk", "/edit-risk", "/delete-risk",
      "/risk-status-workflow", "/filter-risks", "/score-matrix",
      "/audit-log", "/login-v2", "/session-termination",
      "/reset-browser",
      "/generate-report", "/report", "/report-stats", "/clear-results",
    ],
    browserConnected: isBrowserConnected(), sessionCached: getCachedSessionUsername(),
    queue: { running: executionQueue.isRunning, pending: executionQueue.pendingCount },
    memory: { rss: `${Math.round(mem.rss / 1024 / 1024)} MB`, heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB` },
    timestamp: new Date().toISOString(),
  });
});
// ─── POST /change-password (TC 1.6) ──────────────────────────────────────────
app.post("/change-password", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
if (!input.username || !input.current_password || !input.baseline_password || !input.temp_password) {
    res.status(400).json({ status: "error", message: "Missing: username, current_password, baseline_password, temp_password" }); return;
  }
    const startTime = Date.now();
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performChangePassword(input), 600_000, "change-password")
    );
    await saveTestResult("TC_Password_Change", {
      status: result.status, username: result.username, message: result.message,
      assertion_expected: "Profile menu; Change Password modal; success toast; session active; logout; NEW login succeeds; OLD login rejected",
      assertion_actual: result.assertion_actual,
      assertion_match: result.assertion_match === "pass",
      screenshot_failure: result.screenshot_url,
    }, { total_steps: result.total_steps, passed: result.passed, failed: result.failed, steps: result.steps });
    recordTestResult("TC_Password_Change", "Auth Tests",
      result.status === "passed" ? "success" : result.status === "error" ? "error" : "failed",
      result.message, startTime, undefined, result.screenshot_url || undefined,
      { assertion_expected: "Password change end-to-end", assertion_actual: result.assertion_actual, username: result.username });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Password_Change", { status: "error", username: input.username, message: (err as Error).message, assertion_match: false }, {});
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Risk Bot v2.3 (modular + allure + login + session) running on port ${config.port}`);
  console.log(`Dashboard: ${config.dashboardUrl}`);
  console.log(`Login:     ${config.loginUrl}`);
  console.log(`Allure:    ENABLED (/report, /generate-report)`);
  console.log(`LoginBot:  ENABLED (/login-v2)`);
  console.log(`Session:   ENABLED (/session-termination)`);
});

async function shutdown(): Promise<void> {
  console.log("\nShutting down..."); server.close(); await closeBrowser(); process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);