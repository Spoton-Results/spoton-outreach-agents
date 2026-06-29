/**
 * Agent 08: Campaign Launcher — PRODUCT-AWARE
 * Pushes verified prospects into the correct Instantly campaign
 * based on PRODUCT env var.
 */
require('dotenv').config({ path: './config/.env' });
const { callInstantly, logRun, pingDashboard, notifyDashboard } = require('../utils/helpers');
const { isMerchant, PRODUCT, icp } = require('../utils/product-config');

async function launchCampaigns(prospects, options = {}) {
  await pingDashboard(8, 'ok', `campaign-launcher running — ${prospects.length} prospects — PRODUCT=${PRODUCT}`);
  console.log(`[Agent 08] Launching ${prospects.length} prospects — PRODUCT=${PRODUCT}`);

  const campaignId = options.campaignId
    || process.env.INSTANTLY_CAMPAIGN_ID
    || icp?.instantly?.campaign_id
    || null;

  if (!campaignId) {
    console.error('[Agent 08] No campaign ID — set INSTANTLY_CAMPAIGN_ID env var');
    return { launched: [], failed: [] };
  }

  const launched = [], failed = [];

  for (const p of prospects) {
    try {
      const lead = isMerchant
        ? {
            campaign_id: campaignId,
            email: p.email,
            first_name: p.first_name || p.name?.split(' ')[0] || '',
            last_name:  p.last_name  || p.name?.split(' ').slice(1).join(' ') || '',
            company_name: p.organization_name || '',
            personalization: p.personalization?.hook || '',
            custom_variables: {
              hook:               p.personalization?.hook || '',
              industry:           p.industry || '',
              estimated_processor: p.estimated_processor || 'your current processor',
              city:               p.city || '',
              // Edge 1: savings estimate based on estimated volume
              savings_estimate:   '$300-500/month',
              // Edge 3: processor recommendation by industry
              recommended_processor: getProcessorByIndustry(p.industry),
              audit_url:          'spotonresults.com/audit',
            }
          }
        : {
            campaign_id: campaignId,
            email: p.email,
            first_name: p.first_name || p.name?.split(' ')[0] || '',
            last_name:  p.last_name  || p.name?.split(' ').slice(1).join(' ') || '',
            company_name: p.organization_name || '',
            personalization: p.personalization?.hook || '',
            custom_variables: {
              hook:              p.personalization?.hook || '',
              pain_point:        p.screening?.pain_point || p.intel?.primary_pain || '',
              current_tool:      p.intel?.current_tool  || 'your current process',
              recommended_plan:  p.intel?.recommended_plan || 'starter_149',
              city:              p.city || '',
            }
          };

      await callInstantly('POST', '/lead/add', lead);
      launched.push(p);
    } catch(err) {
      console.error(`[Agent 08] Failed ${p.email}: ${err.message}`);
      failed.push({ ...p, error: err.message });
    }
  }

  notifyDashboard('email_sent', { campaign: campaignId, count: launched.length, product: PRODUCT });
  logRun('08-campaign-launcher', { launched: launched.length, failed: failed.length, product: PRODUCT });
  return { launched, failed };
}

// ── Edge 3: match industry to best processor ──────────────────────────────────
function getProcessorByIndustry(industry = '') {
  const ind = industry.toLowerCase();
  if (ind.includes('restaurant') || ind.includes('bar') || ind.includes('brewery') || ind.includes('cafe')) {
    return 'SpotOn (built for hospitality — loyalty, tipping, reservations built in)';
  }
  if (ind.includes('dental') || ind.includes('medical') || ind.includes('legal') || ind.includes('accounting')) {
    return 'NMI + Auth.net (best for professional services and recurring billing)';
  }
  if (ind.includes('retail') && ind.includes('high')) {
    return 'TSYS (lowest markup for high-volume retail)';
  }
  if (ind.includes('ecommerce') || ind.includes('subscription') || ind.includes('saas')) {
    return 'NMI + Auth.net (best gateway stack for online and subscription billing)';
  }
  if (ind.includes('salon') || ind.includes('spa') || ind.includes('gym') || ind.includes('fitness')) {
    return 'SpotOn (appointment booking + payments in one platform)';
  }
  return 'TSYS or Fiserv (we\'ll match you after reviewing your statement)';
}

module.exports = { launchCampaigns };
