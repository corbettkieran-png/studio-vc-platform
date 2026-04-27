require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const submissionRoutes = require('./routes/submissions');
const activityRoutes = require('./routes/activity');
const lpOutreachRoutes = require('./routes/lp-outreach');
const contactsRoutes = require('./routes/contacts');
const { processEmailQueue } = require('./services/email');
const db = require('./config/db');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Middleware
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'https://studio-vc-platform.vercel.app',
];
// Allow Clay webhook origin only if explicitly configured
if (process.env.CLAY_ORIGIN) allowedOrigins.push(process.env.CLAY_ORIGIN);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman in dev)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin === o || origin.startsWith(o))) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// Body size limits — prevent oversized JSON payloads
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Static file serving for uploads (authenticated)
app.use('/uploads', express.static(path.resolve(uploadDir)));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/lp', lpOutreachRoutes);
app.use('/api/contacts', contactsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auto-migrate idempotent schema additions on every boot
async function autoMigrate() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name           VARCHAR(255) NOT NULL,
        email               VARCHAR(255),
        company             VARCHAR(255),
        title               VARCHAR(255),
        linkedin_url        VARCHAR(500),
        relationship_strength VARCHAR(20) DEFAULT 'warm'
                            CHECK (relationship_strength IN ('close','warm','weak','cold')),
        source              VARCHAR(20) DEFAULT 'manual',
        external_id         VARCHAR(255),
        notes               TEXT,
        enriched_data       JSONB,
        created_by          UUID REFERENCES users(id),
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email_lower
        ON contacts (LOWER(email)) WHERE email IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts (LOWER(full_name));
      CREATE INDEX IF NOT EXISTS idx_contacts_strength ON contacts (relationship_strength);

      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS intro_source_contact_id UUID
        REFERENCES contacts(id) ON DELETE SET NULL;
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS intro_source_raw_name VARCHAR(255);
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS intro_source_raw_email VARCHAR(255);
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS intro_source_notes TEXT;

      CREATE INDEX IF NOT EXISTS idx_submissions_intro_source
        ON submissions (intro_source_contact_id);
    `);
    // Manual connections table (Navigator-sourced warm paths)
    await db.query(`
      CREATE TABLE IF NOT EXISTS lp_manual_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lp_target_id UUID NOT NULL REFERENCES lp_targets(id) ON DELETE CASCADE,
        name VARCHAR(500) NOT NULL,
        relationship VARCHAR(500),
        linkedin_url TEXT,
        added_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_lp_manual_conn_target ON lp_manual_connections(lp_target_id);
    `);

    // LP CRM enhancement columns
    await db.query(`
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS next_followup_at DATE;
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'medium'
        CHECK (priority IN ('high', 'medium', 'low'));
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS estimated_aum TEXT;
    `);

    // LP Research Intelligence columns
    await db.query(`
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS research_data JSONB DEFAULT NULL;
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS researched_at TIMESTAMPTZ DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_lp_targets_researched ON lp_targets(researched_at DESC NULLS LAST);
    `);

    // Deduplicate lp_targets: keep the oldest row per company name, delete the rest
    await db.query(`
      DELETE FROM lp_targets
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY LOWER(TRIM(company))
              ORDER BY imported_at ASC NULLS LAST, id ASC
            ) AS rn
          FROM lp_targets
        ) ranked
        WHERE rn > 1
      )
    `);

    // Google OAuth: add google_id column and make password_hash nullable
    await db.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
    `);

    // One-time: update admin email from old seed value to correct address
    await db.query(`
      UPDATE users SET email = 'kcorbett@studio.vc'
      WHERE email = 'kieran@studiovc.com'
    `);
    // Reset failed/stuck emails so they're retried after SMTP → Resend API switch
    await db.query(`
      UPDATE email_queue SET status = 'pending', attempts = 0
      WHERE status IN ('failed', 'pending') AND attempts > 0
    `);

    // Add linkedin_url column to linkedin_connections if not present
    await db.query(`
      ALTER TABLE linkedin_connections ADD COLUMN IF NOT EXISTS linkedin_url VARCHAR(500);
    `);

    // Pre-create Joseph Coyne's user account so Google SSO links correctly (role: admin)
    await db.query(`
      INSERT INTO users (id, email, full_name, role)
      VALUES (gen_random_uuid(), 'jcoyne@studio.vc', 'Joseph Coyne', 'admin')
      ON CONFLICT (email) DO NOTHING
    `);

    console.log('Auto-migrate: contacts schema applied.');
  } catch (err) {
    console.error('Auto-migrate error:', err.message);
  }
}
autoMigrate();

