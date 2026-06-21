/**
 * Agent 33: Lead Enrichment
 * TWO modes:
 * 1. enrichBatch(prospects) — called by daily pipeline for new contacts
 * 2. enrichGHLContacts()    — called by orchestrator daily at 7am
 *    Scans existing GHL contacts missing email, enriches via Apollo then Claude
 */
require('dotenv').config({ path: './config/.env' });
const { callClaude, callGHL, logRun } = require('../utils/helpers');

const SYSTEM = `You are a lead enrichment agent for SubDraw — construction draw management SaaS.
Enrich General Contractor company data with publicly available signals.
Focus on signals that indicate: company size, active project volume, tech sophistication, and financial health.
Return JSON only. Never invent data — use "unknown" when you cannot determine a value.`;

// ── Enrich a single prospect via Claude ───────────────────────────────────────
async function enrichProspect(prospect) {
  const prompt = `Enrich this General Contractor company with available public signals:

Company: ${prospect.organization_name || prospect.companyName}
Contact: ${prospect.name || prospect.firstName + ' ' + prospect.lastName}, ${prospect.title || ''}
Location: ${prospect.city}, ${prospect.state}
Website: ${prospect.website || 'unknown'}
Employees: ${prospect.employees || 'unknown'}

Return: {
  "revenue_range": "under_1M|1_5M|5_20M|20M_plus|unknown",
  "project_types": ["residential","commercial","mixed","industrial"],
  "tech_sophistication": "low|medium|high",
  "estimated_active_subcontracts": X,
  "enrichment_confidence": "high|medium|low",
  "key_signal": "single most important finding"
}`;

  try {
    return JSON.parse(await callClaude(SYSTEM, prompt));
  } catch(e) {
    console.error('[Agent 33] Parse error:', e.message);
    return { enriched: false };
  }
}

// ── Enrich batch of new pipeline prospects ────────────────────────────────────
async function enrichBatch(prospects) {
  console.log('[Agent 33] Enriching ' + prospects.length + ' prospects...');
  const enriched = [];
  for (const p of prospects) {
    const enrichment = await enrichProspect(p);
    enriched.push({ ...p, enrichment });
  }
  logRun('33-lead-enrichment', { processed: enriched.length });
  return enriched;
}

// ── Scan GHL for contacts missing email, try Apollo then Claude ───────────────
async function enrichGHLContacts() {
  console.log('[Agent 33] Scanning GHL for contacts missing emails...');

  const locationId = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
  let enriched = 0, skipped = 0, found = 0;

  try {
    // Pull contacts in batches
    let startAfter = null, startAfterId = null, page = 1;

    while (true) {
      let url = `/contacts/?locationId=${locationId}&limit=100&query=gc-prospect`;
      if (startAfter)   url += `&startAfter=${startAfter}`;
      if (startAfterId) url += `&startAfterId=${startAfterId}`;

      const data = await callGHL('GET', url);
      const contacts = data.contacts || [];
      if (!contacts.length) break;

      for (const c of contacts) {
        // Skip if already has email
        if (c.email && c.email.includes('@')) { skipped++; continue; }
        // Skip if tagged email-enriched already
        if ((c.tags || []).includes('email-enriched')) { skipped++; continue; }
        // Must have website or company name to attempt enrichment
        if (!c.website && !c.companyName) { skipped++; continue; }

        try {
          // Try Apollo first via people match
          const apolloKey = process.env.APOLLO_API_KEY;
          if (apolloKey && c.companyName) {
            const fetch = (await import('node-fetch')).default;
            const ar = await fetch('https://api.apollo.io/v1/people/match', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
              body: JSON.stringify({
                api_key: apolloKey,
                first_name: c.firstName,
                last_name: c.lastName,
                organization_name: c.companyName,
                domain: c.website ? c.website.replace(/^https?:\/\//, '').split('/')[0] : undefined
              })
            });
            const ad = await ar.json();
            const email = ad.person?.email;

            if (email && email.includes('@') && !email.includes('email_not_unlocked')) {
              // Update GHL contact with found email
              await callGHL('PUT', `/contacts/${c.id}`, { email });
              await callGHL('POST', `/contacts/${c.id}/tags`, { tags: ['email-enriched', 'email-via-apollo'] });
              found++;
              console.log(`[Agent 33] ✅ Apollo email: ${c.firstName} ${c.lastName} @ ${c.companyName} → ${email}`);
              continue;
            }
          }

          // Tag as attempted so we don't retry every day
          await callGHL('POST', `/contacts/${c.id}/tags`, { tags: ['email-enriched'] });
          enriched++;

        } catch(e) {
          console.error(`[Agent 33] Enrichment error for ${c.companyName}: ${e.message}`);
        }

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 300));
      }

      console.log(`[Agent 33] Page ${page}: ${contacts.length} contacts (found: ${found} emails)`);
      const meta = data.meta;
      if (!meta?.nextPage || contacts.length < 100) break;
      startAfter   = meta.startAfter;
      startAfterId = meta.startAfterId;
      page++;
    }

  } catch(e) {
    console.error('[Agent 33] GHL scan error:', e.message);
  }

  logRun('33-lead-enrichment-ghl', { found_emails: found, enriched, skipped });
  console.log(`[Agent 33] GHL enrichment done — emails found: ${found}, processed: ${enriched}, skipped: ${skipped}`);
  return { found, enriched, skipped };
}

module.exports = { enrichBatch, enrichGHLContacts };
