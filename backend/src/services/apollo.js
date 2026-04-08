/**
 * Apollo.io REST API client
 * Uses APOLLO_API_KEY env var. Returns 503-style errors if unset.
 *
 * Docs: https://apolloio.github.io/apollo-api-docs/
 */

const APOLLO_BASE = 'https://api.apollo.io/api/v1';

// Senior titles we care about for LP outreach
const SENIOR_TITLES = [
  'partner', 'managing partner', 'managing director', 'principal',
  'investment director', 'head of', 'chief investment officer', 'cio',
  'portfolio manager', 'investment manager', 'associate', 'vice president',
];

const SENIORITY_FILTER = ['c_suite', 'vp', 'director', 'manager', 'partner'];

function hasKey() {
  return !!process.env.APOLLO_API_KEY;
}

async function apolloFetch(path, body) {
  if (!hasKey()) {
    const err = new Error('APOLLO_API_KEY env var not set');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.error || json?.message || `Apollo API ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * Search for senior people at a given organization (by name).
 * Returns normalized contacts ready to insert into apollo_company_contacts.
 */
async function searchPeopleAtCompany(companyName, opts = {}) {
  const {
    perPage = 25,
    titles = SENIOR_TITLES,
    seniorities = SENIORITY_FILTER,
  } = opts;

  const body = {
    q_organization_name: companyName,
    person_seniorities: seniorities,
    person_titles: titles,
    page: 1,
    per_page: perPage,
  };

  const data = await apolloFetch('/mixed_people/search', body);

  const people = (data.people || []).map((p) => ({
    apollo_person_id: p.id,
    first_name: p.first_name || null,
    last_name: p.last_name || null,
    full_name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' '),
    title: p.title || null,
    seniority: p.seniority || null,
    linkedin_url: p.linkedin_url || null,
    email: p.email || null, // usually null without paid unlock
    city: p.city || null,
    state: p.state || null,
    country: p.country || null,
    organization_name:
      p.organization?.name || p.organization_name || companyName,
    organization_domain:
      p.organization?.primary_domain || p.organization?.website_url || null,
  }));

  // First org row (Apollo returns the same org metadata on each person)
  const firstOrg = data.people?.[0]?.organization;
  const company_info = firstOrg ? {
    domain: firstOrg.primary_domain || firstOrg.website_url || null,
    industry: firstOrg.industry || null,
    employee_count: firstOrg.estimated_num_employees || null,
    revenue_range: firstOrg.estimated_annual_revenue_range || null,
    apollo_org_id: firstOrg.id || null,
    total_people_found: data.pagination?.total_entries || people.length,
    senior_contacts_found: people.length,
  } : null;

  return {
    people,
    company_info,
    pagination: data.pagination || null,
  };
}

/**
 * Enrich an organization by domain. Useful to look up firmographics.
 */
async function enrichOrganization(domain) {
  if (!domain) throw new Error('domain required');
  if (!hasKey()) {
    const err = new Error('APOLLO_API_KEY env var not set');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const url = `${APOLLO_BASE}/organizations/enrich?domain=${encodeURIComponent(domain)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Api-Key': process.env.APOLLO_API_KEY },
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json?.error || `Apollo API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json.organization || null;
}

module.exports = {
  hasKey,
  searchPeopleAtCompany,
  enrichOrganization,
};
