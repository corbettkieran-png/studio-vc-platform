const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const apollo = require('../services/apollo');

const router = express.Router();

// Configure multer for CSV uploads
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'text/csv' && !file.originalname.endsWith('.csv')) {
      return cb(new Error('Only CSV files are allowed'));
    }
    cb(null, true);
  },
});

// ============================================================
// Helper: Parse CSV
// ============================================================
function parseCSV(csvContent) {
  // Strip BOM (LinkedIn CSVs use UTF-8 BOM)
  const cleaned = csvContent.replace(/^\uFEFF/, '');
  const lines = cleaned.trim().split('\n');
  if (lines.length === 0) return [];

  // Find the actual header row — LinkedIn CSVs sometimes have metadata lines at the top.
  // Look for a line that contains known CSV header keywords.
  const headerKeywords = ['first name', 'last name', 'email', 'company', 'name', 'position', 'title', 'connected', 'organization', 'full_name'];
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const lineLower = lines[i].toLowerCase();
    const matches = headerKeywords.filter(kw => lineLower.includes(kw));
    if (matches.length >= 2) {
      headerIdx = i;
      break;
    }
  }

  const headerRow = lines[headerIdx];
  const headers = headerRow.split(',').map(h => h.trim().replace(/^"|"$/g, '').replace(/^\uFEFF/, '').toLowerCase());
  console.log(`parseCSV: header row index=${headerIdx}, headers=[${headers.join(', ')}]`);

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Simple CSV parser: handle quoted fields and commas
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current.trim().replace(/^"|"$/g, ''));

    // Build row object
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = fields[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

// ============================================================
// Helper: Compute LP Fit Score
// ============================================================
function computeFitScore(lp) {
  let score = 0;

  // Fund type (30 pts max)
  const fundTypeScores = {
    fund_of_funds: 30,
    endowment: 30,
    pension: 20,
    family_office: 25,
    hni: 15,
    corporate: 10,
  };
  score += fundTypeScores[lp.fund_type] || 0;

  // AUM (25 pts max)
  const aumScores = {
    over_1b: 25,
    '250m_1b': 20,
    '50m_250m': 15,
    under_50m: 5,
  };
  score += aumScores[lp.estimated_aum] || 0;

  // Check size (25 pts max)
  const checkSizeScores = {
    over_5m: 25,
    '2m_5m': 20,
    '500k_2m': 15,
    under_500k: 5,
  };
  score += checkSizeScores[lp.typical_check_size] || 0;

  // Sector interest (20 pts max)
  const fundThesis = ['fintech', 'b2b_saas', 'enterprise_ai'];
  const lpSectors = lp.sector_interest || [];
  const overlap = fundThesis.some(sector => lpSectors.includes(sector));
  if (overlap) {
    score += 20;
  }

  return Math.min(score, 100);
}

// ============================================================
// Helper: Fuzzy match name
// ============================================================
function fuzzyMatchName(targetName, candidateName) {
  const target = targetName.toLowerCase().trim();
  const candidate = candidateName.toLowerCase().trim();

  if (target === candidate) return 100;
  if (target.includes(candidate) || candidate.includes(target)) return 85;

  // Check if words overlap
  const targetWords = target.split(/\s+/);
  const candidateWords = candidate.split(/\s+/);
  const commonWords = targetWords.filter(w => candidateWords.includes(w));
  if (commonWords.length > 0) {
    return Math.min(70 + commonWords.length * 5, 90);
  }

  return 0;
}

// ============================================================
// Helper: Fuzzy company name matching
// ============================================================
function fuzzyMatchCompany(companyA, companyB) {
  if (!companyA || !companyB) return 0;
  const a = companyA.toLowerCase().trim().replace(/[,.\-()]/g, ' ').replace(/\s+/g, ' ');
  const b = companyB.toLowerCase().trim().replace(/[,.\-()]/g, ' ').replace(/\s+/g, ' ');

  if (a === b) return 100;

  // Strip common suffixes for comparison
  const suffixes = /\b(inc|llc|llp|lp|ltd|corp|co|group|partners|capital|management|mgmt|advisors|advisory|fund|funds|ventures|investments|holdings|foundation|assoc|association)\b/g;
  const aNorm = a.replace(suffixes, '').trim().replace(/\s+/g, ' ');
  const bNorm = b.replace(suffixes, '').trim().replace(/\s+/g, ' ');

  if (aNorm === bNorm && aNorm.length > 2) return 95;
  if (aNorm.includes(bNorm) && bNorm.length > 3) return 85;
  if (bNorm.includes(aNorm) && aNorm.length > 3) return 85;

  // Word overlap
  const aWords = aNorm.split(/\s+/).filter(w => w.length > 2);
  const bWords = bNorm.split(/\s+/).filter(w => w.length > 2);
  if (aWords.length === 0 || bWords.length === 0) return 0;
  const common = aWords.filter(w => bWords.includes(w));
  const overlapRatio = common.length / Math.max(aWords.length, bWords.length);
  if (overlapRatio >= 0.5 && common.length >= 1) return Math.round(60 + overlapRatio * 30);

  return 0;
}

// ============================================================
// Helper: Run matching algorithm
// ============================================================
async function runMatching() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Clear existing matches
    await client.query('DELETE FROM lp_connection_matches');

    // Get all LP targets and LinkedIn connections
    const lpResults = await client.query('SELECT * FROM lp_targets');
    const connResults = await client.query('SELECT * FROM linkedin_connections');
    const tmResults = await client.query('SELECT * FROM team_members');

    const lpTargets = lpResults.rows;
    const connections = connResults.rows;
    const teamMembers = tmResults.rows;

    const teamMemberMap = {};
    teamMembers.forEach(tm => {
      teamMemberMap[tm.id] = tm;
    });

    // Pre-index connections by normalized company for fast lookup
    const connsByCompany = {};
    for (const conn of connections) {
      if (conn.company) {
        const key = conn.company.toLowerCase().trim();
        if (!connsByCompany[key]) connsByCompany[key] = [];
        connsByCompany[key].push(conn);
      }
    }

    for (const lp of lpTargets) {
      // Each match key = `${team_member_id}:${match_type}` to allow multiple match types per team member
      const lpMatches = {};

      const addMatch = (tmId, type, confidence, connectionId) => {
        const key = `${tmId}:${type}`;
        if (!lpMatches[key] || lpMatches[key].confidence < confidence) {
          lpMatches[key] = { tmId, type, confidence, connectionId };
        }
      };

      // ── Layer 1: Direct matches (name + email) ──
      // The LP target IS one of your LinkedIn connections
      for (const conn of connections) {
        // Direct name match
        const nameScore = fuzzyMatchName(lp.full_name, conn.full_name);
        if (nameScore >= 70) {
          addMatch(conn.team_member_id, 'direct_name', nameScore, conn.id);
        }
      }

      // Direct email match
      if (lp.email) {
        for (const conn of connections) {
          if (conn.email && conn.email.toLowerCase() === lp.email.toLowerCase()) {
            addMatch(conn.team_member_id, 'direct_email', 100, conn.id);
          }
        }
      }

      // ── Layer 2: Same company (colleague match) ──
      // Your LinkedIn connection works at the same company as the LP target.
      // They're not the LP target themselves, but they could intro you.
      if (lp.company) {
        for (const conn of connections) {
          if (!conn.company) continue;
          const compScore = fuzzyMatchCompany(lp.company, conn.company);
          if (compScore >= 75) {
            // Exclude if this connection already matched as a direct match
            const directKey = `${conn.team_member_id}:direct_name`;
            const directEmailKey = `${conn.team_member_id}:direct_email`;
            if (!lpMatches[directKey] && !lpMatches[directEmailKey]) {
              // Confidence: 40-65 depending on company match quality
              const confidence = Math.round(30 + (compScore / 100) * 35);
              addMatch(conn.team_member_id, 'same_company', confidence, conn.id);
            }
          }
        }
      }

      // ── Layer 3: LP name matches a company ──
      // The LP target's full_name field is actually a firm name (e.g., "Sequoia Heritage")
      // and your LinkedIn connection works at that firm.
      // Check if lp.full_name looks like it could be a company name
      // (heuristic: if it doesn't have a typical first+last pattern, or matches a connection's company)
      for (const conn of connections) {
        if (!conn.company) continue;
        const nameAsCompanyScore = fuzzyMatchCompany(lp.full_name, conn.company);
        if (nameAsCompanyScore >= 75) {
          const confidence = Math.round(25 + (nameAsCompanyScore / 100) * 35);
          addMatch(conn.team_member_id, 'lp_is_company', confidence, conn.id);
        }
      }

      // Insert all matches into DB
      for (const match of Object.values(lpMatches)) {
        await client.query(
          `INSERT INTO lp_connection_matches
           (lp_target_id, team_member_id, linkedin_connection_id, match_type, match_confidence)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (lp_target_id, team_member_id, match_type) DO UPDATE
           SET match_confidence = EXCLUDED.match_confidence`,
          [lp.id, match.tmId, match.connectionId || null, match.type, match.confidence]
        );
      }

      // Determine best connector (prioritize direct > same_company > lp_is_company)
      const bestMatchResult = await client.query(
        `SELECT team_member_id, match_type, match_confidence
         FROM lp_connection_matches
         WHERE lp_target_id = $1
         ORDER BY match_confidence DESC
         LIMIT 1`,
        [lp.id]
      );

      let bestConnectorId = null;
      let connectionStrength = 'none';

      if (bestMatchResult.rows.length > 0) {
        bestConnectorId = bestMatchResult.rows[0].team_member_id;
        const matchType = bestMatchResult.rows[0].match_type;

        if (matchType === 'direct_email' || matchType === 'direct_name') {
          connectionStrength = 'direct';
        } else if (matchType === 'same_company') {
          connectionStrength = 'company_match';
        } else if (matchType === 'lp_is_company') {
          connectionStrength = 'company_match';
        } else {
          connectionStrength = 'mutual';
        }
      }

      // Count total unique connectors for this LP (across all match types)
      const countResult = await client.query(
        'SELECT COUNT(DISTINCT team_member_id) as count FROM lp_connection_matches WHERE lp_target_id = $1',
        [lp.id]
      );
      const totalConnectors = parseInt(countResult.rows[0].count) || 0;

      // Update LP target with best connector info
      if (bestConnectorId) {
        const tm = teamMemberMap[bestConnectorId];
        await client.query(
          `UPDATE lp_targets
           SET best_connector_id = $1, best_connector_name = $2, connection_strength = $3, total_connectors = $4, updated_at = NOW()
           WHERE id = $5`,
          [bestConnectorId, tm ? tm.full_name : null, connectionStrength, totalConnectors, lp.id]
        );
      } else {
        await client.query(
          `UPDATE lp_targets
           SET best_connector_id = NULL, best_connector_name = NULL, connection_strength = 'none', total_connectors = 0, updated_at = NOW()
           WHERE id = $1`,
          [lp.id]
        );
      }
    }

    await client.query('COMMIT');

    // Return stats
    const statsResult = await client.query(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN best_connector_id IS NOT NULL THEN 1 END) as with_matches,
              COUNT(CASE WHEN connection_strength = 'direct' THEN 1 END) as direct_matches,
              COUNT(CASE WHEN connection_strength = 'company_match' THEN 1 END) as company_matches
       FROM lp_targets`
    );
    const s = statsResult.rows[0];
    return {
      targets_processed: parseInt(s.total) || 0,
      matches_found: parseInt(s.with_matches) || 0,
      direct_matches: parseInt(s.direct_matches) || 0,
      company_matches: parseInt(s.company_matches) || 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================
// TEAM MEMBERS
// ============================================================

// GET /api/lp/team - List team members
router.get('/team', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, linkedin_url, connections_count, last_upload_at, created_at
       FROM team_members
       ORDER BY created_at DESC`
    );
    res.json({ team_members: rows });
  } catch (err) {
    console.error('Error fetching team members:', err);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// POST /api/lp/team - Add team member
router.post('/team', authenticate, async (req, res) => {
  try {
    const { full_name, linkedin_url } = req.body;

    if (!full_name) {
      return res.status(400).json({ error: 'full_name is required' });
    }

    const tmId = uuid();
    await db.query(
      `INSERT INTO team_members (id, user_id, full_name, linkedin_url)
       VALUES ($1, $2, $3, $4)`,
      [tmId, req.user.id, full_name, linkedin_url || null]
    );

    const { rows } = await db.query('SELECT * FROM team_members WHERE id = $1', [tmId]);
    res.status(201).json({ team_member: rows[0] });
  } catch (err) {
    console.error('Error creating team member:', err);
    res.status(500).json({ error: 'Failed to create team member' });
  }
});

// DELETE /api/lp/team/:id - Remove team member
router.delete('/team/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await db.query('SELECT id FROM team_members WHERE id = $1', [id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    await db.query('DELETE FROM team_members WHERE id = $1', [id]);
    res.json({ message: 'Team member deleted' });
  } catch (err) {
    console.error('Error deleting team member:', err);
    res.status(500).json({ error: 'Failed to delete team member' });
  }
});

