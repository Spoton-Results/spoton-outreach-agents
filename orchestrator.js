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
  sms_agent:           2 * 60 * 60 * 1000,  // 2 hr
  sms_reply_handler:   2 * 60 * 1000,       // 2 min
  first_contact_sms:   5 * 60 * 1000,       // 5 min — new leads only, prime window gate
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

  // ── Every 2 hr: Revenue monitor + Instantly→GHL stage sync ────────────────
  if (shouldRun('revenue_monitor')) {
    markRun('revenue_monitor');
    runJob('Revenue Monitor', async () => {
      const { monitorRevenue } = require('./agents/14-revenue-monitor');
      await monitorRevenue();
    });
    runJob('Instantly→GHL Stage Sync', async () => {
      const { syncInstantlyToGHL } = require('./agents/09-crm-logger');
      await syncInstantlyToGHL();
    });
  }


  // ── Every 5 min: First Contact SMS (Agent 39) — new leads only, prime window
  if (shouldRun('first_contact_sms')) {
    markRun('first_contact_sms');
    runJob('First Contact SMS (39)', async () => {
      const { runFirstContactSMS } = require('./agents/39-first-contact-sms');
      await runFirstContactSMS();
    });
  }

  // ── Every 2 min: SMS Reply Handler (Agent 38) ─────────────────────────────
  if (shouldRun('sms_reply_handler')) {
    markRun('sms_reply_handler');
    runJob('SMS Reply Handler (38)', async () => {
      const { pollSMSReplies } = require('./agents/38-sms-reply-handler');
      await pollSMSReplies();
    });
  }

  // ── Every 2 hr: Agent 15 high-intent SMS trigger ───────────────────────────
  if (shouldRun('sms_agent')) {
    markRun('sms_agent');
    runJob('High-Intent SMS Agent (15)', async () => {
      const { runSMSAgent } = require('./agents/15-sms-agent');
      await runSMSAgent();
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

      // Load upcoming state contacts daily (TX now, FL/AZ when closer to launch)
      const { loadUpcomingStateContacts } = require('./agents/29-geographic-expansion-scout');
      await loadUpcomingStateContacts();
      logRun('full-pipeline', { raw: raw.length, screened: screened.length, launched: launched.length });
    });
  }

  // ── Daily 7am: GHL contact enrichment (find missing emails via Apollo) ────
  if (isHour(7) && !lastRun['ghl_enrichment_' + now.toDateString()]) {
    lastRun['ghl_enrichment_' + now.toDateString()] = Date.now();
    runJob('GHL Contact Enrichment', async () => {
      const { enrichGHLContacts } = require('./agents/33-lead-enrichment');
      const result = await enrichGHLContacts();
      console.log(`[GHL Enrichment] Found ${result.found} emails from ${result.enriched} contacts`);
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
  // SMS blast removed — Agent 39 handles first contact, Agent 38 handles replies


  // ── Daily 8am: Push GHL contacts to Instantly (Agent 08) ─────────────────
  // Runs independently — pushes verified contacts to Instantly daily
  if (isHour(8) && !lastRun['instantly_push_' + now.toDateString()]) {
    lastRun['instantly_push_' + now.toDateString()] = Date.now();
    runJob('Instantly Push (08)', async () => {
      const { callGHL, callInstantly, logRun } = require('./utils/helpers');
      const LOCATION   = process.env.GHL_LOCATION_ID  || 'oe1TpmlDynQGFNdYLkaK';
      const CAMPAIGN   = process.env.INSTANTLY_CAMPAIGN_ID;
      const CAMPAIGN_UT = process.env.INSTANTLY_CAMPAIGN_ID_UT;
      if (!CAMPAIGN) { console.log('[Agent 08] No INSTANTLY_CAMPAIGN_ID — skipping'); return; }

      let toLoad = [], startAfter = null, startAfterId = null;
      while (toLoad.length < 200) {
        let url = '/contacts/?locationId=' + LOCATION + '&limit=100&query=gc-prospect';
        if (startAfter)   url += '&startAfter='   + startAfter;
        if (startAfterId) url += '&startAfterId=' + startAfterId;
        const data = await callGHL('GET', url);
        const batch = (data.contacts || []).filter(c => {
          const tags = c.tags || [];
          return c.email && !c.email.includes('@example') &&
                 !tags.includes('instantly-pushed') &&
                 !tags.includes('do-not-contact') && !c.dnd;
        });
        toLoad.push(...batch);
        if (!data.meta?.nextPage) break;
        startAfter   = data.meta.startAfter;
        startAfterId = data.meta.startAfterId;
        await new Promise(r => setTimeout(r, 300));
      }

      if (!toLoad.length) { console.log('[Agent 08] No new contacts to push'); return; }
      console.log('[Agent 08] Pushing ' + toLoad.length + ' contacts to Instantly');

      const caLeads = [], utLeads = [];
      for (const c of toLoad) {
        const lead = {
          email: c.email, first_name: c.firstNameRaw || c.firstName || '',
          last_name: c.lastNameRaw || c.lastName || '',
          company_name: c.companyName || '', phone: c.phone || '',
          custom_variables: { city: c.city || '', state: c.state || '' }
        };
        const isUT = (c.tags || []).includes('ut-gc');
        if (isUT && CAMPAIGN_UT) utLeads.push({ id: c.id, lead });
        else caLeads.push({ id: c.id, lead });
      }

      if (caLeads.length) {
        try {
          await callInstantly('POST', '/lead/add/bulk', { campaign_id: CAMPAIGN, leads: caLeads.map(l => l.lead), skip_if_in_workspace: true });
          for (const l of caLeads) { await callGHL('POST', '/contacts/' + l.id + '/tags', { tags: ['instantly-pushed'] }); await new Promise(r => setTimeout(r, 100)); }
        } catch(e) { console.error('[Agent 08] CA push error:', e.message); }
      }
      if (utLeads.length && CAMPAIGN_UT) {
        try {
          await callInstantly('POST', '/lead/add/bulk', { campaign_id: CAMPAIGN_UT, leads: utLeads.map(l => l.lead), skip_if_in_workspace: true });
          for (const l of utLeads) { await callGHL('POST', '/contacts/' + l.id + '/tags', { tags: ['instantly-pushed'] }); await new Promise(r => setTimeout(r, 100)); }
        } catch(e) { console.error('[Agent 08] UT push error:', e.message); }
      }
      console.log('[Agent 08] Done — CA:' + caLeads.length + ' UT:' + utLeads.length);
      logRun('08-instantly-push', { ca: caLeads.length, ut: utLeads.length });
    });
  }

  // ── Sunday midnight: Weekly analyzer ─────────────────────────────────────
  if (isDayOfWeek(0) && isHour(0) && !lastRun['weekly_' + now.toDateString()]) {
    lastRun['weekly_' + now.toDateString()] = Date.now();
    runJob('Weekly Analyzer', async () => {
      const { analyzePerformance }       = require('./agents/20-ab-performance-analyzer');
      const { runDormantRecovery }       = require('./agents/35-dormant-pipeline-recovery');
      const { analyzeMarketTrends }      = require('./agents/37-market-trend-scanner');
      const { scoutExpansion, loadUpcomingStateContacts } = require('./agents/29-geographic-expansion-scout');
      await analyzePerformance();
      await runDormantRecovery();
      await analyzeMarketTrends();
      await scoutExpansion();
      await loadUpcomingStateContacts();
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