// Auto-seed if users table is empty
// In production, only seeds the primary admin (no demo credentials)
async function autoSeed() {
  try {
    const { rows } = await db.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) > 0) return; // already have users

    const isProd = process.env.NODE_ENV === 'production';
    console.log(`No users found — running auto-seed (${isProd ? 'production' : 'development'})...`);

    // Primary admin — password must be set via ADMIN_PASSWORD env var in production
    const adminPassword = process.env.ADMIN_PASSWORD || (isProd ? null : 'demo123');
    if (!adminPassword) {
      console.error('ADMIN_PASSWORD env var required in production for initial seed. Skipping.');
      return;
    }
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await db.query(
      `INSERT INTO users (id, email, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
      [uuid(), 'kcorbett@studio.vc', passwordHash, 'Kieran Corbett', 'admin']
    );

    // Only create demo analyst in development
    if (!isProd) {
      await db.query(
        `INSERT INTO users (id, email, password_hash, full_name, role)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
        [uuid(), 'analyst@studiovc.com', passwordHash, 'Demo Analyst', 'analyst']
      );
      console.log('Dev seed complete. Login: kcorbett@studio.vc / demo123');
    } else {
      console.log('Prod seed complete. Admin: kcorbett@studio.vc');
    }
  } catch (err) {
    console.error('Auto-seed error:', err.message);
  }
}
autoSeed();

// Auto-seed LP targets — inserts any records not already present by company name
async function autoSeedLPTargets() {
  try {
    const lpData = require('./data/lp_seed.json');
    const { rows: countRows } = await db.query('SELECT COUNT(*) FROM lp_targets');
    if (parseInt(countRows[0].count) >= lpData.length) return; // already fully seeded

    console.log(`LP seed: DB has ${countRows[0].count}/${lpData.length} records, seeding missing...`);
    let inserted = 0, skipped = 0;
    for (const r of lpData) {
      try {
        const sectors = r.sector_interest && r.sector_interest.length > 0 ? r.sector_interest : null;
        const result = await db.query(
          `INSERT INTO lp_targets
           (full_name, email, company, fund_type, sector_interest, geographic_focus, outreach_status)
           SELECT $1, $2, $3, $4, $5, $6, $7
           WHERE NOT EXISTS (
             SELECT 1 FROM lp_targets WHERE LOWER(TRIM(company)) = LOWER(TRIM($3))
           )`,
          [
            r.full_name || '',          // full_name NOT NULL — use empty string if missing
            r.email || null,
            r.company,
            r.fund_type || null,
            sectors,
            r.geographic_focus || null,
            r.outreach_status || 'not_started',
          ]
        );
        if (result.rowCount > 0) inserted++; else skipped++;
      } catch (rowErr) {
        console.error(`LP seed row error (${r.company}):`, rowErr.message);
      }
    }
    console.log(`LP seed complete: ${inserted} inserted, ${skipped} already existed.`);
  } catch (err) {
    console.error('LP auto-seed error:', err.message);
  }
}
autoSeedLPTargets();

