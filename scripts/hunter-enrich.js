/**
 * Hunter Email Enrichment
 * Finds emails for GHL contacts that only have phone numbers
 * 
 * Run: node scripts/hunter-enrich.js
 * 
 * What it does:
 * 1. Pulls all GHL contacts tagged ut-gc or ca-gc with no email
 * 2. Extracts domain from website field
 * 3. Calls Hunter to find email
 * 4. Updates GHL contact with found email
 * 5. Pushes to Instantly campaign
 */
require('dotenv').config({ path: './config/.env' });
const { callGHL, notifyDashboard } = require('../utils/helpers');
const { findEmail, checkCredits } = require('../utils/hunter-client');

const CA_CAMPAIGN = process.env.INSTANTLY_CA_CAMPAIGN_ID || process.env.INSTANTLY_CAMPAIGN_ID;
const UT_CAMPAIGN = process.env.INSTANTLY_UT_CAMPAIGN_ID || '1c57cd85-5694-444d-9b03-8978c628ab8d';

function extractDomain(website, companyName) {
  if (website) {
    try {
      const url = website.startsWith('http') ? website : 'https://' + website;
      return new URL(url).hostname.replace('www.', '');
    } catch {}
  }
  // Guess domain from company name
  if (companyName) {
    return companyName.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '')
      .substring(0, 20) + '.com';
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const credits = await checkCredits().catch(() => null);
  if (credits) {
    console.log(`Hunter credits: ${credits.used} used, ${credits.available} available`);
    if (credits.available === 0) {
      console.log('No Hunter credits remaining — try again next month');
      return;
    }
  }

  const locId = process.env.GHL_LOCATION_ID;
  let enriched = 0, skipped = 0, failed = 0;

  for (const tag of ['ut-gc', 'ca-gc']) {
    console.log(`\nFetching ${tag} contacts with no email...`);
    const res = await callGHL('GET', `/contacts/?locationId=${locId}&query=${tag}&limit=100`);
    const contacts = (res.contacts || []).filter(c => !c.email && (c.website || c.companyName));

    console.log(`Found ${contacts.length} contacts without email`);

    for (const contact of contacts) {
      const domain = extractDomain(contact.website, contact.companyName);
      if (!domain) { skipped++; continue; }

      console.log(`\n[Hunter] ${contact.companyName} → ${domain}`);

      try {
        const result = await findEmail(domain, contact.firstName, contact.lastName);

        if (!result?.email) {
          console.log('  No email found');
          skipped++;
          continue;
        }

        console.log(`  ✓ Found: ${result.email} (confidence: ${result.confidence}%)`);

        // Update GHL contact with email
        await callGHL('PUT', `/contacts/${contact.id}`, {
          email: result.email,
          customFields: [{ key: 'hunter_confidence', field_value: String(result.confidence || '') }]
        });

        // Push to Instantly
        const campaignId = tag === 'ca-gc' ? CA_CAMPAIGN : UT_CAMPAIGN;
        const fetch = (await import('node-fetch')).default;
        await fetch('https://api.instantly.ai/api/v2/leads', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + process.env.INSTANTLY_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            campaign_id: campaignId,
            skip_if_in_workspace: true,
            email: result.email,
            first_name: contact.firstName || '',
            last_name: contact.lastName || '',
            company_name: contact.companyName || '',
            phone: contact.phone || '',
            city: contact.city || '',
            state: contact.state || ''
          })
        });

        enriched++;
        console.log(`  ✓ Pushed to Instantly campaign`);

        // Respect Hunter rate limits
        await sleep(1500);

      } catch(e) {
        console.log(`  ✗ Error: ${e.message}`);
        failed++;
        if (e.message.includes('credit') || e.message.includes('limit')) {
          console.log('Hunter credit limit hit — stopping');
          break;
        }
      }
    }
  }

  console.log(`\n✅ Hunter enrichment complete`);
  console.log(`   Enriched: ${enriched}`);
  console.log(`   Skipped:  ${skipped} (no domain or email found)`);
  console.log(`   Failed:   ${failed}`);

  await notifyDashboard('hunter_enrichment', { enriched, skipped, failed });
}

main().catch(console.error);
