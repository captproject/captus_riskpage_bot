// ─── Allure Report Routes ─────────────────────────────────────────────────────
import { Request, Response, Router } from "express";
import * as path from "path";
import * as fs from "fs";
import express from "express";
import { generateReport, getReportStats, clearResults } from "./allureReporter";

const ALLURE_REPORT_DIR = path.join(process.cwd(), "allure-report");

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
allureRouter.use("/report", (req: Request, res: Response, next) => {
  const indexPath = path.join(ALLURE_REPORT_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    res.status(404).json({
      status: "not_found",
      message: "No report generated yet. Call POST /generate-report first.",
    });
    return;
  }
  next();
}, express.static(ALLURE_REPORT_DIR));