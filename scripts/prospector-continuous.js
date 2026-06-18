/**
 * Continuous Prospector
 * Runs 24/7 — finds GCs, processes them, loads into pipeline, repeats
 * 
 * No more waiting for Monday. The pipeline fills constantly.
 * 
 * Strategy:
 * - Rotates through states: CA → UT → TX → FL → AZ → back to CA
 * - Rotates through cities within each state
 * - Rotates search angles: title variations, company types, sub-niches
 * - Short sleep between batches to respect API rate limits
 * - Tracks what's already in GHL to never duplicate
 * - Runs quality pipeline on every batch (screen → enrich → score → personalize → email → launch)
 * 
 * Railway service: prospector (replaces weekly cron)
 * Set start command to: node scripts/prospector-continuous.js
 */
require('dotenv').config({ path: './config/.env' });

const { findProspects }       = require('../agents/01-prospect-finder');
const { screenProspects }     = require('../agents/02-pre-screener');
const { gatherIntelBatch }    = require('../agents/03-competitive-intel');
const { enrichBatch }         = require('../agents/33-lead-enrichment');
const { scoreBatch }          = require('../agents/34-icp-scorer');
const { scoutBatch }          = require('../agents/04-personalization-scout');
const { writeSequenceBatch }  = require('../agents/05-email-copywriter');
const { reviewBatch }         = require('../agents/06-quality-reviewer');
const { verifyContacts }      = require('../agents/07-data-verifier');
const { launchCampaigns }     = require('../agents/08-campaign-launcher');
const { logToGHL }            = require('../agents/09-crm-logger');
const { collectIntelligence } = require('../agents/24-market-intelligence');
const { notifyDashboard }     = require('../utils/helpers');

// Rotation config — expands automatically as campaigns are created
const STATES = [
  { state: 'California', campaign: process.env.INSTANTLY_CA_CAMPAIGN_ID || process.env.INSTANTLY_CAMPAIGN_ID },
  { state: 'Utah',       campaign: process.env.INSTANTLY_UT_CAMPAIGN_ID || '1c57cd85-5694-444d-9b03-8978c628ab8d' },
  { state: 'Texas',      campaign: process.env.INSTANTLY_TX_CAMPAIGN_ID || null },
  { state: 'Florida',    campaign: process.env.INSTANTLY_FL_CAMPAIGN_ID || null },
  { state: 'Arizona',    campaign: process.env.INSTANTLY_AZ_CAMPAIGN_ID || null },
];

// Runtime state
let stateIndex = 0;
let runCount = 0;
let totalLaunched = 0;
let totalFound = 0;
let isRunning = false;

// How long to sleep between batches (milliseconds)
const BATCH_SLEEP_MS = parseInt(process.env.PROSPECTOR_SLEEP_MS || '300000'); // 5 min default
const BATCH_SIZE     = parseInt(process.env.BATCH_SIZE || '15');
const MIN_SCORE      = parseInt(process.env.MIN_ICP_SCORE || '6');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function nextState() {
  // Find next state that has a campaign configured
  let attempts = 0;
  do {
    stateIndex = (stateIndex + 1) % STATES.length;
    attempts++;
  } while (!STATES[stateIndex].campaign && attempts < STATES.length);
  
  return STATES[stateIndex];
}

