// ─── Orchestrator Support: HTTP client, Slack, result logging ────────────────
// callBot()      replaces n8n HTTP Request nodes (same timeouts, same headers).
// notifySlack()  replaces the n8n Slack node (webhook instead of OAuth).
// logOrchestratorResult() writes rows for checks the bot never sees
//                (SEC-2 direct API probes, negative-auth expectations, run summaries).

import { Agent } from "undici";
import { OrchestratorConfig } from "./config";

// Node's built-in fetch (undici) enforces a hidden 300s headersTimeout by
// default, independent of any AbortController signal. Bot calls that hold the
// connection silently past 5 minutes (bulk operations ~5.5min, sec11 ~5min)
// abort with a generic "fetch failed" while the bot completes server-side —
// the same ceiling class as n8n's ECONNABORTED at 240s. This dispatcher
// raises the ceiling above the longest configured timeoutMs (600s).
const longRunningDispatcher = new Agent({
  headersTimeout: 660_000,
  bodyTimeout: 660_000,
});

export interface BotCallResult {
  ok: boolean;
  httpStatus: number;
  timedOut: boolean;
  durationMs: number;
  body: any;
  error?: string;
}

export async function callBot(
  url: string,
  options: {
    method?: "GET" | "POST";
    apiKey?: string | null; // null = deliberately omit header (SEC negative tests)
    body?: any;
    timeoutMs: number;
    extraHeaders?: Record<string, string>;
  }
): Promise<BotCallResult> {
  const { method = "POST", apiKey, body, timeoutMs, extraHeaders } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(extraHeaders || {}) };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetch(url, {
      method,
      headers,
      body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      // undici-specific option; not in the standard fetch types
      dispatcher: longRunningDispatcher,
    } as RequestInit & { dispatcher: Agent });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
    return { ok: res.ok, httpStatus: res.status, timedOut: false, durationMs: Date.now() - started, body: parsed };
  } catch (err: any) {
    const timedOut = err?.name === "AbortError";
    return {
      ok: false, httpStatus: 0, timedOut, durationMs: Date.now() - started,
      body: null, error: timedOut ? `Timed out after ${timeoutMs}ms` : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Wake Render: replaces 00_Wake_Render (health poll with retries) ──────────
export async function wakeRender(cfg: OrchestratorConfig, maxWaitMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const res = await callBot(`${cfg.riskBot.baseUrl}/health`, { method: "GET", timeoutMs: 30_000 });
    if (res.ok) {
      console.log(`[Wake] Service awake (attempt ${attempt}, ${res.durationMs}ms)`);
      return true;
    }
    console.log(`[Wake] Not ready (attempt ${attempt}): ${res.error || res.httpStatus}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.error("[Wake] Service failed to wake within window");
  return false;
}

// ── Slack ─────────────────────────────────────────────────────────────────────
export async function notifySlack(cfg: OrchestratorConfig, text: string): Promise<void> {
  const hook = cfg.notifications.slackWebhook;
  if (!hook || !hook.startsWith("https://")) {
    console.log("[Slack] Webhook not configured — skipping:", text.slice(0, 120));
    return;
  }
  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error(`[Slack] Failed: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`[Slack] Error: ${(err as Error).message}`);
  }
}

// ── Orchestrator-level result logging ────────────────────────────────────────
// Same shape the bot's supabaseLogger writes, plus details.source = "render-cron"
// so parallel-run rows are distinguishable from n8n-era rows during cutover.
export async function logOrchestratorResult(
  cfg: OrchestratorConfig,
  workflowName: string,
  status: "pass" | "fail" | "error",
  fields: {
    message?: string;
    assertion_expected?: string;
    assertion_actual?: string;
    assertion_match?: boolean;
    details?: Record<string, any>;
  } = {}
): Promise<void> {
  try {
    const row = {
      workflow_name: workflowName,
      status,
      username: cfg.users.qa_user.email,
      message: fields.message || null,
      assertion_expected: fields.assertion_expected || null,
      assertion_actual: fields.assertion_actual || null,
      assertion_match: fields.assertion_match ?? status === "pass",
      details: JSON.stringify({ source: "render-cron", ...(fields.details || {}) }),
      executed_at: new Date().toISOString(),
    };
    const res = await fetch(`${cfg.supabase.url}/rest/v1/workflow_results`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabase.key,
        Authorization: `Bearer ${cfg.supabase.key}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) console.error(`[Result] Orchestrator log failed: ${await res.text()}`);
  } catch (err) {
    console.error(`[Result] Orchestrator log error: ${(err as Error).message}`);
  }
}

// ── Shared date helpers (byte-equivalent to n8n Luxon expressions) ───────────
export function nowStamp(): string {
  // $now.toFormat('yyyyMMdd_HHmmss') — UTC, matching n8n Cloud instance TZ
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function duePlus30(): string {
  // $now.plus(30,'days').toFormat('yyyy-MM-dd')
  const d = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
