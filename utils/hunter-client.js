/**
 * Hunter.io client
 * Finds email addresses for companies by domain
 * 50 free lookups/month
 */
require('dotenv').config({ path: './config/.env' });

async function findEmail(domain, firstName, lastName) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new Error('HUNTER_API_KEY not set');

  const fetch = (await import('node-fetch')).default;

  // Domain search — finds all emails at a domain
  const url = `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${apiKey}&limit=5`;
  const r = await fetch(url);
  const data = await r.json();

  if (data.errors) throw new Error(data.errors[0].details);

  const emails = data.data?.emails || [];

  // If we have a name, find the best match
  if (firstName && emails.length > 0) {
    const nameLower = firstName.toLowerCase();
    const match = emails.find(e =>
      e.value.toLowerCase().startsWith(nameLower[0]) ||
      e.value.toLowerCase().includes(nameLower)
    );
    if (match) return { email: match.value, confidence: match.confidence, source: 'hunter_name_match' };
  }

  // Return highest confidence email
  if (emails.length > 0) {
    const best = emails.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    return { email: best.value, confidence: best.confidence, source: 'hunter_domain' };
  }

  // Try email finder if domain search found nothing
  if (firstName && lastName) {
    const finderUrl = `https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${firstName}&last_name=${lastName}&api_key=${apiKey}`;
    const r2 = await fetch(finderUrl);
    const d2 = await r2.json();
    if (d2.data?.email) {
      return { email: d2.data.email, confidence: d2.data.score, source: 'hunter_finder' };
    }
  }

  return null;
}

async function checkCredits() {
  const apiKey = process.env.HUNTER_API_KEY;
  const fetch = (await import('node-fetch')).default;
  const r = await fetch(`https://api.hunter.io/v2/account?api_key=${apiKey}`);
  const data = await r.json();
  return {
    used: data.data?.requests?.searches?.used,
    available: data.data?.requests?.searches?.available
  };
}

module.exports = { findEmail, checkCredits };