// ============================================================
// LINKEDIN CSV UPLOAD
// ============================================================

// POST /api/lp/team/:id/connections - Upload LinkedIn CSV
router.post('/team/:id/connections', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    // Check team member exists
    const { rows: tmRows } = await db.query('SELECT id FROM team_members WHERE id = $1', [id]);
    if (!tmRows.length) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    // Parse CSV
    const csvContent = req.file.buffer.toString('utf-8');
    const parsedRows = parseCSV(csvContent);

    console.log(`LinkedIn CSV: ${parsedRows.length} rows parsed. Headers detected: ${parsedRows.length > 0 ? Object.keys(parsedRows[0]).join(', ') : 'none'}`);

    // Flexible column finder (same as LP import)
    function findConnCol(row, ...candidates) {
      for (const key of candidates) {
        if (row[key] && row[key].trim()) return row[key].trim();
      }
      const rowKeys = Object.keys(row);
      for (const key of candidates) {
        const match = rowKeys.find(k => k.includes(key));
        if (match && row[match] && row[match].trim()) return row[match].trim();
      }
      return '';
    }

    // Map CSV columns to database fields
    const normalizedRows = parsedRows.map(row => {
      const firstName = findConnCol(row, 'first name', 'firstname', 'first_name', 'first');
      const lastName = findConnCol(row, 'last name', 'lastname', 'last_name', 'last');
      const fullName = `${firstName} ${lastName}`.trim();

      return {
        first_name: firstName,
        last_name: lastName,
        full_name: fullName || findConnCol(row, 'name', 'full name', 'full_name'),
        email: findConnCol(row, 'email address', 'email', 'email_address'),
        company: findConnCol(row, 'company', 'organization', 'employer'),
        position: findConnCol(row, 'position', 'title', 'job title', 'job_title'),
        connected_on: findConnCol(row, 'connected on', 'date connected', 'connected_on', 'connection date') || null,
      };
    });

    const validRows = normalizedRows.filter(r => r.full_name);
    console.log(`LinkedIn CSV: ${validRows.length} valid rows with names (out of ${normalizedRows.length} total). Sample: ${validRows.length > 0 ? JSON.stringify(validRows[0]) : 'none'}`);

    if (validRows.length === 0) {
      return res.status(400).json({
        error: 'No valid connections found in CSV. Detected headers: ' + (parsedRows.length > 0 ? Object.keys(parsedRows[0]).join(', ') : 'none')
      });
    }

    // Insert connections
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete old connections for this team member
      await client.query('DELETE FROM linkedin_connections WHERE team_member_id = $1', [id]);

      for (const row of validRows) {
        if (row.full_name) {
          // Parse date if provided
          let connectedDate = null;
          if (row.connected_on) {
            const parsed = new Date(row.connected_on);
            if (!isNaN(parsed.getTime())) {
              connectedDate = parsed.toISOString().split('T')[0];
            }
          }

          await client.query(
            `INSERT INTO linkedin_connections
             (id, team_member_id, first_name, last_name, full_name, email, company, position, connected_on)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              uuid(),
              id,
              row.first_name,
              row.last_name,
              row.full_name,
              row.email || null,
              row.company || null,
              row.position || null,
              connectedDate,
            ]
          );
        }
      }

      // Update team member
      await client.query(
        `UPDATE team_members
         SET connections_count = $1, last_upload_at = NOW()
         WHERE id = $2`,
        [validRows.length, id]
      );

      await client.query('COMMIT');
      console.log(`LinkedIn CSV: Successfully inserted ${validRows.length} connections for team member ${id}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Trigger matching algorithm
    await runMatching();

    res.json({ message: 'Connections imported successfully', count: validRows.length });
  } catch (err) {
    console.error('Error uploading connections:', err);
    res.status(500).json({ error: 'Failed to upload connections' });
  }
});

// ============================================================
// LP TARGET IMPORT
// ============================================================

// POST /api/lp/targets/import - Import LP list CSV
router.post('/targets/import', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    // Parse CSV
    const csvContent = req.file.buffer.toString('utf-8');
    const parsedRows = parseCSV(csvContent);

    // Helper: find a value by trying multiple possible column names
    function findCol(row, ...candidates) {
      for (const key of candidates) {
        if (row[key] && row[key].trim()) return row[key].trim();
      }
      // Also try fuzzy: check if any row key contains the candidate
      const rowKeys = Object.keys(row);
      for (const key of candidates) {
        const match = rowKeys.find(k => k.includes(key));
        if (match && row[match] && row[match].trim()) return row[match].trim();
      }
      return '';
    }

    // Normalize and validate rows
    const normalizedRows = parsedRows.map(row => {
      // Build full name from first+last if no single name field
      let fullName = findCol(row, 'name', 'full name', 'full_name', 'contact name', 'contact_name', 'lp name', 'lp_name');
      if (!fullName) {
        const first = findCol(row, 'first name', 'first_name', 'first');
        const last = findCol(row, 'last name', 'last_name', 'last');
        if (first || last) fullName = [first, last].filter(Boolean).join(' ');
      }

      // Parse sector_interest as comma-separated values
      let sectorInterest = [];
      const sectorRaw = findCol(row, 'sector interest', 'sector_interest', 'sector', 'sectors', 'interest', 'focus area', 'focus_area');
      if (sectorRaw) {
        sectorInterest = sectorRaw.split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(s => s);
      }

      return {
        full_name: fullName,
        email: findCol(row, 'email', 'email address', 'email_address', 'e-mail'),
        company: findCol(row, 'company', 'company name', 'company_name', 'organization', 'firm', 'firm name', 'firm_name'),
        title: findCol(row, 'title', 'job title', 'job_title', 'position', 'role'),
        phone: findCol(row, 'phone', 'phone number', 'phone_number', 'mobile', 'telephone'),
        linkedin_url: findCol(row, 'linkedin', 'linkedin_url', 'linkedin url', 'linkedin profile'),
        fund_type: findCol(row, 'fund type', 'fund_type', 'type', 'investor type', 'investor_type', 'lp type', 'lp_type'),
        estimated_aum: findCol(row, 'estimated aum', 'estimated_aum', 'aum', 'assets under management'),
        typical_check_size: findCol(row, 'typical check size', 'typical_check_size', 'check size', 'check_size', 'commitment size', 'ticket size'),
        sector_interest: sectorInterest,
        geographic_focus: findCol(row, 'geographic focus', 'geographic_focus', 'geography', 'geo', 'region', 'location'),
      };
    });

    // Truncate helper to prevent DB overflow
    const trunc = (str, max = 490) => str && str.length > max ? str.substring(0, max) : str;

    // Filter out empty names
    const validRows = normalizedRows
      .filter(r => r.full_name)
      .map(r => ({
        ...r,
        full_name: trunc(r.full_name),
        email: trunc(r.email),
        company: trunc(r.company, 1000),
        title: trunc(r.title, 1000),
        phone: trunc(r.phone, 250),
        linkedin_url: trunc(r.linkedin_url, 1000),
        fund_type: trunc(r.fund_type),
        estimated_aum: trunc(r.estimated_aum),
        typical_check_size: trunc(r.typical_check_size),
        geographic_focus: trunc(r.geographic_focus, 1000),
      }));

    if (validRows.length === 0) {
      const sampleHeaders = parsedRows.length > 0 ? Object.keys(parsedRows[0]).join(', ') : 'none';
      return res.status(400).json({
        error: `No valid LP records found in CSV. Could not find a name column. Your CSV headers: [${sampleHeaders}]. Expected one of: name, full name, first name + last name, contact name, lp name.`,
      });
    }

    // Insert LP targets
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const insertedIds = [];
      for (const row of validRows) {
        // Compute fit score
        const fitScore = computeFitScore(row);

        const lpId = uuid();
        await client.query(
          `INSERT INTO lp_targets
           (id, full_name, email, company, title, phone, linkedin_url, fund_type,
            estimated_aum, typical_check_size, sector_interest, geographic_focus, fit_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            lpId,
            row.full_name,
            row.email || null,
            row.company || null,
            row.title || null,
            row.phone || null,
            row.linkedin_url || null,
            row.fund_type || null,
            row.estimated_aum || null,
            row.typical_check_size || null,
            row.sector_interest.length > 0 ? row.sector_interest : null,
            row.geographic_focus || null,
            fitScore,
          ]
        );
        insertedIds.push(lpId);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Trigger matching algorithm
    await runMatching();

    res.json({ message: 'LP targets imported successfully', count: validRows.length });
  } catch (err) {
    console.error('Error importing LP targets:', err);
    res.status(500).json({ error: 'Failed to import LP targets' });
  }
});

// ============================================================
// LP TARGETS CRUD
// ============================================================

// GET /api/lp/targets - List LP targets with filtering
router.get('/targets', authenticate, async (req, res) => {
  try {
    const {
      status,
      min_score,
      has_connector,
      search,
      sort_by = 'fit_score',
      page = 1,
      limit = 2000,
    } = req.query;

    let query = `
      SELECT t.*,
        COALESCE(
          (SELECT json_agg(json_build_object('id', mc.id, 'name', mc.name, 'relationship', mc.relationship, 'linkedin_url', mc.linkedin_url) ORDER BY mc.created_at DESC)
           FROM lp_manual_connections mc WHERE mc.lp_target_id = t.id),
          '[]'::json
        ) as manual_connections,
        COALESCE(
          (SELECT json_agg(json_build_object(
              'connection_id', lc.id,
              'connection_name', lc.full_name,
              'connection_position', lc.position,
              'team_member_id', tm.id,
              'team_member_name', tm.full_name
           ) ORDER BY lc.full_name)
           FROM linkedin_connections lc
           JOIN team_members tm ON tm.id = lc.team_member_id
           WHERE LOWER(TRIM(lc.company)) = LOWER(TRIM(t.company))
              OR LOWER(TRIM(lc.company)) LIKE '%' || LOWER(TRIM(t.company)) || '%'
          ),
          '[]'::json
        ) as linkedin_matches
      FROM lp_targets t WHERE 1=1`;
    const params = [];

    // Filters
    if (status) {
      query += ' AND t.outreach_status = $' + (params.length + 1);
      params.push(status);
    }

    if (min_score) {
      query += ' AND t.fit_score >= $' + (params.length + 1);
      params.push(parseInt(min_score));
    }

    if (has_connector === 'true') {
      query += ' AND t.best_connector_id IS NOT NULL';
    } else if (has_connector === 'false') {
      query += ' AND t.best_connector_id IS NULL';
    }

    if (search) {
      const searchTerm = `%${search}%`;
      query += ` AND (t.full_name ILIKE $${params.length + 1} OR t.company ILIKE $${params.length + 1} OR t.email ILIKE $${params.length + 1})`;
      params.push(searchTerm);
    }

    // Sorting
    const validSortFields = ['fit_score', 'connection_strength', 'last_outreach_at', 'created_at', 'company', 'last_contacted_at', 'next_followup_at', 'priority'];
    const sortField = validSortFields.includes(sort_by) ? sort_by : 'company';
    const sortDir = (req.query.sort_dir || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    query += ` ORDER BY t.${sortField} ${sortDir} NULLS LAST`;

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);

    const { rows } = await db.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM lp_targets WHERE 1=1';
    const countParams = [];

    if (status) {
      countQuery += ' AND outreach_status = $' + (countParams.length + 1);
      countParams.push(status);
    }
    if (min_score) {
      countQuery += ' AND fit_score >= $' + (countParams.length + 1);
      countParams.push(parseInt(min_score));
    }
    if (has_connector === 'true') {
      countQuery += ' AND best_connector_id IS NOT NULL';
    } else if (has_connector === 'false') {
      countQuery += ' AND best_connector_id IS NULL';
    }
    if (search) {
      const searchTerm = `%${search}%`;
      countQuery += ` AND (full_name ILIKE $${countParams.length + 1} OR company ILIKE $${countParams.length + 1} OR email ILIKE $${countParams.length + 1})`;
      countParams.push(searchTerm);
    }

    const { rows: countRows } = await db.query(countQuery, countParams);
    const total = parseInt(countRows[0].total);

    res.json({
      lp_targets: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('Error fetching LP targets:', err);
    res.status(500).json({ error: 'Failed to fetch LP targets' });
  }
});

// GET /api/lp/targets/:id - Single LP detail with all connectors
router.get('/targets/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: lpRows } = await db.query('SELECT * FROM lp_targets WHERE id = $1', [id]);
    if (!lpRows.length) {
      return res.status(404).json({ error: 'LP target not found' });
    }

    const lp = lpRows[0];

    // Get all connectors for this LP
    const { rows: connectors } = await db.query(
      `SELECT
        tm.id, tm.full_name, lcm.match_type, lcm.match_confidence,
        lcm.linkedin_connection_id
       FROM lp_connection_matches lcm
       JOIN team_members tm ON lcm.team_member_id = tm.id
       WHERE lcm.lp_target_id = $1
       ORDER BY lcm.match_confidence DESC`,
      [id]
    );

    // Get activity log
    const { rows: activity } = await db.query(
      `SELECT id, user_id, action, details, created_at
       FROM lp_activity_log
       WHERE lp_target_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [id]
    );

    // ── Warm Intro Paths (powered by known_contacts + Apollo) ──
    // Find Apollo contacts at this LP's company that a team member has flagged as "I know them"
    let warmIntroPaths = [];
    const { rows: knownAtCompany } = await db.query(
      `SELECT ac.id as contact_id, ac.first_name, ac.last_name, ac.full_name as contact_name,
              ac.title, ac.seniority, ac.email, ac.linkedin_url,
              kc.team_member_id, kc.relationship_note, kc.created_at as flagged_at,
              tm.full_name as team_member_name
       FROM known_contacts kc
       JOIN apollo_company_contacts ac ON kc.apollo_contact_id = ac.id
       JOIN team_members tm ON kc.team_member_id = tm.id
       WHERE ac.lp_target_id = $1
       ORDER BY
         CASE ac.seniority WHEN 'c_suite' THEN 1 WHEN 'vp' THEN 2 WHEN 'director' THEN 3 WHEN 'manager' THEN 4 WHEN 'senior' THEN 5 ELSE 6 END,
         ac.full_name`,
      [id]
    );

    if (knownAtCompany.length > 0) {
      // Group by team member
      const byTeamMember = {};
      for (const row of knownAtCompany) {
        const tmId = row.team_member_id;
        if (!byTeamMember[tmId]) {
          byTeamMember[tmId] = {
            team_member_id: tmId,
            team_member_name: row.team_member_name,
            known_contacts: [],
          };
        }
        byTeamMember[tmId].known_contacts.push({
          id: row.contact_id,
          full_name: row.contact_name || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
          title: row.title,
          seniority: row.seniority,
          email: row.email,
          linkedin_url: row.linkedin_url,
          relationship_note: row.relationship_note,
        });
      }
      warmIntroPaths = Object.values(byTeamMember);
      warmIntroPaths.sort((a, b) => b.known_contacts.length - a.known_contacts.length);
    }

    // ── LinkedIn Enrichment (from People Data Labs) ──
    const { rows: enrichmentRows } = await db.query(
      'SELECT * FROM linkedin_enrichments WHERE lp_target_id = $1 ORDER BY enriched_at DESC LIMIT 1',
      [id]
    );

    // Get manual connections
    const { rows: manualConnections } = await db.query(
      `SELECT id, name, relationship, linkedin_url, added_by, created_at
       FROM lp_manual_connections WHERE lp_target_id = $1 ORDER BY created_at DESC`,
      [id]
    );

    res.json({
      lp_target: lp,
      connectors,
      warm_intro_paths: warmIntroPaths,
      linkedin_enrichment: enrichmentRows[0] || null,
      activity_log: activity,
      manual_connections: manualConnections,
    });
  } catch (err) {
    console.error('Error fetching LP target:', err);
    res.status(500).json({ error: 'Failed to fetch LP target' });
  }
});

