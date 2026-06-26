/**
 * Agent 08: Campaign Launcher
 * Pushes verified prospects into Instantly SubDraw California GCs campaign
 */
require('dotenv').config({ path: './config/.env' });
const { callInstantly, logRun, pingDashboard } = require('../utils/helpers');
const icp = require('../config/icp.json');

async function launchCampaigns(prospects, options = {}) {
  await pingDashboard(8, 'ok', 'campaign-launcher running — ' + prospects.length + ' prospects');
  const campaignId = options.campaignId || campaignId;
  console.log('[Agent 08] Launching ' + prospects.length + ' prospects into Instantly...');
  const launched = [], failed = [];

  for (const p of prospects) {
    try {
      const lead = {
        campaign_id: process.env.INSTANTLY_CAMPAIGN_ID || icp.instantly.campaign_id,
        email: p.email,
        first_name: p.first_name || p.name?.split(' ')[0] || '',
        last_name: p.last_name || p.name?.split(' ').slice(1).join(' ') || '',
        company_name: p.organization_name || '',
        personalization: p.personalization?.hook || '',
        custom_variables: {
          hook: p.personalization?.hook || '',
          pain_point: p.screening?.pain_point || p.intel?.primary_pain || '',
          current_tool: p.intel?.current_tool || 'your current process',
          recommended_plan: p.intel?.recommended_plan || 'starter_149',
          city: p.city || ''
        }
      };
      await callInstantly('POST', '/lead/add', lead);
      launched.push(p);
    } catch (err) {
      console.error('[Agent 08] Failed ' + p.name + ': ' + err.message);
      failed.push({ ...p, error: err.message });
    }
  }

  require('../utils/helpers').notifyDashboard('email_sent', { campaign: campaignId, count: launched.length });
    logRun('08-campaign-launcher', { launched: launched.length, failed: failed.length });
  return { launched, failed };
}

module.exports = { launchCampaigns };
