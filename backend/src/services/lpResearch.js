/**
 * LP Research Service
 *
 * Synthesises a structured intelligence brief for an LP target by combining:
 *   1. Existing profile data already stored in the DB
 *   2. Apollo organisation enrichment (firmographics)
 *   3. Web search via Perplexity API (if PERPLEXITY_API_KEY is set)
 *   4. Claude synthesis — fund overview, recent activity, warm-intro angles
 *
 * Results are cached in lp_targets.research_data (JSONB) and lp_targets.researched_at.
 */

const db = require('../config/db');
const apollo = require('./apollo');

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch (e) {
  console.warn('[lpResearch] @anthropic-ai/sdk not installed');
}

// ─── Studio VC context injected into every research prompt ───────────────────
const STUDIO_VC_CONTEXT = `
Studio VC is raising CQ Fund III, an early-stage seed fund ($50M target).
Investment thesis: B2B SaaS, fintech infrastructure, and AI-native applications.
Geography: US and Europe (primary focus on English-speaking markets).
Stage: Pre-seed and seed (initial cheques of $250K–$1M).
Current portfolio: 12 companies.
Team background: Operators and former founders with exits in B2B software and fintech.
Value-add: Active board involvement, portfolio network introductions, follow-on support.
`.trim();

// ─── Perplexity web search (optional) ────────────────────────────────────────
async function webSearch(query) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are a research assistant. Return factual, concise information only. No preamble.',
          },
          { role: 'user', content: query },
        ],
        max_tokens: 600,
        temperature: 0.1,
        return_citations: true,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.warn('[lpResearch] Perplexity search failed:', e.message);
    return null;
  }
}

// ─── Main research function ───────────────────────────────────────────────────
async function researchLP(lpId) {
  if (!Anthropic) throw new Error('Anthropic SDK not available');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // 1. Load LP from DB
  const { rows: lpRows } = await db.query('SELECT * FROM lp_targets WHERE id = $1', [lpId]);
  if (!lpRows.length) throw new Error('LP not found');
  const lp = lpRows[0];

  // 2. Load Apollo contacts already found for this LP
  const { rows: apolloContacts } = await db.query(
    `SELECT full_name, title, seniority, city, country FROM apollo_company_contacts
     WHERE lp_target_id = $1 ORDER BY seniority LIMIT 8`,
    [lpId]
  );

  // 3. Load LinkedIn enrichment if available
  const { rows: enrichRows } = await db.query(
    `SELECT headline, summary, location, industry, job_history, education, skills
     FROM linkedin_enrichments WHERE lp_target_id = $1 LIMIT 1`,
    [lpId]
  );
  const enrichment = enrichRows[0] || null;

  // 4. Load manual connections
  const { rows: connections } = await db.query(
    `SELECT name, relationship FROM lp_manual_connections WHERE lp_target_id = $1`,
    [lpId]
  );

  // 5. Apollo org enrichment (best-effort; skip if no domain)
  let apolloOrg = null;
  const domain = lp.website_domain || deriveDomainFromEmail(lp.email);
  if (domain && apollo.hasKey()) {
    try {
      apolloOrg = await apollo.enrichOrganization(domain);
    } catch (e) {
      console.warn('[lpResearch] Apollo org enrich failed:', e.message);
    }
  }

  // 6. Web search for recent activity (Perplexity, optional)
  let recentNewsText = null;
  if (lp.company) {
    recentNewsText = await webSearch(
      `${lp.company} venture capital fund recent news investments portfolio 2024 2025`
    );
  }

  // 7. Build the Claude prompt
  const lpProfile = buildLPProfileText(lp, apolloOrg, apolloContacts, enrichment, connections);

  const systemPrompt = `You are a senior venture capital analyst preparing a concise intelligence brief about a prospective LP (Limited Partner).
Your brief will be used by a GP to prepare for an introductory meeting.
Be specific, factual, and concise. Where information is unknown, say so honestly rather than hallucinating.
Return ONLY valid JSON matching the specified schema — no markdown, no prose outside the JSON.`;

  const userPrompt = `
STUDIO VC (the GP preparing this brief):
${STUDIO_VC_CONTEXT}

LP PROFILE FROM OUR CRM:
${lpProfile}

${recentNewsText ? `RECENT NEWS / WEB RESEARCH:\n${recentNewsText}\n` : ''}

Generate a structured intelligence brief as JSON with exactly this schema:
{
  "fund_overview": {
    "name": "full fund/firm name",
    "type": "type of investor (e.g. Fund of Funds, Family Office, Endowment, Pension Fund)",
    "aum_estimate": "estimated AUM if known, e.g. '$2B–$5B' or 'Unknown'",
    "strategy": "2–3 sentence description of their investment strategy and LP programme",
    "stage_focus": "what stages they typically invest in as an LP",
    "typical_commitment": "typical LP commitment size if known",
    "geographic_focus": "their geographic preferences",
    "key_sectors": ["sector1", "sector2"],
    "fund_count": "number of GP funds they've backed if known",
    "notable_gp_relationships": ["Fund A", "Fund B"],
    "confidence": "high | medium | low"
  },
  "key_people": [
    {
      "name": "full name",
      "title": "title",
      "focus": "what they focus on / what drives their LP decisions",
      "background_note": "brief relevant background"
    }
  ],
  "recent_activity": [
    {
      "event": "concise description of event",
      "relevance": "why this matters for our pitch",
      "approximate_date": "e.g. Q1 2025 or 2024"
    }
  ],
  "warm_intro_angles": [
    {
      "angle": "short headline for this angle",
      "rationale": "why this creates a connection point",
      "suggested_approach": "how to lead with this in the conversation"
    }
  ],
  "talking_points": [
    "Specific, non-generic talking point 1 referencing their actual profile",
    "Specific, non-generic talking point 2",
    "Specific, non-generic talking point 3"
  ],
  "red_flags": [
    "Any known reason they might not be a fit — e.g. minimum commitment too large, sector mismatch, competing GP relationships"
  ],
  "recommended_approach": "1–2 sentence recommended outreach strategy given everything above",
  "data_quality": {
    "sources_used": ["crm_profile", "apollo_enrichment", "web_search", "claude_knowledge"],
    "confidence_score": 0,
    "notes": "Any important caveats about data freshness or gaps"
  }
}`;

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const rawText = response.content[0]?.text || '';

  // Parse JSON — strip any markdown fences if present
  let brief;
  try {
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    brief = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Claude returned invalid JSON: ${rawText.slice(0, 200)}`);
  }

  // Stamp sources
  const sourcesUsed = ['crm_profile', 'claude_knowledge'];
  if (apolloOrg) sourcesUsed.push('apollo_enrichment');
  if (recentNewsText) sourcesUsed.push('web_search');
  if (brief.data_quality) {
    brief.data_quality.sources_used = sourcesUsed;
  }

  // 8. Cache in DB
  await db.query(
    `UPDATE lp_targets SET research_data = $1, researched_at = NOW(), updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(brief), lpId]
  );

  return brief;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveDomainFromEmail(email) {
  if (!email || !email.includes('@')) return null;
  const parts = email.split('@');
  const domain = parts[1]?.toLowerCase();
  // Skip generic email providers
  const generic = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
  return generic.includes(domain) ? null : domain;
}

