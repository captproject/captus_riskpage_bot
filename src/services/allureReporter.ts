// ─── Allure Reporter Service ──────────────────────────────────────────────────
// Collects test results in Allure-compatible JSON format.
// After tests run, call generateReport() to build the HTML dashboard.
// Serve via /report endpoint.

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const ALLURE_RESULTS_DIR = path.join(process.cwd(), "allure-results");
const ALLURE_REPORT_DIR = path.join(process.cwd(), "allure-report");

// Ensure directories exist
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Save Test Result in Allure Format ───────────────────────────────────────

export function saveAllureResult(data: {
  name: string;
  fullName: string;
  status: "passed" | "failed" | "broken";
  stage: "finished";
  start: number;
  stop: number;
  labels: Array<{ name: string; value: string }>;
  statusDetails?: { message?: string; trace?: string };
  steps?: Array<{
    name: string;
    status: "passed" | "failed" | "broken";
    start: number;
    stop: number;
    statusDetails?: { message?: string };
  }>;
  attachments?: Array<{ name: string; source: string; type: string }>;
}): void {
  ensureDir(ALLURE_RESULTS_DIR);

  const uuid = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const resultFile = path.join(ALLURE_RESULTS_DIR, `${uuid}-result.json`);

  const result = {
    uuid,
    historyId: Buffer.from(data.fullName).toString("base64").slice(0, 32),
    ...data,
  };

  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  console.log(`[Allure] Saved result: ${data.name} → ${data.status}`);
}

// ─── Helper: Convert Bot Result to Allure Result ─────────────────────────────

export function recordTestResult(
  workflowName: string,
  suite: string,
  status: string,
  message: string,
  startTime: number,
  checks?: { toast_confirmed?: boolean; dashboard_visible?: boolean; table_search?: boolean; fields_valid?: boolean },
  screenshotUrl?: string | null,
  extra?: Record<string, any>
): void {
  const allureStatus: "passed" | "failed" | "broken" =
    status === "success" || status === "pass" ? "passed" :
    status === "error" ? "broken" : "failed";

  const stopTime = Date.now();

  const steps: Array<{
    name: string;
    status: "passed" | "failed" | "broken";
    start: number;
    stop: number;
    statusDetails?: { message?: string };
  }> = [];

  if (checks) {
    const stepNames = [
      { key: "toast_confirmed", label: "Toast Detection" },
      { key: "dashboard_visible", label: "Dashboard Visibility" },
      { key: "table_search", label: "Table Search" },
      { key: "fields_valid", label: "Field Validation" },
    ];
    const stepDuration = Math.floor((stopTime - startTime) / 4);
    stepNames.forEach((s, i) => {
      const val = (checks as any)[s.key];
      if (val !== undefined) {
        steps.push({
          name: s.label,
          status: val ? "passed" : "failed",
          start: startTime + stepDuration * i,
          stop: startTime + stepDuration * (i + 1),
          statusDetails: val ? undefined : { message: `${s.label} failed` },
        });
      }
    });
  }

  const attachments: Array<{ name: string; source: string; type: string }> = [];
  if (screenshotUrl) {
    attachments.push({
      name: "Failure Screenshot",
      source: screenshotUrl,
      type: "text/uri-list",
    });
  }

  saveAllureResult({
    name: workflowName,
    fullName: `${suite} > ${workflowName}`,
    status: allureStatus,
    stage: "finished",
    start: startTime,
    stop: stopTime,
    labels: [
      { name: "suite", value: suite },
      { name: "parentSuite", value: "Captus QA Automation" },
      { name: "subSuite", value: workflowName },
      { name: "epic", value: "Risk Management" },
      { name: "feature", value: suite },
      { name: "story", value: workflowName },
      { name: "severity", value: suite === "Smoke Tests" ? "critical" : "normal" },
      { name: "framework", value: "Playwright" },
      { name: "host", value: "Render" },
    ],
    statusDetails: allureStatus !== "passed" ? { message } : undefined,
    steps: steps.length > 0 ? steps : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

// ─── Generate HTML Report ────────────────────────────────────────────────────

export function generateReport(): { success: boolean; message: string; reportPath: string } {
  ensureDir(ALLURE_RESULTS_DIR);

  // Check if there are any results
  const files = fs.readdirSync(ALLURE_RESULTS_DIR).filter((f) => f.endsWith("-result.json"));
  if (files.length === 0) {
    return { success: false, message: "No test results found. Run tests first.", reportPath: "" };
  }

  try {
    // Copy history from previous report if exists
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

    // Generate report
    const allureBin = path.join(process.cwd(), "node_modules", ".bin", "allure");
    execSync(`${allureBin} generate ${ALLURE_RESULTS_DIR} --clean -o ${ALLURE_REPORT_DIR}`, {
      timeout: 30_000,
      stdio: "pipe",
    });

    console.log(`[Allure] Report generated — ${files.length} results`);
    return {
      success: true,
      message: `Report generated with ${files.length} test results`,
      reportPath: ALLURE_REPORT_DIR,
    };
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.error(`[Allure] Report generation failed: ${errorMsg}`);
    return { success: false, message: errorMsg, reportPath: "" };
  }
}

// ─── Get Report Stats ────────────────────────────────────────────────────────

export function getReportStats(): {
  totalResults: number;
  reportExists: boolean;
  lastGenerated: string | null;
} {
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

// ─── Clear Results (optional — for fresh start) ─────────────────────────────

export function clearResults(): void {
  if (fs.existsSync(ALLURE_RESULTS_DIR)) {
    const files = fs.readdirSync(ALLURE_RESULTS_DIR);
    for (const file of files) {
      if (file.endsWith("-result.json")) {
        fs.unlinkSync(path.join(ALLURE_RESULTS_DIR, file));
      }
    }
    console.log("[Allure] Results cleared");
  }
}