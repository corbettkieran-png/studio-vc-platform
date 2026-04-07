// Deck analysis service — extracts text from uploaded deck (PDF) and
// calls Claude to produce a structured investment memo.
//
// Runs asynchronously after submission insert — failures are swallowed
// into the deck_analysis_error column so the submission itself never breaks.

const fs = require('fs');
const path = require('path');
const db = require('../config/db');

let Anthropic;
let pdfParse;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch (e) {
  console.warn('[deckAnalysis] @anthropic-ai/sdk not installed — analysis disabled');
}
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  console.warn('[deckAnalysis] pdf-parse not installed — PDF extraction disabled');
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TEXT_CHARS = 60000;

function getClient() {
  if (!Anthropic) return null;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.warn('[deckAnalysis] ANTHROPIC_API_KEY not set');
    return null;
  }
  return new Anthropic({ apiKey: key });
}

async function extractDeckText(deckPath) {
  if (!deckPath) return '';
  const ext = path.extname(deckPath).toLowerCase();
  if (ext !== '.pdf') {
    // For PPTX/KEY we'd need additional parsers — skip for v1
    return '';
  }
  if (!pdfParse) return '';
  try {
    const buf = fs.readFileSync(deckPath);
    const parsed = await pdfParse(buf);
    return (parsed.text || '').slice(0, MAX_TEXT_CHARS);
  } catch (e) {
    console.error('[deckAnalysis] PDF extract failed:', e.message);
    return '';
  }
}

const SYSTEM_PROMPT = `You are an experienced seed-stage venture capital analyst at Studio VC, a firm investing in fintech, B2B SaaS, and enterprise AI companies at the seed stage. You review founder decks and produce crisp, structured investment memos.

Your memo style is:
- Direct and concise — no fluff, no flattery
- Evidence-based — cite specifics from the deck rather than generic platitudes
- Balanced — surface real risks alongside strengths
- Action-oriented — end with a clear recommendation and concrete diligence questions

You respond with valid JSON only, no markdown, no preamble.`;

function buildUserPrompt(submission, deckText) {
  const formFields = {
    company_name: submission.company_name,
    one_liner: submission.one_liner,
    website: submission.website,
    sector: submission.sector,
    stage: submission.stage,
    arr: submission.arr,
    mrr: submission.mrr,
    yoy_growth: submission.yoy_growth,
    fundraising_amount: submission.fundraising_amount,
    founder_name: submission.founder_name,
    founder_linkedin: submission.founder_linkedin,
  };

  return `Analyze this seed-stage deck submission and produce a structured investment memo.

FORM SUBMISSION DATA:
${JSON.stringify(formFields, null, 2)}

EXTRACTED DECK TEXT:
${deckText ? deckText : '(No deck text available — base analysis on form data only and note the limitation.)'}

Return a JSON object with exactly this shape:
{
  "summary": "2-3 sentence plain-English description of what the company does",
  "problem": "The problem they are solving (1-2 sentences)",
  "solution": "Their approach (1-2 sentences)",
  "market": "TAM / market framing as found in the deck (1-2 sentences, or 'Not disclosed')",
  "business_model": "How they make money (1 sentence)",
  "traction": {
    "arr": "value or 'Not disclosed'",
    "mrr": "value or 'Not disclosed'",
    "growth": "value or 'Not disclosed'",
    "customers": "named customers or count if mentioned, else 'Not disclosed'",
    "other": "any other notable metrics"
  },
  "team": "1-2 sentences on founders and relevant experience",
  "competitors": ["competitor1", "competitor2"],
  "differentiation": "Their claimed moat or wedge (1-2 sentences)",
  "ask": "Round size, use of funds, valuation if mentioned",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "risks": ["risk 1", "risk 2", "risk 3"],
  "diligence_questions": ["question 1", "question 2", "question 3", "question 4", "question 5"],
  "recommendation": "pass | explore | strong_interest",
  "recommendation_rationale": "2-3 sentences justifying the recommendation against Studio VC's thesis (seed, fintech/B2B SaaS/enterprise AI, $250K+ ARR preferred, 100%+ YoY growth preferred)",
  "confidence": "low | medium | high",
  "confidence_rationale": "Why this confidence level — call out missing info"
}

Be honest and rigorous. If the deck is thin, say so. If numbers don't add up, flag it.`;
}

async function analyzeSubmission(submissionId) {
  const client = getClient();
  if (!client) {
    await db.query(
      `UPDATE submissions SET deck_analysis_status = 'skipped', deck_analysis_error = $1 WHERE id = $2`,
      ['Claude SDK or API key not configured', submissionId]
    );
    return { ok: false, reason: 'not_configured' };
  }

  try {
    await db.query(
      `UPDATE submissions SET deck_analysis_status = 'running', deck_analysis_error = NULL WHERE id = $1`,
      [submissionId]
    );

    const { rows } = await db.query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
    if (!rows.length) throw new Error('Submission not found');
    const submission = rows[0];

    const deckText = await extractDeckText(submission.deck_path);

    const userPrompt = buildUserPrompt(submission, deckText);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    // Strip code fences if present
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let analysis;
    try {
      analysis = JSON.parse(cleaned);
    } catch (e) {
      // Try to locate first JSON object
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Model did not return parseable JSON');
      analysis = JSON.parse(match[0]);
    }

    analysis._meta = {
      model: MODEL,
      deck_text_chars: deckText.length,
      had_deck_text: deckText.length > 0,
      analyzed_at: new Date().toISOString(),
    };

    await db.query(
      `UPDATE submissions
       SET deck_analysis = $1,
           deck_analysis_status = 'complete',
           deck_analysis_error = NULL,
           deck_analyzed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(analysis), submissionId]
    );

    await db.query(
      `INSERT INTO activity_log (submission_id, action, details)
       VALUES ($1, 'deck_analyzed', $2)`,
      [submissionId, JSON.stringify({
        recommendation: analysis.recommendation,
        confidence: analysis.confidence,
        model: MODEL,
      })]
    );

    return { ok: true, analysis };
  } catch (err) {
    console.error('[deckAnalysis] failed:', err);
    await db.query(
      `UPDATE submissions
       SET deck_analysis_status = 'failed', deck_analysis_error = $1
       WHERE id = $2`,
      [err.message?.slice(0, 500) || 'Unknown error', submissionId]
    );
    return { ok: false, reason: 'error', error: err.message };
  }
}

module.exports = { analyzeSubmission };
