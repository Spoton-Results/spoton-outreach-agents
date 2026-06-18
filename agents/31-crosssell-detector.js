/**
 * Agent 31: Cross-Sell Detector
 * Watches GHL for contacts that appear in BOTH SpotOn and SubDraw contexts
 * Restaurant owners doing buildouts, retail expanding locations
 * One person = two revenue opportunities
 * Also watches for SubDraw customers who might need SpotOn merchant services
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');
const icp = require('../config/icp.json');

const SYSTEM = `You are a cross-sell detection agent.
Identify contacts who could benefit from both SubDraw (construction draws) AND SpotOn Results (merchant services/POS).
Look for: restaurant owners building new locations, retailers expanding, any business doing construction AND accepting payments.
Return JSON only.`;

async function detectCrossSellOpportunities() {
  console.log('[Agent 31] Scanning for cross-sell opportunities...');

  try {
    const locationId = process.env.GHL_LOCATION_ID || icp.ghl.location_id;

    // Find SubDraw customers who might also need SpotOn
    const subDrawCustomers = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=customer&limit=100');

    // Find SpotOn prospects who might be doing construction
    const spotonProspects = await callGHL('GET', '/contacts/?locationId=' + locationId + '&tags=restaurant,retail&limit=100');

    const opportunities = [];

    // Check SubDraw customers for SpotOn signals
    for (const customer of (subDrawCustomers.contacts || [])) {
      const hasRestaurantSignal = customer.companyName?.toLowerCase().includes('restaurant') ||
        customer.companyName?.toLowerCase().includes('bar') ||
        customer.companyName?.toLowerCase().includes('cafe') ||
        customer.tags?.some(t => ['restaurant', 'retail', 'food'].includes(t));

      if (hasRestaurantSignal && !customer.tags?.includes('spoton-prospect')) {
        opportunities.push({
          contact: customer,
          direction: 'subdraw_to_spoton',
          reason: 'SubDraw customer in restaurant/retail — likely needs payment processing'
        });
      }
    }

    if (opportunities.length > 0) {
      const prompt = `Review these cross-sell opportunities for SubDraw → SpotOn Results:
${JSON.stringify(opportunities.map(o => ({ name: o.contact.firstName + ' ' + o.contact.lastName, company: o.contact.companyName, reason: o.reason })))}

Which ones are most likely genuine cross-sell candidates?
Return: [{ "name": "...", "priority": "high|medium|low", "recommended_action": "..." }]`;

      const scored = JSON.parse(await callClaude(SYSTEM, prompt));
      logRun('31-crosssell-detector', { opportunities_found: opportunities.length, high_priority: scored.filter(s => s.priority === 'high').length });
      console.log('[Agent 31] Found ' + opportunities.length + ' cross-sell opportunities');
      return { opportunities, scored };
    } else {
      console.log('[Agent 31] No cross-sell opportunities today');
      logRun('31-crosssell-detector', { opportunities_found: 0 });
      return { opportunities: [], scored: [] };
    }
  } catch(e) {
    console.error('[Agent 31] Error:', e.message);
    return { opportunities: [], scored: [] };
  }
}

module.exports = { detectCrossSellOpportunities };
if (require.main === module) detectCrossSellOpportunities().then(r => console.log('[Agent 31] Done:', r.opportunities.length));