// Auto-seed Joseph Coyne's LinkedIn connections (7,776 contacts from his CSV export)
// Runs once: skips if his team_member already has connections loaded.
async function autoSeedJoeConnections() {
  try {
    const connectionsData = require('./data/joe_connections_seed.json');

    // Ensure linkedin_url column exists before bulk insert (autoMigrate runs concurrently
    // so we guard here too — idempotent)
    await db.query('ALTER TABLE linkedin_connections ADD COLUMN IF NOT EXISTS linkedin_url VARCHAR(500)');

    // Ensure Joe's user account exists (idempotent — autoMigrate also does this,
    // but both functions start concurrently so we upsert here too to be safe)
    await db.query(`
      INSERT INTO users (id, email, full_name, role)
      VALUES (gen_random_uuid(), 'jcoyne@studio.vc', 'Joseph Coyne', 'admin')
      ON CONFLICT (email) DO NOTHING
    `);
    const { rows: userRows } = await db.query(
      "SELECT id FROM users WHERE email = 'jcoyne@studio.vc' LIMIT 1"
    );
    if (!userRows.length) return;

    const userId = userRows[0].id;

    // Get or create Joe's team_member record
    let { rows: tmRows } = await db.query(
      'SELECT id, connections_count FROM team_members WHERE user_id = $1',
      [userId]
    );

    let teamMemberId;
    if (tmRows.length > 0) {
      // Already seeded if connections_count matches
      if (parseInt(tmRows[0].connections_count) >= connectionsData.length) {
        return; // fully seeded
      }
      teamMemberId = tmRows[0].id;
    } else {
      const { rows: created } = await db.query(
        "INSERT INTO team_members (id, user_id, full_name) VALUES (gen_random_uuid(), $1, 'Joseph Coyne') RETURNING id",
        [userId]
      );
      teamMemberId = created[0].id;
    }

    console.log(`Joe connections seed: inserting ${connectionsData.length} connections...`);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM linkedin_connections WHERE team_member_id = $1', [teamMemberId]);

      for (const r of connectionsData) {
        let connectedDate = null;
        if (r.connected_on) {
          const parsed = new Date(r.connected_on);
          if (!isNaN(parsed.getTime())) connectedDate = parsed.toISOString().split('T')[0];
        }
        await client.query(
          `INSERT INTO linkedin_connections
           (id, team_member_id, first_name, last_name, full_name, email, company, position, linkedin_url, connected_on)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            teamMemberId,
            r.first_name || null,
            r.last_name || null,
            r.full_name,
            r.email || null,
            r.company || null,
            r.position || null,
            r.linkedin_url || null,
            connectedDate,
          ]
        );
      }

      await client.query(
        'UPDATE team_members SET connections_count = $1, last_upload_at = NOW() WHERE id = $2',
        [connectionsData.length, teamMemberId]
      );
      await client.query('COMMIT');
      console.log(`Joe connections seed complete: ${connectionsData.length} connections inserted.`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Joe connections seed error:', err.message);
  }
}
autoSeedJoeConnections();

// Auto-seed Kieran Corbett's LinkedIn connections (2,177 contacts from his CSV export)
async function autoSeedKieranConnections() {
  try {
    const connectionsData = require('./data/kieran_connections_seed.json');

    await db.query('ALTER TABLE linkedin_connections ADD COLUMN IF NOT EXISTS linkedin_url VARCHAR(500)');

    const { rows: userRows } = await db.query(
      "SELECT id FROM users WHERE email = 'kcorbett@studio.vc' LIMIT 1"
    );
    if (!userRows.length) return;
    const userId = userRows[0].id;

    let { rows: tmRows } = await db.query(
      'SELECT id, connections_count FROM team_members WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
      [userId]
    );

    let teamMemberId;
    if (tmRows.length > 0) {
      if (parseInt(tmRows[0].connections_count) >= connectionsData.length) return; // already seeded
      teamMemberId = tmRows[0].id;
    } else {
      const { rows: created } = await db.query(
        "INSERT INTO team_members (id, user_id, full_name) VALUES (gen_random_uuid(), $1, 'Kieran Corbett') RETURNING id",
        [userId]
      );
      teamMemberId = created[0].id;
    }

    console.log(`Kieran connections seed: inserting ${connectionsData.length} connections...`);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM linkedin_connections WHERE team_member_id = $1', [teamMemberId]);

      for (const r of connectionsData) {
        let connectedDate = null;
        if (r.connected_on) {
          const parsed = new Date(r.connected_on);
          if (!isNaN(parsed.getTime())) connectedDate = parsed.toISOString().split('T')[0];
        }
        await client.query(
          `INSERT INTO linkedin_connections
           (id, team_member_id, first_name, last_name, full_name, email, company, position, linkedin_url, connected_on)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [teamMemberId, r.first_name || null, r.last_name || null, r.full_name,
           r.email || null, r.company || null, r.position || null, r.linkedin_url || null, connectedDate]
        );
      }

      await client.query(
        'UPDATE team_members SET connections_count = $1, last_upload_at = NOW() WHERE id = $2',
        [connectionsData.length, teamMemberId]
      );
      await client.query('COMMIT');
      console.log(`Kieran connections seed complete: ${connectionsData.length} connections inserted.`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Kieran connections seed error:', err.message);
  }
}
autoSeedKieranConnections();

// Process email queue every 30 seconds
setInterval(processEmailQueue, 30000);

// Global error handler — catches any unhandled express errors
app.use((err, req, res, _next) => {
  // Multer file size / type errors → 400
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum 10 MB.' });
  }
  if (err.message === 'Only CSV files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  // CORS errors → 403
  if (err.message?.startsWith('CORS:')) {
    return res.status(403).json({ error: 'Request blocked by CORS policy.' });
  }
  console.error('Unhandled error:', err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

// Prevent unhandled promise rejections from crashing the process
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection:', reason);
  // Log but do NOT exit — Railway will restart on crash anyway,
  // but we want the server to keep serving other requests
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  // For truly unexpected exceptions, exit and let Railway restart cleanly
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`Studio VC API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;
