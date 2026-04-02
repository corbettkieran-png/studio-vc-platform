require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const migration = `
-- ============================================================
-- Studio VC LP Outreach Module - Database Schema
-- ============================================================

-- Team members whose LinkedIn networks are uploaded
CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  full_name VARCHAR(255) NOT NULL,
  linkedin_url VARCHAR(500),
  connections_count INT DEFAULT 0,
  last_upload_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Imported LinkedIn connections (from CSV exports)
CREATE TABLE IF NOT EXISTS linkedin_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  full_name VARCHAR(255),
  email VARCHAR(255),
  company VARCHAR(500),
  position VARCHAR(500),
  connected_on DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- LP targets (imported from Google Sheets CSV)
CREATE TABLE IF NOT EXISTS lp_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  company VARCHAR(500),
  title VARCHAR(500),
  phone VARCHAR(100),
  linkedin_url VARCHAR(500),
  -- LP fit scoring fields
  fund_type VARCHAR(100),
  estimated_aum VARCHAR(100),
  typical_check_size VARCHAR(100),
  sector_interest TEXT[],
  geographic_focus VARCHAR(255),
  -- Scoring
  fit_score INT DEFAULT 0,
  -- Connector mapping (denormalized for fast reads)
  best_connector_id UUID REFERENCES team_members(id),
  best_connector_name VARCHAR(255),
  connection_strength VARCHAR(50),
  total_connectors INT DEFAULT 0,
  -- Outreach tracking
  outreach_status VARCHAR(50) DEFAULT 'not_started'
    CHECK (outreach_status IN ('not_started','identified','intro_requested','intro_made','meeting_scheduled','in_discussions','committed','passed','not_now')),
  outreach_owner_id UUID REFERENCES users(id),
  last_outreach_at TIMESTAMPTZ,
  notes TEXT,
  -- Metadata
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Connection matches (links LP targets to team members via LinkedIn connections)
CREATE TABLE IF NOT EXISTS lp_connection_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_target_id UUID NOT NULL REFERENCES lp_targets(id) ON DELETE CASCADE,
  team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  linkedin_connection_id UUID REFERENCES linkedin_connections(id),
  match_type VARCHAR(50) NOT NULL,
  match_confidence INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(lp_target_id, team_member_id, match_type)
);

-- LP outreach activity log
CREATE TABLE IF NOT EXISTS lp_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_target_id UUID NOT NULL REFERENCES lp_targets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_linkedin_conn_team ON linkedin_connections(team_member_id);
CREATE INDEX IF NOT EXISTS idx_linkedin_conn_name ON linkedin_connections(full_name);
CREATE INDEX IF NOT EXISTS idx_linkedin_conn_company ON linkedin_connections(company);
CREATE INDEX IF NOT EXISTS idx_lp_targets_status ON lp_targets(outreach_status);
CREATE INDEX IF NOT EXISTS idx_lp_targets_score ON lp_targets(fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_lp_matches_target ON lp_connection_matches(lp_target_id);
CREATE INDEX IF NOT EXISTS idx_lp_matches_team ON lp_connection_matches(team_member_id);
CREATE INDEX IF NOT EXISTS idx_lp_activity ON lp_activity_log(lp_target_id, created_at DESC);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running LP outreach migrations...');
    await client.query(migration);
    console.log('LP outreach migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
