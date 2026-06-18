/**
 * Agent 12: Re-engagement Tracker — REBUILT
 * Fresh angles based on SubDraw's actual value props
 * Invoice protection, lien waiver season, year-end audit prep
 * Never references previous emails
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a re-engagement agent for SubDraw — construction draw management and invoice protection.
Write re-engagement emails for GC leads that went cold 45+ days ago.
NEVER reference previous emails. Use a completely fresh angle.

SubDraw re-engagement angles (rotate through):
- Year-end audit prep: "Construction payments are getting scrutinized — do you have an audit trail for every sub payment this year?"
- Lien waiver risk: "One missing lien waiver can freeze a project. How are you tracking them across all your subs?"
- Change order gaps: "Change orders that aren't documented properly cost GCs thousands. Is yours tracked?"
- Retainage release season: "If you're releasing retainage this quarter, is your documentation ready?"
- New project season: "Starting a new project? The best time to set up a proper draw process is before the first invoice comes in."
- Invoice protection: "How much did subcontractor billing errors cost you last year? Most GCs don't know."

Under 75 words. Sound like a fresh outreach — not a follow-up.
Return JSON only.`;

async function findColdLeads() {
  console.log('[Agent 12] Finding cold GC leads (45+ days)...');
  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 45);

    const opps = await callGHL('GET',
      '/opportunities/search?pipeline_id=' + (process.env.GHL_PIPELINE_ID || icp.ghl.pipeline_id) +
      '&pipeline_stage_id=' + (process.env.GHL_STAGE_COLD || icp.ghl.stages.cold) +
      '&date_added_lte=' + cutoff.toISOString() + '&limit=20'
    );

    const cold = (opps.opportunities || []).filter(o => !o.contact?.tags?.includes('reengaged'));
    console.log('[Agent 12] Found ' + cold.length + ' cold leads');
    return cold;
  } catch(e) {
    console.error('[Agent 12] Error:', e.message);
    return [];
  }
}

async function writeReengagement(opp) {
  const month = new Date().toLocaleString('default', { month: 'long' });
  const quarter = Math.ceil((new Date().getMonth() + 1) / 3);

  const prompt = `Write a re-engagement email for a cold GC lead using a fresh SubDraw angle.

Contact: ${opp.contact?.name || 'there'} at ${opp.name?.replace(' — SubDraw', '') || 'their company'}
Month: ${month}, Q${quarter}
Demo URL: ${icp.product.demo_url}

Choose the most seasonally relevant angle from the playbook.
Do NOT say "following up" or reference previous contact.
Under 75 words.

Return: { "subject": "...", "body": "..." }`;

  const email = JSON.parse(await callClaude(SYSTEM, prompt));

  try {
    if (opp.contact?.id) {
      await callGHL('POST', '/conversations/messages', {
        type: 'Email',
        contactId: opp.contact.id,
        subject: email.subject,
        body: email.body,
        html: '<p>' + email.body.replace(/\n/g, '<br>') + '</p>'
      });
      await callGHL('PUT', '/contacts/' + opp.contact.id, {
        tags: [...(opp.contact.tags || []), 'reengaged']
      });
    }
  } catch(e) {
    console.error('[Agent 12] Send error:', e.message);
  }

  logRun('12-reengagement-tracker', { reengaged: opp.contact?.email });
  return { opp, email };
}

async function findAndReengageColdLeads() {
  const cold = await findColdLeads();
  if (!cold.length) return [];
  return Promise.all(cold.map(writeReengagement));
}

module.exports = { findAndReengageColdLeads };
if (require.main === module) findAndReengageColdLeads().then(r => console.log('[Agent 12] Reengaged:', r.length));
