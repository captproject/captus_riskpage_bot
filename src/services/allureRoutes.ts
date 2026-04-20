// ─── Allure Report Routes ─────────────────────────────────────────────────────
import { Request, Response, Router } from "express";
import * as path from "path";
import * as fs from "fs";
import express from "express";
import { generateReport, getReportStats, clearResults } from "./allureReporter";

const ALLURE_REPORT_DIR = path.join(process.cwd(), "allure-report");
const ALLURE_RESULTS_DIR = path.join(process.cwd(), "allure-results");

export const allureRouter = Router();

// POST /generate-report
allureRouter.post("/generate-report", (req: Request, res: Response) => {
  console.log("[Allure] Generating report...");
  const result = generateReport();
  res.json(result);
});

// GET /report-stats
allureRouter.get("/report-stats", (req: Request, res: Response) => {
  const stats = getReportStats();
  res.json({ status: "ok", ...stats, reportUrl: stats.reportExists ? "/report" : null });
});

// POST /clear-results
allureRouter.post("/clear-results", (req: Request, res: Response) => {
  clearResults();
  res.json({ status: "ok", message: "All Allure results cleared" });
});

// GET /report — serve static Allure HTML dashboard
// Auto-generates report if results exist but report doesn't
allureRouter.use("/report", (req: Request, res: Response, next) => {
  const indexPath = path.join(ALLURE_REPORT_DIR, "index.html");

  // If report exists, serve it
  if (fs.existsSync(indexPath)) {
    next();
    return;
  }

  // If results exist but report doesn't, auto-generate
  const hasResults = fs.existsSync(ALLURE_RESULTS_DIR) &&
    fs.readdirSync(ALLURE_RESULTS_DIR).some((f) => f.endsWith("-result.json"));

  if (hasResults) {
    console.log("[Allure] Report missing but results found — auto-generating...");
    const result = generateReport();
    if (result.success && fs.existsSync(indexPath)) {
      console.log("[Allure] Auto-generated successfully");
      next();
      return;
    }
  }

  // No results and no report
  res.status(404).json({
    status: "not_found",
    message: "No test results available. Run tests first, then access /report.",
  });
}, express.static(ALLURE_REPORT_DIR));