const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { getConfig, screenSubmission } = require('../services/screening');
const { notifyNewSubmission, notifyStatusChange } = require('../services/email');
const { analyzeSubmission } = require('../services/deckAnalysis');

const router = express.Router();

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || './uploads'),
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'deck') {
      const allowed = ['.pdf', '.pptx', '.ppt', '.key'];
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowed.includes(ext)) return cb(new Error('Deck must be PDF, PPTX, PPT, or KEY'));
    }
    if (file.fieldname === 'video') {
      const allowed = ['.mp4', '.mov', '.webm'];
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowed.includes(ext)) return cb(new Error('Video must be MP4, MOV, or WebM'));
    }
    cb(null, true);
  },
});

const uploadFields = upload.fields([
  { name: 'deck', maxCount: 1 },
  { name: 'video', maxCount: 1 },
]);

// ─── PUBLIC: Submit a deck ───────────────────────────────────────

// POST /api/submissions
router.post('/', (req, res) => {
  uploadFields(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const {
        founder_name, founder_email, founder_phone, founder_linkedin,
        company_name, one_liner, website, sector, stage,
        arr, mrr, yoy_growth, fundraising_amount,
        intro_source_name, intro_source_email, intro_source_notes,
      } = req.body;

      // Validate required fields
      if (!founder_name || !founder_email || !company_name || !sector || !stage) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Screen against thesis
      const config = await getConfig();
      const screenResult = screenSubmission({ sector, stage, arr, yoy_growth }, config);

      // File paths
      const deckFile = req.files?.deck?.[0];
      const videoFile = req.files?.video?.[0];

      // Resolve intro source: try existing contact by email, else create stub
      let introContactId = null;
      const introName = intro_source_name?.trim();
      const introEmail = intro_source_email?.trim();
      if (introName || introEmail) {
        try {
          if (introEmail) {
            const existing = await db.query(
              'SELECT id FROM contacts WHERE LOWER(email) = LOWER($1) LIMIT 1',
              [introEmail]
            );
            if (existing.rows.length) {
              introContactId = existing.rows[0].id;
            }
          }
          if (!introContactId && introName) {
            const created = await db.query(
              `INSERT INTO contacts (full_name, email, source, relationship_strength)
               VALUES ($1, $2, 'inbound_form', 'cold')
               RETURNING id`,
              [introName, introEmail || null]
            );
            introContactId = created.rows[0].id;
          }
        } catch (e) {
          console.error('Intro source resolution error:', e.message);
        }
      }

      const { rows } = await db.query(
        `INSERT INTO submissions
         (founder_name, founder_email, founder_phone, founder_linkedin,
          company_name, one_liner, website, sector, stage,
          arr, mrr, yoy_growth, fundraising_amount,
          deck_filename, deck_path, video_filename, video_path,
          status, match_score, rejection_reasons,
          intro_source_contact_id, intro_source_raw_name, intro_source_raw_email, intro_source_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING id, company_name, status`,
        [
          founder_name, founder_email, founder_phone || null, founder_linkedin || null,
          company_name, one_liner || null, website || null, sector, stage,
          arr || null, mrr || null, yoy_growth || null, fundraising_amount || null,
          deckFile?.originalname || null, deckFile?.path || null,
          videoFile?.originalname || null, videoFile?.path || null,
          screenResult.status,
          JSON.stringify(screenResult.checks),
          JSON.stringify(screenResult.rejectionReasons),
          introContactId,
          introName || null,
          introEmail || null,
          intro_source_notes?.trim() || null,
        ]
      );

      const submission = rows[0];

      // Activity log
      await db.query(
        `INSERT INTO activity_log (submission_id, action, details)
         VALUES ($1, 'submitted', $2)`,
        [submission.id, JSON.stringify({
          company: company_name,
          matched: screenResult.matched,
          checks: screenResult.checks,
        })]
      );

      // Email notification (async, don't block response)
      notifyNewSubmission(
        { company_name, founder_name, sector, stage, arr },
        screenResult
      ).catch((e) => console.error('Notification error:', e));

      // AI deck analysis (async, non-blocking)
      if (deckFile) {
        analyzeSubmission(submission.id).catch((e) =>
          console.error('Deck analysis error:', e)
        );
      }

      res.status(201).json({
        id: submission.id,
        company: company_name,
        status: screenResult.status,
        screening: screenResult,
      });
    } catch (err) {
      console.error('Submission error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// ─── AUTHENTICATED: CRM endpoints ───────────────────────────────

// GET /api/submissions — list all with filters
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, sector, search, sort, order, limit, offset } = req.query;

    let where = [];
    let params = [];
    let i = 1;

    if (status) {
      // Support comma-separated statuses for pipeline view
      const statuses = status.split(',');
      where.push(`status = ANY($${i}::varchar[])`);
      params.push(statuses);
      i++;
    }
    if (sector) {
      where.push(`sector = $${i}`);
      params.push(sector);
      i++;
    }
    if (search) {
      where.push(`(company_name ILIKE $${i} OR founder_name ILIKE $${i} OR one_liner ILIKE $${i})`);
      params.push(`%${search}%`);
      i++;
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortCol = ['submitted_at', 'company_name', 'status', 'arr'].includes(sort) ? sort : 'submitted_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    const { rows } = await db.query(
      `SELECT s.*,
        (SELECT COUNT(*) FROM notes WHERE submission_id = s.id) as note_count,
        (SELECT COUNT(*) FROM progress_checks WHERE submission_id = s.id) as check_count
       FROM submissions s
       ${whereClause}
       ORDER BY ${sortCol} ${sortOrder}
       LIMIT ${lim} OFFSET ${off}`,
      params
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) as total FROM submissions ${whereClause}`, params
    );

    res.json({ submissions: rows, total: parseInt(countRows[0].total) });
  } catch (err) {
    console.error('List error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/submissions/stats
router.get('/stats', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'matched') as matched,
        COUNT(*) FILTER (WHERE status = 'reviewing') as reviewing,
        COUNT(*) FILTER (WHERE status = 'contacted') as contacted,
        COUNT(*) FILTER (WHERE status = 'passed') as passed,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
        COUNT(*) FILTER (WHERE submitted_at > NOW() - INTERVAL '7 days') as last_7d,
        COUNT(*) FILTER (WHERE submitted_at > NOW() - INTERVAL '30 days') as last_30d,
        COUNT(*) FILTER (WHERE video_path IS NOT NULL) as with_video
      FROM submissions
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/submissions/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*,
              c.id   AS intro_contact_id,
              c.full_name AS intro_contact_name,
              c.email     AS intro_contact_email,
              c.company   AS intro_contact_company,
              c.title     AS intro_contact_title,
              c.linkedin_url AS intro_contact_linkedin,
              c.relationship_strength AS intro_contact_strength
       FROM submissions s
       LEFT JOIN contacts c ON c.id = s.intro_source_contact_id
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    // Get notes
    const notes = await db.query(
      `SELECT n.*, u.full_name as author_name
       FROM notes n JOIN users u ON n.user_id = u.id
       WHERE n.submission_id = $1 ORDER BY n.created_at DESC`,
      [req.params.id]
    );

    // Get activity
    const activity = await db.query(
      `SELECT a.*, u.full_name as user_name
       FROM activity_log a LEFT JOIN users u ON a.user_id = u.id
       WHERE a.submission_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [req.params.id]
    );

    // Get progress checks
    const checks = await db.query(
      `SELECT pc.*, u.full_name as checked_by_name
       FROM progress_checks pc LEFT JOIN users u ON pc.checked_by = u.id
       WHERE pc.submission_id = $1 ORDER BY pc.checked_at DESC`,
      [req.params.id]
    );

    res.json({
      ...rows[0],
      notes: notes.rows,
      activity: activity.rows,
      progress_checks: checks.rows,
    });
  } catch (err) {
    console.error('Detail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/submissions/:id/status
router.patch('/:id/status', authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['matched', 'reviewing', 'contacted', 'passed', 'rejected'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const { rows: current } = await db.query('SELECT * FROM submissions WHERE id = $1', [req.params.id]);
    if (!current.length) return res.status(404).json({ error: 'Not found' });

    const oldStatus = current[0].status;

    await db.query(
      'UPDATE submissions SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, req.params.id]
    );

    // Log activity
    await db.query(
      `INSERT INTO activity_log (submission_id, user_id, action, details)
       VALUES ($1, $2, 'status_change', $3)`,
      [req.params.id, req.user.id, JSON.stringify({ from: oldStatus, to: status })]
    );

    // Notify team
    notifyStatusChange(current[0], oldStatus, status, req.user.id)
      .catch((e) => console.error('Notification error:', e));

    res.json({ status, previous: oldStatus });
  } catch (err) {
    console.error('Status update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/submissions/:id/notes
router.post('/:id/notes', authenticate, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Note content required' });

    const { rows } = await db.query(
      `INSERT INTO notes (submission_id, user_id, content)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.user.id, content.trim()]
    );

    // Log activity
    await db.query(
      `INSERT INTO activity_log (submission_id, user_id, action, details)
       VALUES ($1, $2, 'note_added', $3)`,
      [req.params.id, req.user.id, JSON.stringify({ preview: content.trim().substring(0, 100) })]
    );

    res.status(201).json({ ...rows[0], author_name: req.user.full_name });
  } catch (err) {
    console.error('Note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/submissions/:id/progress-check
router.post('/:id/progress-check', authenticate, async (req, res) => {
  try {
    const { summary, sources } = req.body;

    const { rows } = await db.query(
      `INSERT INTO progress_checks (submission_id, checked_by, summary, sources)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, req.user.id, summary || 'Automated check', JSON.stringify(sources || [])]
    );

    // Log activity
    await db.query(
      `INSERT INTO activity_log (submission_id, user_id, action, details)
       VALUES ($1, $2, 'progress_check', $3)`,
      [req.params.id, req.user.id, JSON.stringify({ summary: summary?.substring(0, 100) })]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Progress check error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/submissions/analytics/overview
router.get('/analytics/overview', authenticate, async (req, res) => {
  try {
    // Submissions by sector
    const bySector = await db.query(
      `SELECT sector, COUNT(*) as count, status
       FROM submissions GROUP BY sector, status ORDER BY count DESC`
    );

    // Submissions over time (last 12 weeks)
    const overTime = await db.query(
      `SELECT date_trunc('week', submitted_at) as week, COUNT(*) as count, status
       FROM submissions
       WHERE submitted_at > NOW() - INTERVAL '12 weeks'
       GROUP BY week, status ORDER BY week`
    );

    // Conversion funnel
    const funnel = await db.query(
      `SELECT status, COUNT(*) as count FROM submissions GROUP BY status`
    );

    // Average time in each status (days)
    const avgTime = await db.query(
      `SELECT status,
        AVG(EXTRACT(EPOCH FROM (updated_at - submitted_at)) / 86400)::numeric(10,1) as avg_days
       FROM submissions GROUP BY status`
    );

    // Top sectors by match rate
    const matchRate = await db.query(
      `SELECT sector,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status != 'rejected') as matched,
        ROUND(100.0 * COUNT(*) FILTER (WHERE status != 'rejected') / NULLIF(COUNT(*), 0), 1) as match_pct
       FROM submissions GROUP BY sector HAVING COUNT(*) >= 2 ORDER BY match_pct DESC`
    );

    res.json({
      by_sector: bySector.rows,
      over_time: overTime.rows,
      funnel: funnel.rows,
      avg_time: avgTime.rows,
      match_rate: matchRate.rows,
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/submissions/:id/intro-source — set or change the referring contact
router.patch('/:id/intro-source', authenticate, async (req, res) => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid submission id' });
  try {
    const { contact_id, full_name, email, company, title, notes, relationship_strength } = req.body;
    if (relationship_strength && !['close','warm','weak','cold'].includes(relationship_strength)) {
      return res.status(400).json({ error: 'Invalid relationship_strength' });
    }

    let resolvedId = contact_id || null;
    if (resolvedId && !UUID_RE.test(resolvedId)) {
      return res.status(400).json({ error: 'Invalid contact_id' });
    }
    if (resolvedId) {
      const { rowCount } = await db.query('SELECT 1 FROM contacts WHERE id = $1', [resolvedId]);
      if (!rowCount) return res.status(404).json({ error: 'Contact not found' });
    }

    // If no contact_id given, try to find or create one
    if (!resolvedId && (full_name || email)) {
      if (email) {
        const existing = await db.query(
          'SELECT id FROM contacts WHERE LOWER(email) = LOWER($1) LIMIT 1',
          [email]
        );
        if (existing.rows.length) resolvedId = existing.rows[0].id;
      }
      if (!resolvedId && full_name) {
        const created = await db.query(
          `INSERT INTO contacts
            (full_name, email, company, title, relationship_strength, source, created_by)
           VALUES ($1,$2,$3,$4,$5,'manual',$6)
           RETURNING id`,
          [
            full_name.trim(),
            email?.trim() || null,
            company?.trim() || null,
            title?.trim() || null,
            relationship_strength || 'warm',
            req.user.id,
          ]
        );
        resolvedId = created.rows[0].id;
      }
    }

    const { rowCount } = await db.query(
      `UPDATE submissions
       SET intro_source_contact_id = $1,
           intro_source_notes = COALESCE($2, intro_source_notes),
           updated_at = NOW()
       WHERE id = $3`,
      [resolvedId, notes?.trim() || null, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });

    await db.query(
      `INSERT INTO activity_log (submission_id, user_id, action, details)
       VALUES ($1, $2, 'intro_source_set', $3)`,
      [req.params.id, req.user.id, JSON.stringify({ contact_id: resolvedId })]
    );

    // Return joined view
    const { rows } = await db.query(
      `SELECT c.* FROM contacts c WHERE c.id = $1`,
      [resolvedId]
    );
    res.json({ ok: true, contact: rows[0] || null });
  } catch (err) {
    console.error('Intro source update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/submissions/:id/analyze — re-run AI deck analysis
router.post('/:id/analyze', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM submissions WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // Allow analysis without a deck — deckAnalysis handles missing deck_path gracefully

    // Fire off synchronously so caller sees result
    const result = await analyzeSubmission(req.params.id);
    if (!result.ok) return res.status(500).json({ error: result.error || result.reason || 'Analysis failed' });
    res.json({ ok: true, analysis: result.analysis });
  } catch (err) {
    console.error('Re-analyze error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
