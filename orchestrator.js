/**
 * SubDraw Master Orchestrator
 * 
 * Runs ALL cron jobs in one process with correct schedules.
 * Replace the current railway.toml startCommand with this.
 * 
 * Schedule:
 *   Every 5 min  — Prospect finder (OpenAI web search for GCs)
 *   Every 15 min — Reply handler (classify + respond + send demo links)
 *   Every 30 min — Health monitor
 *   Every 2 hr   — Revenue monitor (Stripe)
 *   Every 6 hr   — Demo engagement tracker (follow up on clicks)
 *   Daily 5am    — Daily briefing SMS to founder
 *   Daily 6am    — Full prospector pipeline (Apollo/Vibe → full 9-agent flow)
 *   Sunday midnight — Weekly analyzer (A/B winners, re-engagement)
 *
 * SMS Campaign Schedule (data-driven, construction-specific):
 *   Tue/Wed/Thu 10:00am Mountain — Morning send (pre-job-site window)
 *   Tue/Wed/Thu 12:15pm Mountain — Lunch send (peak reply window)
 *   Research: construction pros respond best Mon-Wed, reply rates peak at noon
 *   Skips: contacts already tagged sms-sent, 555 numbers, DND, weekends
 */
require('dotenv').config({ path: './config/.env' });
const { logRun } = require('./utils/helpers');

console.log('═══════════════════════════════════════════════');
console.log('🚀 SubDraw Master Orchestrator — Starting');
console.log('   Time:', new Date().toISOString());
console.log('   Node:', process.version);
console.log('═══════════════════════════════════════════════\n');

// Track last run times to implement schedule without node-cron dependency
const lastRun = {};
const intervals = {
  prospect_continuous: 5 * 60 * 1000,      // 5 min
  reply_handler:       15 * 60 * 1000,      // 15 min
  health_monitor:      30 * 60 * 1000,      // 30 min
  revenue_monitor:     2 * 60 * 60 * 1000,  // 2 hr
  demo_tracker:        6 * 60 * 60 * 1000,  // 6 hr
};

function shouldRun(key) {
  const now = Date.now();
  if (!lastRun[key]) return true;
  return (now - lastRun[key]) >= intervals[key];
}

function markRun(key) {
  lastRun[key] = Date.now();
}

function isHour(h) {
  return new Date().getHours() === h && new Date().getMinutes() < 5;
}

function isDayOfWeek(d) {
  return new Date().getDay() === d; // 0 = Sunday
}

// ── SMS CAMPAIGN LOGIC ───────────────────────────────────────────────────────
// Research-backed windows for construction GC owners:
// - Tue/Wed/Thu only (Mon planning chaos, Fri wind-down)
// - 10:00am Mountain (in office before job site, peak B2B SMS window)
// - 12:15pm Mountain (lunch break, highest reply rates for construction)
// - Skip Mon/Fri, skip weekends entirely
// Source: construction outreach data shows noon replies peak, 7-9am avoid (driving)

function isSMSCampaignWindow() {
  const now    = new Date();
  const utcDay = now.getUTCDay();   // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  const utcH   = now.getUTCHours();
  const utcM   = now.getUTCMinutes();

  // Only Tue(2), Wed(3), Thu(4)
  if (![2, 3, 4].includes(utcDay)) return null;

  // Mountain Time = UTC-6 in summer
  // 10:00am MT = 16:00 UTC
  // 12:15pm MT = 18:15 UTC
  const utcMins = utcH * 60 + utcM;

  if (utcMins >= 960 && utcMins < 965)  return 'morning';  // 16:00-16:05 UTC = 10:00-10:05am MT
  if (utcMins >= 1095 && utcMins < 1100) return 'lunch';   // 18:15-18:20 UTC = 12:15-12:20pm MT

  return null;
}

async function runSMSCampaign(window) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    console.log(`[SMS Campaign] Firing ${window} send window`);
    const proc = spawn('node', ['scripts/sms-blast.js', '--send', '--tag=gc-prospect'], {
      cwd: __dirname,
      env: process.env,
      stdio: 'inherit'
    });
    proc.on('close', (code) => {
      console.log(`[SMS Campaign] ${window} send completed — exit code ${code}`);
      resolve(code);
    });
    proc.on('error', (err) => {
      console.error(`[SMS Campaign] Error spawning sms-blast: ${err.message}`);
      resolve(1);
    });
  });
}

let runCount = 0;

