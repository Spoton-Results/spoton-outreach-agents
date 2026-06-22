/**
 * SubDraw Master Orchestrator
 * 
 * The ONLY service that runs on a schedule.
 * All other services are workers — they sit idle until this calls them.
 * 
 * Worker URLs are set via env vars in Railway:
 *   WORKER_REPLY_URL       → reply-handler service URL
 *   WORKER_BRIEFING_URL    → daily-briefing service URL  
 *   WORKER_REVENUE_URL     → revenue-monitor service URL
 *   WORKER_ANALYZER_URL    → weekly-analyzer service URL
 * 
 * Schedule:
 *   Every 5 min  — Prospect finder (runs locally, lightweight)
 *   Every 2 min  — SMS reply handler (runs locally)
 *   Every 15 min — Reply handler (calls reply-handler worker)
 *   Every 2 hr   — Revenue monitor (calls revenue-monitor worker)
 *   Every 6 hr   — Demo engagement tracker (runs locally)
 *   Daily 5am    — Daily briefing (calls daily-briefing worker)
 *   Sunday mid   — Weekly analyzer (calls weekly-analyzer worker)
 * 
 *   SMS blast — ONLY runs when explicitly triggered via /trigger-sms
 *   Never auto-fires on deploy or schedule without confirmation
 */
require('dotenv').config({ path: './config/.env' });
const { logRun } = require('./utils/helpers');
const http = require('http');

const WORKER_SECRET = process.env.WORKER_SECRET || 'subdraw-worker-2026';

console.log('═══════════════════════════════════════════════');
console.log('🚀 SubDraw Master Orchestrator — Starting');
console.log('   Time:', new Date().toISOString());
console.log('   Role: ORCHESTRATOR ONLY — workers handle execution');
console.log('═══════════════════════════════════════════════\n');

// ── CALL A WORKER ─────────────────────────────────────────────────────────────
async function callWorker(workerUrl, job, params = {}) {
  if (!workerUrl) {
    console.log(`[Orchestrator] No URL for job ${job} — skipping`);
    return null;
  }
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(workerUrl + '/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': WORKER_SECRET
      },
      body: JSON.stringify({ job, params }),
      signal: AbortSignal.timeout(10 * 60 * 1000) // 10 min timeout
    });
    const data = await res.json();
    if (!data.ok) console.error(`[Orchestrator] Worker error for ${job}:`, data.error);
    return data;
  } catch(e) {
    console.error(`[Orchestrator] Failed to call worker for ${job}:`, e.message);
    return null;
  }
}

// Worker URLs from env
const WORKERS = {
  reply:    process.env.WORKER_REPLY_URL,
  briefing: process.env.WORKER_BRIEFING_URL,
  revenue:  process.env.WORKER_REVENUE_URL,
  analyzer: process.env.WORKER_ANALYZER_URL,
};

// ── SCHEDULE STATE ────────────────────────────────────────────────────────────
const lastRun = {};
const intervals = {
  prospect_continuous: 5 * 60 * 1000,
  sms_reply_handler:   2 * 60 * 1000,
  reply_handler:       15 * 60 * 1000,
  revenue_monitor:     2 * 60 * 60 * 1000,
  demo_tracker:        6 * 60 * 60 * 1000,
  sms_agent:           2 * 60 * 60 * 1000,
};

function shouldRun(key) {
  const now = Date.now();
  if (!lastRun[key]) return true;
  return (now - lastRun[key]) >= intervals[key];
}
function markRun(key) { lastRun[key] = Date.now(); }
function isHour(h) { return new Date().getHours() === h && new Date().getMinutes() < 5; }
function isDayOfWeek(d) { return new Date().getDay() === d; }

// ── TICK ──────────────────────────────────────────────────────────────────────
let runCount = 0;

