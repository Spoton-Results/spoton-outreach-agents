/**
 * Agent 07: Data Verifier
 * Validates contact data before sending — prevents bounces and bad GHL data
 */
require('dotenv').config({ path: './config/.env' });
const { logRun } = require('../utils/helpers');

async function verifyContacts(prospects) {
  console.log('[Agent 07] Verifying ' + prospects.length + ' contacts...');
  const verified = [];

  for (const p of prospects) {
    const checks = {
      has_email: !!(p.email),
      email_valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email || ''),
      not_role_email: !['info@','hello@','contact@','admin@','office@'].some(x => (p.email||'').toLowerCase().startsWith(x)),
      has_name: !!(p.name && p.name.length > 2),
      has_company: !!(p.organization_name),
      has_location: !!(p.city || p.state)
    };
    const score = Object.values(checks).filter(Boolean).length;
    if (score >= 4) verified.push({ ...p, verification: { checks, score, verified: true } });
    else console.log('[Agent 07] Skipping ' + p.name + ' — score ' + score + '/6');
  }

  logRun('07-data-verifier', { input: prospects.length, verified: verified.length });
  return verified;
}

module.exports = { verifyContacts };
