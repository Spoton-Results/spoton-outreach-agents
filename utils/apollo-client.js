/**
 * Apollo.io API Client
 * Primary prospecting source — 210M+ contacts
 * Fixed: proper keyword and title filtering for GC search
 */
require('dotenv').config({ path: './config/.env' });

async function searchPeople(params = {}) {
  const fetch = (await import('node-fetch')).default;
  const {
    titles = ['owner', 'president', 'principal', 'project manager'],
    keywords = ['general contractor', 'construction management'],
    state = 'California',
    employeeRanges = ['1,10', '11,50', '51,200'],
    limit = 50
  } = params;

  const body = {
    api_key: process.env.APOLLO_API_KEY,
    // Title filter — people who actually manage subs and draws
    person_titles: titles,
    // Location
    person_locations: [state + ', US'],
    // Company size — small to mid GCs
    organization_num_employees_ranges: employeeRanges,
    // Industry keyword tags — how Apollo identifies construction companies
    q_organization_keyword_tags: keywords,
    // Only return contacts with usable emails
    contact_email_status: ['verified', 'guessed', 'unavailable'],
    per_page: Math.min(limit, 100),
    page: 1
  };

  const res = await fetch('https://api.apollo.io/v1/mixed_people/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Apollo error ' + res.status + ': ' + text.substring(0, 200));
  }

  const data = await res.json();

  if (data.error) throw new Error('Apollo API error: ' + data.error);

  const people = data.people || data.contacts || [];
  console.log('[Apollo] Raw results:', people.length, '| Pagination:', JSON.stringify(data.pagination || {}));

  return people.map(normalizeApolloContact).filter(p => p.email && p.organization_name);
}

async function enrichPerson(email) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.apollo.io/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.APOLLO_API_KEY,
      email,
      reveal_personal_emails: true
    })
  });
  if (!res.ok) throw new Error('Apollo enrich error ' + res.status);
  const data = await res.json();
  return data.person ? normalizeApolloContact(data.person) : null;
}

function normalizeApolloContact(p) {
  return {
    id: p.id,
    name: p.name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim(),
    first_name: p.first_name || '',
    last_name: p.last_name || '',
    title: p.title || '',
    email: p.email || '',
    phone: p.phone_numbers?.[0]?.raw_number || p.phone_number || '',
    linkedin_url: p.linkedin_url || '',
    organization_name: p.organization?.name || p.company || '',
    website: p.organization?.website_url || '',
    industry: p.organization?.industry || 'construction',
    employees: p.organization?.num_employees || p.employment_history?.[0]?.organization_num_employees || '',
    city: p.city || '',
    state: p.state || '',
    source: 'apollo'
  };
}

module.exports = { searchPeople, enrichPerson };