async function tick() {
  runCount++;
  const now = new Date();
  console.log(`\n[Orchestrator] Tick #${runCount} — ${now.toISOString()}`);

  // ── Every 5 min: Continuous prospect finder ──────────────────────────────
  if (shouldRun('prospect_continuous')) {
    markRun('prospect_continuous');
    runJob('Prospect Finder (continuous)', async () => {
      const { findProspects } = require('./agents/01-prospect-finder');
      const results = await findProspects();
      console.log(`[ProspectFinder] Pushed ${results.length} contacts`);
    });
  }

  // ── Every 15 min: Reply handler ──────────────────────────────────────────
  if (shouldRun('reply_handler')) {
    markRun('reply_handler');
    runJob('Reply Handler', async () => {
      const { classifyReplies }  = require('./agents/10-reply-classifier');
      const { sendDemoLinks }    = require('./agents/11-demo-link-sender');
      const { handleObjections } = require('./agents/13-objection-handler');
      const { scheduleFollowUps } = require('./agents/32-followup-scheduler');
      const classified = await classifyReplies();
      if (classified.length > 0) {
        await sendDemoLinks(classified);
        await handleObjections(classified);
        await scheduleFollowUps(classified);
        console.log(`[ReplyHandler] Processed ${classified.length} replies`);
      } else {
        console.log('[ReplyHandler] No new replies');
      }
    });
  }

  // ── Every 30 min: Health monitor ─────────────────────────────────────────
  if (shouldRun('health_monitor')) {
    markRun('health_monitor');
    runJob('Health Monitor', async () => {
      const { runHealthCheck } = require('./agents/25-health-monitor');
      await runHealthCheck();
    });
  }

  // ── Every 2 hr: Revenue monitor ──────────────────────────────────────────
  if (shouldRun('revenue_monitor')) {
    markRun('revenue_monitor');
    runJob('Revenue Monitor', async () => {
      const { monitorRevenue } = require('./agents/14-revenue-monitor');
      await monitorRevenue();
    });
  }

  // ── Every 6 hr: Demo engagement tracker ──────────────────────────────────
  if (shouldRun('demo_tracker')) {
    markRun('demo_tracker');
    runJob('Demo Tracker', async () => {
      const { runDemoTracker } = require('./agents/16-demo-engagement-tracker');
      await runDemoTracker();
    });
  }

  // ── Daily 5am: Founder briefing ───────────────────────────────────────────
  if (isHour(5) && !lastRun['daily_briefing_' + now.toDateString()]) {
    lastRun['daily_briefing_' + now.toDateString()] = Date.now();
    runJob('Daily Briefing', async () => {
      const { sendDailyBriefing } = require('./agents/19-daily-briefing');
      await sendDailyBriefing();
    });
  }

  // ── Daily 6am: Full pipeline prospector ──────────────────────────────────
  if (isHour(6) && !lastRun['full_pipeline_' + now.toDateString()]) {
    lastRun['full_pipeline_' + now.toDateString()] = Date.now();
    runJob('Full Pipeline', async () => {
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
      const { findProspects }      = require('./agents/01-prospect-finder');

      const state = process.env.TARGET_STATE || 'California';
      const limit = parseInt(process.env.MAX_PROSPECTS_PER_RUN || '25');

      const raw = await findProspects({ state, limit });
      if (!raw.length) { console.log('[FullPipeline] No prospects found'); return; }

      const screened    = await screenProspects(raw);
      const withIntel   = await gatherIntelBatch(screened);
      const withEnrich  = await enrichBatch(withIntel);
      const withScore   = await scoreBatch(withEnrich);
      const withHooks   = await scoutBatch(withScore);
      const withEmails  = await writeSequenceBatch(withHooks);
      const { approved } = await reviewBatch(withEmails);
      const verified    = await verifyContacts(approved);
      const { launched } = await launchCampaigns(verified);
      await logToGHL(launched);

      console.log(`[FullPipeline] Done — raw:${raw.length} → launched:${launched.length}`);
      logRun('full-pipeline', { raw: raw.length, screened: screened.length, launched: launched.length });
    });
  }

  // ── Daily 8am: Lead scorer ───────────────────────────────────────────────
  if (isHour(8) && !lastRun['lead_score_' + now.toDateString()]) {
    lastRun['lead_score_' + now.toDateString()] = Date.now();
    runJob('Lead Scorer', async () => {
      const { scoreAllLeads } = require('./agents/17-lead-scorer');
      await scoreAllLeads();
    });
  }

  // ── Daily 9am: Re-engagement (cold leads revival) ────────────────────────
  if (isHour(9) && !lastRun['reengagement_' + now.toDateString()]) {
    lastRun['reengagement_' + now.toDateString()] = Date.now();
    runJob('Re-engagement', async () => {
      const { findAndReengageColdLeads } = require('./agents/12-reengagement-tracker');
      await findAndReengageColdLeads();
    });
  }

  // ── Tue/Wed/Thu 10am + 12:15pm MT: SMS Campaign ─────────────────────────
  const smsWindow = isSMSCampaignWindow();
  if (smsWindow) {
    const smsKey = 'sms_campaign_' + smsWindow + '_' + now.toDateString();
    if (!lastRun[smsKey]) {
      lastRun[smsKey] = Date.now();
      runJob('SMS Campaign (' + smsWindow + ')', async () => {
        await runSMSCampaign(smsWindow);
      });
    }
  }

  // ── Sunday midnight: Weekly analyzer ─────────────────────────────────────
  if (isDayOfWeek(0) && isHour(0) && !lastRun['weekly_' + now.toDateString()]) {
    lastRun['weekly_' + now.toDateString()] = Date.now();
    runJob('Weekly Analyzer', async () => {
      const { analyzePerformance } = require('./agents/20-ab-performance-analyzer');
      const { runDormantRecovery } = require('./agents/35-dormant-pipeline-recovery');
      const { analyzeMarketTrends } = require('./agents/37-market-trend-scanner');
      await analyzePerformance();
      await runDormantRecovery();
      await analyzeMarketTrends();
    });
  }
}

// Run a job without crashing the orchestrator if it fails
async function runJob(name, fn) {
  console.log(`\n[Orchestrator] ▶ Starting: ${name}`);
  const start = Date.now();
  try {
    await fn();
    console.log(`[Orchestrator] ✓ ${name} — ${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[Orchestrator] ✗ ${name} failed: ${err.message}`);
    // Never exit — keep the orchestrator alive
  }
}

// Run tick every 5 minutes
const TICK_MS = 5 * 60 * 1000;
tick(); // Run immediately on boot
setInterval(tick, TICK_MS);
console.log(`[Orchestrator] Running. Tick every ${TICK_MS / 60000} min.\n`);

// Keep alive
process.on('SIGTERM', () => {
  console.log('[Orchestrator] SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('uncaughtException', err => {
  console.error('[Orchestrator] Uncaught exception:', err.message);
  // Don't exit — stay alive
});

process.on('unhandledRejection', (reason) => {
  console.error('[Orchestrator] Unhandled rejection:', reason);
  // Don't exit — stay alive
});
