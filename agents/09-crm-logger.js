/**
 * Agent 09: CRM Logger
 * Creates/updates contacts in GoHighLevel with full enrichment data
 * Uses your exact pipeline and stage IDs
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

async function logToGHL(prospects) {
  console.log('[Agent 09] Logging ' + prospects.length + ' contacts to GHL...');
  const logged = [];

  for (const p of prospects) {
    try {
      const nameParts = (p.name || '').split(' ');
      const contact = {
        firstName: p.first_name || nameParts[0] || '',
        lastName: p.last_name || nameParts.slice(1).join(' ') || '',
        email: p.email,
        phone: p.phone || '',
        companyName: p.organization_name || '',
        source: 'SubDraw Agent Outreach',
        tags: [
          'agent-outreach',
          'gc-prospect',
          p.intel?.recommended_plan || 'unknown-plan',
          p.intel?.current_tool ? 'tool-' + p.intel.current_tool.toLowerCase().replace(/\s/g,'-') : 'tool-unknown',
          'score-' + (p.screening?.score || 0)
        ],
        customFields: [
          { key: 'screening_score', field_value: String(p.screening?.score || '') },
          { key: 'pain_point', field_value: p.screening?.pain_point || p.intel?.primary_pain || '' },
          { key: 'current_draw_tool', field_value: p.intel?.current_tool || '' },
          { key: 'recommended_plan', field_value: p.intel?.recommended_plan || '' },
          { key: 'personalization_hook', field_value: p.personalization?.hook || '' },
          { key: 'switching_likelihood', field_value: p.intel?.switching_likelihood || '' },
          { key: 'outreach_date', field_value: new Date().toISOString().split('T')[0] }
        ]
      };

      // Create contact
      const result = await callGHL('POST', '/contacts/', contact);
      const contactId = result.contact?.id;

      // Add to pipeline at Cold stage
      if (contactId) {
        await callGHL('POST', '/opportunities/', {
          pipelineId: process.env.GHL_PIPELINE_ID || icp.ghl.pipeline_id,
          locationId: process.env.GHL_LOCATION_ID || icp.ghl.location_id,
          name: (p.organization_name || p.name) + ' — SubDraw',
          pipelineStageId: process.env.GHL_STAGE_COLD || icp.ghl.stages.cold,
          contactId,
          status: 'open'
        });
      }

      logged.push(p);
    } catch (err) {
      console.error('[Agent 09] GHL error for ' + p.name + ': ' + err.message);
    }
  }

  logRun('09-crm-logger', { logged: logged.length });
  return logged;
}

module.exports = { logToGHL };
