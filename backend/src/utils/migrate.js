require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const migration = `
-- ============================================================
-- Studio VC Deal Flow Platform - Database Schema
-- ============================================================

-- Users / Team members
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(255) NOT NULL,
  role          VARCHAR(50) NOT NULL DEFAULT 'analyst'
                CHECK (role IN ('admin','partner','analyst')),
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Submissions (founder-facing intake)
CREATE TABLE IF NOT EXISTS submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Founder info
  founder_name    VARCHAR(255) NOT NULL,
  founder_email   VARCHAR(255) NOT NULL,
  founder_phone   VARCHAR(100),
  founder_linkedin VARCHAR(500),
  -- Company info
  company_name    VARCHAR(255) NOT NULL,
  one_liner       TEXT,
  website         VARCHAR(500),
  sector          VARCHAR(100) NOT NULL,
  stage           VARCHAR(100) NOT NULL,
  -- Metrics
  arr             VARCHAR(100),
  mrr             VARCHAR(100),
  yoy_growth      VARCHAR(100),
  fundraising_amount VARCHAR(100),
  -- Files
  deck_filename   VARCHAR(500),
  deck_path       VARCHAR(1000),
  video_filename  VARCHAR(500),
  video_path      VARCHAR(1000),
  -- Screening
  status          VARCHAR(50) NOT NULL DEFAULT 'matched'
                  CHECK (status IN ('matched','reviewing','contacted','passed','rejected')),
  match_score     JSONB,
  rejection_reasons JSONB,
  -- Metadata
  submitted_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Internal notes (team collaboration)
CREATE TABLE IF NOT EXISTS notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Activity log (audit trail)
CREATE TABLE IF NOT EXISTS activity_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   UUID REFERENCES submissions(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  action          VARCHAR(100) NOT NULL,
  details         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Progress checks (for rejected companies)
CREATE TABLE IF NOT EXISTS progress_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  checked_by      UUID REFERENCES users(id),
  summary         TEXT,
  sources         JSONB,
  checked_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Email notifications queue
CREATE TABLE IF NOT EXISTS email_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email        VARCHAR(255) NOT NULL,
  subject         VARCHAR(500) NOT NULL,
  body            TEXT NOT NULL,
  status          VARCHAR(50) DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','failed')),
  attempts        INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  sent_at         TIMESTAMPTZ
);

-- Screening config (editable thesis criteria)
CREATE TABLE IF NOT EXISTS screening_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             VARCHAR(100) UNIQUE NOT NULL,
  value           JSONB NOT NULL,
  updated_by      UUID REFERENCES users(id),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Add AI deck analysis column (idempotent)
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS deck_analysis JSONB;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS deck_analysis_status VARCHAR(50);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS deck_analysis_error TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS deck_analyzed_at TIMESTAMPTZ;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_sector ON submissions(sector);
CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_submission ON notes(submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_submission ON activity_log(submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_progress_submission ON progress_checks(submission_id, checked_at DESC);

-- Insert default screening config
INSERT INTO screening_config (key, value) VALUES
  ('sectors', '["fintech","b2b_saas","enterprise_ai"]'),
  ('stages', '["seed"]'),
  ('min_arr', '"250000"'),
  ('min_yoy_growth', '"100"'),
  ('growth_na_exempt', 'true')
ON CONFLICT (key) DO NOTHING;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');
    await client.query(migration);
    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
