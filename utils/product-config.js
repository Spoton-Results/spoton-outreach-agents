/**
 * utils/product-config.js
 *
 * Single source of truth for all product-specific config.
 * Reads PRODUCT env var (default: 'subdraw') and returns the right ICP + campaigns.
 *
 * Usage in any agent:
 *   const { icp, campaigns, product, isSubDraw, isMerchant } = require('../utils/product-config');
 *
 * No agent should ever require('../config/icp.json') directly — use this instead.
 */

require('dotenv').config({ path: './config/.env' });
const path = require('path');

const PRODUCT = (process.env.PRODUCT || 'subdraw').toLowerCase().trim();

// Allow override via env vars, fall back to convention
const ICP_PATH       = process.env.ICP_CONFIG       || (PRODUCT === 'merchant' ? './config/icp-merchant.json'       : './config/icp.json');
const CAMPAIGNS_PATH = process.env.CAMPAIGNS_CONFIG || (PRODUCT === 'merchant' ? './config/campaigns-merchant.json' : './config/campaigns.json');

let icp, campaigns;

try {
  icp = require(path.resolve(ICP_PATH));
} catch(e) {
  console.error(`[product-config] ⚠ Could not load ICP from ${ICP_PATH}: ${e.message}`);
  icp = {};
}

try {
  campaigns = require(path.resolve(CAMPAIGNS_PATH));
} catch(e) {
  campaigns = {};
}

const isSubDraw  = PRODUCT === 'subdraw';
const isMerchant = PRODUCT === 'merchant';

// ── MERCHANT: Edge 1 + Edge 3 combined pitch ─────────────────────────────────
// Edge 1 — Free statement audit that reveals hidden processor markup
// Edge 3 — Multi-processor matching (TSYS, Fiserv, Maverick, NMI, Auth.net, SpotOn)

const MERCHANT_SMS_TEMPLATES = [
  // Edge 1 — statement audit hook
  `{name}, quick question — when did someone last audit your processing statement? Most merchants on Square or Stripe are overpaying $300-500/mo without knowing. Free audit → spotonresults.com/audit –Shawn. Reply STOP to opt out.`,
  // Edge 3 — multi-processor angle
  `{name}, are you locked into one payment processor? We work with 6 — TSYS, Fiserv, SpotOn, and more. We match your business type to the right one, then audit your current statement free. spotonresults.com/audit –Shawn. STOP to opt out.`,
  // Edge 1 — Worldpay/Global Payments acquisition angle
  `{name}, if you're on Worldpay or Global Payments — they just merged with a $24B acquisition. That almost never means lower fees. Free statement audit shows you exactly what changed. spotonresults.com/audit –Shawn. STOP to opt out.`,
  // Edge 1+3 combined
  `{name}, we audited 47 merchant statements last month. Average was overpaying $380/mo. We also work with 6 processors so we find the right fit, not just the cheapest quote. Free look → spotonresults.com/audit –Shawn. STOP to opt out.`,
];

const MERCHANT_EMAIL_SYSTEM = `You are a direct-response copywriter for SpotOn Results — free merchant statement audits and multi-processor matching for small businesses.

POSITIONING:
- We audit your processing statement for free and show you exactly what you're overpaying
- We work with 6 processors: TSYS, Fiserv, Maverick, NMI, Auth.net, SpotOn
- We match the merchant to the right processor for their business type and volume — not just the cheapest rate
- Our rate: IC+ 0.20% + $0.20 — genuinely competitive vs the 2.5-3.5% blended most merchants are on

TWO EDGES TO LEAD WITH:
Edge 1 — Statement Audit: Most merchants on flat-rate or tiered pricing are overpaying $200-600/month. The processor quietly raises its markup when interchange drops so the merchant never sees the savings. We show them exactly what they're paying vs what they should be paying.
Edge 3 — Multi-Processor Fit: Most ISOs push one processor. We have six. Restaurants go on SpotOn (built for hospitality). High-volume retail goes on TSYS. eComm and subscriptions go on NMI/Auth.net. High-risk goes on Maverick. Enterprise multi-location goes on Fiserv.

COMBINED PITCH: Lead with the free audit (zero risk, immediate value), close with multi-processor fit (nobody else can offer this).

WRITE LIKE THIS:
- Lead with financial pain — merchants are losing real money every month and don't know it
- Speak payments: interchange, markup, tiered vs IC+, non-qualified surcharges, batch fees, PCI fees
- One pain point per email — don't stack them
- CTA is always: spotonresults.com/audit — send us your last statement
- Under 100 words email 1, under 75 follow-ups
- Sound like a payments consultant, not a salesperson

NEVER SAY: streamline, leverage, touch base, circle back, synergy, innovative solution
NEVER DO: multiple pain points in one email, vague CTAs, corporate language

Return JSON only.`;

const SUBDRAW_SMS_TEMPLATES = [
  `{name}, quick question — are your subs billing you accurately on every draw? Most GCs lose $8-15K per job without knowing it. Check it free: subdraw.com/login –Shawn. Reply STOP to opt out.`,
];

module.exports = {
  PRODUCT,
  icp,
  campaigns,
  isSubDraw,
  isMerchant,
  // Merchant-specific exports
  MERCHANT_SMS_TEMPLATES,
  MERCHANT_EMAIL_SYSTEM,
  SUBDRAW_SMS_TEMPLATES,
};
