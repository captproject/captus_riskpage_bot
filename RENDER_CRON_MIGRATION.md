# n8n → Render Cron Migration Runbook (v2 — single sequential pipeline)

Migration of all n8n QA workflows to Render Cron Jobs using the orchestrator
in `src/orchestrator/` + `src/scripts/runTask.ts`.

The bot service (`captus-riskpage-bot-6ycg`) is unchanged: it runs the
Playwright tests and writes per-test rows to `workflow_results`. The
orchestrator replaces what n8n did — scheduling, sequencing, HTTP calls,
Allure lifecycle, Slack delivery.

**Design (per requirements):** every TC executes strictly one after another in
a single daily pipeline, followed by ONE final Allure report, delivered to
Slack, plus a run-summary row in Supabase. Slack's only job is delivering the
Allure report (with a one-line pass count for context). No scattered
schedules, no minute-staggering.

---

## 1. New files (add to `captproject/captus_riskpage_bot`)

```
src/orchestrator/config.ts     — loads Config_Files from Supabase (replaces 00_Config_Loader)
src/orchestrator/support.ts    — HTTP client, wakeRender, Slack webhook, result logging
src/orchestrator/manifest.ts   — all TCs as tasks + the daily_regression sequence
src/orchestrator/loginBot.ts   — 01B_Login_Bot port (SignIn_Task refresh loop)
src/scripts/runTask.ts         — CLI entrypoint for cron jobs
```

No `package.json` changes needed (`npm run build` compiles these; Node 18+
provides global `fetch`). Run `npm run build` locally before pushing; verify
with `/version` after Render deploys.

## 2. Render Cron Job services — only TWO

Create each as a **Cron Job** in Render, same repo, branch `main`,
build command `npm install && npm run build`. Schedules are UTC.

| # | Service name            | Schedule (UTC) | Command                                                    | Purpose |
|---|-------------------------|----------------|------------------------------------------------------------|---------|
| 1 | `qa-daily-regression`   | `0 1 * * *`    | `node dist/scripts/runTask.js --suite daily_regression`    | The entire QA day: every TC sequentially → Allure report → Slack → Supabase summary |
| 2 | `qa-login-refresh`      | `0 * * * *`    | `node dist/scripts/runTask.js --task login_bot_refresh`    | 01B_Login_Bot hourly SignIn_Task refresh |

`0 1 * * *` = 01:00 UTC = 06:30 IST, so the report is in Slack before the
workday. Changing the time is a one-field edit on the service — pick whatever
suits standup.

### Pipeline flow (`daily_regression`)

1. Wake Render (`/health` poll — replaces 00_Wake_Render and all per-workflow health checks)
2. `POST /clear-results` — fresh Allure run scoped to exactly this pipeline
3. Every TC strictly one-by-one, in old-n8n-day chronological order:
   integration tests → project selector → registry load → chat message →
   SEC-2 → current user → SEC-6 → SEC-8 → SEC-11 → create risk → edit risk →
   delete risk → SEC-1 → score matrix → filter risks → status workflow →
   session termination (kills session, so near the end) → audit log (last)
4. `POST /generate-report` — ONE final Allure report covering the whole run
5. Run-summary row → `workflow_results` (per-TC rows written by the bot as always)
6. ONE Slack message: pass count + Allure report link (`<bot>/report`)

On-demand (no cron): `--suite critical` (98_Critical_Test_Runner),
`--task tc_login_module`, `--task tc_create_dependency`, or any single TC via
`--task <id>`.

### Deliberate changes vs n8n (all requested/agreed)

1. **One daily run replaces the scattered schedule** (CRUD was 6×/day; now 1×/day
   inside the pipeline). Side effect: orphaned `QA_`/seeded risk creation drops ~6×.
2. **Sequential execution is guaranteed**, not stagger-and-hope — no browser
   singleton collisions possible within the pipeline.
3. **Allure lifecycle owned by the pipeline**: clear at start, generate at end.
   The hourly login bot no longer calls `/clear-results` (in n8n it wiped
   results hourly; that would corrupt the daily report).
