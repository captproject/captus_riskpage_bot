// ─── Allure Reporter Service ──────────────────────────────────────────────────
// Collects test results in Allure-compatible JSON format.
// Includes: steps, assertions, parameters, environment info

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const ALLURE_RESULTS_DIR = path.join(process.cwd(), "allure-results");
const ALLURE_REPORT_DIR = path.join(process.cwd(), "allure-report");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Save Raw Allure Result ──────────────────────────────────────────────────

function saveAllureResult(data: Record<string, any>): void {
  ensureDir(ALLURE_RESULTS_DIR);
  const uuid = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const resultFile = path.join(ALLURE_RESULTS_DIR, `${uuid}-result.json`);
  const result = { uuid, historyId: Buffer.from(data.fullName || data.name).toString("base64").slice(0, 32), ...data };
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  console.log(`[Allure] Saved result: ${data.name} → ${data.status}`);
}

// ─── Record Test Result (called from every route in server.ts) ───────────────

export function recordTestResult(
  workflowName: string,
  suite: string,
  status: string,
  message: string,
  startTime: number,
  checks?: {
    toast_confirmed?: boolean;
    dashboard_visible?: boolean;
    table_search?: boolean;
    fields_valid?: boolean;
  },
  screenshotUrl?: string | null,
  extra?: {
    assertion_expected?: string;
    assertion_actual?: string;
    failure_type?: string | null;
    field_mismatches?: Array<{ field: string; expected: string; actual: string }>;
    table_data?: Record<string, string> | null;
    risk_title?: string;
    username?: string;
  }
): void {
  const allureStatus: "passed" | "failed" | "broken" =
    status === "success" || status === "pass" ? "passed" :
    status === "error" ? "broken" : "failed";

  const stopTime = Date.now();
  const duration = stopTime - startTime;

  // ── Build Steps (4-layer validation) ──
  const steps: Array<Record<string, any>> = [];

  if (checks) {
    const stepDefs = [
      { key: "toast_confirmed", label: "Layer 1: Toast Detection", desc: "Verify UI action completed via toast notification" },
      { key: "dashboard_visible", label: "Layer 2: Dashboard Visibility", desc: "Verify risk appears in dashboard search" },
      { key: "table_search", label: "Layer 3: Table Search", desc: "Verify risk row exists in data table" },
      { key: "fields_valid", label: "Layer 4: Field Validation", desc: "Verify all field values match input" },
    ];
    const stepDuration = Math.floor(duration / 4);

    stepDefs.forEach((s, i) => {
      const val = (checks as any)[s.key];
      if (val !== undefined) {
        steps.push({
          name: s.label,
          status: val ? "passed" : "failed",
          stage: "finished",
          start: startTime + stepDuration * i,
          stop: startTime + stepDuration * (i + 1),
          statusDetails: val
            ? { message: `${s.label}: PASSED` }
            : { message: `${s.label}: FAILED — ${s.desc}` },
          parameters: [
            { name: "check", value: s.key },
            { name: "result", value: val ? "✅ PASS" : "❌ FAIL" },
          ],
        });
      }
    });
  }

  // ── Add field mismatch steps if any ──
  if (extra?.field_mismatches && extra.field_mismatches.length > 0) {
    for (const m of extra.field_mismatches) {
      steps.push({
        name: `Field Mismatch: ${m.field}`,
        status: "failed",
        stage: "finished",
        start: stopTime - 100,
        stop: stopTime,
        statusDetails: { message: `Expected "${m.expected}" but got "${m.actual}"` },
        parameters: [
          { name: "field", value: m.field },
          { name: "expected", value: m.expected },
          { name: "actual", value: m.actual },
        ],
      });
    }
  }

  // ── Build Parameters (shown in Allure test detail) ──
  const parameters: Array<{ name: string; value: string }> = [];

  if (extra?.risk_title) parameters.push({ name: "Risk Title", value: extra.risk_title });
  if (extra?.username) parameters.push({ name: "Username", value: extra.username });
  if (extra?.assertion_expected) parameters.push({ name: "Assertion Expected", value: extra.assertion_expected });
  if (extra?.assertion_actual) parameters.push({ name: "Assertion Actual", value: extra.assertion_actual });
  if (extra?.failure_type) parameters.push({ name: "Failure Type", value: extra.failure_type });

  // Add check summary as parameters
  if (checks) {
    parameters.push({ name: "Toast Confirmed", value: checks.toast_confirmed ? "✅ true" : "❌ false" });
    parameters.push({ name: "Dashboard Visible", value: checks.dashboard_visible ? "✅ true" : "❌ false" });
    parameters.push({ name: "Table Search", value: checks.table_search ? "✅ true" : "❌ false" });
    parameters.push({ name: "Fields Valid", value: checks.fields_valid ? "✅ true" : "❌ false" });
  }

  // Add table data as parameters
  if (extra?.table_data) {
    for (const [key, val] of Object.entries(extra.table_data)) {
      parameters.push({ name: `Table: ${key}`, value: String(val) });
    }
  }

  // ── Build Attachments ──
  const attachments: Array<{ name: string; source: string; type: string }> = [];
  if (screenshotUrl) {
    attachments.push({ name: "Failure Screenshot", source: screenshotUrl, type: "text/uri-list" });
  }

  // ── Build Description (HTML — shown in test body) ──
  let description = `<h4>Test: ${workflowName}</h4>`;
  description += `<p><b>Status:</b> ${allureStatus.toUpperCase()}</p>`;
  description += `<p><b>Duration:</b> ${(duration / 1000).toFixed(1)}s</p>`;
  description += `<p><b>Message:</b> ${message}</p>`;

  if (extra?.assertion_expected || extra?.assertion_actual) {
    description += `<hr/><h4>Assertion</h4>`;
    description += `<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse">`;
    description += `<tr><td><b>Expected</b></td><td>${extra?.assertion_expected || "—"}</td></tr>`;
    description += `<tr><td><b>Actual</b></td><td>${extra?.assertion_actual || "—"}</td></tr>`;
    description += `<tr><td><b>Match</b></td><td>${allureStatus === "passed" ? "✅ Yes" : "❌ No"}</td></tr>`;
    description += `</table>`;
  }

  if (checks) {
    description += `<hr/><h4>Validation Checks</h4>`;
    description += `<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse">`;
    description += `<tr><th>Check</th><th>Result</th></tr>`;
    description += `<tr><td>Toast Detection</td><td>${checks.toast_confirmed ? "✅ PASS" : "❌ FAIL"}</td></tr>`;
    description += `<tr><td>Dashboard Visibility</td><td>${checks.dashboard_visible ? "✅ PASS" : "❌ FAIL"}</td></tr>`;
    description += `<tr><td>Table Search</td><td>${checks.table_search ? "✅ PASS" : "❌ FAIL"}</td></tr>`;
    description += `<tr><td>Field Validation</td><td>${checks.fields_valid ? "✅ PASS" : "❌ FAIL"}</td></tr>`;
    description += `</table>`;
  }

  if (extra?.table_data) {
    description += `<hr/><h4>Table Data (from UI)</h4>`;
    description += `<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse">`;
    description += `<tr><th>Field</th><th>Value</th></tr>`;
    for (const [key, val] of Object.entries(extra.table_data)) {
      description += `<tr><td>${key}</td><td>${val}</td></tr>`;
    }
    description += `</table>`;
  }

  if (extra?.field_mismatches && extra.field_mismatches.length > 0) {
    description += `<hr/><h4>Field Mismatches</h4>`;
    description += `<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse">`;
    description += `<tr><th>Field</th><th>Expected</th><th>Actual</th></tr>`;
    for (const m of extra.field_mismatches) {
      description += `<tr><td>${m.field}</td><td>${m.expected}</td><td>${m.actual}</td></tr>`;
    }
    description += `</table>`;
  }

  if (extra?.failure_type) {
    description += `<hr/><p><b>Failure Type:</b> <code>${extra.failure_type}</code></p>`;
  }

  // ── Save Result ──
  saveAllureResult({
    name: workflowName,
    fullName: `${suite} > ${workflowName}`,
    status: allureStatus,
    stage: "finished",
    start: startTime,
    stop: stopTime,
    description,
    descriptionHtml: description,
    labels: [
      { name: "suite", value: suite },
      { name: "parentSuite", value: "Captus QA Automation" },
      { name: "subSuite", value: workflowName },
      { name: "epic", value: "Risk Management" },
      { name: "feature", value: suite },
      { name: "story", value: workflowName },
      { name: "severity", value: suite === "CRUD Tests" ? "critical" : "normal" },
      { name: "framework", value: "Playwright" },
      { name: "host", value: "Render" },
    ],
    statusDetails: allureStatus !== "passed"
      ? { message: message, trace: extra?.failure_type || "" }
      : { message: message },
    steps: steps.length > 0 ? steps : undefined,
    parameters: parameters.length > 0 ? parameters : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

// ─── Generate HTML Report ────────────────────────────────────────────────────

export function generateReport(): { success: boolean; message: string; reportPath: string } {
  ensureDir(ALLURE_RESULTS_DIR);

  const files = fs.readdirSync(ALLURE_RESULTS_DIR).filter((f) => f.endsWith("-result.json"));
  if (files.length === 0) {
    return { success: false, message: "No test results found. Run tests first.", reportPath: "" };
  }

  try {
    // Preserve history from previous report
    const historyDir = path.join(ALLURE_REPORT_DIR, "history");
    const tempHistoryDir = path.join(ALLURE_RESULTS_DIR, "history");
    if (fs.existsSync(historyDir)) {
      ensureDir(tempHistoryDir);
      const historyFiles = fs.readdirSync(historyDir);
      for (const file of historyFiles) {
        fs.copyFileSync(path.join(historyDir, file), path.join(tempHistoryDir, file));
      }
      console.log("[Allure] Preserved history from previous report");
    }

    // Write environment.properties
    const envFile = path.join(ALLURE_RESULTS_DIR, "environment.properties");
    fs.writeFileSync(envFile, [
      "Framework=Playwright",
      "Platform=Render (Docker)",
      "Bot.Version=2.1.0-allure",
      "Browser=Chromium (headless)",
      "Application=Captus Risk Management",
      `Report.Generated=${new Date().toISOString()}`,
      `Total.Results=${files.length}`,
    ].join("\n"));

    // Generate report
    const allureBin = path.join(process.cwd(), "node_modules", ".bin", "allure");
    execSync(`${allureBin} generate ${ALLURE_RESULTS_DIR} --clean -o ${ALLURE_REPORT_DIR}`, {
      timeout: 30_000,
      stdio: "pipe",
    });

    console.log(`[Allure] Report generated — ${files.length} results`);
    return { success: true, message: `Report generated with ${files.length} test results`, reportPath: ALLURE_REPORT_DIR };
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.error(`[Allure] Report generation failed: ${errorMsg}`);
    return { success: false, message: errorMsg, reportPath: "" };
  }
}

// ─── Get Report Stats ────────────────────────────────────────────────────────

export function getReportStats(): { totalResults: number; reportExists: boolean; lastGenerated: string | null } {
  const resultsExist = fs.existsSync(ALLURE_RESULTS_DIR);
  const totalResults = resultsExist
    ? fs.readdirSync(ALLURE_RESULTS_DIR).filter((f) => f.endsWith("-result.json")).length
    : 0;
  const reportExists = fs.existsSync(path.join(ALLURE_REPORT_DIR, "index.html"));
  let lastGenerated: string | null = null;
  if (reportExists) {
    const stat = fs.statSync(path.join(ALLURE_REPORT_DIR, "index.html"));
    lastGenerated = stat.mtime.toISOString();
  }
  return { totalResults, reportExists, lastGenerated };
}

// ─── Clear Results ───────────────────────────────────────────────────────────

export function clearResults(): void {
  if (fs.existsSync(ALLURE_RESULTS_DIR)) {
    const files = fs.readdirSync(ALLURE_RESULTS_DIR);
    for (const file of files) {
      if (file.endsWith("-result.json") || file === "environment.properties") {
        fs.unlinkSync(path.join(ALLURE_RESULTS_DIR, file));
      }
    }
    console.log("[Allure] Results cleared");
  }
}