/**
 * Vibe Prospecting API Client (Explorium)
 * Secondary source — burns remaining 864 credits first before switching to Apollo
 * Same normalized output format as apollo-client.js
 */
require('dotenv').config({ path: './config/.env' });

async function searchProspects(params = {}) {
  const fetch = (await import('node-fetch')).default;
  const { state = 'California', industries = ['construction'], limit = 50 } = params;

  const res = await fetch('https://vibeprospecting.explorium.ai/api/v1/prospects/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.VIBE_API_KEY
    },
    body: JSON.stringify({
      query: 'General contractors in ' + state + ' with active construction projects',
      filters: {
        industries,
        locations: [state],
        company_size: { min: 2, max: 150 },
        titles: ['owner', 'president', 'principal', 'project manager', 'founder']
      },
      limit
    })
  });

  if (!res.ok) throw new Error('Vibe error: ' + res.status + ' ' + await res.text());
  const data = await res.json();
  return (data.prospects || []).map(normalizeVibeContact);
}

function normalizeVibeContact(p) {
  return {
    id: p.id || p.prospect_id,
    name: p.full_name || (p.first_name + ' ' + p.last_name),
    first_name: p.first_name,
    last_name: p.last_name,
    title: p.title || p.job_title,
    email: p.email,
    phone: p.phone || p.mobile || '',
    linkedin_url: p.linkedin_url,
    organization_name: p.company_name || p.organization,
    website: p.company_website,
    industry: p.industry,
    employees: p.company_size,
    city: p.city,
    state: p.state,
    source: 'vibe'
  };
}

module.exports = { searchProspects };
