/**
 * Agent 09: CRM Logger
 * Creates/updates contacts in GoHighLevel
 * Also handles pipeline stage sync from Instantly reply events
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL, logRun, notifyDashboard } = require('../utils/helpers');
const icp = require('../config/icp.json');

const LOCATION_ID  = process.env.GHL_LOCATION_ID  || icp.ghl?.location_id  || 'oe1TpmlDynQGFNdYLkaK';
const PIPELINE_ID  = process.env.GHL_PIPELINE_ID  || icp.ghl?.pipeline_id  || 'lu4BTmjYjJC2hZVKxj1t';
const STAGE_COLD   = process.env.GHL_STAGE_COLD   || icp.ghl?.stages?.cold   || '751975e9-c7f2-46a4-b821-e053bf505d8a';
const STAGE_EMAIL  = process.env.GHL_STAGE_EMAILED || icp.ghl?.stages?.emailed || 'a9cb193d-c634-41e2-b7eb-e0c6a24065ca';
const STAGE_REPLY  = process.env.GHL_STAGE_REPLIED || icp.ghl?.stages?.replied || '32e745b6-97f5-4ad1-8b59-4652995f2176';

// ── Create or update contact + add to pipeline ────────────────────────────────
async function logToGHL(prospects) {
  console.log('[Agent 09] Logging ' + prospects.length + ' contacts to GHL...');
  const logged = [];

  for (const p of prospects) {
    try {
      const nameParts = (p.name || '').split(' ');
      const stateTag  = (p.state || '').toLowerCase().replace(/\s/g, '-');
      const stateSuffix = stateTag ? `-${stateTag.substring(0,2)}` : '';

      const contact = {
        firstName:   p.first_name  || nameParts[0] || '',
        lastName:    p.last_name   || nameParts.slice(1).join(' ') || '',
        email:       p.email       || '',
        phone:       p.phone       || '',
        companyName: p.organization_name || '',
        website:     p.website     || '',
        city:        p.city        || '',
        state:       p.state       || '',
        source:      'SubDraw Agent Outreach',
        locationId:  LOCATION_ID,
        tags: [
          'agent-outreach',
          'gc-prospect',
          `${stateTag.substring(0,2)}-gc`,
          'cold-outreach',
          'ai-prospected'
        ].filter(Boolean),
        customFields: [
          { key: 'screening_score',      field_value: String(p.screening?.score || '') },
          { key: 'pain_point',           field_value: p.screening?.pain_point || p.intel?.primary_pain || '' },
          { key: 'current_draw_tool',    field_value: p.intel?.current_tool || '' },
          { key: 'recommended_plan',     field_value: p.intel?.recommended_plan || '' },
          { key: 'personalization_hook', field_value: p.personalization?.hook || '' },
          { key: 'outreach_date',        field_value: new Date().toISOString().split('T')[0] }
        ]
      };

      const result    = await callGHL('POST', '/contacts/', contact);
      const contactId = result.contact?.id;

      if (contactId) {
        // Add to pipeline at Cold stage
        await callGHL('POST', '/opportunities/', {
          pipelineId:      PIPELINE_ID,
          locationId:      LOCATION_ID,
          name:            (p.organization_name || p.name) + ' — SubDraw',
          pipelineStageId: STAGE_COLD,
          contactId,
          status: 'open'
        });

        notifyDashboard('new_lead', {
          company: p.organization_name,
          city:    p.city,
          state:   p.state,
          source:  p.source || 'agent'
        }).catch(() => {});
      }

      logged.push({ ...p, contactId });
    } catch(err) {
      console.error('[Agent 09] GHL error for ' + (p.name || p.organization_name) + ': ' + err.message);
    }
  }

  logRun('09-crm-logger', { logged: logged.length });
  console.log('[Agent 09] Logged: ' + logged.length + '/' + prospects.length);
  return logged;
}

// ── Sync Instantly reply events → GHL pipeline stages ────────────────────────
// Called every 2 hours by orchestrator to close the loop
async function syncInstantlyToGHL() {
  console.log('[Agent 09] Syncing Instantly reply data → GHL pipeline stages...');

  const fetch   = (await import('node-fetch')).default;
  const instKey = process.env.INSTANTLY_API_KEY;
  if (!instKey) { console.error('[Agent 09] No INSTANTLY_API_KEY'); return; }

  const campaignIds = [
    process.env.INSTANTLY_CAMPAIGN_ID,
    process.env.INSTANTLY_UT_CAMPAIGN_ID
  ].filter(Boolean);

  let stageUpdates = 0;

  for (const campaignId of campaignIds) {
    try {
      const res  = await fetch(`https://api.instantly.ai/api/v2/leads?campaign_id=${campaignId}&limit=100`, {
        headers: { Authorization: `Bearer ${instKey}` }
      });
      const data = await res.json();
      const leads = data.items || data.leads || [];

      for (const lead of leads) {
        if (!lead.replied && !lead.is_replied) continue;
        const email = lead.email || lead.lead_email;
        if (!email) continue;

        try {
          // Find in GHL
          const cd = await callGHL('GET', `/contacts/?email=${encodeURIComponent(email)}&locationId=${LOCATION_ID}`);
          const contact = cd.contacts?.[0];
          if (!contact) continue;

          // Check current tags — skip if already marked replied
          if ((contact.tags || []).includes('replied')) continue;

          // Tag as replied
          await callGHL('POST', `/contacts/${contact.id}/tags`, { tags: ['replied', 'email-replied'] });

          // Advance pipeline stage
          const opps = await callGHL('GET', `/opportunities/search?location_id=${LOCATION_ID}&contact_id=${contact.id}`);
          const opp  = opps.opportunities?.[0];
          if (opp && opp.pipelineStageId !== STAGE_REPLY) {
            await callGHL('PUT', `/opportunities/${opp.id}`, { pipelineStageId: STAGE_REPLY });
            stageUpdates++;
            console.log(`[Agent 09] ✅ Stage → Replied: ${contact.firstName} ${contact.lastName} @ ${contact.companyName}`);
          }
        } catch(e) {
          console.error(`[Agent 09] Stage sync error for ${email}: ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 200));
      }
    } catch(e) {
      console.error(`[Agent 09] Campaign ${campaignId} sync error: ${e.message}`);
    }
  }

  logRun('09-crm-stage-sync', { stage_updates: stageUpdates });
  console.log(`[Agent 09] Stage sync done — ${stageUpdates} contacts advanced to Replied`);
  return stageUpdates;
}

module.exports = { logToGHL, syncInstantlyToGHL };