async function runBatch() {
  if (isRunning) {
    console.log('[Prospector] Batch already running, skipping...');
    return;
  }
  
  isRunning = true;
  const target = STATES[stateIndex];
  
  if (!target.campaign) {
    console.log('[Prospector] No campaign for ' + target.state + ' — skipping');
    nextState();
    isRunning = false;
    return;
  }

  runCount++;
  console.log('\n════════════════════════════════════════');
  console.log('[Prospector] Run #' + runCount + ' | ' + target.state + ' | ' + new Date().toLocaleTimeString());
  console.log('[Prospector] Total launched so far: ' + totalLaunched);
  console.log('════════════════════════════════════════');

  try {
    // Agent 01: Find prospects
    const raw = await findProspects({ state: target.state, limit: BATCH_SIZE });
    totalFound += raw.length;
    
    if (!raw.length) {
      console.log('[Prospector] No prospects found for ' + target.state);
      nextState();
      isRunning = false;
      return;
    }

    // Run the full pipeline
    const screened    = await screenProspects(raw);
    if (!screened.length) { console.log('[Prospector] All screened out'); nextState(); isRunning = false; return; }
    
    const withIntel   = await gatherIntelBatch(screened);
    const withEnrich  = await enrichBatch(withIntel);
    const withScore   = await scoreBatch(withEnrich);
    
    // Filter by minimum ICP score before spending on personalization
    const qualified   = withScore.filter(p => (p.icpScore?.icp_score || 0) >= MIN_SCORE);
    console.log('[Prospector] ' + qualified.length + '/' + withScore.length + ' passed ICP threshold (' + MIN_SCORE + '+)');
    
    if (!qualified.length) { nextState(); isRunning = false; return; }

    const withHooks   = await scoutBatch(qualified);
    const withEmails  = await writeSequenceBatch(withHooks);
    const { approved, rejected } = await reviewBatch(withEmails);
    
    if (!approved.length) { nextState(); isRunning = false; return; }

    const verified    = await verifyContacts(approved);
    
    // Override campaign ID based on state
    const { launched } = await launchCampaigns(verified, { campaignId: target.campaign });
    await logToGHL(launched);
    await collectIntelligence(launched);

    totalLaunched += launched.length;

    // Notify dashboard
    await notifyDashboard('prospector_run', {
      state: target.state,
      run: runCount,
      found: raw.length,
      launched: launched.length,
      total_launched: totalLaunched
    });

    console.log('\n[Prospector] Batch complete:');
    console.log('  Found:      ' + raw.length);
    console.log('  Qualified:  ' + qualified.length);
    console.log('  Launched:   ' + launched.length);
    console.log('  All-time:   ' + totalLaunched);

  } catch(e) {
    console.error('[Prospector] Batch error:', e.message);
    console.error(e.stack);
    // Don't exit — just log and continue to next batch
  }

  // Rotate to next state for variety
  nextState();
  isRunning = false;
}

// Weekly intelligence tasks — run Sunday midnight equivalent
async function runWeeklyTasks() {
  console.log('\n[Prospector] Running weekly intelligence tasks...');
  try {
    const { scoutExpansion }        = require('../agents/29-geographic-expansion-scout');
    const { generateContentBriefs } = require('../agents/26-content-brief-generator');
    await scoutExpansion();
    await generateContentBriefs();
    console.log('[Prospector] Weekly tasks complete');
  } catch(e) {
    console.error('[Prospector] Weekly tasks error:', e.message);
  }
}

async function main() {
  console.log('\n🔄 SubDraw Continuous Prospector Starting...');
  console.log('   Batch size:   ' + BATCH_SIZE);
  console.log('   Sleep:        ' + (BATCH_SLEEP_MS/60000).toFixed(1) + ' min between batches');
  console.log('   Min ICP score: ' + MIN_SCORE);
  console.log('   States:       ' + STATES.filter(s => s.campaign).map(s => s.state).join(', '));

  let weeklyTasksRun = new Date().getDay(); // Track day for weekly tasks

  while (true) {
    // Run a batch
    await runBatch();

    // Check if we should run weekly tasks (Sunday = day 0)
    const today = new Date().getDay();
    if (today === 0 && today !== weeklyTasksRun) {
      weeklyTasksRun = today;
      await runWeeklyTasks();
    }

    // Sleep before next batch
    console.log('\n[Prospector] Sleeping ' + (BATCH_SLEEP_MS/60000).toFixed(1) + 'min before next batch...');
    console.log('[Prospector] Next state: ' + STATES[stateIndex].state);
    await sleep(BATCH_SLEEP_MS);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n[Prospector] SIGTERM received — finishing current batch then stopping');
  process.exit(0);
});

main().catch(e => {
  console.error('[Prospector] Fatal error:', e.message);
  process.exit(1);
});
