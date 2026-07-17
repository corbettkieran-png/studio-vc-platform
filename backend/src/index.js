require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const { migrateRestoreLPs } = require('./utils/migrate-restore-lps');
const authRoutes = require('./routes/auth');
const submissionRoutes = require('./routes/submissions');
const activityRoutes = require('./routes/activity');
const lpOutreachRoutes = require('./routes/lp-outreach');
const contactsRoutes = require('./routes/contacts');
const { processEmailQueue } = require('./services/email');
const { authenticate } = require('./middleware/auth');
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
    if (allowedOrigins.some(o => origin === o)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// Security headers
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled — frontend handles its own

// Rate limiting — public endpoints only
const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please try again later.' },
});
app.use('/api/submissions', submissionLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/google', authLimiter);

// Body size limits — prevent oversized JSON payloads
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Static file serving for uploads — gated behind JWT auth
// Pitch decks and founder videos must not be publicly accessible by URL
app.use('/uploads', authenticate, express.static(path.resolve(uploadDir)));

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

    // One-time dedup: keep the oldest row per company name, delete the rest.
    // Guarded by a migration_flags table so it never runs again after the first pass.
    await db.query(`
      CREATE TABLE IF NOT EXISTS migration_flags (
        flag_key VARCHAR(100) PRIMARY KEY,
        ran_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const { rows: dedupFlag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_targets_dedup_v1'`
    );
    if (!dedupFlag.length) {
      const { rowCount } = await db.query(`
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
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_targets_dedup_v1')`);
      if (rowCount > 0) console.log(`LP dedup migration: removed ${rowCount} duplicate rows.`);
    }

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
    // One-time: reset failed/stuck emails after SMTP → Resend API switch
    const { rows: emailResetFlag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'email_queue_reset_v1'`
    ).catch(() => ({ rows: [] }));
    if (!emailResetFlag.length) {
      await db.query(`
        UPDATE email_queue SET status = 'pending', attempts = 0
        WHERE status IN ('failed', 'pending') AND attempts > 0
      `);
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('email_queue_reset_v1')`).catch(() => {});
    }

    // Add linkedin_url column to linkedin_connections if not present
    await db.query(`
      ALTER TABLE linkedin_connections ADD COLUMN IF NOT EXISTS linkedin_url VARCHAR(500);
    `);

    // Add email engagement tracking columns to lp_targets
    await db.query(`
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS last_email_opened_at TIMESTAMPTZ;
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS last_email_clicked_at TIMESTAMPTZ;
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS email_open_count INT DEFAULT 0;
      ALTER TABLE lp_targets ADD COLUMN IF NOT EXISTS email_click_count INT DEFAULT 0;
    `);

    // Email events table for Resend webhook tracking
    await db.query(`
      CREATE TABLE IF NOT EXISTS lp_email_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lp_target_id UUID REFERENCES lp_targets(id) ON DELETE CASCADE,
        resend_email_id VARCHAR(255),
        event_type VARCHAR(50),
        occurred_at TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_lp_email_events_target ON lp_email_events(lp_target_id);
      CREATE INDEX IF NOT EXISTS idx_lp_email_events_resend ON lp_email_events(resend_email_id);
    `);

    // Bulk-recalculate fit scores for all LP targets using the updated scoring function.
    // We pull all rows and compute in JS so the same logic is used everywhere.
    {
      const { computeFitScoreForMigration } = require('./routes/lp-outreach');
      if (computeFitScoreForMigration) {
        const { rows: allLPs } = await db.query('SELECT * FROM lp_targets');
        let rescored = 0;
        for (const lp of allLPs) {
          const score = computeFitScoreForMigration(lp);
          if (score > 0) {
            await db.query('UPDATE lp_targets SET fit_score = $1 WHERE id = $2', [score, lp.id]);
            rescored++;
          }
        }
        if (rescored > 0) console.log(`Fit score migration: rescored ${rescored} LP targets.`);
      }
    }

    // Pre-create Joseph Coyne's user account so Google SSO links correctly (role: admin)
    await db.query(`
      INSERT INTO users (id, email, full_name, role)
      VALUES (gen_random_uuid(), 'jcoyne@studio.vc', 'Joseph Coyne', 'admin')
      ON CONFLICT (email) DO NOTHING
    `);

    // Promote known team Google accounts to admin (handles accounts already created
    // before the OAuth role fix was deployed)
    await db.query(`
      UPDATE users SET role = 'admin'
      WHERE email IN ('corbett.kieran@gmail.com')
        AND role <> 'admin'
    `);

    // Add work_email to team_members — allows a separate display email in signatures
    // distinct from the Google OAuth login email
    await db.query(`
      ALTER TABLE team_members ADD COLUMN IF NOT EXISTS work_email VARCHAR(255);
    `);

    // Add title to team_members — used in email signatures so each colleague's
    // emails show their actual role rather than a hardcoded fallback
    await db.query(`
      ALTER TABLE team_members ADD COLUMN IF NOT EXISTS title VARCHAR(255);
    `);

    // Seed work emails for known team members
    await db.query(`
      UPDATE team_members SET work_email = 'kcorbett@studio.vc'
      WHERE full_name ILIKE '%kieran%' AND (work_email IS NULL OR work_email = '');
      UPDATE team_members SET work_email = 'jcoyne@studio.vc'
      WHERE full_name ILIKE '%joseph%' OR full_name ILIKE '%joe%coyne%'
      AND (work_email IS NULL OR work_email = '');
    `);

    // Seed default titles for known team members (only sets when null/empty)
    await db.query(`
      UPDATE team_members SET title = 'Senior Associate, Studio VC'
      WHERE full_name ILIKE '%kieran%' AND (title IS NULL OR title = '');
      UPDATE team_members SET title = 'Partner, Studio VC'
      WHERE (full_name ILIKE '%joseph%' OR full_name ILIKE '%joe%coyne%')
      AND (title IS NULL OR title = '');
    `);

    // ── Prior fund tracking ───────────────────────────────────
    // Tracks whether an LP invested in Fund I, Fund II, or both.
    await db.query(`
      ALTER TABLE lp_targets
        ADD COLUMN IF NOT EXISTS prior_fund TEXT DEFAULT NULL;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'lp_targets_prior_fund_check'
        ) THEN
          ALTER TABLE lp_targets
            ADD CONSTRAINT lp_targets_prior_fund_check
            CHECK (prior_fund IN ('fund_i', 'fund_ii', 'both'));
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_lp_targets_prior_fund
        ON lp_targets(prior_fund)
        WHERE prior_fund IS NOT NULL;
    `);

    // ── Categorise Fund I / Fund II LPs from definitive email list ───────────
    // Source: Mailchimp segment export (subscribed_email_segment_export_b44d81a473.xlsx)
    // Replaces the imprecise date-range approach that tagged ~230 records incorrectly.
    // One-time migration; boot-time connections INSERT below handles new imports.
    const { rows: priorFundFlag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_prior_fund_correct_2026_07'`
    );
    if (!priorFundFlag.length) {
      // Email lists derived from TAGS column in the Mailchimp export
      const FUND_I_EMAILS = [
        'winters.daniel@gmail.com', 'jeffrshafer@gmail.com',
        'patrick.m.clinton@irscounsel.treas.gov', 'clark@nebari.us',
        'anderslynch@hotmail.com', 'gjmmorales@gmail.com', 'dan@nebari.us',
        'patrickmclinton@yahoo.com', 'dhassett@summitrepartners.com',
        'jfin481@gmail.com', 'mmamatc@icloud.com', 'michael@inisheerpartners.com',
      ];
      const FUND_II_EMAILS = [
        'federico.jost@blueopalcapital.com', 'jessica.s.chow@gmail.com',
        'wmsmurray@gmail.com', 'mtorbert@5cpartners.com', 'neal.shear@gmail.com',
        'amiramir@gmail.com', 'john.r.niehaus@gmail.com', 'ggs@msg.com',
        'aharatz@propuscapital.com', 'hemanshunpatel@gmail.com',
        'seibert.nicholas@gmail.com', 'eric@jamali.net',
        'sebastien.dejong@blueopalcapital.com', 'stephen.cohen@scohenplanning.com',
        'rsteinberg@propuscapital.com', 'jmeriwether@jmadvisorsllc.com',
        'douglas.munsey@gmail.com', 'rniehaus@gcpcapital.com', 'chifu.huang@gmail.com',
      ];
      const BOTH_EMAILS = [
        'lcovillo@gmail.com', 'jcoyne@studio.vc', 'jcovillo@gmail.com',
        'lesliejr55@gmail.com', 'dballen@gmail.com', 'rzenker@overbrook.com',
        'anselmi.lillian@gmail.com', 'liam@studio.vc', 'rweiss328@gmail.com',
        'tcb@zmlp.com', 'mg@zmlp.com', 'michaelluftman@hotmail.com',
        'lynchvab@gmail.com', 'lanselmi@marlboroughinvestments.com',
        'nicolelauralynch@hotmail.com', 'pingpongdiplomat@gmail.com',
        'brucehack1@gmail.com', 'nateleung@gmail.com', 'cneider@clearviewcap.com',
      ];
      const ALL_FUND_EMAILS = [...FUND_I_EMAILS, ...FUND_II_EMAILS, ...BOTH_EMAILS];

      // Reset any prior_fund values that were set by the old date-range approach
      await db.query(`UPDATE lp_targets SET prior_fund = NULL WHERE prior_fund IS NOT NULL`);

      // Apply correct categories based on email
      const { rowCount: tagged } = await db.query(`
        UPDATE lp_targets
        SET prior_fund = CASE
          WHEN lower(trim(email)) = ANY($1) THEN 'both'
          WHEN lower(trim(email)) = ANY($2) THEN 'fund_i'
          WHEN lower(trim(email)) = ANY($3) THEN 'fund_ii'
        END
        WHERE lower(trim(email)) = ANY($4)
      `, [BOTH_EMAILS, FUND_I_EMAILS, FUND_II_EMAILS, ALL_FUND_EMAILS]);

      // Remove auto-inserted connections from the old (imprecise) batch so the
      // boot-time INSERT below re-adds only the correct ~50 LPs.
      await db.query(`
        DELETE FROM lp_manual_connections
        WHERE name = 'Kieran Corbett' AND relationship = 'Existing LP'
      `);

      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_prior_fund_correct_2026_07')`);
      console.log(`Prior fund correction: tagged ${tagged} LP records from definitive email list (Fund I: ${FUND_I_EMAILS.length}, Fund II: ${FUND_II_EMAILS.length}, Both: ${BOTH_EMAILS.length}).`);
    }

    // ── Performance indexes ────────────────────────────────────
    // These are all CREATE INDEX IF NOT EXISTS so safe to run every boot.
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_lp_targets_fit_score
        ON lp_targets (fit_score DESC NULLS LAST);
      CREATE INDEX IF NOT EXISTS idx_lp_targets_outreach_status
        ON lp_targets (outreach_status);
      CREATE INDEX IF NOT EXISTS idx_lp_targets_company_lower
        ON lp_targets (lower(trim(company)));
      CREATE INDEX IF NOT EXISTS idx_lp_conn_matches_target
        ON lp_connection_matches (lp_target_id);
      CREATE INDEX IF NOT EXISTS idx_lp_conn_matches_team
        ON lp_connection_matches (team_member_id);
      CREATE INDEX IF NOT EXISTS idx_linkedin_conn_team
        ON linkedin_connections (team_member_id);
      CREATE INDEX IF NOT EXISTS idx_linkedin_conn_company_lower
        ON linkedin_connections (lower(trim(company)));
    `);

    // ── Restore 278 LPs deleted during dedup op (2026-07-07) ─────────
    // Runs BEFORE dedup_v2 so restored records aren't immediately re-deduped.
    const { rows: restoreFlag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_restore_deleted_2026_07'`
    );
    if (!restoreFlag.length) {
      const inserted = await migrateRestoreLPs(db);
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_restore_deleted_2026_07')`);
      console.log(`LP restore migration complete: ${inserted} records re-inserted.`);
    }

    // ── Dedup v2: by full_name + company (v1 only deduped by company alone) ──
    const { rows: dedupV2Flag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_targets_dedup_v2'`
    );
    if (!dedupV2Flag.length) {
      const { rowCount } = await db.query(`
        DELETE FROM lp_targets
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY lower(trim(full_name)), lower(trim(company))
                ORDER BY
                  (CASE WHEN email IS NOT NULL THEN 0 ELSE 1 END),
                  (CASE WHEN linkedin_url IS NOT NULL THEN 0 ELSE 1 END),
                  imported_at ASC NULLS LAST,
                  id ASC
              ) AS rn
            FROM lp_targets
          ) ranked
          WHERE rn > 1
        )
      `);
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_targets_dedup_v2')`);
      if (rowCount > 0) console.log(`LP dedup v2: removed ${rowCount} duplicate rows.`);
    }

    // ── Fund I/II investors → lp_manual_connections (idempotent) ────────────
    // Any LP with prior_fund set is a known Fund I or Fund II investor.
    // Insert them as Joe Coyne's direct connection ('Existing LP') so they
    // surface in the Warm Intros direct-connections panel automatically.
    // Runs on every boot; WHERE NOT EXISTS prevents duplicates.

    // One-time: swap any entries that were previously inserted under Kieran's name
    const { rows: joeSwapFlag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_conn_owner_joe_2026_07'`
    );
    if (!joeSwapFlag.length) {
      await db.query(`
        DELETE FROM lp_manual_connections
        WHERE name = 'Kieran Corbett' AND relationship = 'Existing LP'
      `);
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_conn_owner_joe_2026_07')`);
    }

    const { rowCount: connInserted } = await db.query(`
      INSERT INTO lp_manual_connections (lp_target_id, name, relationship, added_by)
      SELECT
        lt.id,
        'Joe Coyne',
        'Existing LP',
        (SELECT id FROM users WHERE email = 'jcoyne@studio.vc' LIMIT 1)
      FROM lp_targets lt
      WHERE lt.prior_fund IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM lp_manual_connections mc
          WHERE mc.lp_target_id = lt.id
            AND mc.name          = 'Joe Coyne'
            AND mc.relationship  = 'Existing LP'
        )
    `);
    if (connInserted > 0) {
      console.log(`Fund LP connections: added ${connInserted} Fund I/II investors as Joe Coyne direct connections.`);
    }

    // ── LinkedIn URLs for Fund I/II LPs confirmed from team connection CSVs ────
    // 24 email→URL mappings sourced from Joe's LinkedIn export (July 2026).
    // Flexible name matching was used (Dan→Daniel, Bob→Robert, Sébastien accent).
    // Only sets URL when currently NULL — won't overwrite any manually entered values.
    const { rows: linkedinUrlFlag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_linkedin_urls_fund_lps_2026_07'`
    );
    if (!linkedinUrlFlag.length) {
      const LP_LINKEDIN_URLS = [
        ['winters.daniel@gmail.com',            'https://www.linkedin.com/in/dan-winters-75805331'],
        ['clark@nebari.us',                      'https://www.linkedin.com/in/clark-gillam-79010827'],
        ['gjmmorales@gmail.com',                 'https://www.linkedin.com/in/gabriel-m-6625b2140'],
        ['dan@nebari.us',                        'https://www.linkedin.com/in/daniel-freuman-1a5a861'],
        ['michael@inisheerpartners.com',         'https://www.linkedin.com/in/michaelspellacy'],
        ['jessica.s.chow@gmail.com',            'https://www.linkedin.com/in/jessica-chow-1844963a'],
        ['wmsmurray@gmail.com',                  'https://www.linkedin.com/in/scot-murray-18266223'],
        ['mtorbert@5cpartners.com',              'https://www.linkedin.com/in/marques-torbert-b35b5913'],
        ['amiramir@gmail.com',                   'https://www.linkedin.com/in/amirbakhtiar'],
        ['john.r.niehaus@gmail.com',             'https://www.linkedin.com/in/john-niehaus-aaaa0188'],
        ['hemanshunpatel@gmail.com',             'https://www.linkedin.com/in/hemanshunpatel'],
        ['rsteinberg@propuscapital.com',         'https://www.linkedin.com/in/rafael-steinberg-1827015'],
        ['douglas.munsey@gmail.com',             'https://www.linkedin.com/in/douglas-munsey-17407423'],
        ['rzenker@overbrook.com',                'https://www.linkedin.com/in/richard-zenker-808397'],
        ['anselmi.lillian@gmail.com',            'https://www.linkedin.com/in/lillian-anselmi-03931420'],
        ['lanselmi@marlboroughinvestments.com',  'https://www.linkedin.com/in/lillian-anselmi-03931420'],
        ['liam@studio.vc',                       'https://www.linkedin.com/in/liam-lynch-021435'],
        ['mg@zmlp.com',                          'https://www.linkedin.com/in/mukgulati'],
        ['brucehack1@gmail.com',                 'https://www.linkedin.com/in/brucehack'],
        ['nateleung@gmail.com',                  'https://www.linkedin.com/in/nleung'],
        ['dballen@gmail.com',                    'https://www.linkedin.com/in/dballen'],
        ['dhassett@summitrepartners.com',        'https://www.linkedin.com/in/daniel-hassett-2294055'],
        ['rniehaus@gcpcapital.com',              'https://www.linkedin.com/in/robert-niehaus-3821843b'],
        ['sebastien.dejong@blueopalcapital.com', 'https://www.linkedin.com/in/s%C3%A9bastien-de-jong-55b5118'],
      ];
      let urlsSet = 0;
      for (const [email, url] of LP_LINKEDIN_URLS) {
        const { rowCount } = await db.query(`
          UPDATE lp_targets
          SET linkedin_url = $1
          WHERE lower(trim(email)) = $2
            AND (linkedin_url IS NULL OR linkedin_url = '')
        `, [url, email]);
        urlsSet += rowCount;
      }
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_linkedin_urls_fund_lps_2026_07')`);
      console.log(`Fund LP LinkedIn URLs: set ${urlsSet} URLs from confirmed Joe Coyne connection data.`);
    }

    // ── LinkedIn URLs for Fund I/II LPs sourced from Apollo enrichment (July 2026) ─
    // Second pass: 6 additional LPs confirmed via Apollo People Match API.
    // Note: Alan Haratz email prefix "a" makes his email aharatz@propuscapital.com —
    // confirmed via Propus Capital employment history in Apollo response.
    const { rows: apolloUrlFlag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_linkedin_urls_apollo_2026_07'`
    );
    if (!apolloUrlFlag.length) {
      const APOLLO_LINKEDIN_URLS = [
        ['federico.jost@blueopalcapital.com',  'https://www.linkedin.com/in/federico-a-jost'],
        ['neal.shear@gmail.com',               'https://www.linkedin.com/in/neal-shear-b32745a'],
        ['aharatz@propuscapital.com',           'https://www.linkedin.com/in/alan-haratz-57a4584'],
        ['eric@jamali.net',                    'https://www.linkedin.com/in/eric-rosenfeld-5a78805'],
        ['jcoyne@studio.vc',                   'https://www.linkedin.com/in/coynejoseph'],
        ['cneider@clearviewcap.com',           'https://www.linkedin.com/in/calvin-neider-2300321b'],
      ];
      let apolloUrlsSet = 0;
      for (const [email, url] of APOLLO_LINKEDIN_URLS) {
        const { rowCount } = await db.query(`
          UPDATE lp_targets
          SET linkedin_url = $1
          WHERE lower(trim(email)) = $2
            AND (linkedin_url IS NULL OR linkedin_url = '')
        `, [url, email]);
        apolloUrlsSet += rowCount;
      }
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_linkedin_urls_apollo_2026_07')`);
      console.log(`Fund LP LinkedIn URLs (Apollo): set ${apolloUrlsSet} additional URLs from Apollo enrichment.`);
    }

    // ── LinkedIn URLs confirmed via Sales Navigator + web search (July 2026) ────
    // Michael Luftman  → SN profile navigation + Joe's connections seed confirmation
    // Chi-Fu Huang     → SN search (private investor, Wilson WY, member 4028197)
    // Jeff Shafer      → SN search (Aura Equity, Dallas; LinkedIn: jjshafer)
    const { rows: snUrlFlag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_linkedin_urls_sn_2026_07'`
    );
    if (!snUrlFlag.length) {
      const SN_LINKEDIN_URLS = [
        ['michaelluftman@hotmail.com', 'https://www.linkedin.com/in/michaelluftmanhudsonwealthadvs'],
        ['chifu.huang@gmail.com',      'https://www.linkedin.com/in/chi-fu-huang-1714231'],
        ['jeffrshafer@gmail.com',      'https://www.linkedin.com/in/jjshafer'],
      ];
      let snUrlsSet = 0;
      for (const [email, url] of SN_LINKEDIN_URLS) {
        const { rowCount } = await db.query(`
          UPDATE lp_targets SET linkedin_url = $1
          WHERE lower(trim(email)) = $2 AND (linkedin_url IS NULL OR linkedin_url = '')
        `, [url, email]);
        snUrlsSet += rowCount;
      }
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_linkedin_urls_sn_2026_07')`);
      console.log(`Fund LP LinkedIn URLs (Sales Navigator): set ${snUrlsSet} additional URLs from SN + web search.`);
    }

    // ── Warm intro connections confirmed via Apollo enrichment (July 2026) ──────
    // Marques Torbert (Fund II, ex-Lazard IB) → Kenneth Colton at Lazard
    // Neal Shear (Fund II, ex-Apollo Global Management Partner) → Kevin Crowe at Apollo Manager LLC
    // Inserts into lp_manual_connections so they surface in the Warm Intros tab.
    const { rows: warmIntroFlag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_warm_intros_apollo_2026_07'`
    );
    if (!warmIntroFlag.length) {
      const WARM_INTROS = [
        {
          targetEmail: 'kenneth.colton@lazard.com',
          connectorName: 'Marques Torbert',
          relationship: 'Fund II LP — ex-Lazard IB Analyst; can warm intro to Lazard AM team',
          linkedinUrl: 'https://www.linkedin.com/in/marques-torbert-b35b5913',
        },
        {
          targetEmail: 'kcrowe@apollo.com',
          connectorName: 'Neal Shear',
          relationship: 'Fund II LP — ex-Apollo Global Management Partner (Commodities); can warm intro to Apollo AM',
          linkedinUrl: 'https://www.linkedin.com/in/neal-shear-b32745a',
        },
      ];
      let warmIntrosSet = 0;
      for (const intro of WARM_INTROS) {
        const { rows: targets } = await db.query(
          `SELECT id FROM lp_targets WHERE lower(trim(email)) = $1 LIMIT 1`,
          [intro.targetEmail.toLowerCase()]
        );
        if (targets.length > 0) {
          const { rowCount } = await db.query(`
            INSERT INTO lp_manual_connections (lp_target_id, name, relationship, linkedin_url)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
          `, [targets[0].id, intro.connectorName, intro.relationship, intro.linkedinUrl]);
          warmIntrosSet += rowCount;
        }
      }
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_warm_intros_apollo_2026_07')`);
      console.log(`Warm intro connections: inserted ${warmIntrosSet} confirmed paths from Apollo enrichment.`);
    }

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

