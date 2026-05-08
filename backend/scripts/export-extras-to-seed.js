/**
 * export-extras-to-seed.js
 *
 * Finds LP records in the DB that aren't in lp_seed.json (matched by company),
 * cleans their names/data, and appends them to the seed file.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/export-extras-to-seed.js
 *
 * Find your DATABASE_URL in Railway → studio-vc-backend → Variables.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  console.error('Get it from Railway → your backend service → Variables tab.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SEED_PATH = path.join(__dirname, '../src/data/lp_seed.json');

// ── Name cleaning (mirrors cleanAllLPNames logic) ─────────────────────────
function cleanName(raw) {
  if (!raw) return raw;
  let n = raw;

  // Remove [+N] tags
  n = n.replace(/\[\+\d+\]/g, '').trim();

  // Strip leading country prefix: "United States John Smith" → "John Smith"
  const countryPrefixes = [
    'United States', 'United Kingdom', 'Canada', 'Australia',
    'Germany', 'France', 'Netherlands', 'Switzerland', 'Singapore',
    'Hong Kong', 'Japan', 'China', 'India', 'Brazil', 'Sweden',
    'Norway', 'Denmark', 'Finland', 'Israel', 'UAE', 'South Korea',
    'New Zealand', 'Belgium', 'Austria', 'Italy', 'Spain',
  ];
  for (const cp of countryPrefixes) {
    const re = new RegExp(`^${cp}\\s+`, 'i');
    n = n.replace(re, '');
  }

  // Strip trailing title suffixes
  const titleSuffixes = [
    /,?\s*(Managing Director|MD|Chief Executive Officer|CEO|Chief Investment Officer|CIO|Chief Operating Officer|COO|Chief Financial Officer|CFO|President|Partner|Senior Partner|Managing Partner|General Partner|Executive Director|Executive Vice President|EVP|Senior Vice President|SVP|Vice President|VP|Director|Principal|Associate|Analyst|Manager|Senior Manager|Portfolio Manager|Investment Manager|Fund Manager|Head of|Founder|Co-Founder|Chairman|Trustee|Board Member)\s*$/i,
    /,?\s*(Venture Capital|Private Equity|Hedge Fund|Family Office|Endowment|Foundation|Pension Fund|Sovereign Wealth Fund|Asset Manager|Wealth Manager)\s*$/i,
    /\s+I{2,3}$/, // trailing III, II
  ];
  for (const sfx of titleSuffixes) {
    n = n.replace(sfx, '').trim();
  }

  // Trim punctuation
  n = n.replace(/^[,.\s]+|[,.\s]+$/g, '').trim();

  // Normalize multiple spaces
  n = n.replace(/\s{2,}/g, ' ');

  return n || raw;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const seedCompanies = new Set(seed.map(r => (r.company || '').toLowerCase().trim()));

  console.log(`Seed has ${seed.length} records.`);

  const { rows } = await pool.query(
    `SELECT full_name, email, company, fund_type, sector_interest, geographic_focus, outreach_status
     FROM lp_targets
     ORDER BY company, full_name`
  );

  const extras = rows.filter(r => !seedCompanies.has((r.company || '').toLowerCase().trim()));
  console.log(`Found ${extras.length} DB records not in seed.`);

  // Clean and deduplicate by company+name
  const seen = new Set();
  const cleaned = [];
  for (const r of extras) {
    const key = `${(r.company || '').toLowerCase().trim()}|${(r.full_name || '').toLowerCase().trim()}`;
    if (seen.has(key)) {
      console.log(`  SKIP duplicate: ${r.full_name} @ ${r.company}`);
      continue;
    }
    seen.add(key);

    // Skip clearly bad records
    if (!r.full_name || r.full_name.trim() === '' ||
        r.full_name === 'No contact name' || r.full_name === 'Unnamed') {
      console.log(`  SKIP bad name: "${r.full_name}" @ ${r.company}`);
      continue;
    }

    cleaned.push({
      company: r.company,
      fund_type: r.fund_type || null,
      geographic_focus: r.geographic_focus || null,
      sector_interest: r.sector_interest || null,
      full_name: cleanName(r.full_name),
      email: r.email || null,
      outreach_status: r.outreach_status || 'not_started',
      source: 'csv_import',
    });
  }

  console.log(`\n${cleaned.length} clean records to append.`);

  // Show a preview
  console.log('\nFirst 5:');
  cleaned.slice(0, 5).forEach(r => console.log(`  ${r.full_name} — ${r.company}`));

  // Write updated seed
  const updated = [...seed, ...cleaned];
  fs.writeFileSync(SEED_PATH, JSON.stringify(updated, null, 2));
  console.log(`\n✓ lp_seed.json updated: ${seed.length} → ${updated.length} records.`);
  console.log('  Review the changes, then git add/commit as normal.');

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