// PATCH /api/lp/targets/:id - Update LP
router.patch('/targets/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      outreach_status,
      outreach_owner_id,
      notes,
      fund_type,
      estimated_aum,
      typical_check_size,
      sector_interest,
      geographic_focus,
    } = req.body;

    const { rows } = await db.query('SELECT * FROM lp_targets WHERE id = $1', [id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'LP target not found' });
    }

    const lp = rows[0];

    // Build update query
    const updates = [];
    const params = [];

    if (outreach_status !== undefined) {
      updates.push('outreach_status = $' + (params.length + 1));
      params.push(outreach_status);
      updates.push('last_outreach_at = NOW()');
    }

    if (outreach_owner_id !== undefined) {
      updates.push('outreach_owner_id = $' + (params.length + 1));
      params.push(outreach_owner_id || null);
    }

    if (notes !== undefined) {
      updates.push('notes = $' + (params.length + 1));
      params.push(notes);
    }

    // Fit scoring fields
    let needsRescore = false;
    if (fund_type !== undefined) {
      updates.push('fund_type = $' + (params.length + 1));
      params.push(fund_type || null);
      needsRescore = true;
    }

    if (estimated_aum !== undefined) {
      updates.push('estimated_aum = $' + (params.length + 1));
      params.push(estimated_aum || null);
      needsRescore = true;
    }

    if (typical_check_size !== undefined) {
      updates.push('typical_check_size = $' + (params.length + 1));
      params.push(typical_check_size || null);
      needsRescore = true;
    }

    if (sector_interest !== undefined) {
      updates.push('sector_interest = $' + (params.length + 1));
      params.push(sector_interest || null);
      needsRescore = true;
    }

    if (geographic_focus !== undefined) {
      updates.push('geographic_focus = $' + (params.length + 1));
      params.push(geographic_focus || null);
      needsRescore = true;
    }

    if (req.body.last_contacted_at !== undefined) {
      updates.push('last_contacted_at = $' + (params.length + 1));
      params.push(req.body.last_contacted_at || null);
    }

    if (req.body.next_followup_at !== undefined) {
      updates.push('next_followup_at = $' + (params.length + 1));
      params.push(req.body.next_followup_at || null);
    }

    if (req.body.priority !== undefined) {
      const p = req.body.priority;
      if (['high', 'medium', 'low'].includes(p)) {
        updates.push('priority = $' + (params.length + 1));
        params.push(p);
      }
    }

    // Recompute fit score if needed
    if (needsRescore) {
      const updatedLp = {
        ...lp,
        fund_type: fund_type !== undefined ? fund_type : lp.fund_type,
        estimated_aum: estimated_aum !== undefined ? estimated_aum : lp.estimated_aum,
        typical_check_size: typical_check_size !== undefined ? typical_check_size : lp.typical_check_size,
        sector_interest: sector_interest !== undefined ? sector_interest : lp.sector_interest,
      };
      const fitScore = computeFitScore(updatedLp);
      updates.push('fit_score = $' + (params.length + 1));
      params.push(fitScore);
    }

    updates.push('updated_at = NOW()');
    params.push(id);

    if (updates.length === 1) {
      return res.json({ lp_target: lp });
    }

    const query = `UPDATE lp_targets SET ${updates.join(', ')} WHERE id = $${params.length}`;
    await db.query(query, params);

    const { rows: updatedRows } = await db.query('SELECT * FROM lp_targets WHERE id = $1', [id]);
    res.json({ lp_target: updatedRows[0] });
  } catch (err) {
    console.error('Error updating LP target:', err);
    res.status(500).json({ error: 'Failed to update LP target' });
  }
});

// ============================================================
// INTRO EMAIL GENERATION
// ============================================================

// POST /api/lp/targets/:id/draft-intro  — generate personalised intro email
router.post('/targets/:id/draft-intro', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Load LP details
    const { rows: lpRows } = await db.query('SELECT * FROM lp_targets WHERE id = $1', [id]);
    if (!lpRows.length) return res.status(404).json({ error: 'LP not found' });
    const lp = lpRows[0];

    // Load the logged-in user's full profile
    const { rows: userRows } = await db.query(
      'SELECT full_name, email, role FROM users WHERE id = $1', [req.user.id]
    );
    const sender = userRows[0] || { full_name: 'The Studio VC Team', email: '' };

    // Build a personalised email using what we know
    const fundType = lp.fund_type || 'investment firm';
    const geo = lp.geographic_focus ? ` based in ${lp.geographic_focus}` : '';
    const sectors = Array.isArray(lp.sector_interest) && lp.sector_interest.length
      ? lp.sector_interest.slice(0, 3).join(', ')
      : null;
    const sectorLine = sectors ? ` with a focus on ${sectors}` : '';
    const contactName = lp.full_name ? lp.full_name.split(' ')[0] : null;
    const salutation = contactName ? `Hi ${contactName},` : 'Hi,';
    const connectors = req.body.connector_name
      ? `I was introduced to you by ${req.body.connector_name}.`
      : '';

    const subject = `Introduction — CQ Fund III | Studio VC`;

    const body = `${salutation}

${connectors ? connectors + '\n\n' : ''}I'm ${sender.full_name} from Studio VC. I wanted to reach out as we're currently raising CQ Fund III, our early-stage seed fund focused on B2B software, fintech, and deep tech companies across the US and Europe.

Given ${lp.company}'s profile as a ${fundType}${geo}${sectorLine}, I think there could be a strong fit — many of our LPs share a similar thesis and have found our deal flow and co-investment opportunities compelling.

CQ Fund III highlights:
• Target: $50M fund
• Stage: Pre-seed and seed (initial cheques of $250K–$1M)
• Focus: B2B SaaS, fintech infrastructure, and AI-native applications
• Portfolio: 12 current investments across the US and Europe

I'd love to share our deck and have a brief 20-minute intro call at your convenience.

Best,
${sender.full_name}
Studio VC
${sender.email}`;

    res.json({ subject, body, lp_name: lp.full_name, lp_company: lp.company, sender: sender.full_name });
  } catch (err) {
    console.error('Draft intro error:', err);
    res.status(500).json({ error: 'Failed to generate intro email' });
  }
});

// ============================================================
// ACTIVITY LOGGING
// ============================================================

