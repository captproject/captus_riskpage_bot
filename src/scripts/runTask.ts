// ─── Render Cron entrypoint ───────────────────────────────────────────────────
// Usage:
//   node dist/scripts/runTask.js --suite daily_regression   (the nightly run)
//   node dist/scripts/runTask.js --suite critical           (on-demand)
//   node dist/scripts/runTask.js --task tc_create_risk      (any single TC)
//   node dist/scripts/runTask.js --task login_bot_refresh   (hourly cron)
//
// Suite flow: wake Render → clear Allure results → run every TC strictly
// one-by-one → generate the final Allure report → deliver report link to
// Slack → write run-summary row to workflow_results.
// Exit code 0 = all pass, 1 = any fail/error (visible in Render run history).

import { loadConfig, OrchestratorConfig } from "../orchestrator/config";
import { TASKS, SUITES, TaskOutcome } from "../orchestrator/manifest";
import { callBot, wakeRender, notifySlack, logOrchestratorResult } from "../orchestrator/support";
import { runLoginBotRefresh } from "../orchestrator/loginBot";

function parseArgs(): { suite?: string; task?: string; noSlack: boolean } {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return { suite: get("--suite"), task: get("--task"), noSlack: args.includes("--no-slack") };
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function finalizeReport(cfg: OrchestratorConfig): Promise<void> {
  const res = await callBot(`${cfg.riskBot.baseUrl}/generate-report`, {
    apiKey: cfg.riskBot.apiKey, timeoutMs: 120_000, body: {},
  });
  if (!res.ok) console.error(`[Allure] generate-report failed: ${res.error || res.httpStatus}`);
  else console.log("[Allure] Report generated");
}

async function main(): Promise<void> {
  const { suite, task, noSlack } = parseArgs();
  const cfg = await loadConfig();

  // 01B_Login_Bot (hourly, independent of the regression pipeline)
  if (task === "login_bot_refresh") {
    const outcome = await runLoginBotRefresh(cfg);
    console.log(`[${outcome.task}] ${outcome.status.toUpperCase()} — ${outcome.detail} (${fmtDuration(outcome.durationMs)})`);
    process.exit(outcome.status === "pass" ? 0 : 1);
  }

  const taskIds: string[] = suite ? SUITES[suite] || [] : task ? [task] : [];
  if (taskIds.length === 0) {
    console.error(`Unknown suite/task. Suites: ${Object.keys(SUITES).join(", ")}. Tasks: ${Object.keys(TASKS).join(", ")}, login_bot_refresh`);
    process.exit(2);
  }

  const label = suite ? `suite:${suite}` : `task:${task}`;
  console.log(`[Runner] ${label} — ${taskIds.length} task(s), sequential`);

  // 1) Wake the Render service (replaces 00_Wake_Render + per-workflow health checks)
  const awake = await wakeRender(cfg);
  if (!awake) {
    if (!noSlack) await notifySlack(cfg, `:rotating_light: QA ${label} aborted — Render service did not wake`);
    process.exit(1);
  }

  // 2) Fresh Allure run: clear previous results so the final report covers
  //    exactly this run (was part of 01B in n8n; now owned by the pipeline).
  if (suite) {
    await callBot(`${cfg.riskBot.baseUrl}/clear-results`, { apiKey: cfg.riskBot.apiKey, timeoutMs: 60_000, body: {} });
  }

  // 3) Every TC strictly one-by-one
  const outcomes: TaskOutcome[] = [];
  for (const id of taskIds) {
    const fn = TASKS[id];
    if (!fn) {
      outcomes.push({ task: id, status: "error", detail: "Task not found in manifest", durationMs: 0 });
      continue;
    }
    // Per-task health gate (faithful port of n8n's per-workflow CHECK_HEALTH):
    // heavy tests can crash the bot service; wait for recovery before each task
    // instead of firing at a dead service.
    const healthy = await wakeRender(cfg, 180_000);
    if (!healthy) {
      outcomes.push({ task: id, status: "error", detail: "Bot service unavailable (did not recover before task)", durationMs: 0 });
      console.error(`[Runner] ← ${id}: ERROR — bot did not recover, skipping`);
      continue;
    }
    console.log(`[Runner] → ${id}`);
    try {
      const outcome = await fn(cfg);
      outcomes.push(outcome);
      console.log(`[Runner] ← ${outcome.task}: ${outcome.status.toUpperCase()} — ${outcome.detail} (${fmtDuration(outcome.durationMs)})`);
    } catch (err) {
      outcomes.push({ task: id, status: "error", detail: String((err as Error).message), durationMs: 0 });
      console.error(`[Runner] ← ${id}: ERROR — ${(err as Error).message}`);
    }
  }

  const passed = outcomes.filter((o) => o.status === "pass").length;
  const failedList = outcomes.filter((o) => o.status !== "pass").map((o) => o.task);
  const failed = failedList.length;

  // 4) Final Allure report for the whole run (health-gated: last task may have
  //    crashed the bot; give it a chance to recover so the report still lands)
  if (suite) {
    await wakeRender(cfg, 180_000);
    await finalizeReport(cfg);
  }

  // 5) Supabase run-summary row (per-TC rows are written by the bot itself)
  await logOrchestratorResult(cfg, `RUN_${(suite || task || "unknown").toUpperCase()}`, failed === 0 ? "pass" : "fail", {
    message: `${passed}/${outcomes.length} passed${failed ? `; failed: ${failedList.join(", ")}` : ""}`,
    details: { outcomes },
  });

  // 6) Slack: single message whose job is delivering the Allure report
  if (suite && !noSlack) {
    const statusIcon = failed === 0 ? ":white_check_mark:" : ":x:";
    await notifySlack(
      cfg,
      `${statusIcon} QA ${suite} — ${passed}/${outcomes.length} passed${failed ? ` (failed: ${failedList.join(", ")})` : ""}\nAllure report: ${cfg.riskBot.baseUrl}/report`
    );
  }

  console.log(`[Runner] Done: ${passed}/${outcomes.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[Runner] Fatal: ${err?.message || err}`);
  process.exit(1);
});
