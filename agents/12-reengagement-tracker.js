/**
 * Agent 12: Re-engagement Tracker
 * Finds GC leads that went cold 45+ days ago and hits them with a fresh angle
 * Seasonal construction angles: busy season, end of quarter, lender rate changes
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a re-engagement agent for SubDraw construction draw software.
Write re-engagement emails for GC leads that went cold 45+ days ago.
Use a completely fresh angle — never reference previous emails.
Construction-specific angles: busy season, Q-end billing, lender rate environment, new SubDraw features.
Under 75 words. Sound human. Return JSON only.`;

async function findAndReengageColdLeads() {
  console.log('[Agent 12] Finding cold GC leads...');

  // Pull contacts from GHL that are still in Cold stage and older than 45 days
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 45);

    const opps = await callGHL('GET',
      '/opportunities/search?pipeline_id=' + (process.env.GHL_PIPELINE_ID || icp.ghl.pipeline_id) +
      '&pipeline_stage_id=' + (process.env.GHL_STAGE_COLD || icp.ghl.stages.cold) +
      '&date_added_lte=' + cutoffDate.toISOString()
    );

    const coldLeads = opps.opportunities || [];
    console.log('[Agent 12] Found ' + coldLeads.length + ' cold leads');

    const month = new Date().toLocaleString('default', { month: 'long' });
    const reengaged = [];

    for (const opp of coldLeads.slice(0, 20)) { // cap at 20 per run
      const prompt = `Write a re-engagement email for a GC lead that went cold.
Do NOT reference previous emails. Use a fresh construction-specific angle.

Contact: ${opp.contact?.name || 'there'}
Company: ${opp.name?.replace(' — SubDraw', '') || 'your company'}
Month: ${month}

Use a seasonal or timely construction angle (busy season, year-end billing, lender environment).
Keep under 75 words.

Return: { "subject": "...", "body": "..." }`;

      const email = JSON.parse(await callClaude(SYSTEM, prompt));
      reengaged.push({ opportunity: opp, email });
    }

    logRun('12-reengagement-tracker', { cold_found: coldLeads.length, reengaged: reengaged.length });
    return reengaged;
  } catch (e) {
    console.error('[Agent 12] Error: ' + e.message);
    return [];
  }
}

module.exports = { findAndReengageColdLeads };
if (require.main === module) findAndReengageColdLeads().then(r => console.log('Reengaged:', r.length));