// POST /api/lp/targets/:id/activity - Log outreach activity
router.post('/targets/:id/activity', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, details } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'action is required' });
    }

    const { rows } = await db.query('SELECT id FROM lp_targets WHERE id = $1', [id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'LP target not found' });
    }

    const activityId = uuid();
    await db.query(
      `INSERT INTO lp_activity_log (id, lp_target_id, user_id, action, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [activityId, id, req.user.id, action, JSON.stringify(details || {})]
    );

    // Auto-update last_contacted_at for contact-type activities
    const contactActions = ['email_sent', 'meeting', 'call', 'intro_sent', 'follow_up', 'email'];
    if (contactActions.some(a => action.toLowerCase().includes(a))) {
      await db.query(
        `UPDATE lp_targets SET last_contacted_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [id]
      );
    }

    const { rows: activity } = await db.query('SELECT * FROM lp_activity_log WHERE id = $1', [
      activityId,
    ]);

    res.status(201).json({ activity: activity[0] });
  } catch (err) {
    console.error('Error logging activity:', err);
    res.status(500).json({ error: 'Failed to log activity' });
  }
});

// ============================================================
// MATCHING & SCORING
// ============================================================

// POST /api/lp/match - Re-run matching algorithm
router.post('/match', authenticate, async (req, res) => {
  try {
    const stats = await runMatching();
    res.json({ message: 'Matching algorithm completed successfully', stats });
  } catch (err) {
    console.error('Error running matching algorithm:', err);
    res.status(500).json({ error: 'Failed to run matching algorithm' });
  }
});