4. **Slack = report delivery only.** One message per run: status line + report
   link. Uses an incoming webhook (`SLACK_WEBHOOK_URL` env var or
   `Config_Files` → notifications/slack_webhook). The current table value is a
   placeholder — set a real webhook before cutover.
5. **SEC-2 still targets `captus.replit.app`** (ported 1:1). Post-cutover, set
   `SEC2_TARGET_BASE=https://web-demo-application.onrender.com`.
6. **SET_RESULT `"success"`/`"pass"` bug retired**; **`retryOnFail` duplicate
   runs impossible** (orchestrator never re-fires Playwright calls).
7. **SEC-2/6/8 results now land in `workflow_results`** with
   `details.source = "render-cron"` (previously only in n8n execution logs).

## 3. Environment variables (set on both cron services)

| Variable | Value | Required |
|---|---|---|
| `SUPABASE_URL` | `https://fhrieaeihuhvgyojlzne.supabase.co` | yes |
| `SUPABASE_KEY` | QA project key (same one n8n used) | yes |
| `RISK_BOT_API_KEY` | risk bot x-api-key | yes |
| `LOGIN_BOT_API_KEY` | 01_Login_Module key (differs from risk bot key) | only for `--task tc_login_module` |
| `SLACK_WEBHOOK_URL` | real incoming-webhook URL | before cutover |
| `SEC2_TARGET_BASE` | unset for 1:1; Render backend URL post-cutover | no |

Non-secret config still loads from `Config_Files` at run start — the table
remains the source of truth; env vars override.

## 4. Parallel-run plan (3–5 days)

Both stacks running doubles seeded data and can collide on the browser
singleton, so:

1. Schedule `qa-daily-regression` at a quiet window vs n8n (01:00 UTC sits
   after integration tests at 01:25 — use `0 3 * * *` during overlap if you
   want full clearance, then move to the final time at cutover).
2. Compare daily:

```sql
SELECT workflow_name,
       count(*) FILTER (WHERE lower(status) IN ('pass','passed','success')) AS pass,
       count(*) FILTER (WHERE lower(status) NOT IN ('pass','passed','success')) AS fail
FROM workflow_results
WHERE executed_at >= now() - interval '1 day'
GROUP BY 1 ORDER BY 1;
```

Run-summary rows are named `RUN_DAILY_REGRESSION` with `details.source =
"render-cron"` and a per-TC outcomes array — one row tells you the whole night.

## 5. Cutover checklist

- [ ] `npm run build` passes locally; push; `/version` confirms deploy
- [ ] Both cron services created; env vars set
- [ ] One manual "Trigger Run" of `daily_regression` is green end-to-end
- [ ] Real Slack webhook set; report link message received
- [ ] Parallel window complete; pass rates match n8n
- [ ] Deactivate every n8n workflow trigger (toggle off — do not delete yet)
- [ ] After 1 clean week: archive final n8n JSONs in repo (`src/n8n/archive/`), cancel n8n Cloud
- [ ] Post-cutover fixes now unblocked: SEC-2 target URL, TC_Chat_Message entry
      point, dashboard-search tests (pending testids), TC_Create_Dependency retirement

## 6. n8n → new structure map (complete)

| n8n workflow | New home |
|---|---|
| 00_Config_Loader | `config.ts` (reads Config_Files per run) |
| 00_Wake_Render | pipeline step 1 (health poll) |
| 00_Workflow_Template | retired (pattern lives in `manifest.ts`) |
| 01_Login_Module | `--task tc_login_module` (on-demand) |
| 01B_Login_Bot | `--task login_bot_refresh`, hourly cron |
| 98_Critical_Test_Runner | `--suite critical` (on-demand) |
| All scheduled TC_* and SEC-* workflows | `daily_regression` sequence (order in §2) |
| TC_Audit_Log's report + Slack steps | pipeline steps 4–6 (report → Supabase → Slack) |
| TC_Create_Dependency | `--task tc_create_dependency` (on-demand; was unscheduled) |
