/**
 * Apollo.io API Client
 * Primary prospecting source — 210M+ contacts, native Claude MCP connector
 * Used by Agent 01 to find CA General Contractors
 */
require('dotenv').config({ path: './config/.env' });

async function searchPeople(params = {}) {
  const fetch = (await import('node-fetch')).default;
  const {
    titles = ['owner', 'president', 'principal', 'project manager'],
    state = 'California',
    industries = ['construction', 'general contractor'],
    employeeRanges = ['1,50', '51,200'],
    limit = 50
  } = params;

  const body = {
    api_key: process.env.APOLLO_API_KEY,
    person_titles: titles,
    organization_industry_tag_ids: [],
    q_organization_keyword_tags: industries,
    person_locations: [state + ', US'],
    organization_num_employees_ranges: employeeRanges,
    contact_email_status: ['verified', 'guessed'],
    per_page: Math.min(limit, 100),
    page: 1
  };

  const res = await fetch('https://api.apollo.io/v1/mixed_people/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error('Apollo error: ' + res.status + ' ' + await res.text());
  const data = await res.json();
  return (data.people || []).map(normalizeApolloContact);
}

async function enrichPerson(email) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.apollo.io/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.APOLLO_API_KEY, email, reveal_personal_emails: true })
  });
  if (!res.ok) throw new Error('Apollo enrich error: ' + res.status);
  const data = await res.json();
  return data.person ? normalizeApolloContact(data.person) : null;
}

function normalizeApolloContact(p) {
  return {
    id: p.id,
    name: p.name || (p.first_name + ' ' + p.last_name),
    first_name: p.first_name,
    last_name: p.last_name,
    title: p.title,
    email: p.email,
    phone: p.phone_numbers?.[0]?.raw_number || '',
    linkedin_url: p.linkedin_url,
    organization_name: p.organization?.name,
    website: p.organization?.website_url,
    industry: p.organization?.industry,
    employees: p.organization?.num_employees,
    city: p.city,
    state: p.state,
    source: 'apollo'
  };
}

module.exports = { searchPeople, enrichPerson };
