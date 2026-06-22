/**
 * SubDraw Worker Server
 * 
 * Sits idle on an HTTP port. Does NOTHING until the orchestrator
 * calls it with a job. One worker per Railway service.
 * 
 * Each Railway service has a WORKER_ROLE env var that defines what it runs:
 *   reply-handler     → runs Agent 10, 11, 13, 32 (email replies)
 *   daily-briefing    → runs Agent 19 (5am briefing)
 *   revenue-monitor   → runs Agent 14 (Stripe revenue)
 *   weekly-analyzer   → runs Agent 20, 35, 37, 29 (weekly analysis)
 * 
 * The orchestrator POSTs to /run with { job: 'reply-handler' }
 * The worker executes it and returns { ok: true }
 * 
 * If WORKER_ROLE is not set, this service does nothing at all.
 */

require('dotenv').config({ path: './config/.env' });
const http = require('http');

const PORT = process.env.PORT || 3001;
const ROLE = process.env.WORKER_ROLE || 'idle';
const SECRET = process.env.WORKER_SECRET || 'subdraw-worker-2026';

console.log(`[Worker] Starting — role: ${ROLE} port: ${PORT}`);

// ── JOB RUNNERS ───────────────────────────────────────────────────────────────
const jobs = {

  'reply-handler': async () => {
    const { classifyReplies }   = require('./agents/10-reply-classifier');
    const { sendDemoLinks }     = require('./agents/11-demo-link-sender');
    const { handleObjections }  = require('./agents/13-objection-handler');
    const { scheduleFollowUps } = require('./agents/32-followup-scheduler');
    const classified = await classifyReplies();
    if (classified.length > 0) {
      await sendDemoLinks(classified);
      await handleObjections(classified);
      await scheduleFollowUps(classified);
    }
    return { replies: classified.length };
  },

  'sms-reply-handler': async () => {
    const { pollSMSReplies } = require('./agents/38-sms-reply-handler');
    const handled = await pollSMSReplies();
    return { handled };
  },

  'daily-briefing': async () => {
    const { sendDailyBriefing } = require('./agents/19-daily-briefing');
    await sendDailyBriefing();
    return { sent: true };
  },

  'revenue-monitor': async () => {
    const { monitorRevenue } = require('./agents/14-revenue-monitor');
    await monitorRevenue();
    return { checked: true };
  },

  'weekly-analyzer': async () => {
    const { analyzePerformance }  = require('./agents/20-ab-performance-analyzer');
    const { runDormantRecovery }  = require('./agents/35-dormant-pipeline-recovery');
    const { analyzeMarketTrends } = require('./agents/37-market-trend-scanner');
    await analyzePerformance();
    await runDormantRecovery();
    await analyzeMarketTrends();
    return { analyzed: true };
  },

  'sms-blast': async (params = {}) => {
    // Only runs when orchestrator explicitly calls it
    // Never auto-runs on deploy
    const { spawn } = require('child_process');
    const args = ['scripts/sms-blast.js', '--send', '--tag=gc-prospect'];
    if (params.limit) args.push('--limit=' + params.limit);
    if (params.tag)   args[2] = '--tag=' + params.tag;
    return new Promise((resolve) => {
      const proc = spawn('node', args, { cwd: __dirname, env: process.env, stdio: 'inherit' });
      proc.on('close', code => resolve({ exit: code }));
      proc.on('error', err => resolve({ error: err.message }));
    });
  },

  'health-check': async () => {
    return { status: 'ok', role: ROLE, uptime: process.uptime() };
  }
};

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
let busy = false;

const server = http.createServer(async (req, res) => {

  // Health check — no auth needed
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, role: ROLE, busy, uptime: process.uptime() }));
    return;
  }

  // All other routes require POST + secret header
  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const secret = req.headers['x-worker-secret'];
  if (secret !== SECRET) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }

  // Parse body
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch(e) {}

    const job = payload.job || ROLE;
    const params = payload.params || {};

    if (!jobs[job]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown job: ' + job }));
      return;
    }

    if (busy) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Worker busy', role: ROLE }));
      return;
    }

    busy = true;
    console.log(`[Worker] Running job: ${job}`);

    try {
      const result = await jobs[job](params);
      console.log(`[Worker] Job complete: ${job}`, result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job, result }));
    } catch(e) {
      console.error(`[Worker] Job failed: ${job}`, e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, job, error: e.message }));
    } finally {
      busy = false;
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Worker] Ready on port ${PORT} — role: ${ROLE}`);
  console.log(`[Worker] Waiting for orchestrator to call /run`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('uncaughtException', err => console.error('[Worker] Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('[Worker] Unhandled:', err));
