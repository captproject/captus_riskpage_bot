// ─── Captus Risk Bot — Modular Server ─────────────────────────────────────────
// Slim entry point: config, middleware, route registration, lifecycle.
// All logic lives in /routes, /services, and /utils.

import express, { Request, Response, NextFunction } from "express";
import { Config } from "./utils/types";
import {
  executionQueue,
  closeBrowser,
  invalidateSession,
  isBrowserConnected,
  getCachedSessionUsername,
} from "./services/browserManager";
import { withTimeout } from "./utils/retry";
import { saveTestResult } from "./services/supabaseLogger";

// Route handlers
import { performCreateRisk } from "./routes/createRisk";
import { performEditRisk } from "./routes/editRisk";
import { performDeleteRisk } from "./routes/deleteRisk";
import { performStatusWorkflow } from "./routes/statusWorkflow";
import { performFilterRisks } from "./routes/filterRisk";
import { performScoreMatrix } from "./routes/scoreMatrix";
import { performAuditLog } from "./routes/auditLog";

// ─── Config (exported for use by services) ───────────────────────────────────

export const config: Config = {
  loginUrl: process.env.LOGIN_URL || "https://captus.replit.app/login",
  dashboardUrl: process.env.DASHBOARD_URL || "https://captus.replit.app/dashboard",
  tableUrl: process.env.TABLE_URL || "https://captus.replit.app/table",
  auditUrl: process.env.AUDIT_URL || "https://captus.replit.app/audit",
  apiKey: process.env.API_KEY || "",
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_KEY || "",
  port: Number(process.env.PORT) || 3000,
  navigationTimeout: 60_000,
  executionTimeout: 180_000,
};

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

// Auth middleware
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) { next(); return; }
  if (req.headers["x-api-key"] !== config.apiKey) {
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return;
  }
  next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /create-risk
app.post("/create-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.title) {
    res.status(400).json({ status: "error", message: "Missing: username, password, title" });
    return;
  }
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
      message: result.message, assertion_expected: "All validations pass",
      assertion_actual: result.failure_type || "All passed",
      assertion_match: !result.failure_type,
      screenshot_failure: result.screenshots.failure || null,
    }, {
      failure_type: result.failure_type, checks: result.checks,
      field_mismatches: result.field_mismatches, table_data: result.table_data,
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Create_Risk", {
      status: "error", username: input.username, risk_title: input.title,
      message: (err as Error).message, assertion_match: false,
    }, { failure_type: "EXECUTION_ERROR" });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// POST /edit-risk
app.post("/edit-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.searchTitle) {
    res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" });
    return;
  }
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performEditRisk(input), config.executionTimeout, "edit-risk")
    );
    await saveTestResult("TC_Edit_Risk", {
      status: result.status, username: result.username, risk_title: result.riskTitle,
      message: result.message, assertion_expected: "All validations pass",
      assertion_actual: result.failure_type || "All passed",
      assertion_match: !result.failure_type,
      screenshot_failure: result.screenshots.failure || null,
    }, {
      failure_type: result.failure_type, checks: result.checks,
      field_mismatches: result.field_mismatches, table_data: result.table_data,
    });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Edit_Risk", {
      status: "error", username: input.username, message: (err as Error).message, assertion_match: false,
    }, { failure_type: "EXECUTION_ERROR" });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// POST /delete-risk
app.post("/delete-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.searchTitle) {
    res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" });
    return;
  }
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performDeleteRisk(input), config.executionTimeout, "delete-risk")
    );
    await saveTestResult("TC_Delete_Risk", {
      status: result.status, username: result.username, risk_title: result.riskTitle,
      message: result.message, assertion_match: !result.failure_type,
      screenshot_failure: result.screenshots.failure || null,
    }, { failure_type: result.failure_type, checks: result.checks });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// POST /risk-status-workflow
app.post("/risk-status-workflow", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.title) {
    res.status(400).json({ status: "error", message: "Missing: username, password, title" });
    return;
  }
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
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// POST /filter-risks
app.post("/filter-risks", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password) {
    res.status(400).json({ status: "error", message: "Missing: username, password" });
    return;
  }
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performFilterRisks(input), config.executionTimeout, "filter-risks")
    );
    await saveTestResult("TC_Filter_Risk", {
      status: result.status, username: result.username,
      message: result.message, assertion_match: result.validation.all_match,
      screenshot_failure: result.screenshots.failure || null,
    }, { filters: result.filters_applied, rows_found: result.rows_found, validation: result.validation });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// POST /score-matrix
app.post("/score-matrix", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password || !input.title || !input.expectedScore) {
    res.status(400).json({ status: "error", message: "Missing: username, password, title, expectedScore" });
    return;
  }
  try {
    const full = {
      username: input.username, password: input.password, title: input.title,
      description: input.description || "", category: input.category || "Technical",
      impact: input.impact || "3 - Medium", likelihood: input.likelihood || "3 - Medium",
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
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// POST /audit-log
app.post("/audit-log", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body;
  if (!input.username || !input.password) {
    res.status(400).json({ status: "error", message: "Missing: username, password" });
    return;
  }
  try {
    const result = await executionQueue.add(() =>
      withTimeout(() => performAuditLog(input), 300_000, "audit-log")
    );
    await saveTestResult("TC_Audit_Log", {
      status: result.status, username: result.username, risk_title: result.risk_title,
      message: result.steps_summary || result.message,
      assertion_expected: `All ${result.total_steps} audit entries verified`,
      assertion_actual: `${result.passed}/${result.total_steps} passed`,
      assertion_match: result.failed === 0,
      screenshot_failure: result.screenshots.failure || null,
    }, { total_steps: result.total_steps, passed: result.passed, failed: result.failed, steps: result.steps });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Audit_Log", {
      status: "error", username: input.username, message: (err as Error).message, assertion_match: false,
    }, {});
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// POST /reset-browser
app.post("/reset-browser", authMiddleware, async (_req: Request, res: Response) => {
  await closeBrowser();
  invalidateSession();
  if (global.gc) { global.gc(); console.log("[Reset] Forced garbage collection"); }
  res.json({ status: "ok", message: "Browser closed, session cleared, memory released", timestamp: new Date().toISOString() });
});

// GET /health
app.get("/health", (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  res.json({
    status: "running",
    service: "captus-risk-bot",
    version: "2.0.0-modular",
    endpoints: [
      "/create-risk", "/edit-risk", "/delete-risk",
      "/risk-status-workflow", "/filter-risks", "/score-matrix",
      "/audit-log", "/reset-browser",
    ],
    browserConnected: isBrowserConnected(),
    sessionCached: getCachedSessionUsername(),
    queue: { running: executionQueue.isRunning, pending: executionQueue.pendingCount },
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── Start & Shutdown ────────────────────────────────────────────────────────

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Risk Bot v2.0 (modular) running on port ${config.port}`);
  console.log(`Dashboard: ${config.dashboardUrl}`);
  console.log(`Table:     ${config.tableUrl}`);
  console.log(`Audit:     ${config.auditUrl}`);
  console.log(`Auth:      ${config.apiKey ? "ENABLED" : "DISABLED"}`);
  console.log(`Supabase:  ${config.supabaseUrl ? "ENABLED" : "DISABLED"}`);
  console.log(`Queue:     ENABLED (single concurrency)`);
});

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
