// ─── Allure Report Routes ─────────────────────────────────────────────────────
// POST /generate-report  → builds Allure HTML from collected results
// GET  /report           → serves the Allure HTML dashboard
// GET  /report-stats     → returns result count and report status
// POST /clear-results    → clears all collected results for fresh start

import { Request, Response } from "express";
import * as path from "path";
import * as fs from "fs";
import { generateReport, getReportStats, clearResults } from "./allureReporter";

const ALLURE_REPORT_DIR = path.join(process.cwd(), "allure-report");

// POST /generate-report
export function handleGenerateReport(_req: Request, res: Response): void {
  console.log("[Allure] Generating report...");
  const result = generateReport();
  res.json(result);
}

// GET /report — serve Allure HTML
export function handleServeReport(req: Request, res: Response): void {
  const indexPath = path.join(ALLURE_REPORT_DIR, "index.html");

  if (!fs.existsSync(indexPath)) {
    res.status(404).json({
      status: "not_found",
      message: "No report generated yet. Call POST /generate-report first.",
    });
    return;
  }

  // Serve specific file if path is provided
  const filePath = req.params[0] || "index.html";
  const fullPath = path.join(ALLURE_REPORT_DIR, filePath);

  if (!fs.existsSync(fullPath)) {
    res.status(404).send("File not found");
    return;
  }

  // Set correct content type
  const ext = path.extname(fullPath).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  };
  const contentType = contentTypes[ext] || "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.sendFile(fullPath);
}

// GET /report-stats
export function handleReportStats(_req: Request, res: Response): void {
  const stats = getReportStats();
  res.json({
    status: "ok",
    ...stats,
    reportUrl: stats.reportExists ? "/report" : null,
  });
}

// POST /clear-results
export function handleClearResults(_req: Request, res: Response): void {
  clearResults();
  res.json({ status: "ok", message: "All Allure results cleared" });
}