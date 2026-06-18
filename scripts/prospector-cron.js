/**
 * Railway Cron: Monday 6am
 * Finds new GC prospects and launches them into outreach
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
const { collectIntelligence }   = require('../agents/24-market-intelligence');
const { scoutExpansion }        = require('../agents/29-geographic-expansion-scout');
const { generateContentBriefs } = require('../agents/26-content-brief-generator');
const apollo = require('../utils/apollo-client');
const vibe   = require('../utils/vibe-client');

async function main() {
  console.log('\n🔨 SubDraw Prospector Cron — ' + new Date().toISOString());
  const state = process.env.TARGET_STATE || 'California';
  const limit = parseInt(process.env.MAX_PROSPECTS_PER_RUN || '25');

  try {
    // Fetch prospects — Vibe first, Apollo fallback
    let raw = [];
    try {
      raw = await vibe.searchProspects({ state, limit });
      if (!raw.length) throw new Error('Vibe returned 0');
    } catch(e) {
      console.log('Switching to Apollo:', e.message);
      raw = await apollo.searchPeople({ state, limit });
    }

    const screened  = await screenProspects(raw);
    const withIntel = await gatherIntelBatch(screened);
    const withHooks = await scoutBatch(withIntel);
    const withEmails = await writeSequenceBatch(withHooks);
    const { approved, rejected } = await reviewBatch(withEmails);
    const verified  = await verifyContacts(approved);
    const { launched } = await launchCampaigns(verified);
    await logToGHL(launched);
    await collectIntelligence(launched);

    // Weekly tasks (Monday only)
    await scoutExpansion();
    await generateContentBriefs();

    console.log('\n✅ Prospector Done | Launched:', launched.length, '| Rejected:', rejected.length);
  } catch(e) {
    console.error('Prospector error:', e.message);
    process.exit(1);
  }
}

main();