// Repair LP full_name values that were garbled by the original CSV parse.
// Runs on every deploy: matches records by company name and overwrites full_name
// only when it differs from the canonical seed value. Fully idempotent.
async function repairLPNames() {
  try {
    const lpData = require('./data/lp_seed.json');
    let fixed = 0;
    for (const r of lpData) {
      if (!r.full_name || !r.company) continue;
      const result = await db.query(
        `UPDATE lp_targets
         SET full_name = $1
         WHERE LOWER(TRIM(company)) = LOWER(TRIM($2))
           AND full_name IS DISTINCT FROM $1`,
        [r.full_name, r.company]
      );
      fixed += result.rowCount;
    }
    if (fixed > 0) console.log(`LP name repair: updated ${fixed} records.`);
  } catch (err) {
    console.error('LP name repair error:', err.message);
  }
}
repairLPNames();

// Pattern-based name cleaning applied to ALL lp_targets rows (covers records added
// after the initial seed — i.e. the ~136 CSV-imported extras not in lp_seed.json).
// Idempotent: only updates rows where full_name actually changes.
async function cleanAllLPNames() {
  try {
    const { rows } = await db.query(`SELECT id, full_name FROM lp_targets WHERE full_name IS NOT NULL`);

    const ASSET_PREFIXES = [
      'Venture Capital','Private Equity','Public Equity','Fixed Income','Real Estate',
      'Hedge Funds','Hedge Fund','Private Credit','Digital Asset','Infrastructure',
      'Others','Other','Capital','Funds','Fund','Income','Equity','Estate','Credit',
    ];
    const TITLE_SUFFIXES = [
      /\s+(Co-)?Founder\b.*/i, /\s+CEO\b.*/i, /\s+CFO\b.*/i, /\s+CIO\b.*/i, /\s+COO\b.*/i,
      /\s+(Managing\s+)?(Director|Partner|Member)\b.*/i, /\s+General\s+Partner\b.*/i,
      /\s+Venture\s+Partner\b.*/i, /\s+President\b.*/i, /\s+Chief\b.*/i,
      /\s+Shareholder\b.*/i, /\s+Geschäftsführer\b.*/i, /\s+bei\s+.*/i,
      /\s+Relationship\s+Manager\b.*/i, /\s+Principal\b.*/i, /\s+Associate\b.*/i,
      /\s+Analyst\b.*/i, /\s+Chairman\b.*/i, /\s+Advisor\b.*/i, /\s+Officer\b.*/i,
      /\s+--$/, /,\s+[A-Z].+$/, /\s+Forest\b.*/i, /\s+Founding\b.*/i,
    ];
    const PURE_TITLES = new Set([
      'ceo','cfo','cio','coo','president','founder','co-founder','managing partner',
      'managing director','general partner','director','partner','officer','analyst',
      'and chief investment officer','and co-chief investment officer',
      'and chief compliance officer','and chief executive officer',
      'executive officer and president','director of operations',
      'compliance officer, wealth advisor','officer, investment advisor representative',
      'real estate management, llc','and chief investment officer',
    ]);
    const COUNTRY_PREFIX = /^(?:United\s+States|United\s+Kingdom|Germany|France|Singapore|Luxembourg|South\s+Korea|China|Japan|Australia|SG|HK)[,\s]+/i;

    function stripAssetPrefix(s) {
      for (let i = 0; i < 4; i++) {
        const before = s;
        for (const ac of ASSET_PREFIXES) {
          const re = new RegExp(`^${ac.replace(/[()]/g,'\\$&')}[,\\s]*`, 'i');
          s = s.replace(re, '').trim();
        }
        if (s === before) break;
      }
      return s;
    }

    function cleanName(raw) {
      let s = raw.trim();
      if (PURE_TITLES.has(s.toLowerCase())) return null;
      // Strip [+N] LinkedIn tags
      s = s.replace(/\[\+\d+\]/g, ' ').trim();
      // Strip country prefix
      s = s.replace(COUNTRY_PREFIX, '').trim();
      // Strip asset class prefixes (multiple passes)
      s = stripAssetPrefix(s);
      // Strip leading lowercase fragment (e.g. "s, ")
      s = s.replace(/^[a-z,\s]+/, '').trim();
      // Insert spaces at camelCase boundaries
      s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
      // Strip title suffixes
      for (const pat of TITLE_SUFFIXES) s = s.replace(pat, '').trim();
      // Second prefix pass after suffix removal
      s = stripAssetPrefix(s);
      // Title-case ALL-CAPS words (not abbreviations)
      s = s.split(' ').map(w =>
        /^[A-Z]{3,}$/.test(w) && !['LLC','LP','LLP','SA','UK','US','CIO','CEO','CFO','COO','AI','VC','KG','III'].includes(w)
          ? w.charAt(0) + w.slice(1).toLowerCase() : w
      ).join(' ');
      // Strip trailing punctuation
      s = s.replace(/[\s\-,.]+$/, '').trim();
      if (!s || PURE_TITLES.has(s.toLowerCase())) return null;
      if (!/^[A-Z]/.test(s)) return null;
      return s;
    }

    let fixed = 0;
    for (const row of rows) {
      const cleaned = cleanName(row.full_name);
      if (cleaned && cleaned !== row.full_name) {
        await db.query(`UPDATE lp_targets SET full_name = $1 WHERE id = $2`, [cleaned, row.id]);
        fixed++;
      }
    }
    if (fixed > 0) console.log(`LP name deep-clean: fixed ${fixed} records.`);
  } catch (err) {
    console.error('LP name deep-clean error:', err.message);
  }
}
cleanAllLPNames();

