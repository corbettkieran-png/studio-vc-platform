const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');

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
  const lines = csvContent.trim().split('\n');
  if (lines.length === 0) return [];

  // Parse header row
  const headerRow = lines[0];
  const headers = headerRow.split(',').map(h => h.trim().toLowerCase());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
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

    // For each LP target, find all matches and compute best connector
    for (const lp of lpTargets) {
      const lpMatches = {}; // team_member_id -> highest confidence match

      // Direct name match
      for (const conn of connections) {
        const nameScore = fuzzyMatchName(lp.full_name, conn.full_name);
        if (nameScore >= 70) {
          const tmId = conn.team_member_id;
          if (!lpMatches[tmId] || lpMatches[tmId].confidence < nameScore) {
            lpMatches[tmId] = {
              type: 'direct_name',
              confidence: nameScore,
              connectionId: conn.id,
            };
          }
        }
      }

      // Direct email match
      if (lp.email) {
        const emailConn = connections.find(
          c => c.email && c.email.toLowerCase() === lp.email.toLowerCase()
        );
        if (emailConn) {
          const tmId = emailConn.team_member_id;
          if (!lpMatches[tmId] || lpMatches[tmId].confidence < 100) {
            lpMatches[tmId] = {
              type: 'direct_email',
              confidence: 100,
              connectionId: emailConn.id,
            };
          }
        }
      }

      // Company + name fuzzy match
      if (lp.company) {
        const companyConns = connections.filter(
          c => c.company && c.company.toLowerCase().includes(lp.company.toLowerCase())
        );
        for (const conn of companyConns) {
          const nameScore = fuzzyMatchName(lp.full_name, conn.full_name);
          if (nameScore >= 50) {
            const tmId = conn.team_member_id;
            const confidence = Math.min(85, nameScore + 15);
            if (!lpMatches[tmId] || lpMatches[tmId].confidence < confidence) {
              lpMatches[tmId] = {
                type: 'company_match',
                confidence,
                connectionId: conn.id,
              };
            }
          }
        }
      }

      // Insert matches into DB
      for (const [tmId, match] of Object.entries(lpMatches)) {
        await client.query(
          `INSERT INTO lp_connection_matches
           (lp_target_id, team_member_id, linkedin_connection_id, match_type, match_confidence)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (lp_target_id, team_member_id, match_type) DO UPDATE
           SET match_confidence = EXCLUDED.match_confidence`,
          [lp.id, tmId, match.connectionId || null, match.type, match.confidence]
        );
      }

      // Determine best connector
      const bestMatchResult = await client.query(
        `SELECT team_member_id, match_type, match_confidence
         FROM lp_connection_matches
         WHERE lp_target_id = $1
         ORDER BY match_confidence DESC, match_type = 'direct_email' DESC
         LIMIT 1`,
        [lp.id]
      );

      let bestConnectorId = null;
      let connectionStrength = 'none';

      if (bestMatchResult.rows.length > 0) {
        bestConnectorId = bestMatchResult.rows[0].team_member_id;
        const matchType = bestMatchResult.rows[0].match_type;

        if (matchType === 'direct_email') {
          connectionStrength = 'direct';
        } else if (matchType === 'direct_name') {
          connectionStrength = 'direct';
        } else if (matchType === 'company_match') {
          connectionStrength = 'company_match';
        } else {
          connectionStrength = 'mutual';
        }
      }

      // Count total connectors for this LP
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

    // Map CSV columns to database fields
    const normalizedRows = parsedRows.map(row => {
      const firstName =
        row['first name'] || row['firstname'] || row['first_name'] || '';
      const lastName = row['last name'] || row['lastname'] || row['last_name'] || '';
      const fullName = `${firstName} ${lastName}`.trim();

      return {
        first_name: firstName,
        last_name: lastName,
        full_name: fullName || row['name'] || row['full name'] || '',
        email: row['email address'] || row['email'] || '',
        company: row['company'] || '',
        position: row['position'] || row['title'] || '',
        connected_on: row['connected on'] || row['date connected'] || null,
      };
    });

    // Insert connections
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete old connections for this team member
      await client.query('DELETE FROM linkedin_connections WHERE team_member_id = $1', [id]);

      for (const row of normalizedRows) {
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
        [normalizedRows.filter(r => r.full_name).length, id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Trigger matching algorithm
    await runMatching();

    res.json({ message: 'Connections imported successfully', count: normalizedRows.length });
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
      limit = 50,
    } = req.query;

    let query = 'SELECT * FROM lp_targets WHERE 1=1';
    const params = [];

    // Filters
    if (status) {
      query += ' AND outreach_status = $' + (params.length + 1);
      params.push(status);
    }

    if (min_score) {
      query += ' AND fit_score >= $' + (params.length + 1);
      params.push(parseInt(min_score));
    }

    if (has_connector === 'true') {
      query += ' AND best_connector_id IS NOT NULL';
    } else if (has_connector === 'false') {
      query += ' AND best_connector_id IS NULL';
    }

    if (search) {
      const searchTerm = `%${search}%`;
      query += ` AND (full_name ILIKE $${params.length + 1} OR company ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1})`;
      params.push(searchTerm);
    }

    // Sorting
    const validSortFields = ['fit_score', 'connection_strength', 'last_outreach_at', 'created_at'];
    const sortField = validSortFields.includes(sort_by) ? sort_by : 'fit_score';
    query += ` ORDER BY ${sortField} DESC`;

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
        tm.id, tm.full_name, lcm.match_type, lcm.match_confidence
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

    res.json({
      lp_target: lp,
      connectors,
      activity_log: activity,
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
    await runMatching();
    res.json({ message: 'Matching algorithm completed successfully' });
  } catch (err) {
    console.error('Error running matching algorithm:', err);
    res.status(500).json({ error: 'Failed to run matching algorithm' });
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

module.exports = router;
