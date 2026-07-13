#!/usr/bin/env node
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file.
/**
 * tools/health-watch.mjs — DNS-failover trigger monitor (plan item 30). 2026-07-13.
 *
 * Polls the PRIMARY origin's /health endpoint and pages the alert webhook after
 * N consecutive failures — the human (or the DNS provider's own failover
 * feature) then executes the DNS step in DISASTER_RECOVERY.md §4.
 *
 * HARD CONSTRAINT (non-negotiable, from the plan): failure detection uses
 * ORIGIN HEALTH SIGNALS ONLY — TCP/TLS connect success, HTTP status, response
 * latency. There is deliberately NO input for client IP, geography, or ISP
 * anywhere in this tool, and none may be added; "is the origin responding" is
 * the only question it asks. If you find yourself wanting "is this reachable
 * from region X", stop — that is a different feature requiring its own
 * decision (plan item 31).
 *
 * Run anywhere OUTSIDE the primary host (a $5 VPS, a cron runner, a second
 * region): the monitor must not die with the thing it monitors.
 *
 *   PRIMARY_URL=https://yourdomain.com/health \
 *   ALERT_WEBHOOK_URL=https://hooks.slack.com/... \
 *   node tools/health-watch.mjs
 *
 * Env: PRIMARY_URL (required) · ALERT_WEBHOOK_URL (required to page)
 *      CHECK_INTERVAL_MS (default 30000) · FAIL_THRESHOLD (default 3,
 *      consecutive — one blip never flaps) · LATENCY_BUDGET_MS (default 10000)
 */
const url        = process.env.PRIMARY_URL;
const webhook    = process.env.ALERT_WEBHOOK_URL;
const intervalMs = Number(process.env.CHECK_INTERVAL_MS || 30_000);
const threshold  = Number(process.env.FAIL_THRESHOLD || 3);
const budgetMs   = Number(process.env.LATENCY_BUDGET_MS || 10_000);

if (!url) { console.error('PRIMARY_URL is required'); process.exit(1); }

let consecutiveFailures = 0;
let alerted = false;

async function page(text, details) {
  if (!webhook) { console.error('[health-watch] (no webhook set)', text); return; }
  try {
    await fetch(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🚨 [health-watch] ${text}`, details, ts: new Date().toISOString() }),
    });
  } catch (e) { console.error('[health-watch] webhook failed:', e.message); }
}

async function check() {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), budgetMs);
    const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    const ms = Date.now() - started;
    if (res.ok && ms <= budgetMs) {
      if (alerted) {
        await page(`RECOVERED: ${url} healthy again (${ms}ms). Failback is a MANUAL decision — see DISASTER_RECOVERY.md §4.`, { latencyMs: ms });
        alerted = false;
      }
      consecutiveFailures = 0;
      console.log(`[health-watch] OK ${res.status} ${ms}ms`);
      return;
    }
    throw new Error(`HTTP ${res.status} in ${ms}ms`);
  } catch (e) {
    consecutiveFailures++;
    console.warn(`[health-watch] FAIL ${consecutiveFailures}/${threshold}: ${e.message}`);
    if (consecutiveFailures >= threshold && !alerted) {
      alerted = true;
      await page(
        `PRIMARY ORIGIN DOWN: ${url} failed ${consecutiveFailures} consecutive checks. Execute the DNS failover runbook (DISASTER_RECOVERY.md §4).`,
        { url, consecutiveFailures, lastError: e.message },
      );
    }
  }
}

console.log(`[health-watch] watching ${url} every ${intervalMs}ms (threshold ${threshold}, budget ${budgetMs}ms)`);
setInterval(check, intervalMs);
check();
