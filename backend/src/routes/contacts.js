const express = require('express');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All contacts routes require auth
router.use(authenticate);

// GET /api/contacts — list / search
router.get('/', async (req, res) => {
  try {
    const { search, strength, sort, limit, offset } = req.query;

    const where = [];
    const params = [];
    let i = 1;

    if (search) {
      where.push(`(full_name ILIKE $${i} OR email ILIKE $${i} OR company ILIKE $${i})`);
      params.push(`%${search}%`);
      i++;
    }
    if (strength) {
      where.push(`relationship_strength = $${i}`);
      params.push(strength);
      i++;
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortCol = ['full_name', 'created_at', 'relationship_strength'].includes(sort)
      ? sort
      : 'full_name';
    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    const { rows } = await db.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM submissions WHERE intro_source_contact_id = c.id) AS deals_sourced,
        (SELECT COUNT(*) FROM submissions
          WHERE intro_source_contact_id = c.id
            AND status IN ('reviewing','contacted')) AS deals_advanced
       FROM contacts c
       ${whereClause}
       ORDER BY ${sortCol} ASC
       LIMIT ${lim} OFFSET ${off}`,
      params
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM contacts ${whereClause}`,
      params
    );

    res.json({ contacts: rows, total: parseInt(countRows[0].total) });
  } catch (err) {
    console.error('Contacts list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/contacts/leaderboard — top sources by deals & advance rate
router.get('/leaderboard', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.full_name, c.email, c.company, c.title,
             c.relationship_strength,
             COUNT(s.id) AS deals_sourced,
             COUNT(s.id) FILTER (
               WHERE s.status IN ('reviewing','contacted')
             ) AS deals_advanced,
             COUNT(s.id) FILTER (WHERE s.status = 'matched') AS deals_matched,
             COUNT(s.id) FILTER (WHERE s.status = 'rejected') AS deals_rejected,
             ROUND(
               100.0 * COUNT(s.id) FILTER (WHERE s.status IN ('reviewing','contacted'))
               / NULLIF(COUNT(s.id), 0), 1
             ) AS advance_rate,
             MAX(s.submitted_at) AS last_referral_at
      FROM contacts c
      LEFT JOIN submissions s ON s.intro_source_contact_id = c.id
      GROUP BY c.id
      HAVING COUNT(s.id) > 0
      ORDER BY deals_sourced DESC, deals_advanced DESC
      LIMIT 100
    `);
    res.json({ leaderboard: rows });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/contacts/:id — single contact + sourced deals
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const deals = await db.query(
      `SELECT id, company_name, founder_name, sector, stage, status, submitted_at
       FROM submissions
       WHERE intro_source_contact_id = $1
       ORDER BY submitted_at DESC`,
      [req.params.id]
    );

    res.json({ ...rows[0], sourced_deals: deals.rows });
  } catch (err) {
    console.error('Contact detail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/contacts — create
router.post('/', async (req, res) => {
  try {
    const {
      full_name, email, company, title, linkedin_url,
      relationship_strength, source, notes,
    } = req.body;

    if (!full_name?.trim()) {
      return res.status(400).json({ error: 'full_name required' });
    }

    // De-dupe by lowercase email if provided
    if (email) {
      const existing = await db.query(
        'SELECT * FROM contacts WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [email.trim()]
      );
      if (existing.rows.length) {
        return res.status(200).json({ ...existing.rows[0], _existing: true });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO contacts
        (full_name, email, company, title, linkedin_url,
         relationship_strength, source, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        full_name.trim(),
        email?.trim() || null,
        company?.trim() || null,
        title?.trim() || null,
        linkedin_url?.trim() || null,
        relationship_strength || 'warm',
        source || 'manual',
        notes?.trim() || null,
        req.user.id,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Contact create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/contacts/:id — update
router.patch('/:id', async (req, res) => {
  try {
    const allowed = [
      'full_name', 'email', 'company', 'title', 'linkedin_url',
      'relationship_strength', 'notes',
    ];
    const sets = [];
    const params = [];
    let i = 1;
    for (const k of allowed) {
      if (k in req.body) {
        sets.push(`${k} = $${i}`);
        params.push(req.body[k] || null);
        i++;
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    sets.push(`updated_at = NOW()`);
    params.push(req.params.id);

    const { rows } = await db.query(
      `UPDATE contacts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Contact update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