// Migrate misplaced job titles from geographic_focus → title column.
// During the original CSV import, some records had their contact title
// parsed into geographic_focus instead of title. This function detects
// values that look like job titles (no city/country keywords) and moves
// them. Idempotent: only updates rows where geographic_focus matches
// the title pattern and title is currently null or empty.
async function migrateGeoFocusToTitle() {
  try {
    const TITLE_KEYWORDS = [
      'manager','partner','director','president','officer','analyst',
      'associate','principal','advisor','trustee','chairman','founder',
      'cio','ceo','cfo','coo','head of','investment','portfolio',
      'managing','general partner','venture partner','senior',
      'executive','vice president','vp','svp','evp',
    ];

    // Location keywords — if any appear, it's a real geo value, leave it alone
    const GEO_KEYWORDS = [
      'united states','united kingdom','canada','australia','germany',
      'france','singapore','hong kong','japan','china','india','brazil',
      'europe','asia','pacific','middle east','africa','latin america',
      'new york','california','london','global','domestic','international',
      'north america','south america','emerging market',
    ];

    const { rows } = await db.query(
      `SELECT id, geographic_focus, title
       FROM lp_targets
       WHERE geographic_focus IS NOT NULL
         AND TRIM(geographic_focus) <> ''
         AND (title IS NULL OR TRIM(title) = '')`
    );

    let migrated = 0;
    for (const row of rows) {
      const geo = (row.geographic_focus || '').toLowerCase().trim();

      // Skip if it contains any geo keyword
      const isGeo = GEO_KEYWORDS.some(kw => geo.includes(kw));
      if (isGeo) continue;

      // Treat as a title if it matches a title keyword
      const isTitle = TITLE_KEYWORDS.some(kw => geo.includes(kw));
      if (!isTitle) continue;

      await db.query(
        `UPDATE lp_targets
         SET title = $1, geographic_focus = NULL
         WHERE id = $2`,
        [row.geographic_focus.trim(), row.id]
      );
      migrated++;
    }
    if (migrated > 0) console.log(`LP title migration: moved ${migrated} geo_focus values to title.`);
  } catch (err) {
    console.error('LP title migration error:', err.message);
  }
}
migrateGeoFocusToTitle();

