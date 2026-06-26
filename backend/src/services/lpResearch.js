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
    max_tokens: 4096,
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

// ─── Recent Press Scan ───────────────────────────────────────────────────────
/**
 * Runs a targeted Perplexity news search for an LP firm, then uses Claude Haiku
 * to extract structured article cards (headline, summary, date, category, url).
 * Lightweight and fast — no DB caching, intended for on-demand use.
 */
async function fetchRecentPress(company, personName) {
  if (!Anthropic) throw new Error('Anthropic SDK not available');
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');

  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  if (!perplexityKey) throw new Error('PERPLEXITY_API_KEY not set');

  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  // Step 1: Perplexity — real-time web search with citation URLs
  const perplexityRes = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${perplexityKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are a financial research assistant. Return only factual, sourced news items. Be concise.',
        },
        {
          role: 'user',
          content: `Search for the most recent news and announcements about the investment firm "${company}" (${prevYear}–${currentYear}).

Cover all of the following:
1. New fund raises, fund closes, or capital commitments
2. New partners, managing directors, or key hires who joined the firm
3. Notable portfolio company investments, exits, or announcements they were involved in
4. Any press coverage, awards, or notable business developments
${personName ? `5. Any personal news or commentary from ${personName} (interviews, quotes, events)` : ''}

For each news item provide the headline, a brief description, and the approximate date. Cite your sources.`,
        },
      ],
      max_tokens: 1400,
      temperature: 0.1,
      return_citations: true,
    }),
  });

  if (!perplexityRes.ok) {
    const errText = await perplexityRes.text();
    throw new Error(`Perplexity API error ${perplexityRes.status}: ${errText.slice(0, 200)}`);
  }

  const perplexityData = await perplexityRes.json();
  const newsContent = perplexityData.choices?.[0]?.message?.content || '';
  const citations = perplexityData.citations || [];

  if (!newsContent || newsContent.length < 50) return [];

  // Step 2: Claude Haiku — extract structured article cards from the narrative
  const client = new Anthropic({ apiKey: anthropicKey });

  const structurePrompt = `Extract structured news items from the following research result about "${company}".

RESEARCH RESULT:
${newsContent}

CITATION URLS (in order as [1], [2], … in the text above):
${citations.length > 0 ? citations.map((url, i) => `[${i + 1}] ${url}`).join('\n') : 'None available'}

Return a JSON array of up to 6 distinct, factual news items. For each item find the most relevant citation URL.

Required format — return ONLY valid JSON, no markdown:
[
  {
    "headline": "Concise 8-12 word headline",
    "summary": "One sentence factual summary of the event.",
    "date": "e.g. 'June 2025' or 'Q1 2026' or null if unknown",
    "category": "fundraising | team | portfolio | press",
    "url": "best matching URL from citations or null",
    "source_name": "Publication name e.g. TechCrunch, Bloomberg, Axios, PR Newswire or null"
  }
]

If there are no credible recent news items, return [].`;

  const haikuResponse = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: structurePrompt }],
  });

  const rawText = haikuResponse.content[0]?.text || '[]';

  try {
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('[fetchRecentPress] Failed to parse Haiku response:', rawText.slice(0, 200));
    return [];
  }
}

module.exports = { researchLP, fetchRecentPress };
