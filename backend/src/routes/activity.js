const express = require('express');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/activity — global activity feed
router.get('/', authenticate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;

    const { rows } = await db.query(
      `SELECT a.*, u.full_name as user_name, s.company_name
       FROM activity_log a
       LEFT JOIN users u ON a.user_id = u.id
       LEFT JOIN submissions s ON a.submission_id = s.id
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ activity: rows });
  } catch (err) {
    console.error('Activity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
