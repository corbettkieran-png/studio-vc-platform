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
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'https://app.clay.com',
    'https://studio-vc-platform.vercel.app',
  ],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    console.log('Auto-migrate: contacts schema applied.');
  } catch (err) {
    console.error('Auto-migrate error:', err.message);
  }
}
autoMigrate();

// Auto-seed if users table is empty
async function autoSeed() {
  try {
    const { rows } = await db.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
      console.log('No users found — running auto-seed...');
      const passwordHash = await bcrypt.hash('demo123', 10);
      const users = [
        { email: 'kcorbett@studio.vc', name: 'Kieran Corbett', role: 'admin' },
        { email: 'analyst@studiovc.com', name: 'Demo Analyst', role: 'analyst' },
      ];
      for (const u of users) {
        await db.query(
          `INSERT INTO users (id, email, password_hash, full_name, role)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
          [uuid(), u.email, passwordHash, u.name, u.role]
        );
      }
      console.log('Auto-seed complete. Login: kieran@studiovc.com / demo123');
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

// Process email queue every 30 seconds
setInterval(processEmailQueue, 30000);

// Error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Studio VC API running on port ${PORT}`);
});

module.exports = app;
