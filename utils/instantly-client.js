/**
 * Instantly API Client
 * Manages the SubDraw California GCs campaign
 */
require('dotenv').config({ path: './config/.env' });
const { callInstantly } = require('./helpers');

async function addLead(leadData) {
  return callInstantly('POST', '/lead/add', {
    campaign_id: process.env.INSTANTLY_CAMPAIGN_ID,
    email: leadData.email,
    first_name: leadData.first_name || '',
    last_name: leadData.last_name || '',
    company_name: leadData.organization_name || '',
    personalization: leadData.personalization?.hook || '',
    custom_variables: {
      hook: leadData.personalization?.hook || '',
      pain_point: leadData.screening?.pain_point || '',
      current_tool: leadData.intel?.current_tool || 'your current process',
      demo_url: 'subdraw.com/login',
      city: leadData.city || ''
    }
  });
}

async function getCampaignAnalytics() {
  return callInstantly('GET', '/analytics/campaign?campaign_id=' + process.env.INSTANTLY_CAMPAIGN_ID);
}

async function getLeadReplies(limit = 50) {
  return callInstantly('GET', '/email/list?campaign_id=' + process.env.INSTANTLY_CAMPAIGN_ID + '&limit=' + limit + '&reply=true');
}

async function unsubscribeLead(email) {
  return callInstantly('POST', '/lead/update', {
    campaign_id: process.env.INSTANTLY_CAMPAIGN_ID,
    email,
    skip: true
  });
}

module.exports = { addLead, getCampaignAnalytics, getLeadReplies, unsubscribeLead };