function buildLPProfileText(lp, apolloOrg, apolloContacts, enrichment, connections) {
  const lines = [];

  lines.push(`Name: ${lp.full_name || 'Unknown'}`);
  lines.push(`Company/Fund: ${lp.company || 'Unknown'}`);
  if (lp.title) lines.push(`Title: ${lp.title}`);
  if (lp.fund_type) lines.push(`Fund Type: ${lp.fund_type}`);
  if (lp.estimated_aum) lines.push(`Estimated AUM: ${lp.estimated_aum}`);
  if (lp.typical_check_size) lines.push(`Typical LP Commitment: ${lp.typical_check_size}`);
  if (lp.geographic_focus) lines.push(`Geographic Focus: ${lp.geographic_focus}`);
  if (lp.sector_interest && lp.sector_interest.length) {
    lines.push(`Sector Interest: ${lp.sector_interest.join(', ')}`);
  }
  if (lp.fit_score) lines.push(`Our Fit Score: ${lp.fit_score}/100`);
  if (lp.notes) lines.push(`Notes: ${lp.notes}`);

  if (apolloOrg) {
    lines.push('\nAPOLLO ORG DATA:');
    if (apolloOrg.industry) lines.push(`Industry: ${apolloOrg.industry}`);
    if (apolloOrg.estimated_num_employees) lines.push(`Employees: ${apolloOrg.estimated_num_employees}`);
    if (apolloOrg.short_description) lines.push(`Description: ${apolloOrg.short_description}`);
    if (apolloOrg.founded_year) lines.push(`Founded: ${apolloOrg.founded_year}`);
    if (apolloOrg.linkedin_url) lines.push(`LinkedIn: ${apolloOrg.linkedin_url}`);
    if (apolloOrg.website_url) lines.push(`Website: ${apolloOrg.website_url}`);
  }

  if (apolloContacts.length > 0) {
    lines.push('\nKEY PEOPLE (from Apollo):');
    apolloContacts.forEach(c => {
      lines.push(`  - ${c.full_name || 'Unknown'}, ${c.title || ''} ${c.city ? `(${c.city})` : ''}`);
    });
  }

  if (enrichment) {
    lines.push('\nLINKEDIN ENRICHMENT:');
    if (enrichment.headline) lines.push(`Headline: ${enrichment.headline}`);
    if (enrichment.summary) lines.push(`Summary: ${enrichment.summary?.slice(0, 300)}`);
    if (enrichment.industry) lines.push(`Industry: ${enrichment.industry}`);
    if (enrichment.job_history && enrichment.job_history.length) {
      const recent = enrichment.job_history.slice(0, 3).map(j => `${j.title} at ${j.company}`).join('; ');
      lines.push(`Recent Roles: ${recent}`);
    }
  }

  if (connections.length > 0) {
    lines.push('\nWARM CONNECTIONS (from our network):');
    connections.forEach(c => {
      lines.push(`  - ${c.name}: ${c.relationship || 'known contact'}`);
    });
  }

  return lines.join('\n');
}

module.exports = { researchLP };
