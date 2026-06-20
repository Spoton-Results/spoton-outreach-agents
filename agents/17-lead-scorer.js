/**
 * Agent 17: Lead Scorer
 * Continuously re-scores every GHL contact based on engagement signals
 * Email opens, link clicks, SMS replies, time in stage, demo visits
 * Surfaces the hottest leads daily so you know who to focus on
 * Runs daily at 6am on Railway
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a lead scoring agent for SubDraw SaaS sales.
Score GC leads 1-100 based on engagement signals.
Higher score = closer to signing up. Return JSON only.

Scoring weights:
- Replied to email: +30
- Visited demo (subdraw.com/login): +25
- Opened email 3+ times: +20
- Clicked link in email: +15
- Opened email 1-2 times: +10
- SMS replied: +20
- In pipeline 0-7 days: +5
- In pipeline 8-30 days: 0
- In pipeline 30+ days: -10
- Has phone number: +5
- Company size 5-50 employees: +5`;

async function scoreAllLeads() {
  console.log('[Agent 17] Scoring all active GHL leads...');

  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;
    const contacts = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=agent-outreach&limit=100');
    const allContacts = contacts.contacts || [];
    if (allContacts.length === 100) {
      console.warn('[Agent 17] WARNING: fetched exactly 100 contacts — results may be truncated. Pagination not implemented.');
    }

    console.log('[Agent 17] Scoring ' + allContacts.length + ' contacts...');
    const scored = [];

    for (const contact of allContacts) {
      const daysInPipeline = Math.floor((Date.now() - new Date(contact.dateAdded).getTime()) / (1000 * 60 * 60 * 24));
      const tags = contact.tags || [];

      const signals = {
        replied: tags.includes('replied') || contact.tags?.includes('agent-outreach-replied'),
        demo_visited: tags.includes('demo-clicked'),
        high_open_count: tags.some(t => t.startsWith('opens-3+')),
        link_clicked: tags.includes('link-clicked'),
        sms_replied: tags.includes('sms-replied'),
        has_phone: !!(contact.phone),
        days_in_pipeline: daysInPipeline,
        is_customer: tags.includes('customer')
      };

      const prompt = `Score this SubDraw lead based on their engagement signals:

Contact: ${contact.firstName} ${contact.lastName} at ${contact.companyName}
Signals: ${JSON.stringify(signals)}
Tags: ${tags.join(', ')}
Days in pipeline: ${daysInPipeline}

Score 1-100 and give ONE recommended action.

Return: { "score": X, "tier": "hot|warm|cold|dead", "recommended_action": "...", "reason": "..." }`;

      let scoring;
      try {
        scoring = JSON.parse(await callClaude(SYSTEM, prompt));
      } catch(e) {
        console.error('[Agent 17] Parse error for ' + contact.firstName + ' ' + contact.lastName + ':', e.message);
        continue; // skip this contact, don't abort the whole batch
      }

      // Update score in GHL custom field
      try {
        await callGHL('PUT', '/contacts/' + contact.id, {
          customFields: [
            { key: 'lead_score', field_value: String(scoring.score) },
            { key: 'lead_tier', field_value: scoring.tier },
            { key: 'recommended_action', field_value: scoring.recommended_action },
            { key: 'score_updated', field_value: new Date().toISOString().split('T')[0] }
          ]
        });
      } catch(e) { /* non-blocking */ }

      scored.push({ contact, scoring });
    }

    // Surface top leads
    const hot = scored.filter(s => s.scoring.tier === 'hot');
    const warm = scored.filter(s => s.scoring.tier === 'warm');

    console.log('[Agent 17] Hot leads: ' + hot.length + ' | Warm leads: ' + warm.length);
    logRun('17-lead-scorer', {
      total_scored: scored.length,
      hot: hot.length,
      warm: warm.length,
      top_leads: hot.slice(0, 5).map(s => ({
        name: s.contact.firstName + ' ' + s.contact.lastName,
        company: s.contact.companyName,
        score: s.scoring.score,
        action: s.scoring.recommended_action
      }))
    });

    return scored;
  } catch(e) {
    console.error('[Agent 17] Error:', e.message);
    return [];
  }
}

module.exports = { scoreAllLeads };
if (require.main === module) scoreAllLeads().then(r => console.log('[Agent 17] Done:', r.length, 'leads scored'));
