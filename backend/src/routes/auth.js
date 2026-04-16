const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─── Login brute-force protection ─────────────────────────────────────────────
// Tracks failed attempts per email. In-memory (resets on restart) — good enough
// for a single-server setup. Replace with Redis for multi-instance deployments.
const loginAttempts = new Map();
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(email) {
  const key = email.toLowerCase().trim();
  const now = Date.now();
  const record = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  if (record.lockedUntil > now) {
    const remaining = Math.ceil((record.lockedUntil - now) / 60000);
    return { blocked: true, message: `Too many failed attempts. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.` };
  }
  return { blocked: false };
}

function recordLoginFailure(email) {
  const key = email.toLowerCase().trim();
  const now = Date.now();
  const record = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
    record.count = 0;
  }
  loginAttempts.set(key, record);
}

function clearLoginFailures(email) {
  loginAttempts.delete(email.toLowerCase().trim());
}

// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts.entries()) {
    if (v.lockedUntil < now - LOCKOUT_MS) loginAttempts.delete(k);
  }
}, 60 * 60 * 1000);

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Brute-force check before hitting the DB
    const rateCheck = checkLoginRateLimit(email);
    if (rateCheck.blocked) {
      return res.status(429).json({ error: rateCheck.message });
    }

    const { rows } = await db.query(
      'SELECT id, email, password_hash, full_name, role FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase().trim()]
    );

    if (!rows.length) {
      recordLoginFailure(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    const valid = user.password_hash && await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      recordLoginFailure(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    clearLoginFailures(email);
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.full_name, role: user.role },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/google — verify Google ID token and return a Studio VC JWT
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Google credential required' });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(501).json({ error: 'Google auth not configured on this server' });
    }

    // Verify the ID token issued by Google
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Invalid Google credential' });
    }

    const { email, name, sub: googleId } = payload;
    if (!email) {
      return res.status(400).json({ error: 'No email returned from Google' });
    }

    // Optional domain restriction — e.g. ALLOWED_GOOGLE_DOMAINS=studio.vc,studiovc.com
    const allowedDomains = process.env.ALLOWED_GOOGLE_DOMAINS;
    if (allowedDomains) {
      const domain = email.split('@')[1];
      const allowed = allowedDomains.split(',').map(d => d.trim().toLowerCase());
      if (!allowed.includes(domain.toLowerCase())) {
        return res.status(403).json({
          error: `Access restricted to: ${allowedDomains}. Contact your admin.`,
        });
      }
    }

    // Find existing user by google_id or email
    const { rows } = await db.query(
      `SELECT id, email, full_name, role, is_active, google_id
       FROM users WHERE google_id = $1 OR email = $2
       LIMIT 1`,
      [googleId, email.toLowerCase()]
    );

    let user;
    if (rows.length > 0) {
      user = rows[0];
      if (!user.is_active) {
        return res.status(403).json({ error: 'Account disabled. Contact your admin.' });
      }
      // Link google_id if this user signed up with a password before
      if (!user.google_id) {
        await db.query('UPDATE users SET google_id = $1, updated_at = NOW() WHERE id = $2', [googleId, user.id]);
      }
    } else {
      // First-time Google sign-in — create the user as analyst
      const { rows: created } = await db.query(
        `INSERT INTO users (email, full_name, google_id, role)
         VALUES ($1, $2, $3, 'analyst')
         RETURNING id, email, full_name, role`,
        [email.toLowerCase(), name, googleId]
      );
      user = created[0];
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.full_name, role: user.role },
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/users (admin only — invite team member)
router.post('/users', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { email, full_name, role, password } = req.body;
    if (!email || !full_name || !password) {
      return res.status(400).json({ error: 'Email, name, and password required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4) RETURNING id, email, full_name, role`,
      [email.toLowerCase().trim(), passwordHash, full_name, role || 'analyst']
    );

    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
