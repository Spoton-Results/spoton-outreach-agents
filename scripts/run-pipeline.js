/**
 * SubDraw — Full 13-Agent Outreach Pipeline
 * Usage:
 *   node scripts/run-pipeline.js              — full pipeline
 *   node scripts/run-pipeline.js --mode prospect   — find prospects only
 *   node scripts/run-pipeline.js --mode outreach   — write + launch emails
 *   node scripts/run-pipeline.js --mode replies    — process incoming replies
 *   node scripts/run-pipeline.js --mode monitor    — re-engagement + revenue check
 */
require('dotenv').config({ path: './config/.env' });

const { findProspects }         = require('../agents/01-prospect-finder');
const { screenProspects }       = require('../agents/02-pre-screener');
const { gatherIntelBatch }      = require('../agents/03-competitive-intel');
const { scoutBatch }            = require('../agents/04-personalization-scout');
const { writeSequenceBatch }    = require('../agents/05-email-copywriter');
const { reviewBatch }           = require('../agents/06-quality-reviewer');
const { verifyContacts }        = require('../agents/07-data-verifier');
const { launchCampaigns }       = require('../agents/08-campaign-launcher');
const { logToGHL }              = require('../agents/09-crm-logger');
const { classifyReplies }       = require('../agents/10-reply-classifier');
const { processInterestedReplies } = require('../agents/11-meeting-scheduler');
const { findAndReengageColdLeads } = require('../agents/12-reengagement-tracker');
const { handleObjections }      = require('../agents/13-objection-handler');

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'full';
const state = args.includes('--state') ? args[args.indexOf('--state') + 1] : 'California';
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 25;

async function runProspectPipeline() {
  console.log('\n--- LAYER 1: INTELLIGENCE ---');
  const criteria = await findProspects({ limit, state });

  // NOTE: In production, pass real prospect data from Vibe Prospecting API
  // For now returns search criteria — wire Vibe API in utils/vibe-client.js
  console.log('[Pipeline] Search criteria ready. Wire Vibe Prospecting to fetch real contacts.');
  return criteria;
}

async function runOutreachPipeline(prospects) {
  if (!prospects?.length) { console.log('No prospects to process'); return; }

  console.log('\n--- LAYER 1: SCREENING ---');
  const screened = await screenProspects(prospects);

  console.log('\n--- LAYER 2: ENRICHMENT ---');
  const withIntel = await gatherIntelBatch(screened);
  const withHooks = await scoutBatch(withIntel);

  console.log('\n--- LAYER 3: CONTENT ---');
  const withEmails = await writeSequenceBatch(withHooks);
  const { approved, rejected } = await reviewBatch(withEmails);
  const verified = await verifyContacts(approved);

  console.log('\n--- LAYER 4: EXECUTION ---');
  const { launched } = await launchCampaigns(verified);
  await logToGHL(launched);

  console.log('\n✅ Outreach Complete');
  console.log('Screened: ' + screened.length + ' | Approved: ' + approved.length + ' | Launched: ' + launched.length + ' | Rejected: ' + rejected.length);
  return { screened, approved, launched, rejected };
}

async function runReplyPipeline() {
  console.log('\n--- LAYER 5: REPLIES ---');
  const classified = await classifyReplies();
  await processInterestedReplies(classified);
  await handleObjections(classified);
  console.log('\n✅ Reply Pipeline Complete');
  return classified;
}

async function runMonitorPipeline() {
  console.log('\n--- LAYER 6: RE-ENGAGEMENT ---');
  await findAndReengageColdLeads();
  console.log('\n✅ Monitor Pipeline Complete');
}

async function main() {
  const start = Date.now();
  console.log('\n🔨 SubDraw Agent Pipeline — Mode: ' + mode.toUpperCase());

  try {
    if (mode === 'prospect' || mode === 'full') await runProspectPipeline();
    if (mode === 'replies' || mode === 'full') await runReplyPipeline();
    if (mode === 'monitor' || mode === 'full') await runMonitorPipeline();

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log('\n✅ Done in ' + elapsed + 's\n');
  } catch (err) {
    console.error('Pipeline error:', err.message);
    process.exit(1);
  }
}

main();