// Remove duplicate LP records — keeps the most data-complete record per
// company (ranked by number of non-null fields), deletes the rest.
// Fully idempotent: only deletes when >1 record shares the same normalised
// company name.
async function deduplicateLPTargets() {
  try {
    // Find all company groups with more than one record
    const { rows: dupeGroups } = await db.query(`
      SELECT LOWER(TRIM(company)) AS norm_company, COUNT(*) AS cnt
      FROM lp_targets
      WHERE company IS NOT NULL AND TRIM(company) <> ''
      GROUP BY LOWER(TRIM(company))
      HAVING COUNT(*) > 1
    `);

    if (dupeGroups.length === 0) return;
    console.log(`LP dedup: found ${dupeGroups.length} companies with duplicates.`);

    let totalDeleted = 0;
    for (const group of dupeGroups) {
      const { rows: records } = await db.query(
        `SELECT id,
          (CASE WHEN full_name  IS NOT NULL AND TRIM(full_name)  <> '' THEN 1 ELSE 0 END +
           CASE WHEN email      IS NOT NULL AND TRIM(email)      <> '' THEN 1 ELSE 0 END +
           CASE WHEN title      IS NOT NULL AND TRIM(title)      <> '' THEN 1 ELSE 0 END +
           CASE WHEN fund_type  IS NOT NULL THEN 1 ELSE 0 END +
           CASE WHEN geographic_focus IS NOT NULL AND TRIM(geographic_focus) <> '' THEN 1 ELSE 0 END +
           CASE WHEN sector_interest IS NOT NULL THEN 1 ELSE 0 END +
           CASE WHEN linkedin_url IS NOT NULL AND TRIM(linkedin_url) <> '' THEN 1 ELSE 0 END +
           CASE WHEN outreach_status IS NOT NULL AND outreach_status <> 'not_started' THEN 2 ELSE 0 END
          ) AS completeness_score
         FROM lp_targets
         WHERE LOWER(TRIM(company)) = $1
         ORDER BY completeness_score DESC, id ASC`,
        [group.norm_company]
      );

      // Keep first (most complete), delete the rest
      const keepId = records[0].id;
      const deleteIds = records.slice(1).map(r => r.id);

      if (deleteIds.length > 0) {
        await db.query(
          `DELETE FROM lp_targets WHERE id = ANY($1::uuid[])`,
          [deleteIds]
        );
        totalDeleted += deleteIds.length;
      }
    }
    if (totalDeleted > 0) console.log(`LP dedup: deleted ${totalDeleted} duplicate records.`);
  } catch (err) {
    console.error('LP dedup error:', err.message);
  }
}
deduplicateLPTargets();

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