async function tick() {
  runCount++;
  const now = new Date();
  console.log(`\n[Orchestrator] Tick #${runCount} — ${now.toISOString()}`);

  // Every 5 min: Prospect finder (lightweight, runs locally)
  if (shouldRun('prospect_continuous')) {
    markRun('prospect_continuous');
    runJob('Prospect Finder', async () => {
      const { findProspects } = require('./agents/01-prospect-finder');
      const results = await findProspects();
      console.log(`[ProspectFinder] Pushed ${results.length} contacts`);
    });
  }

  // Every 2 min: SMS reply handler (lightweight, runs locally)
  if (shouldRun('sms_reply_handler')) {
    markRun('sms_reply_handler');
    runJob('SMS Reply Handler', async () => {
      const { pollSMSReplies } = require('./agents/38-sms-reply-handler');
      await pollSMSReplies();
    });
  }

  // Every 15 min: Email reply handler (calls worker)
  if (shouldRun('reply_handler')) {
    markRun('reply_handler');
    runJob('Reply Handler', async () => {
      await callWorker(WORKERS.reply, 'reply-handler');
    });
  }

  // Every 2 hr: Revenue monitor (calls worker)
  if (shouldRun('revenue_monitor')) {
    markRun('revenue_monitor');
    runJob('Revenue Monitor', async () => {
      await callWorker(WORKERS.revenue, 'revenue-monitor');
    });
  }

  // Every 2 hr: High-intent SMS agent (runs locally — no blast, just nudges)
  if (shouldRun('sms_agent')) {
    markRun('sms_agent');
    runJob('High-Intent SMS Agent', async () => {
      const { runSMSAgent } = require('./agents/15-sms-agent');
      await runSMSAgent();
    });
  }

  // Every 6 hr: Demo tracker (runs locally)
  if (shouldRun('demo_tracker')) {
    markRun('demo_tracker');
    runJob('Demo Tracker', async () => {
      const { runDemoTracker } = require('./agents/16-demo-engagement-tracker');
      await runDemoTracker();
    });
  }

  // Daily 5am: Founder briefing (calls worker)
  if (isHour(5) && !lastRun['daily_briefing_' + now.toDateString()]) {
    lastRun['daily_briefing_' + now.toDateString()] = Date.now();
    runJob('Daily Briefing', async () => {
      await callWorker(WORKERS.briefing, 'daily-briefing');
    });
  }

  // Daily 6am: Full pipeline prospector (runs locally)
  if (isHour(6) && !lastRun['full_pipeline_' + now.toDateString()]) {
    lastRun['full_pipeline_' + now.toDateString()] = Date.now();
    runJob('Full Pipeline', async () => {
      const { findProspects }      = require('./agents/01-prospect-finder');
      const { screenProspects }    = require('./agents/02-pre-screener');
      const { gatherIntelBatch }   = require('./agents/03-competitive-intel');
      const { enrichBatch }        = require('./agents/33-lead-enrichment');
      const { scoreBatch }         = require('./agents/34-icp-scorer');
      const { scoutBatch }         = require('./agents/04-personalization-scout');
      const { writeSequenceBatch } = require('./agents/05-email-copywriter');
      const { reviewBatch }        = require('./agents/06-quality-reviewer');
      const { verifyContacts }     = require('./agents/07-data-verifier');
      const { launchCampaigns }    = require('./agents/08-campaign-launcher');
      const { logToGHL }           = require('./agents/09-crm-logger');

      const state = process.env.TARGET_STATE || 'California';
      const limit = parseInt(process.env.MAX_PROSPECTS_PER_RUN || '25');
      const raw = await findProspects({ state, limit });
      if (!raw.length) { console.log('[FullPipeline] No prospects'); return; }
      const screened   = await screenProspects(raw);
      const withIntel  = await gatherIntelBatch(screened);
      const withEnrich = await enrichBatch(withIntel);
      const withScore  = await scoreBatch(withEnrich);
      const withHooks  = await scoutBatch(withScore);
      const withEmails = await writeSequenceBatch(withHooks);
      const { approved } = await reviewBatch(withEmails);
      const verified   = await verifyContacts(approved);
      const { launched } = await launchCampaigns(verified);
      await logToGHL(launched);
      console.log(`[FullPipeline] Done — launched:${launched.length}`);
    });
  }

  // Sunday midnight: Weekly analyzer (calls worker)
  if (isDayOfWeek(0) && isHour(0) && !lastRun['weekly_' + now.toDateString()]) {
    lastRun['weekly_' + now.toDateString()] = Date.now();
    runJob('Weekly Analyzer', async () => {
      await callWorker(WORKERS.analyzer, 'weekly-analyzer');
    });
  }

  // SMS BLAST — DISABLED FROM AUTO-SCHEDULE
  // Only fires via manual HTTP trigger below: POST /trigger-sms
}

async function runJob(name, fn) {
  console.log(`[Orchestrator] ▶ ${name}`);
  const start = Date.now();
  try {
    await fn();
    console.log(`[Orchestrator] ✓ ${name} — ${Date.now() - start}ms`);
  } catch(err) {
    console.error(`[Orchestrator] ✗ ${name}: ${err.message}`);
  }
}

// ── HTTP SERVER — manual triggers only ───────────────────────────────────────
// POST /trigger-sms   → manually fire SMS blast (requires secret header)
// GET  /health        → health check
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, role: 'orchestrator', uptime: process.uptime(), tick: runCount }));
    return;
  }

  if (req.method === 'POST' && req.url === '/trigger-sms') {
    const secret = req.headers['x-worker-secret'];
    if (secret !== WORKER_SECRET) { res.writeHead(401); res.end('Unauthorized'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'SMS blast triggered — check logs' }));
    // Fire blast via reply-handler worker
    runJob('SMS Blast (manual trigger)', async () => {
      await callWorker(WORKERS.reply, 'sms-blast');
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`[Orchestrator] HTTP on port ${PORT} — /health + /trigger-sms`));

// ── START ─────────────────────────────────────────────────────────────────────
const TICK_MS = 5 * 60 * 1000;
tick();
setInterval(tick, TICK_MS);
console.log(`[Orchestrator] Running. Tick every ${TICK_MS / 60000} min.\n`);

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('uncaughtException', err => console.error('[Orchestrator] Uncaught:', err.message));
process.on('unhandledRejection', reason => console.error('[Orchestrator] Rejection:', reason));