// GET /api/lp/debug-match - Sample data from both tables to diagnose matching
router.get('/debug-match', authenticate, async (req, res) => {
  try {
    const { rows: lpSample } = await db.query(
      'SELECT full_name, company, email FROM lp_targets ORDER BY full_name LIMIT 10'
    );
    const { rows: connSample } = await db.query(
      'SELECT full_name, company, email FROM linkedin_connections ORDER BY full_name LIMIT 10'
    );
    const { rows: lpCount } = await db.query('SELECT COUNT(*) as count FROM lp_targets');
    const { rows: connCount } = await db.query('SELECT COUNT(*) as count FROM linkedin_connections');
    res.json({
      lp_count: parseInt(lpCount[0].count),
      conn_count: parseInt(connCount[0].count),
      lp_sample: lpSample,
      conn_sample: connSample,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DASHBOARD STATS
// ============================================================

// GET /api/lp/stats - Aggregate statistics
router.get('/stats', authenticate, async (req, res) => {
  try {
    // Total LPs
    const { rows: totalRows } = await db.query('SELECT COUNT(*) as count FROM lp_targets');
    const totalLps = parseInt(totalRows[0].count);

    // With connector
    const { rows: withConnRows } = await db.query(
      'SELECT COUNT(*) as count FROM lp_targets WHERE best_connector_id IS NOT NULL'
    );
    const withConnector = parseInt(withConnRows[0].count);
    const withoutConnector = totalLps - withConnector;

    // By status
    const { rows: statusRows } = await db.query(
      `SELECT outreach_status, COUNT(*) as count FROM lp_targets
       GROUP BY outreach_status
       ORDER BY count DESC`
    );
    const byStatus = {};
    statusRows.forEach(row => {
      byStatus[row.outreach_status] = parseInt(row.count);
    });

    // By connection strength
    const { rows: strengthRows } = await db.query(
      `SELECT connection_strength, COUNT(*) as count FROM lp_targets
       WHERE connection_strength IS NOT NULL
       GROUP BY connection_strength
       ORDER BY count DESC`
    );
    const byConnectionStrength = {};
    strengthRows.forEach(row => {
      byConnectionStrength[row.connection_strength] = parseInt(row.count);
    });

    // Average fit score
    const { rows: scoreRows } = await db.query(
      'SELECT AVG(fit_score) as avg_score FROM lp_targets'
    );
    const avgFitScore = scoreRows[0].avg_score ? Math.round(scoreRows[0].avg_score) : 0;

    // Team member connection counts
    const { rows: tmRows } = await db.query(
      `SELECT id, full_name, connections_count FROM team_members
       ORDER BY connections_count DESC`
    );
    const teamMemberConnectionCounts = tmRows.map(tm => ({
      id: tm.id,
      name: tm.full_name,
      connections_count: tm.connections_count,
    }));

    res.json({
      stats: {
        total_lps: totalLps,
        with_connector: withConnector,
        without_connector: withoutConnector,
        by_status: byStatus,
        by_connection_strength: byConnectionStrength,
        avg_fit_score: avgFitScore,
        team_member_connection_counts: teamMemberConnectionCounts,
      },
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================================
// APOLLO INTEGRATION
// ============================================================

// POST /api/lp/apollo/company-contacts - Store Apollo search results for a company
router.post('/apollo/company-contacts', authenticate, async (req, res) => {
  try {
    const { company_name, lp_target_ids, contacts, company_info } = req.body;

    if (!company_name) {
      return res.status(400).json({ error: 'company_name is required' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Upsert company cache
      if (company_info) {
        await client.query(
          `INSERT INTO apollo_company_cache
           (id, company_name, domain, industry, employee_count, revenue_range, apollo_org_id, total_people_found, senior_contacts_found, last_searched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
           ON CONFLICT (company_name) DO UPDATE SET
             domain = EXCLUDED.domain, industry = EXCLUDED.industry,
             employee_count = EXCLUDED.employee_count, revenue_range = EXCLUDED.revenue_range,
             apollo_org_id = EXCLUDED.apollo_org_id, total_people_found = EXCLUDED.total_people_found,
             senior_contacts_found = EXCLUDED.senior_contacts_found, last_searched_at = NOW()`,
          [
            uuid(), company_name, company_info.domain || null,
            company_info.industry || null, company_info.employee_count || null,
            company_info.revenue_range || null, company_info.apollo_org_id || null,
            company_info.total_people_found || 0, company_info.senior_contacts_found || 0,
          ]
        );
      }

      // Insert contacts for each LP target at this company
      let insertedCount = 0;
      const targetIds = lp_target_ids || [];

      for (const contact of (contacts || [])) {
        for (const lpId of targetIds) {
          try {
            await client.query(
              `INSERT INTO apollo_company_contacts
               (id, lp_target_id, company_name, apollo_person_id, first_name, last_name, full_name, title, seniority, linkedin_url, email, city, state, country, match_type)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
               ON CONFLICT (lp_target_id, apollo_person_id) DO UPDATE SET
                 title = EXCLUDED.title, seniority = EXCLUDED.seniority, full_name = EXCLUDED.full_name`,
              [
                uuid(), lpId, company_name, contact.apollo_person_id || uuid(),
                contact.first_name || null, contact.last_name || null,
                contact.full_name || `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
                contact.title || null, contact.seniority || null,
                contact.linkedin_url || null, contact.email || null,
                contact.city || null, contact.state || null, contact.country || null,
                contact.match_type || 'apollo_search',
              ]
            );
            insertedCount++;
          } catch (insertErr) {
            // Skip duplicates silently
          }
        }
      }

      // Update LP targets with apollo match info
      for (const lpId of targetIds) {
        const { rows: countRows } = await client.query(
          'SELECT COUNT(*) as count FROM apollo_company_contacts WHERE lp_target_id = $1',
          [lpId]
        );
        const apolloContacts = parseInt(countRows[0].count) || 0;
        if (apolloContacts > 0) {
          await client.query(
            `UPDATE lp_targets SET total_connectors = $1, connection_strength = 'apollo_match', updated_at = NOW() WHERE id = $2`,
            [apolloContacts, lpId]
          );
        }
      }

      await client.query('COMMIT');
      res.json({ message: 'Apollo contacts stored', inserted: insertedCount });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error storing Apollo contacts:', err);
    res.status(500).json({ error: 'Failed to store Apollo contacts' });
  }
});

// GET /api/lp/apollo/contacts/:lpId - Get Apollo contacts for an LP target
router.get('/apollo/contacts/:lpId', authenticate, async (req, res) => {
  try {
    const { lpId } = req.params;
    const { rows: contacts } = await db.query(
      `SELECT ac.*,
              COALESCE(
                (SELECT json_agg(json_build_object(
                  'team_member_id', kc.team_member_id,
                  'team_member_name', tm.full_name,
                  'relationship_note', kc.relationship_note,
                  'flagged_at', kc.created_at
                ))
                FROM known_contacts kc
                JOIN team_members tm ON kc.team_member_id = tm.id
                WHERE kc.apollo_contact_id = ac.id),
                '[]'::json
              ) as known_by
       FROM apollo_company_contacts ac
       WHERE ac.lp_target_id = $1
       ORDER BY
         CASE WHEN EXISTS (SELECT 1 FROM known_contacts kc WHERE kc.apollo_contact_id = ac.id) THEN 0 ELSE 1 END,
         CASE ac.seniority WHEN 'c_suite' THEN 1 WHEN 'vp' THEN 2 WHEN 'director' THEN 3 WHEN 'manager' THEN 4 WHEN 'senior' THEN 5 ELSE 6 END,
         ac.full_name`,
      [lpId]
    );
    const { rows: cache } = await db.query(
      `SELECT * FROM apollo_company_cache WHERE company_name = (SELECT company FROM lp_targets WHERE id = $1)`,
      [lpId]
    );
    res.json({ contacts, company_info: cache[0] || null });
  } catch (err) {
    console.error('Error fetching Apollo contacts:', err);
    res.status(500).json({ error: 'Failed to fetch Apollo contacts' });
  }
});

// GET /api/lp/apollo/status - Get Apollo enrichment status
router.get('/apollo/status', authenticate, async (req, res) => {
  try {
    const { rows: total } = await db.query('SELECT COUNT(DISTINCT company) as count FROM lp_targets WHERE company IS NOT NULL');
    const { rows: searched } = await db.query('SELECT COUNT(DISTINCT company_name) as count FROM apollo_company_contacts');
    const { rows: withContacts } = await db.query(
      'SELECT COUNT(DISTINCT lp_target_id) as count FROM apollo_company_contacts'
    );
    const { rows: totalContacts } = await db.query('SELECT COUNT(*) as count FROM apollo_company_contacts');

    res.json({
      total_companies: parseInt(total[0].count) || 0,
      companies_searched: parseInt(searched[0].count) || 0,
      lps_with_apollo_contacts: parseInt(withContacts[0].count) || 0,
      total_apollo_contacts: parseInt(totalContacts[0].count) || 0,
    });
  } catch (err) {
    console.error('Error fetching Apollo status:', err);
    res.status(500).json({ error: 'Failed to fetch Apollo status' });
  }
});

// ── Live Apollo enrichment (server-side, requires APOLLO_API_KEY) ──

// Internal helper: search Apollo for a single LP target and persist results.
// Returns { inserted, total_found, skipped_reason? }
async function enrichSingleLpTarget(lpTarget, opts = {}) {
  const { perPage = 25 } = opts;
  if (!lpTarget?.company) {
    return { inserted: 0, total_found: 0, skipped_reason: 'no_company' };
  }

  const { people, company_info } = await apollo.searchPeopleAtCompany(
    lpTarget.company,
    { perPage }
  );

  if (!people.length) {
    return { inserted: 0, total_found: 0, skipped_reason: 'no_people_found' };
  }

  const client = await db.pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');

    // Upsert company cache
    if (company_info) {
      await client.query(
        `INSERT INTO apollo_company_cache
          (id, company_name, domain, industry, employee_count, revenue_range,
           apollo_org_id, total_people_found, senior_contacts_found, last_searched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (company_name) DO UPDATE SET
           domain = EXCLUDED.domain, industry = EXCLUDED.industry,
           employee_count = EXCLUDED.employee_count, revenue_range = EXCLUDED.revenue_range,
           apollo_org_id = EXCLUDED.apollo_org_id,
           total_people_found = EXCLUDED.total_people_found,
           senior_contacts_found = EXCLUDED.senior_contacts_found,
           last_searched_at = NOW()`,
        [
          uuid(), lpTarget.company, company_info.domain, company_info.industry,
          company_info.employee_count, company_info.revenue_range,
          company_info.apollo_org_id, company_info.total_people_found,
          company_info.senior_contacts_found,
        ]
      );
    }

    for (const p of people) {
      try {
        const result = await client.query(
          `INSERT INTO apollo_company_contacts
            (id, lp_target_id, company_name, apollo_person_id, first_name, last_name,
             full_name, title, seniority, linkedin_url, email, city, state, country, match_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'apollo_live')
           ON CONFLICT (lp_target_id, apollo_person_id) DO UPDATE SET
             title = EXCLUDED.title, seniority = EXCLUDED.seniority,
             linkedin_url = COALESCE(EXCLUDED.linkedin_url, apollo_company_contacts.linkedin_url),
             email = COALESCE(EXCLUDED.email, apollo_company_contacts.email),
             full_name = EXCLUDED.full_name
           RETURNING (xmax = 0) AS inserted`,
          [
            uuid(), lpTarget.id, lpTarget.company, p.apollo_person_id,
            p.first_name, p.last_name, p.full_name, p.title, p.seniority,
            p.linkedin_url, p.email, p.city, p.state, p.country,
          ]
        );
        if (result.rows[0]?.inserted) inserted++;
      } catch (e) {
        // Skip duplicates / individual errors
      }
    }

    // Update LP target rollup
    const { rows: countRows } = await client.query(
      'SELECT COUNT(*) AS count FROM apollo_company_contacts WHERE lp_target_id = $1',
      [lpTarget.id]
    );
    const totalContacts = parseInt(countRows[0].count) || 0;
    if (totalContacts > 0) {
      await client.query(
        `UPDATE lp_targets
           SET total_connectors = $1,
               connection_strength = COALESCE(NULLIF(connection_strength,''), 'apollo_match'),
               updated_at = NOW()
         WHERE id = $2`,
        [totalContacts, lpTarget.id]
      );
    }

    await client.query('COMMIT');
    return { inserted, total_found: people.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// POST /api/lp/apollo/live-search/:lpId — call Apollo live for one LP target
router.post('/apollo/live-search/:lpId', authenticate, async (req, res) => {
  if (!apollo.hasKey()) {
    return res.status(503).json({
      error: 'APOLLO_API_KEY not configured. Set it in Railway environment variables to enable live enrichment.',
    });
  }
  try {
    const { rows } = await db.query('SELECT * FROM lp_targets WHERE id = $1', [req.params.lpId]);
    if (!rows.length) return res.status(404).json({ error: 'LP target not found' });

    const result = await enrichSingleLpTarget(rows[0], { perPage: req.body?.per_page || 25 });
    res.json({ ok: true, lp_target_id: rows[0].id, company: rows[0].company, ...result });
  } catch (err) {
    if (err.code === 'NO_API_KEY') return res.status(503).json({ error: err.message });
    console.error('Apollo live-search error:', err);
    res.status(500).json({ error: err.message || 'Apollo search failed' });
  }
});

// POST /api/lp/apollo/bulk-enrich — enrich every LP target without contacts
// Body: { only_missing?: true, limit?: 50 }
router.post('/apollo/bulk-enrich', authenticate, async (req, res) => {
  const { only_missing = true, limit = 50, dry_run = false } = req.body || {};
  if (!dry_run && !apollo.hasKey()) {
    return res.status(503).json({
      error: 'APOLLO_API_KEY not configured. Set it in Railway environment variables.',
    });
  }
  try {
    const sql = only_missing
      ? `SELECT t.* FROM lp_targets t
          WHERE t.company IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM apollo_company_contacts c WHERE c.lp_target_id = t.id)
          ORDER BY COALESCE(t.fit_score, 0) DESC, t.imported_at DESC NULLS LAST
          LIMIT $1`
      : `SELECT * FROM lp_targets WHERE company IS NOT NULL
          ORDER BY COALESCE(fit_score, 0) DESC LIMIT $1`;
    const capped = Math.min(parseInt(limit) || 50, 1000);
    const { rows: targets } = await db.query(sql, [capped]);

    if (dry_run) {
      return res.json({
        ok: true,
        dry_run: true,
        queue_size: targets.length,
        targets: targets.map((t) => ({ id: t.id, company: t.company, fit_score: t.fit_score, email: t.email, full_name: t.full_name })),
      });
    }

    const results = [];
    let totalInserted = 0;
    for (const t of targets) {
      try {
        const r = await enrichSingleLpTarget(t, { perPage: 25 });
        totalInserted += r.inserted || 0;
        results.push({ id: t.id, company: t.company, ...r });
      } catch (e) {
        results.push({ id: t.id, company: t.company, error: e.message });
      }
      // Small delay to be polite to Apollo's rate limits
      await new Promise((r2) => setTimeout(r2, 250));
    }

    res.json({
      ok: true,
      processed: results.length,
      total_inserted: totalInserted,
      results,
    });
  } catch (err) {
    console.error('Apollo bulk-enrich error:', err);
    res.status(500).json({ error: err.message || 'Bulk enrich failed' });
  }
});

// GET /api/lp/apollo/key-status — does the backend have a key?
router.get('/apollo/key-status', authenticate, (req, res) => {
  res.json({ has_key: apollo.hasKey() });
});

// ── Known Contacts (Warm Intro Paths) ──────────────────────────

// POST /api/lp/apollo/contacts/:contactId/know - Flag "I know this person"
router.post('/apollo/contacts/:contactId/know', authenticate, async (req, res) => {
  try {
    const { contactId } = req.params;
    const { relationship_note } = req.body || {};

    // Get team_member_id for current user
    const { rows: tm } = await db.query(
      'SELECT id FROM team_members WHERE user_id = $1',
      [req.user.id]
    );
    if (!tm.length) {
      return res.status(400).json({ error: 'You must be added as a team member first' });
    }
    const teamMemberId = tm[0].id;

    // Verify the Apollo contact exists
    const { rows: contact } = await db.query(
      'SELECT id FROM apollo_company_contacts WHERE id = $1',
      [contactId]
    );
    if (!contact.length) {
      return res.status(404).json({ error: 'Apollo contact not found' });
    }

    const { rows } = await db.query(
      `INSERT INTO known_contacts (apollo_contact_id, team_member_id, relationship_note)
       VALUES ($1, $2, $3)
       ON CONFLICT (apollo_contact_id, team_member_id)
       DO UPDATE SET relationship_note = COALESCE($3, known_contacts.relationship_note)
       RETURNING *`,
      [contactId, teamMemberId, relationship_note || null]
    );

    res.json({ known_contact: rows[0] });
  } catch (err) {
    console.error('Error flagging known contact:', err);
    res.status(500).json({ error: 'Failed to flag contact' });
  }
});

// DELETE /api/lp/apollo/contacts/:contactId/know - Unflag
router.delete('/apollo/contacts/:contactId/know', authenticate, async (req, res) => {
  try {
    const { contactId } = req.params;
    const { rows: tm } = await db.query(
      'SELECT id FROM team_members WHERE user_id = $1',
      [req.user.id]
    );
    if (!tm.length) return res.status(400).json({ error: 'Not a team member' });

    await db.query(
      'DELETE FROM known_contacts WHERE apollo_contact_id = $1 AND team_member_id = $2',
      [contactId, tm[0].id]
    );
    res.json({ removed: true });
  } catch (err) {
    console.error('Error removing known contact:', err);
    res.status(500).json({ error: 'Failed to remove contact flag' });
  }
});

// ============================================================
// APOLLO DEEP ENRICHMENT (People Match - gets LinkedIn URLs, emails)
// ============================================================

// POST /api/lp/apollo/contacts/:contactId/enrich - Deep enrich a single contact via RocketReach
router.post('/apollo/contacts/:contactId/enrich', authenticate, async (req, res) => {
  try {
    const rrApiKey = process.env.ROCKETREACH_API_KEY;
    if (!rrApiKey) {
      return res.status(500).json({ error: 'ROCKETREACH_API_KEY environment variable not set' });
    }

    const { contactId } = req.params;
    const { rows: [contact] } = await db.query(
      'SELECT * FROM apollo_company_contacts WHERE id = $1',
      [contactId]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Accept optional overrides from request body (e.g. linkedin_url found via search)
    const { linkedin_url: bodyLinkedin, override_name: bodyName } = req.body || {};

    // Build name from body override, full_name, or first+last
    const contactName = bodyName
      || (contact.full_name && contact.full_name !== contact.first_name ? contact.full_name : null)
      || [contact.first_name, contact.last_name].filter(Boolean).join(' ');

    // Build RocketReach query — prioritize LinkedIn URL for most reliable match
    const linkedinUrl = bodyLinkedin || contact.linkedin_url;
    const rrParams = new URLSearchParams();
    if (linkedinUrl) {
      rrParams.set('linkedin_url', linkedinUrl);
    } else {
      rrParams.set('current_employer', contact.company_name);
      if (contactName) rrParams.set('name', contactName);
      if (contact.title) rrParams.set('current_title', contact.title);
    }

    const rrRes = await fetch(`https://api.rocketreach.co/api/v2/person/lookup?${rrParams}`, {
      method: 'GET',
      headers: {
        'Api-Key': rrApiKey,
      },
    });

    if (rrRes.status === 404) {
      // Still save override data even though RocketReach didn't find a match
      if (bodyName || linkedinUrl) {
        const nameParts = bodyName ? bodyName.split(' ') : [];
        const overrideLastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;
        await db.query(
          `UPDATE apollo_company_contacts SET
            linkedin_url = COALESCE($1, linkedin_url),
            last_name = COALESCE($2, last_name),
            full_name = COALESCE($3, full_name)
           WHERE id = $4`,
          [linkedinUrl || null, overrideLastName, bodyName || null, contactId]
        );
      }
      return res.status(404).json({ error: 'No match found in RocketReach', contact_name: contactName, linkedin_url: linkedinUrl || null, override_saved: !!(bodyName || linkedinUrl) });
    }

    if (!rrRes.ok) {
      const errText = await rrRes.text();
      console.error('RocketReach lookup error:', rrRes.status, errText);
      // Save override data even when RocketReach is rate-limited or unavailable
      if (bodyName || linkedinUrl) {
        const nameParts = bodyName ? bodyName.split(' ') : [];
        const overrideLastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;
        await db.query(
          `UPDATE apollo_company_contacts SET
            linkedin_url = COALESCE($1, linkedin_url),
            last_name = COALESCE($2, last_name),
            full_name = COALESCE($3, full_name)
           WHERE id = $4`,
          [linkedinUrl || null, overrideLastName, bodyName || null, contactId]
        );
      }
      return res.status(502).json({ error: 'RocketReach API error', status: rrRes.status, override_saved: !!(bodyName || linkedinUrl) });
    }

    const person = await rrRes.json();

    if (!person || person.status === 'failed') {
      return res.status(404).json({ error: 'No match found in RocketReach' });
    }

    // Extract best email (prefer professional, grade A/B)
    const bestEmail = (person.emails || [])
      .filter(e => e.smtp_valid !== 'invalid')
      .sort((a, b) => {
        const gradeOrder = { A: 0, B: 1, C: 2, D: 3, F: 4 };
        return (gradeOrder[a.grade] || 5) - (gradeOrder[b.grade] || 5);
      })[0];

    // Resolve full name from RocketReach response
    const rrFirstName = person.first_name || null;
    const rrLastName = person.last_name || null;
    const rrFullName = (rrFirstName && rrLastName)
      ? `${rrFirstName} ${rrLastName}`
      : person.name || bodyName || null;

    // Update the contact with enriched data (including resolved name)
    await db.query(
      `UPDATE apollo_company_contacts SET
        linkedin_url = COALESCE($1, linkedin_url),
        email = COALESCE($2, email),
        title = COALESCE($3, title),
        city = COALESCE($4, city),
        state = COALESCE($5, state),
        country = COALESCE($6, country),
        last_name = COALESCE($7, last_name),
        full_name = COALESCE($8, full_name),
        enriched = true
       WHERE id = $9`,
      [
        person.linkedin_url || null,
        bestEmail ? bestEmail.email : null,
        person.current_title || null,
        person.city || null,
        person.state || null,
        person.country || null,
        rrLastName,
        rrFullName,
        contactId,
      ]
    );

    // Return enriched contact
    const { rows: [updated] } = await db.query(
      'SELECT * FROM apollo_company_contacts WHERE id = $1',
      [contactId]
    );

    res.json({
      contact: updated,
      enrichment_source: 'rocketreach',
      rocketreach_match: {
        linkedin_url: person.linkedin_url,
        email: bestEmail ? bestEmail.email : null,
        email_grade: bestEmail ? bestEmail.grade : null,
        title: person.current_title,
        employer: person.current_employer,
        phones: (person.phones || []).slice(0, 3),
      },
    });
  } catch (err) {
    console.error('Error enriching contact via RocketReach:', err);
    res.status(500).json({ error: 'Failed to enrich contact', detail: err.message });
  }
});

// PATCH /api/lp/apollo/contacts/batch-update - Batch update contact names and LinkedIn URLs without RocketReach
// Body: { updates: [{ id, full_name, linkedin_url }] }
router.patch('/apollo/contacts/batch-update', authenticate, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates array required' });
    }

    const results = [];
    for (const u of updates) {
      if (!u.id) continue;
      const nameParts = u.full_name ? u.full_name.split(' ') : [];
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;

      await db.query(
        `UPDATE apollo_company_contacts SET
          linkedin_url = COALESCE($1, linkedin_url),
          last_name = COALESCE($2, last_name),
          full_name = COALESCE($3, full_name)
         WHERE id = $4`,
        [u.linkedin_url || null, lastName, u.full_name || null, u.id]
      );
      results.push({ id: u.id, full_name: u.full_name, updated: true });
    }

    res.json({ updated: results.length, results });
  } catch (err) {
    console.error('Error batch updating contacts:', err);
    res.status(500).json({ error: 'Failed to batch update contacts', detail: err.message });
  }
});

// POST /api/lp/apollo/contacts/enrich-batch - Batch enrich contacts for an LP target via RocketReach
// Accepts optional body: { contact_overrides: { [contactId]: { linkedin_url, override_name } } }
router.post('/apollo/contacts/enrich-batch/:lpId', authenticate, async (req, res) => {
  try {
    const rrApiKey = process.env.ROCKETREACH_API_KEY;
    if (!rrApiKey) {
      return res.status(500).json({ error: 'ROCKETREACH_API_KEY environment variable not set' });
    }

    const { lpId } = req.params;
    const { contact_overrides = {} } = req.body || {};
    const { rows: contacts } = await db.query(
      'SELECT * FROM apollo_company_contacts WHERE lp_target_id = $1 AND (enriched = false OR enriched IS NULL)',
      [lpId]
    );

    if (!contacts.length) {
      return res.json({ message: 'All contacts already enriched', enriched: 0 });
    }

    let enriched = 0;
    let errors = 0;
    let skipped = 0;

    for (const contact of contacts.slice(0, 10)) { // Max 10 at a time to conserve credits
      try {
        const overrides = contact_overrides[contact.id] || {};

        // Build name from override, full_name, or first+last
        const contactName = overrides.override_name
          || (contact.full_name && contact.full_name !== contact.first_name ? contact.full_name : null)
          || [contact.first_name, contact.last_name].filter(Boolean).join(' ');

        // Build RocketReach query — prioritize LinkedIn URL for reliable match
        const linkedinUrl = overrides.linkedin_url || contact.linkedin_url;
        const rrParams = new URLSearchParams();

        if (linkedinUrl) {
          rrParams.set('linkedin_url', linkedinUrl);
        } else {
          if (!contactName && !contact.title) {
            skipped++;
            continue; // Skip contacts with no name, title, or LinkedIn URL
          }
          rrParams.set('current_employer', contact.company_name);
          if (contactName) rrParams.set('name', contactName);
          if (contact.title) rrParams.set('current_title', contact.title);
        }

        const rrRes = await fetch(`https://api.rocketreach.co/api/v2/person/lookup?${rrParams}`, {
          method: 'GET',
          headers: {
            'Api-Key': rrApiKey,
          },
        });

        if (rrRes.ok) {
          const person = await rrRes.json();
          if (person && person.status !== 'failed') {
            const bestEmail = (person.emails || [])
              .filter(e => e.smtp_valid !== 'invalid')
              .sort((a, b) => {
                const gradeOrder = { A: 0, B: 1, C: 2, D: 3, F: 4 };
                return (gradeOrder[a.grade] || 5) - (gradeOrder[b.grade] || 5);
              })[0];

            // Resolve full name from RocketReach
            const rrFirstName = person.first_name || null;
            const rrLastName = person.last_name || null;
            const rrFullName = (rrFirstName && rrLastName)
              ? `${rrFirstName} ${rrLastName}`
              : person.name || overrides.override_name || null;

            await db.query(
              `UPDATE apollo_company_contacts SET
                linkedin_url = COALESCE($1, linkedin_url),
                email = COALESCE($2, email),
                title = COALESCE($3, title),
                city = COALESCE($4, city),
                state = COALESCE($5, state),
                country = COALESCE($6, country),
                last_name = COALESCE($7, last_name),
                full_name = COALESCE($8, full_name),
                enriched = true
               WHERE id = $9`,
              [
                person.linkedin_url || null,
                bestEmail ? bestEmail.email : null,
                person.current_title || null,
                person.city || null,
                person.state || null,
                person.country || null,
                rrLastName,
                rrFullName,
                contact.id,
              ]
            );
            enriched++;
          }
        }
      } catch (e) {
        console.error('RocketReach batch enrich error for contact:', contact.id, e.message);
        errors++;
      }
      // Delay between requests to respect rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    res.json({ enriched, errors, skipped, total: contacts.length, source: 'rocketreach' });
  } catch (err) {
    console.error('Error batch enriching contacts:', err);
    res.status(500).json({ error: 'Failed to batch enrich contacts' });
  }
});

// ============================================================
// LINKEDIN ENRICHMENT (via People Data Labs)
// ============================================================

// Helper: Initialize PDL client (lazy, so it doesn't crash if no key set)
let pdlClient = null;
function getPDLClient() {
  if (!pdlClient) {
    if (!process.env.PDL_API_KEY) {
      throw new Error('PDL_API_KEY environment variable not set');
    }
    const PDLJS = require('peopledatalabs');
    pdlClient = new PDLJS({ apiKey: process.env.PDL_API_KEY });
  }
  return pdlClient;
}

// Helper: Map PDL response to our enrichment fields
function mapPDLResponse(data) {
  return {
    pdl_id: data.id || null,
    full_name: data.full_name || null,
    headline: data.headline || null,
    summary: data.summary || null,
    location: data.location_name || null,
    industry: data.industry || null,
    current_title: data.job_title || null,
    current_company: data.job_company_name || null,
    current_company_industry: data.job_company_industry || null,
    job_history: (data.experience || []).map(exp => ({
      title: exp.title?.name || exp.title || null,
      company: exp.company?.name || exp.company || null,
      start_date: exp.start_date || null,
      end_date: exp.end_date || null,
      is_primary: exp.is_primary || false,
      summary: exp.summary || null,
    })),
    education: (data.education || []).map(edu => ({
      school: edu.school?.name || edu.school || null,
      degree: edu.degrees?.join(', ') || edu.degree || null,
      field_of_study: edu.majors?.join(', ') || edu.field_of_study || null,
      start_date: edu.start_date || null,
      end_date: edu.end_date || null,
    })),
    skills: data.skills || [],
    twitter_url: data.twitter_url || null,
    github_url: data.github_url || null,
    facebook_url: data.facebook_url || null,
  };
}

// POST /api/lp/linkedin/enrich - Enrich a person by LinkedIn URL
// Body: { linkedin_url, lp_target_id?, apollo_contact_id? }
router.post('/linkedin/enrich', authenticate, async (req, res) => {
  try {
    const { linkedin_url, lp_target_id, apollo_contact_id } = req.body;
    if (!linkedin_url) {
      return res.status(400).json({ error: 'linkedin_url is required' });
    }

    // Check if we already have enrichment for this URL
    const { rows: existing } = await db.query(
      'SELECT * FROM linkedin_enrichments WHERE linkedin_url = $1',
      [linkedin_url]
    );
    if (existing.length > 0) {
      // Update foreign keys if needed
      if (lp_target_id && !existing[0].lp_target_id) {
        await db.query('UPDATE linkedin_enrichments SET lp_target_id = $1 WHERE id = $2', [lp_target_id, existing[0].id]);
        existing[0].lp_target_id = lp_target_id;
      }
      if (apollo_contact_id && !existing[0].apollo_contact_id) {
        await db.query('UPDATE linkedin_enrichments SET apollo_contact_id = $1 WHERE id = $2', [apollo_contact_id, existing[0].id]);
        existing[0].apollo_contact_id = apollo_contact_id;
      }
      return res.json({ enrichment: existing[0], cached: true });
    }

    // Call People Data Labs
    const pdl = getPDLClient();
    let pdlResponse;
    try {
      pdlResponse = await pdl.person.enrichment({ profile: [linkedin_url] });
    } catch (pdlErr) {
      if (pdlErr.status === 404) {
        return res.status(404).json({ error: 'No matching profile found in People Data Labs' });
      }
      console.error('PDL API error:', pdlErr.message || pdlErr);
      return res.status(502).json({ error: 'People Data Labs API error', detail: pdlErr.message });
    }

    const mapped = mapPDLResponse(pdlResponse.data || pdlResponse);
    const id = uuid();

    await db.query(
      `INSERT INTO linkedin_enrichments
        (id, lp_target_id, apollo_contact_id, linkedin_url,
         pdl_id, full_name, headline, summary, location, industry,
         current_title, current_company, current_company_industry,
         job_history, education, skills,
         twitter_url, github_url, facebook_url, pdl_likelihood)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        id, lp_target_id || null, apollo_contact_id || null, linkedin_url,
        mapped.pdl_id, mapped.full_name, mapped.headline, mapped.summary,
        mapped.location, mapped.industry,
        mapped.current_title, mapped.current_company, mapped.current_company_industry,
        JSON.stringify(mapped.job_history), JSON.stringify(mapped.education),
        mapped.skills.length > 0 ? mapped.skills : null,
        mapped.twitter_url, mapped.github_url, mapped.facebook_url,
        pdlResponse.likelihood || null,
      ]
    );

    const { rows: [enrichment] } = await db.query(
      'SELECT * FROM linkedin_enrichments WHERE id = $1', [id]
    );

    res.json({ enrichment, cached: false });
  } catch (err) {
    console.error('Error enriching LinkedIn profile:', err);
    res.status(500).json({ error: 'Failed to enrich LinkedIn profile', detail: err.message });
  }
});

// GET /api/lp/linkedin/enrichment/:targetId - Get enrichment for an LP target
router.get('/linkedin/enrichment/:targetId', authenticate, async (req, res) => {
  try {
    const { targetId } = req.params;
    const { rows } = await db.query(
      'SELECT * FROM linkedin_enrichments WHERE lp_target_id = $1 ORDER BY enriched_at DESC LIMIT 1',
      [targetId]
    );
    if (!rows.length) {
      return res.json({ enrichment: null });
    }
    res.json({ enrichment: rows[0] });
  } catch (err) {
    console.error('Error fetching enrichment:', err);
    res.status(500).json({ error: 'Failed to fetch enrichment' });
  }
});

// POST /api/lp/linkedin/enrich-target/:targetId - Enrich an LP target using their stored LinkedIn URL
router.post('/linkedin/enrich-target/:targetId', authenticate, async (req, res) => {
  try {
    const { targetId } = req.params;
    const { rows: [target] } = await db.query(
      'SELECT id, full_name, linkedin_url FROM lp_targets WHERE id = $1',
      [targetId]
    );
    if (!target) return res.status(404).json({ error: 'LP target not found' });
    if (!target.linkedin_url) return res.status(400).json({ error: 'LP target has no LinkedIn URL' });

    // Delegate to the main enrichment endpoint logic
    req.body = { linkedin_url: target.linkedin_url, lp_target_id: targetId };

    // Check cache first
    const { rows: existing } = await db.query(
      'SELECT * FROM linkedin_enrichments WHERE linkedin_url = $1',
      [target.linkedin_url]
    );
    if (existing.length > 0) {
      if (!existing[0].lp_target_id) {
        await db.query('UPDATE linkedin_enrichments SET lp_target_id = $1 WHERE id = $2', [targetId, existing[0].id]);
        existing[0].lp_target_id = targetId;
      }
      return res.json({ enrichment: existing[0], cached: true });
    }

    // Call PDL
    const pdl = getPDLClient();
    let pdlResponse;
    try {
      pdlResponse = await pdl.person.enrichment({ profile: [target.linkedin_url] });
    } catch (pdlErr) {
      if (pdlErr.status === 404) {
        return res.status(404).json({ error: `No PDL match for ${target.full_name}` });
      }
      return res.status(502).json({ error: 'PDL API error', detail: pdlErr.message });
    }

    const mapped = mapPDLResponse(pdlResponse.data || pdlResponse);
    const id = uuid();

    await db.query(
      `INSERT INTO linkedin_enrichments
        (id, lp_target_id, linkedin_url,
         pdl_id, full_name, headline, summary, location, industry,
         current_title, current_company, current_company_industry,
         job_history, education, skills,
         twitter_url, github_url, facebook_url, pdl_likelihood)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        id, targetId, target.linkedin_url,
        mapped.pdl_id, mapped.full_name, mapped.headline, mapped.summary,
        mapped.location, mapped.industry,
        mapped.current_title, mapped.current_company, mapped.current_company_industry,
        JSON.stringify(mapped.job_history), JSON.stringify(mapped.education),
        mapped.skills.length > 0 ? mapped.skills : null,
        mapped.twitter_url, mapped.github_url, mapped.facebook_url,
        pdlResponse.likelihood || null,
      ]
    );

    const { rows: [enrichment] } = await db.query(
      'SELECT * FROM linkedin_enrichments WHERE id = $1', [id]
    );
    res.json({ enrichment, cached: false });
  } catch (err) {
    console.error('Error enriching LP target:', err);
    res.status(500).json({ error: 'Failed to enrich LP target', detail: err.message });
  }
});

// GET /api/lp/companies - Get unique company names from LP targets
router.get('/companies', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT company, array_agg(id) as lp_ids, COUNT(*) as lp_count
       FROM lp_targets
       WHERE company IS NOT NULL AND company != ''
       GROUP BY company
       ORDER BY company`
    );
    res.json({ companies: rows });
  } catch (err) {
    console.error('Error fetching companies:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// ============================================================
// Clay Integration
// ============================================================

// Clay settings table auto-migration
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS clay_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        clay_table_webhook_url TEXT,
        clay_webhook_secret VARCHAR(255),
        clay_api_key VARCHAR(500),
        last_export_at TIMESTAMPTZ,
        last_import_at TIMESTAMPTZ,
        export_count INT DEFAULT 0,
        import_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS clay_sync_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        direction VARCHAR(20) NOT NULL CHECK (direction IN ('export', 'import')),
        records_count INT DEFAULT 0,
        status VARCHAR(50) DEFAULT 'pending',
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_clay_sync_log_dir ON clay_sync_log(direction, created_at DESC);
    `);
  } catch (err) {
    console.error('Clay migration warning:', err.message);
  }
})();

// GET /api/lp/clay/settings — Get current Clay config
router.get('/clay/settings', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM clay_settings LIMIT 1');
    const settings = rows[0] || null;
    // Mask API key for frontend
    if (settings && settings.clay_api_key) {
      settings.clay_api_key_masked = settings.clay_api_key.slice(0, 6) + '***' + settings.clay_api_key.slice(-4);
    }
    const { rows: logs } = await db.query(
      'SELECT * FROM clay_sync_log ORDER BY created_at DESC LIMIT 10'
    );
    res.json({ settings, sync_log: logs });
  } catch (err) {
    console.error('Error fetching Clay settings:', err);
    res.status(500).json({ error: 'Failed to fetch Clay settings' });
  }
});

// POST /api/lp/clay/settings — Save Clay config
router.post('/clay/settings', authenticate, async (req, res) => {
  try {
    const { clay_table_webhook_url, clay_webhook_secret, clay_api_key } = req.body;

    // Upsert — there should only ever be one row
    const { rows: existing } = await db.query('SELECT id FROM clay_settings LIMIT 1');
    if (existing.length > 0) {
      const updates = [];
      const vals = [];
      let idx = 1;
      if (clay_table_webhook_url !== undefined) { updates.push(`clay_table_webhook_url = $${idx++}`); vals.push(clay_table_webhook_url); }
      if (clay_webhook_secret !== undefined) { updates.push(`clay_webhook_secret = $${idx++}`); vals.push(clay_webhook_secret); }
      if (clay_api_key !== undefined) { updates.push(`clay_api_key = $${idx++}`); vals.push(clay_api_key); }
      updates.push(`updated_at = NOW()`);
      vals.push(existing[0].id);
      await db.query(
        `UPDATE clay_settings SET ${updates.join(', ')} WHERE id = $${idx}`,
        vals
      );
    } else {
      await db.query(
        `INSERT INTO clay_settings (clay_table_webhook_url, clay_webhook_secret, clay_api_key) VALUES ($1, $2, $3)`,
        [clay_table_webhook_url || null, clay_webhook_secret || null, clay_api_key || null]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving Clay settings:', err);
    res.status(500).json({ error: 'Failed to save Clay settings' });
  }
});

// POST /api/lp/clay/export — Push LP targets to Clay table webhook
router.post('/clay/export', authenticate, async (req, res) => {
  try {
    const { rows: settingsRows } = await db.query('SELECT * FROM clay_settings LIMIT 1');
    const settings = settingsRows[0];
    if (!settings || !settings.clay_table_webhook_url) {
      return res.status(400).json({ error: 'Clay webhook URL not configured. Add it in Clay Settings.' });
    }

    // Optional filter: only export certain statuses or unenriched
    const { filter = 'all', include_contacts = false } = req.body;

    let query = 'SELECT * FROM lp_targets';
    const params = [];
    if (filter === 'unenriched') {
      query += ' WHERE email IS NULL OR email = \'\'';
    } else if (filter === 'active') {
      query += ` WHERE outreach_status IN ('not_started', 'identified', 'intro_requested', 'intro_made', 'meeting_scheduled', 'in_discussions')`;
    }
    query += ' ORDER BY fit_score DESC';

    const { rows: lpTargets } = await db.query(query, params);

    // Optionally include Apollo contacts that need email enrichment
    let apolloContacts = [];
    if (include_contacts) {
      const { rows } = await db.query(
        `SELECT acc.*, lt.company as lp_company, lt.full_name as lp_name
         FROM apollo_company_contacts acc
         JOIN lp_targets lt ON acc.lp_target_id = lt.id
         WHERE acc.email IS NULL OR acc.email = ''
         ORDER BY acc.seniority, acc.company_name`
      );
      apolloContacts = rows;
    }

    // Format records for Clay table
    // Each record becomes a row in the Clay table
    const clayRecords = lpTargets.map(lp => ({
      // Unique identifier so Clay can match back
      platform_id: lp.id,
      record_type: 'lp_target',
      full_name: lp.full_name,
      email: lp.email || '',
      company: lp.company || '',
      title: lp.title || '',
      linkedin_url: lp.linkedin_url || '',
      phone: lp.phone || '',
      fund_type: lp.fund_type || '',
      estimated_aum: lp.estimated_aum || '',
      geographic_focus: lp.geographic_focus || '',
      sector_interest: (lp.sector_interest || []).join(', '),
      fit_score: lp.fit_score || 0,
      outreach_status: lp.outreach_status || 'not_started',
    }));

    // Add Apollo contacts if requested
    const contactRecords = apolloContacts.map(c => ({
      platform_id: c.id,
      record_type: 'apollo_contact',
      full_name: c.full_name || `${c.first_name} ${c.last_name}`,
      email: c.email || '',
      company: c.company_name || '',
      title: c.title || '',
      linkedin_url: c.linkedin_url || '',
      seniority: c.seniority || '',
      lp_company: c.lp_company || '',
      lp_name: c.lp_name || '',
    }));

    const allRecords = [...clayRecords, ...contactRecords];

    // Push to Clay in batches of 50 (Clay webhook best practice)
    const batchSize = 50;
    let pushed = 0;
    const errors = [];

    for (let i = 0; i < allRecords.length; i += batchSize) {
      const batch = allRecords.slice(i, i + batchSize);
      try {
        const response = await fetch(settings.clay_table_webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(settings.clay_api_key ? { 'Authorization': `Bearer ${settings.clay_api_key}` } : {}),
          },
          body: JSON.stringify(batch.length === 1 ? batch[0] : batch),
        });

        if (!response.ok) {
          const errText = await response.text();
          errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${response.status} - ${errText.slice(0, 200)}`);
        } else {
          pushed += batch.length;
        }
      } catch (fetchErr) {
        errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${fetchErr.message}`);
      }
    }

    // Update settings
    await db.query(
      'UPDATE clay_settings SET last_export_at = NOW(), export_count = export_count + $1 WHERE id = $2',
      [pushed, settings.id]
    );

    // Log sync
    await db.query(
      `INSERT INTO clay_sync_log (direction, records_count, status, details) VALUES ('export', $1, $2, $3)`,
      [pushed, errors.length > 0 ? 'partial' : 'success', JSON.stringify({
        total_records: allRecords.length,
        lp_targets: clayRecords.length,
        apollo_contacts: contactRecords.length,
        pushed,
        errors: errors.slice(0, 5),
        filter,
      })]
    );

    res.json({
      success: true,
      total_records: allRecords.length,
      pushed,
      errors: errors.length,
      error_details: errors.slice(0, 5),
    });
  } catch (err) {
    console.error('Error exporting to Clay:', err);
    res.status(500).json({ error: 'Failed to export to Clay', detail: err.message });
  }
});

// POST /api/lp/clay/webhook — Receive enriched data from Clay (HTTP action callback)
// Clay sends enriched records back here after waterfall enrichment
// This endpoint does NOT require JWT auth — it uses the webhook secret instead
router.post('/clay/webhook', async (req, res) => {
  try {
    // Verify webhook secret if configured
    const { rows: settingsRows } = await db.query('SELECT * FROM clay_settings LIMIT 1');
    const settings = settingsRows[0];

    if (settings && settings.clay_webhook_secret) {
      const authHeader = req.headers['authorization'] || req.headers['x-webhook-secret'] || '';
      const token = authHeader.replace('Bearer ', '');
      if (token !== settings.clay_webhook_secret) {
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }
    }

    // Clay can send a single record or an array
    const records = Array.isArray(req.body) ? req.body : [req.body];
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const record of records) {
      try {
        const platformId = record.platform_id || record.id;
        const recordType = record.record_type || 'lp_target';

        if (!platformId) {
          skipped++;
          continue;
        }

        if (recordType === 'lp_target') {
          // Update LP target with enriched data from Clay
          const updates = [];
          const vals = [];
          let idx = 1;

          // Email (primary value from Clay enrichment)
          if (record.enriched_email || record.email_found || record.work_email || record.personal_email) {
            const email = record.enriched_email || record.email_found || record.work_email || record.personal_email;
            updates.push(`email = COALESCE(NULLIF($${idx}, ''), email)`);
            vals.push(email);
            idx++;
          }

          // Phone
          if (record.enriched_phone || record.phone_found || record.direct_phone) {
            const phone = record.enriched_phone || record.phone_found || record.direct_phone;
            updates.push(`phone = COALESCE(NULLIF($${idx}, ''), phone)`);
            vals.push(phone);
            idx++;
          }

          // LinkedIn URL
          if (record.enriched_linkedin_url || record.linkedin_url_found) {
            const url = record.enriched_linkedin_url || record.linkedin_url_found;
            updates.push(`linkedin_url = COALESCE(NULLIF($${idx}, ''), linkedin_url)`);
            vals.push(url);
            idx++;
          }

          // Title (might get a better/updated title)
          if (record.enriched_title || record.current_title) {
            const title = record.enriched_title || record.current_title;
            updates.push(`title = COALESCE(NULLIF($${idx}, ''), title)`);
            vals.push(title);
            idx++;
          }

          // Fund type / AUM from Clay enrichment columns
          if (record.enriched_fund_type) {
            updates.push(`fund_type = COALESCE(NULLIF($${idx}, ''), fund_type)`);
            vals.push(record.enriched_fund_type);
            idx++;
          }
          if (record.enriched_aum) {
            updates.push(`estimated_aum = COALESCE(NULLIF($${idx}, ''), estimated_aum)`);
            vals.push(record.enriched_aum);
            idx++;
          }

          // Notes from Clay (e.g., AI-generated context)
          if (record.clay_notes || record.enrichment_notes) {
            const notes = record.clay_notes || record.enrichment_notes;
            updates.push(`notes = COALESCE(notes || E'\\n', '') || '[Clay] ' || $${idx}`);
            vals.push(notes);
            idx++;
          }

          if (updates.length > 0) {
            updates.push('updated_at = NOW()');
            vals.push(platformId);
            await db.query(
              `UPDATE lp_targets SET ${updates.join(', ')} WHERE id = $${idx}`,
              vals
            );

            // Log activity
            await db.query(
              `INSERT INTO lp_activity_log (lp_target_id, action, details) VALUES ($1, 'clay_enrichment', $2)`,
              [platformId, JSON.stringify({
                fields_updated: updates.length - 1,
                source: 'clay_webhook',
                timestamp: new Date().toISOString(),
              })]
            );

            updated++;
          } else {
            skipped++;
          }

        } else if (recordType === 'apollo_contact') {
          // Update Apollo contact with enriched data
          const updates = [];
          const vals = [];
          let idx = 1;

          if (record.enriched_email || record.email_found || record.work_email) {
            const email = record.enriched_email || record.email_found || record.work_email;
            updates.push(`email = COALESCE(NULLIF($${idx}, ''), email)`);
            vals.push(email);
            idx++;
            updates.push('enriched = true');
          }

          if (record.enriched_linkedin_url || record.linkedin_url_found) {
            updates.push(`linkedin_url = COALESCE(NULLIF($${idx}, ''), linkedin_url)`);
            vals.push(record.enriched_linkedin_url || record.linkedin_url_found);
            idx++;
          }

          if (record.enriched_title || record.current_title) {
            updates.push(`title = COALESCE(NULLIF($${idx}, ''), title)`);
            vals.push(record.enriched_title || record.current_title);
            idx++;
          }

          if (record.enriched_full_name || record.full_name_resolved) {
            updates.push(`full_name = COALESCE(NULLIF($${idx}, ''), full_name)`);
            vals.push(record.enriched_full_name || record.full_name_resolved);
            idx++;
          }

          if (updates.length > 0) {
            vals.push(platformId);
            await db.query(
              `UPDATE apollo_company_contacts SET ${updates.join(', ')} WHERE id = $${idx}`,
              vals
            );
            updated++;
          } else {
            skipped++;
          }
        }
      } catch (recErr) {
        errors.push(recErr.message);
      }
    }

    // Log sync
    await db.query(
      `INSERT INTO clay_sync_log (direction, records_count, status, details) VALUES ('import', $1, $2, $3)`,
      [updated, errors.length > 0 ? 'partial' : 'success', JSON.stringify({
        total_received: records.length,
        updated,
        skipped,
        errors: errors.slice(0, 5),
      })]
    );

    // Update settings
    if (settings) {
      await db.query(
        'UPDATE clay_settings SET last_import_at = NOW(), import_count = import_count + $1 WHERE id = $2',
        [updated, settings.id]
      );
    }

    // Recalculate fit scores for updated targets
    if (updated > 0) {
      const { rows: allTargets } = await db.query('SELECT * FROM lp_targets');
      for (const lp of allTargets) {
        const newScore = computeFitScore(lp);
        if (newScore !== lp.fit_score) {
          await db.query('UPDATE lp_targets SET fit_score = $1 WHERE id = $2', [newScore, lp.id]);
        }
      }
    }

    res.json({ success: true, updated, skipped, errors: errors.length });
  } catch (err) {
    console.error('Error processing Clay webhook:', err);
    res.status(500).json({ error: 'Failed to process Clay webhook', detail: err.message });
  }
});

// POST /api/lp/clay/import-csv — Import enriched CSV from Clay (manual upload)
// For users who prefer to download from Clay and upload directly
router.post('/clay/import-csv', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'CSV file required' });

    const csvContent = req.file.buffer.toString('utf-8');
    const rows = parseCSV(csvContent);

    if (rows.length === 0) return res.status(400).json({ error: 'No data found in CSV' });

    let updated = 0;
    let skipped = 0;
    let matched = 0;

    for (const row of rows) {
      // Try to match by platform_id first, then by name+company
      let lpId = row.platform_id || row.id || null;

      if (!lpId) {
        // Fuzzy match by name + company
        const name = row.full_name || row.name || `${row.first_name || ''} ${row.last_name || ''}`.trim();
        const company = row.company || row.organization || '';
        if (!name) { skipped++; continue; }

        const { rows: candidates } = await db.query(
          `SELECT id, full_name, company FROM lp_targets WHERE LOWER(full_name) = LOWER($1)`,
          [name]
        );

        if (candidates.length === 1) {
          lpId = candidates[0].id;
          matched++;
        } else if (candidates.length > 1 && company) {
          // Disambiguate by company
          const match = candidates.find(c =>
            fuzzyMatchCompany(c.company, company) >= 75
          );
          if (match) {
            lpId = match.id;
            matched++;
          } else {
            skipped++;
            continue;
          }
        } else {
          skipped++;
          continue;
        }
      }

      // Build update from Clay CSV columns
      const updates = [];
      const vals = [];
      let idx = 1;

      // Map common Clay enrichment column names to our schema
      const emailVal = row.enriched_email || row.email_found || row.work_email || row.personal_email || row.email || '';
      if (emailVal) {
        updates.push(`email = COALESCE(NULLIF($${idx}, ''), email)`);
        vals.push(emailVal);
        idx++;
      }

      const phoneVal = row.enriched_phone || row.phone_found || row.direct_phone || row.phone || '';
      if (phoneVal) {
        updates.push(`phone = COALESCE(NULLIF($${idx}, ''), phone)`);
        vals.push(phoneVal);
        idx++;
      }

      const linkedinVal = row.enriched_linkedin_url || row.linkedin_url || row.linkedin || '';
      if (linkedinVal) {
        updates.push(`linkedin_url = COALESCE(NULLIF($${idx}, ''), linkedin_url)`);
        vals.push(linkedinVal);
        idx++;
      }

      const titleVal = row.enriched_title || row.current_title || row.title || '';
      if (titleVal) {
        updates.push(`title = COALESCE(NULLIF($${idx}, ''), title)`);
        vals.push(titleVal);
        idx++;
      }

      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        vals.push(lpId);
        await db.query(
          `UPDATE lp_targets SET ${updates.join(', ')} WHERE id = $${idx}`,
          vals
        );
        updated++;
      } else {
        skipped++;
      }
    }

    // Log sync
    await db.query(
      `INSERT INTO clay_sync_log (direction, records_count, status, details) VALUES ('import', $1, 'success', $2)`,
      [updated, JSON.stringify({
        source: 'csv_upload',
        total_rows: rows.length,
        updated,
        matched_by_name: matched,
        skipped,
      })]
    );

    res.json({
      success: true,
      total_rows: rows.length,
      updated,
      matched_by_name: matched,
      skipped,
    });
  } catch (err) {
    console.error('Error importing Clay CSV:', err);
    res.status(500).json({ error: 'Failed to import Clay CSV', detail: err.message });
  }
});

// GET /api/lp/clay/export-csv — Public CSV download of LP targets for Clay import
// Temporary convenience endpoint - no auth required but uses a time-limited token
router.get('/clay/export-csv', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM lp_targets ORDER BY fit_score DESC');
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const headers = ['platform_id','record_type','full_name','email','company','title','linkedin_url','phone','fund_type','estimated_aum','geographic_focus','sector_interest','fit_score','outreach_status'];
    const csvRows = rows.map(t => [
      t.id, 'lp_target', esc(t.full_name), esc(t.email), esc(t.company), esc(t.title),
      esc(t.linkedin_url), esc(t.phone), esc(t.fund_type), esc(t.estimated_aum),
      esc(t.geographic_focus), esc((t.sector_interest || []).join('; ')),
      t.fit_score || 0, t.outreach_status || 'not_started'
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=lp_targets_clay.csv');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(csv);
  } catch (err) {
    console.error('Error exporting CSV:', err);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// GET /api/lp/clay/webhook-url — Return the platform's webhook URL for Clay to call back
router.get('/clay/webhook-url', authenticate, async (req, res) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    webhook_url: `${baseUrl}/api/lp/clay/webhook`,
    instructions: 'Add this URL as an HTTP POST action in your Clay table. Map your enriched columns to the expected field names (enriched_email, enriched_phone, enriched_linkedin_url, etc.). Include platform_id and record_type in the payload.',
  });
});

// ── Manual Connections (Navigator-sourced warm paths) ──

// GET /api/lp/targets/:id/connections — list manual connections for an LP
router.get('/targets/:id/connections', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `SELECT id, name, relationship, linkedin_url, added_by, created_at
       FROM lp_manual_connections
       WHERE lp_target_id = $1
       ORDER BY created_at DESC`,
      [id]
    );
    res.json({ connections: rows });
  } catch (err) {
    console.error('Error fetching manual connections:', err);
    res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

// POST /api/lp/targets/:id/connections — add a manual connection
router.post('/targets/:id/connections', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, relationship, linkedin_url } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // Verify LP exists
    const { rows: lpCheck } = await db.query('SELECT id FROM lp_targets WHERE id = $1', [id]);
    if (!lpCheck.length) return res.status(404).json({ error: 'LP target not found' });

    const { rows } = await db.query(
      `INSERT INTO lp_manual_connections (lp_target_id, name, relationship, linkedin_url, added_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, name.trim(), relationship?.trim() || null, linkedin_url?.trim() || null, req.user.id]
    );

    // Log activity
    await db.query(
      `INSERT INTO lp_activity_log (lp_target_id, user_id, action, details)
       VALUES ($1, $2, 'manual_connection_added', $3)`,
      [id, req.user.id, JSON.stringify({ name: name.trim(), relationship: relationship?.trim() })]
    );

    res.status(201).json({ connection: rows[0] });
  } catch (err) {
    console.error('Error adding manual connection:', err);
    res.status(500).json({ error: 'Failed to add connection' });
  }
});

// DELETE /api/lp/targets/:id/connections/:connId — remove a manual connection
router.delete('/targets/:id/connections/:connId', authenticate, async (req, res) => {
  try {
    const { id, connId } = req.params;
    const { rowCount } = await db.query(
      'DELETE FROM lp_manual_connections WHERE id = $1 AND lp_target_id = $2',
      [connId, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Connection not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting manual connection:', err);
    res.status(500).json({ error: 'Failed to delete connection' });
  }
});

module.exports = router;