// Match surnames for single-name LP targets using the team's LinkedIn connections.
// Strategy: normalise company names (strip fund/LLC/LP/etc suffixes), then require
// that the LP's first name matches a connection's first name AND the normalised
// company names are identical (or one is fully contained in the other).
// Only applies the match when exactly 1 connection qualifies — avoids false positives.
// Gated by migration_flags so it only runs once per database.
async function matchLPSurnamesFromConnections() {
  try {
    // v2 uses word-set containment instead of substring — revert the 3 false
    // positives written by v1 (Aaron Habriga × 2, Steve Ehrlich × 1) before re-running.
    const { rows: v1Flag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_surname_match_v1'`
    );
    const { rows: v4Flag } = await db.query(
      `SELECT 1 FROM migration_flags WHERE flag_key = 'lp_surname_match_v4'`
    );
    if (v4Flag.length) return; // already ran v4

    if (v1Flag.length) {
      // Revert false positives from v1 (substring bug: "sta" matched "highvista", "sol" matched "mirasol")
      await db.query(`
        UPDATE lp_targets SET full_name = 'Aaron'
        WHERE full_name = 'Aaron Habriga'
          AND LOWER(TRIM(company)) IN (
            LOWER('Highvista Private Capital Management Llc'),
            LOWER('SPDGSingle Family Office, Venture Capital FirmBrussels, BelgiumBelgiumInfrastructure, Mobility & Automotive, Cleantech & Sustainability, General Technology, Utilities, Hardware & Electronics, Digital Health (HealthTech)Philippe Mauchardphilippe.mauchard@spdg.be SPE – Serruya Private Equity')
          )
      `);
      await db.query(`
        UPDATE lp_targets SET full_name = 'Steve'
        WHERE full_name = 'Steve Ehrlich'
          AND LOWER(TRIM(company)) = LOWER('Mirasol Capital')
      `);
      console.log('[surname-match] Reverted v1 false positives.');
    }
    // Revert v2 false positive ("us" from "US Capital" matched "Baker Tilly US")
    await db.query(`
      UPDATE lp_targets SET full_name = 'Jeffrey'
      WHERE full_name = 'Jeffrey Pierce'
        AND LOWER(TRIM(company)) = LOWER('US Capital')
    `);
    // Revert v3 false positive ("morgan" from "J.P. Morgan" matched "Morgan Creek Capital")
    await db.query(`
      UPDATE lp_targets SET full_name = 'Dan'
      WHERE full_name = 'Dan Akivis, CFA'
        AND LOWER(TRIM(company)) = LOWER('Morgan Creek Capital Management, LLC')
    `);

    // Fetch single-name LP targets (full_name has no space)
    const { rows: lpTargets } = await db.query(`
      SELECT id, full_name, company
      FROM lp_targets
      WHERE full_name NOT LIKE '% %'
        AND TRIM(full_name) <> ''
        AND company IS NOT NULL AND TRIM(company) <> ''
    `);

    if (lpTargets.length === 0) {
      await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_surname_match_v1')`);
      return;
    }

    // Fetch all team connections that have a non-empty last name
    const { rows: connections } = await db.query(`
      SELECT first_name, last_name, company
      FROM linkedin_connections
      WHERE first_name IS NOT NULL AND TRIM(first_name) <> ''
        AND last_name  IS NOT NULL AND TRIM(last_name)  <> ''
        AND company    IS NOT NULL AND TRIM(company)    <> ''
    `);

    console.log(`[surname-match] ${lpTargets.length} single-name LPs, ${connections.length} connections with surnames`);

    // Common fund/entity suffixes to strip before comparing
    const STRIP_WORDS = new Set([
      'llc','lp','inc','corp','ltd','gp','llp','co','pllc','plc',
      'fund','funds','capital','management','investments','investment',
      'advisors','advisor','partners','partner','group','associates',
      'associate','family','office','offices','wealth','financial',
      'asset','assets','ventures','venture','holdings','holding',
      'equity','properties','property','trust','services','solutions',
      'consulting','consultants','strategies','strategy','markets','market',
    ]);

    function normalizeCompany(raw) {
      if (!raw) return '';
      return raw
        .toLowerCase()
        // remove punctuation except spaces
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        // Require ≥3 chars so ultra-short tokens like "us", "uk", "ny" can't
        // drive a spurious match (e.g. "US Capital" → "us" matching "Baker Tilly US")
        .filter(w => w.length >= 3 && !STRIP_WORDS.has(w))
        .join(' ')
        .trim();
    }

    function companiesMatch(a, b) {
      const na = normalizeCompany(a);
      const nb = normalizeCompany(b);
      if (!na || !nb) return false;
      if (na === nb) return true;
      // Word-set containment: all words in the shorter name must appear
      // as whole words in the longer name.
      // Require shorter.size >= 2: single-word names are too generic for
      // partial matching (e.g. "morgan" from "J.P. Morgan" must not match
      // "Morgan Creek Capital Management").
      const wordsA = new Set(na.split(/\s+/).filter(w => w.length > 0));
      const wordsB = new Set(nb.split(/\s+/).filter(w => w.length > 0));
      const shorter = wordsA.size <= wordsB.size ? wordsA : wordsB;
      const longer  = wordsA.size <= wordsB.size ? wordsB : wordsA;
      if (shorter.size < 2) return false;
      return [...shorter].every(w => longer.has(w));
    }

    let updated = 0;
    let ambiguous = 0;

    for (const lp of lpTargets) {
      const lpFirst = lp.full_name.trim().toLowerCase();

      // First-name matches
      const firstNameMatches = connections.filter(c =>
        c.first_name.trim().toLowerCase() === lpFirst
      );
      if (firstNameMatches.length === 0) continue;

      // Then filter by company similarity
      const companyMatches = firstNameMatches.filter(c =>
        companiesMatch(lp.company, c.company)
      );

      if (companyMatches.length === 1) {
        const match = companyMatches[0];
        // Strip professional credentials appended to last names (e.g. "Akivis, CFA")
        const cleanLastName = match.last_name.trim().replace(/[,\s]+(CFA|MBA|CPA|CFP|JD|MD|PhD|CIO|ESQ|PE|PMP|CAIA|CIMA|CPWA|CFA®|FRM)\b.*/i, '').trim();
        const newName = `${lp.full_name.trim()} ${cleanLastName}`;
        await db.query(
          `UPDATE lp_targets SET full_name = $1 WHERE id = $2`,
          [newName, lp.id]
        );
        console.log(`[surname-match] ✓ ${lp.full_name} @ "${lp.company}" → "${newName}" (matched via connection @ "${match.company}")`);
        updated++;
      } else if (companyMatches.length > 1) {
        console.log(`[surname-match] ambiguous: ${lp.full_name} @ "${lp.company}" — ${companyMatches.length} candidates`);
        ambiguous++;
      }
    }

    await db.query(`INSERT INTO migration_flags (flag_key) VALUES ('lp_surname_match_v4') ON CONFLICT DO NOTHING`);
    console.log(`[surname-match] Complete: ${updated} updated, ${ambiguous} ambiguous, ${lpTargets.length - updated - ambiguous} unmatched.`);
  } catch (err) {
    console.error('[surname-match] Error:', err.message);
  }

  // ── Fix team_member user_id linkage (POST /team bug) ────────────────────
  // The admin-create route stamped user_id = admin's ID on all new team member
  // slots. Clear those and re-link each GP to their actual row.
  const { rows: tmLinkFlag } = await db.query(
    `SELECT 1 FROM migration_flags WHERE flag_key = 'team_member_userid_fix_v1'`
  );
  if (!tmLinkFlag.length) {
    // Clear wrong user_id from non-GP slots (Lillian, Stanley)
    await db.query(`
      UPDATE team_members SET user_id = NULL
      WHERE full_name ILIKE 'lillian anselmi'
        AND user_id = (SELECT id FROM users WHERE email = 'corbett.kieran@gmail.com' LIMIT 1)
    `);
    await db.query(`
      UPDATE team_members SET user_id = NULL
      WHERE full_name ILIKE 'stanley scott'
        AND user_id IS NOT NULL
    `);
    // Link Kieran's actual row + set work email / title
    await db.query(`
      UPDATE team_members
      SET user_id    = (SELECT id FROM users WHERE email = 'corbett.kieran@gmail.com' LIMIT 1),
          work_email = 'kcorbett@studio.vc',
          title      = 'General Partner'
      WHERE id = '1ac41adb-71ff-4c9d-993f-220388f8b896'
    `);
    // Link Joe's row + set work email / title (no-op if Joe has no user account yet)
    await db.query(`
      UPDATE team_members
      SET user_id    = (SELECT id FROM users WHERE email = 'jcoyne@studio.vc' LIMIT 1),
          work_email = 'jcoyne@studio.vc',
          title      = 'General Partner'
      WHERE id = '8928842a-9e8c-4e9f-9ccc-e3cab85b7586'
    `);
    await db.query(
      `INSERT INTO migration_flags (flag_key) VALUES ('team_member_userid_fix_v1')`
    ).catch(() => {});
    console.log('team_member_userid_fix_v1: GP user_id linkage corrected.');
  }
}
matchLPSurnamesFromConnections();

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
