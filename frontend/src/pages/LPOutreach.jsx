import { useState, useEffect, useCallback } from 'react';
import {
  getMyTeamMember, uploadMyLinkedInCSV,
  getLPTeam, addLPTeamMember, removeLPTeamMember, uploadLinkedInCSV,
  importLPTargets, getLPTargets, getLPTarget, updateLPTarget, addLPActivity,
  runLPMatching, getLPStats, getApolloStatus, getApolloContacts,
  getApolloKeyStatus, apolloLiveSearch, apolloBulkEnrich,
  flagKnownContact, unflagKnownContact, enrichLPTarget,
  enrichApolloContact, enrichApolloContactsBatch,
  getClaySettings, saveClaySettings, exportToClay, importClayCSV, getClayWebhookUrl,
  addManualConnection, deleteManualConnection,
} from '../services/api';

const request = (path, opts = {}) => {
  const token = localStorage.getItem('svc_token');
  return fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  }).then(r => r.json());
};
import { useAuth } from '../hooks/useAuth';

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const OUTREACH_STATUS_LABELS = {
  not_started: 'Not Started',
  identified: 'Identified',
  intro_requested: 'Intro Requested',
  intro_made: 'Intro Made',
  meeting_scheduled: 'Meeting Scheduled',
  in_discussions: 'In Discussions',
  committed: 'Committed',
  passed: 'Passed',
  not_now: 'Not Now',
};

const OUTREACH_STATUS_COLORS = {
  not_started: '#9CA3AF',
  identified: '#3B82F6',
  intro_requested: '#F59E0B',
  intro_made: '#10B981',
  meeting_scheduled: '#003B76',
  in_discussions: '#8B5CF6',
  committed: '#059669',
  passed: '#D1D5DB',
  not_now: '#FECACA',
};

const CONNECTION_STRENGTH_LABELS = {
  direct_email: 'Direct Email',
  direct_name: 'Name Match',
  company_match: 'Company',
  apollo_match: 'Apollo',
  none: 'No Connection',
};

const CONNECTION_STRENGTH_COLORS = {
  direct_email: '#059669',
  direct_name: '#10B981',
  company_match: '#F59E0B',
  apollo_match: '#6366F1',
  none: '#9CA3AF',
};

const SENIORITY_ORDER = { c_suite: 0, vp: 1, director: 2, manager: 3, senior: 4 };
const SENIORITY_LABELS = { c_suite: 'C-Suite', vp: 'VP', director: 'Director', manager: 'Manager', senior: 'Senior' };
const SENIORITY_COLORS = { c_suite: '#DC2626', vp: '#7C3AED', director: '#2563EB', manager: '#0891B2', senior: '#6B7280' };

function getFitScoreColor(score) {
  if (score >= 81) return '#059669';
  if (score >= 61) return '#10B981';
  if (score >= 31) return '#F59E0B';
  return '#DC2626';
}

function FitScoreBar({ score }) {
  const color = getFitScoreColor(score);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
      <div style={{ flex: 1, height: 8, background: '#E5E7EB', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', background: color, width: `${Math.min(score, 100)}%` }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color }}>{score}</span>
    </div>
  );
}

function StatusBadge({ status, color }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '4px 8px',
      background: color,
      color: 'white',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: 'nowrap'
    }}>
      {status}
    </span>
  );
}

export default function LPOutreach() {
  const { user } = useAuth();
  const [tab, setTab] = useState('lp-list');
  const [stats, setStats] = useState(null);
  const [targets, setTargets] = useState([]);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('company');
  const [sortDir, setSortDir] = useState('asc');
  const [myTeamMember, setMyTeamMember] = useState(null);
  const [myConnectionsUploading, setMyConnectionsUploading] = useState(false);
  const [teamMembers, setTeamMembers] = useState([]);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberLinkedin, setNewMemberLinkedin] = useState('');
  const [activityAction, setActivityAction] = useState('email_sent');
  const [activityDetails, setActivityDetails] = useState('');
  const [noteText, setNoteText] = useState('');
  const [apolloStats, setApolloStats] = useState(null);
  const [apolloContacts, setApolloContacts] = useState([]);
  const [apolloLoading, setApolloLoading] = useState(false);
  const [apolloKeyStatus, setApolloKeyStatus] = useState(null);
  const [apolloBulkRunning, setApolloBulkRunning] = useState(false);
  const [emailDraft, setEmailDraft] = useState(null);
  const [emailDraftType, setEmailDraftType] = useState('cold');
  const [showEmailDraft, setShowEmailDraft] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);
  const [contactFilter, setContactFilter] = useState('all'); // all, c_suite, vp, director, has_email, known
  const [statusFilter, setStatusFilter] = useState('all'); // outreach status filter for LP list
  const [pageSize] = useState(50);
  const [page, setPage] = useState(0);
  // Clay integration state
  const [claySettings, setClaySettings] = useState(null);
  const [claySyncLog, setClaySyncLog] = useState([]);
  const [clayWebhookUrl, setClayWebhookUrl] = useState('');
  const [clayFormUrl, setClayFormUrl] = useState('');
  const [clayFormSecret, setClayFormSecret] = useState('');
  const [clayFormApiKey, setClayFormApiKey] = useState('');
  const [clayExporting, setClayExporting] = useState(false);
  const [clayConfigSaved, setClayConfigSaved] = useState(false);

  // Manual connections state
  const [showAddConnection, setShowAddConnection] = useState(false);
  const [newConnName, setNewConnName] = useState('');
  const [newConnRelationship, setNewConnRelationship] = useState('');
  const [newConnLinkedin, setNewConnLinkedin] = useState('');
  const [addingConn, setAddingConn] = useState(false);
  // Inline status edit
  const [editingStatusId, setEditingStatusId] = useState(null);
  // Intro email modal
  const [introEmail, setIntroEmail] = useState(null);
  const [generatingIntro, setGeneratingIntro] = useState(false);
  const [researchBrief, setResearchBrief] = useState(null);  // { brief, researched_at }
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState(null);
  // Inline editable fields
  const [editingFollowup, setEditingFollowup] = useState(null); // lpId being edited
  const [editingLastContact, setEditingLastContact] = useState(null); // lpId being edited

  // Generate email draft based on LP target data
  const generateEmailDraft = (type = 'cold') => {
    if (!detail) return;
    const firstName = detail.full_name?.split(' ')[0] || 'there';
    const company = detail.company || 'your firm';
    const connectors = detail.connectors || [];
    const warmPaths = detail.warm_intro_paths || [];
    const sectors = detail.sector_interest || [];
    const fundType = detail.fund_type || '';
    const enrichment = detail.linkedin_enrichment;

    const sectorText = sectors.length > 0
      ? sectors.slice(0, 3).map(s => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).join(', ')
      : 'technology';

    let subject = '';
    let body = '';

    if (type === 'warm_intro' && connectors.length > 0) {
      const connector = connectors[0];
      subject = `Studio VC Fund III — Introduction via ${connector.name}`;
      body = `Hi ${firstName},

${connector.name} suggested I reach out — I'm Kieran Corbett, Senior Associate at Studio VC.

We're currently raising Fund III ($50M target) and I wanted to connect given ${connector.name}'s view that there could be strong alignment with ${company}.

Studio VC focuses exclusively on late-stage seed — companies that are post-product, generating early revenue, and positioned for Series A within 12–18 months. Our portfolio (38 companies across Funds I & II) is collectively valued at over $3B, with Fund II at 2.3x Net TVPI. We invest $750K–$1M as a first check and consistently co-invest alongside firms like QED, Left Lane, and General Catalyst.${fundType ? `\n\nGiven ${company}'s focus on ${fundType.replace(/_/g, ' ')}, I think there's a real conversation to be had around our current pipeline and whether Fund III fits your mandate.` : ''}

Would you have 20 minutes for a brief intro call? Happy to share our deck in advance.

Best,
Kieran Corbett
Senior Associate, Studio VC`;
    } else if (type === 'warm_intro_path' && warmPaths.length > 0) {
      const path = warmPaths[0];
      subject = `Studio VC Fund III — Introduction via ${path.contact_name}`;
      body = `Hi ${firstName},

I'm Kieran Corbett, Senior Associate at Studio VC. I understand you know ${path.contact_name}${path.contact_title ? ` (${path.contact_title})` : ''} — I was hoping that connection might open the door to a brief conversation.

We're currently raising Fund III ($50M target, capped at $60M) and selectively engaging LPs who back high-quality early-stage managers. Studio VC has invested in 38 companies across two funds, with a portfolio collectively valued at over $3B. Fund II sits at 2.3x Net TVPI — and 50% of our seed investments have reached Series A within two years, roughly double the industry average.

Our edge is operational depth. Our Managing Partners bring backgrounds from Broadway.com (former CEO, $600M+ revenue) and Bain Capital Ventures, and we consistently invest ahead of firms including QED, Left Lane, Insight Partners, and General Catalyst.${fundType ? `\n\nGiven ${company}'s focus on ${fundType.replace(/_/g, ' ')}, I believe there's a strong case for a conversation around fit.` : ''}

Would you be open to a 20-minute call? Happy to send our deck ahead of time.

Best,
Kieran Corbett
Senior Associate, Studio VC`;
    } else if (type === 'follow_up') {
      subject = `Following up — Studio VC Fund III`;
      body = `Hi ${firstName},

I wanted to follow up on my earlier note about Studio VC's Fund III raise.

Since we last connected, we've continued to build strong momentum — our Fund II portfolio is now collectively valued at over $3B, and we're seeing compelling late-stage seed deal flow in ${sectorText} that I believe would be of interest to ${company}.

Fund III is a $50M vehicle (capped at $60M) targeting 25 core positions at $750K–$1M first checks. We're actively deploying and have limited LP capacity remaining.

If the timing makes sense, I'd welcome a 20-minute call to walk through our thesis and current pipeline. Happy to send the deck if useful.

Best,
Kieran Corbett
Senior Associate, Studio VC`;
    } else {
      // Cold outreach
      subject = `Studio VC Fund III — Late-Stage Seed, $3B+ Portfolio`;
      body = `Hi ${firstName},

I'm Kieran Corbett, Senior Associate at Studio VC. We're a New York-based venture fund currently raising Fund III ($50M target) and I wanted to reach out given what I know about ${company}.

Studio VC invests exclusively at the late-stage seed — post-product companies with early revenue and a clear path to Series A. It's a de-risked entry point that carries some of the strongest risk-adjusted returns in venture. Our track record reflects that: 38 portfolio companies across Funds I & II, collectively valued at over $3B, with Fund II at 2.3x Net TVPI. 50% of our seed investments have reached Series A within two years — roughly double the industry average.

${fundType ? `Given ${company}'s focus on ${fundType.replace(/_/g, ' ')}, I think there could be meaningful alignment with our deal flow and LP base.` : `We focus on Pure Play SaaS, SaaS-enabled Marketplaces, and FinTech & Enterprise Analytics — sectors where we've built deep pattern recognition over nearly a decade.`}${enrichment?.headline ? ` Your background in ${enrichment.headline.toLowerCase()} also suggests you'd have a strong read on the types of companies we're backing.` : ''}

Fund III is capped at $60M and we're selectively engaging LPs. Would you be open to a 20-minute call? Happy to share our deck in advance.

Best,
Kieran Corbett
Senior Associate, Studio VC`;
    }

    setEmailDraft({ subject, body, to: detail.email || '', type });
    setShowEmailDraft(true);
    setEmailCopied(false);
  };

  // Load dashboard stats
  const loadStats = useCallback(async () => {
    try {
      const data = await getLPStats();
      setStats(data.stats || data);
    } catch (err) {
      console.error('Load stats error:', err);
    }
  }, []);

  // Load LP targets
  const loadTargets = useCallback(async () => {
    try {
      const params = {
        sort_by: sortBy,
        sort_dir: sortDir,
        limit: 2000,
      };
      if (search.trim()) params.search = search.trim();
      const data = await getLPTargets(params);
      setTargets(data.lp_targets || data.targets || []);
    } catch (err) {
      console.error('Load targets error:', err);
    } finally {
      setLoading(false);
    }
  }, [search, sortBy, sortDir]);

  // Load current user's own team_member record (auto-created on first call)
  const loadMyTeamMember = useCallback(async () => {
    try {
      const data = await getMyTeamMember();
      setMyTeamMember(data.team_member || null);
    } catch (err) {
      console.error('Load my team member error:', err);
    }
  }, []);

  // Load team members
  const loadTeamMembers = useCallback(async () => {
    try {
      const data = await getLPTeam();
      setTeamMembers(data.team_members || data.team || []);
    } catch (err) {
      console.error('Load team error:', err);
    }
  }, []);

  // Load Apollo key status (does the backend have an APOLLO_API_KEY?)
  const loadApolloKey = useCallback(async () => {
    try {
      const data = await getApolloKeyStatus();
      setApolloKeyStatus(data);
    } catch (err) {
      console.error('Apollo key status error:', err);
    }
  }, []);

  // Load Apollo stats
  const loadApolloStats = useCallback(async () => {
    try {
      const data = await getApolloStatus();
      setApolloStats(data);
    } catch (err) {
      console.error('Load apollo stats error:', err);
    }
  }, []);

  // Load Clay settings
  const loadClaySettings = useCallback(async () => {
    try {
      const data = await getClaySettings();
      setClaySettings(data.settings);
      setClaySyncLog(data.sync_log || []);
      if (data.settings) {
        setClayFormUrl(data.settings.clay_table_webhook_url || '');
        setClayFormSecret(data.settings.clay_webhook_secret || '');
        setClayFormApiKey(''); // Don't prefill API key for security
      }
      // Also get our webhook URL
      const wh = await getClayWebhookUrl();
      setClayWebhookUrl(wh.webhook_url);
    } catch (err) {
      console.error('Load Clay settings error:', err);
    }
  }, []);

  // Initial loads
  useEffect(() => {
    loadStats();
    loadMyTeamMember();
    loadTeamMembers();
    loadApolloStats();
    loadApolloKey();
    loadClaySettings();
  }, [loadStats, loadMyTeamMember, loadTeamMembers, loadApolloStats, loadApolloKey, loadClaySettings]);

  const runApolloBulkEnrich = async () => {
    if (apolloBulkRunning) return;
    if (!apolloKeyStatus?.has_key) {
      alert('Apollo API key not configured on the backend. Add APOLLO_API_KEY in Railway → Variables and redeploy.');
      return;
    }
    if (!confirm('Run Apollo live search for all LP targets without contacts? This calls the Apollo API and may take a few minutes.')) return;
    setApolloBulkRunning(true);
    try {
      const result = await apolloBulkEnrich(50);
      alert(`Apollo bulk enrich complete:\n${result.processed} LPs processed\n${result.total_inserted} contacts inserted`);
      await loadApolloStats();
      await loadStats();
    } catch (err) {
      alert('Bulk enrich failed: ' + err.message);
    } finally {
      setApolloBulkRunning(false);
    }
  };

  useEffect(() => {
    loadTargets();
  }, [loadTargets]);

  // Load detail when target selected
  useEffect(() => {
    if (!selectedTarget) {
      setDetail(null);
      setApolloContacts([]);
      setResearchBrief(null);
      setResearchError(null);
      return;
    }
    const loadDetail = async () => {
      try {
        const data = await getLPTarget(selectedTarget);
        setDetail({ ...(data.lp_target || data.target), connectors: data.connectors, warm_intro_paths: data.warm_intro_paths || [], linkedin_enrichment: data.linkedin_enrichment || null, activity: data.activity_log, manual_connections: data.manual_connections || [] });
        // Load Apollo contacts for this LP
        setApolloLoading(true);
        try {
          const apolloData = await getApolloContacts(selectedTarget);
          setApolloContacts(apolloData.contacts || []);
        } catch { setApolloContacts([]); }
        setApolloLoading(false);
        // Load cached research brief (if any)
        try {
          const rd = await request(`/lp/targets/${selectedTarget}/research`);
          if (rd.brief) setResearchBrief(rd);
        } catch { /* no cached research — that's fine */ }
      } catch (err) {
        console.error('Load detail error:', err);
      }
    };
    loadDetail();
  }, [selectedTarget]);

  // DASHBOARD TAB
  const renderDashboard = () => {
    if (!stats) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading...</div>;

    return (
      <>
        {/* LinkedIn Export Banner */}
        {stats.team_member_connection_counts?.reduce((sum, t) => sum + (t.connections_count || 0), 0) === 0 && (
          <div style={{
            background: 'linear-gradient(135deg, #EFF6FF, #DBEAFE)',
            border: '1px solid #93C5FD',
            borderRadius: 10, padding: '14px 20px', marginBottom: 20,
            display: 'flex', alignItems: 'center', gap: 12
          }}>
            <span style={{ fontSize: 20 }}>🔗</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#1E40AF', marginBottom: 2 }}>
                LinkedIn Connection Export Pending
              </div>
              <div style={{ fontSize: 12, color: '#3B82F6' }}>
                Your LinkedIn data archive has been requested and should be ready within 24 hours. Once downloaded, upload the Connections.csv in Upload & Setup to activate connection matching across all {stats.total_lps} LP targets.
              </div>
            </div>
          </div>
        )}

        <div className="stats-row">
          <div className="stat-card hl">
            <div className="stat-value">{stats.total_lps}</div>
            <div className="stat-label">Total LPs</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.with_connector}</div>
            <div className="stat-label">With Connections</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{Math.round(stats.avg_fit_score || 0)}</div>
            <div className="stat-label">Avg Fit Score</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.team_member_connection_counts?.length || 0}</div>
            <div className="stat-label">Team Members</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.team_member_connection_counts?.reduce((sum, t) => sum + (t.connections_count || 0), 0) || 0}</div>
            <div className="stat-label">Total Connections</div>
          </div>
        </div>

        {/* Pipeline Funnel */}
        {stats.by_status && Object.keys(stats.by_status).length > 0 && (
          <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Outreach Pipeline</h3>
            <div className="card" style={{ padding: 20 }}>
              {Object.entries(OUTREACH_STATUS_LABELS).map(([status, label]) => {
                const count = stats.by_status[status] || 0;
                const pct = stats.total_lps > 0 ? (count / stats.total_lps) * 100 : 0;
                return (
                  <div key={status} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0',
                    cursor: 'pointer', borderRadius: 4
                  }}
                  onClick={() => { setStatusFilter(status); setTab('lp-list'); setPage(0); }}
                  >
                    <div style={{ width: 110, fontSize: 12, fontWeight: 500, color: 'var(--dark)', flexShrink: 0 }}>
                      {label}
                    </div>
                    <div style={{ flex: 1, height: 22, background: '#F3F4F6', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                      <div style={{
                        height: '100%', background: OUTREACH_STATUS_COLORS[status] || '#9CA3AF',
                        width: `${Math.max(pct, count > 0 ? 2 : 0)}%`, borderRadius: 4,
                        transition: 'width 0.3s ease'
                      }} />
                    </div>
                    <div style={{ width: 36, fontSize: 13, fontWeight: 600, color: 'var(--dark)', textAlign: 'right' }}>
                      {count}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Apollo Enrichment Stats */}
        {apolloStats && (
          <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Apollo Enrichment</h3>
            <div className="stats-row">
              <div className="stat-card" style={{ borderLeft: '3px solid #6366F1' }}>
                <div className="stat-value">{apolloStats.companies_searched || 0}</div>
                <div className="stat-label">Companies Searched</div>
              </div>
              <div className="stat-card" style={{ borderLeft: '3px solid #6366F1' }}>
                <div className="stat-value">{apolloStats.lps_with_apollo_contacts || 0}</div>
                <div className="stat-label">LPs with Contacts</div>
              </div>
              <div className="stat-card" style={{ borderLeft: '3px solid #6366F1' }}>
                <div className="stat-value">{apolloStats.total_apollo_contacts || 0}</div>
                <div className="stat-label">Total Apollo Contacts</div>
              </div>
              <div className="stat-card" style={{ borderLeft: '3px solid #6366F1' }}>
                <div className="stat-value">{apolloStats.total_companies || 0}</div>
                <div className="stat-label">Total Companies</div>
              </div>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
              {apolloStats.companies_searched > 0
                ? `${Math.round((apolloStats.companies_searched / apolloStats.total_companies) * 100)}% of LP companies enriched via Apollo`
                : 'Apollo enrichment in progress — senior contacts are being mapped to your LP targets'}
            </div>
            <div style={{
              marginTop: 12, padding: 10, borderRadius: 6,
              background: apolloKeyStatus?.has_key ? '#ecfdf5' : '#fff7ed',
              border: `1px solid ${apolloKeyStatus?.has_key ? '#10b981' : '#fb923c'}`,
              fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <span>
                {apolloKeyStatus?.has_key
                  ? '✓ Apollo API key detected — live enrichment is enabled.'
                  : '⚠ APOLLO_API_KEY not set on the backend. Live enrichment is disabled. Add it in Railway → Variables.'}
              </span>
              <button
                className="btn btn-primary btn-sm"
                disabled={!apolloKeyStatus?.has_key || apolloBulkRunning}
                onClick={runApolloBulkEnrich}
              >
                {apolloBulkRunning ? 'Enriching…' : 'Run Live Apollo Enrich (missing only)'}
              </button>
            </div>
          </div>
        )}

        {/* Quick Actions */}
        <div style={{ marginTop: 24, display: 'flex', gap: 12 }}>
          <button className="btn btn-primary" onClick={async () => {
            try {
              const result = await runLPMatching();
              const st = result.stats || {};
              alert(`Matching complete: ${st.targets_processed || 0} LPs processed, ${st.matches_found || 0} with connections found.\n\nDirect matches: ${st.direct_matches || 0}\nCompany/colleague matches: ${st.company_matches || 0}`);
              loadStats();
              loadTargets();
            } catch (err) {
              alert(err.message);
            }
          }}>
            Re-run Matching Algorithm
          </button>
          <button className="btn btn-secondary" onClick={loadStats}>
            Refresh Stats
          </button>
        </div>
      </>
    );
  };

  // Inline status update handler for the grid
  const handleInlineStatusChange = async (lpId, newStatus) => {
    try {
      await updateLPTarget(lpId, { outreach_status: newStatus });
      setTargets(prev => prev.map(t => t.id === lpId ? { ...t, outreach_status: newStatus } : t));
    } catch (err) {
      alert('Failed to update status');
    } finally {
      setEditingStatusId(null);
    }
  };

  // LP LIST TAB — Airtable-style grid
  const renderLPList = () => {
    let filtered = targets.filter(t => {
      if (statusFilter === 'all') return true;
      if (statusFilter === 'active') return ['identified', 'intro_requested', 'intro_made', 'meeting_scheduled', 'in_discussions'].includes(t.outreach_status);
      if (statusFilter === 'connected') return (t.connection_strength && t.connection_strength !== 'none') || (t.manual_connections && t.manual_connections.length > 0);
      if (statusFilter === 'has_email') return !!t.email;
      return t.outreach_status === statusFilter;
    });

    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(t =>
        (t.full_name || '').toLowerCase().includes(q) ||
        (t.company || '').toLowerCase().includes(q) ||
        (t.email || '').toLowerCase().includes(q)
      );
    }

    // Client-side sort
    filtered = [...filtered].sort((a, b) => {
      let va, vb;
      if (sortBy === 'fit_score') { va = a.fit_score || 0; vb = b.fit_score || 0; }
      else if (sortBy === 'name') { va = (a.full_name || '').toLowerCase(); vb = (b.full_name || '').toLowerCase(); }
      else if (sortBy === 'company') { va = (a.company || '').toLowerCase(); vb = (b.company || '').toLowerCase(); }
      else if (sortBy === 'outreach_status') { va = a.outreach_status || ''; vb = b.outreach_status || ''; }
      else { va = (a.company || '').toLowerCase(); vb = (b.company || '').toLowerCase(); }
      if (va < vb) return sortDir === 'desc' ? 1 : -1;
      if (va > vb) return sortDir === 'desc' ? -1 : 1;
      return 0;
    });

    const paginated = filtered; // show all — no pagination

    const COLS = [
      { key: 'name', label: 'Name / Company', width: 220, sticky: true },
      { key: 'status', label: 'Status', width: 148 },
      { key: 'last_contacted', label: 'Last Contact', width: 120 },
      { key: 'next_followup', label: 'Follow-up', width: 110 },
      { key: 'fund_type', label: 'Fund Type', width: 130 },
      { key: 'geo', label: 'Geography', width: 130 },
      { key: 'your_connections', label: 'Your Connections', width: 200 },
      { key: 'connections', label: '2nd-Degree (Manual)', width: 190 },
      { key: 'email', label: 'Email', width: 190 },
      { key: 'navigator', label: 'Navigator', width: 90 },
      { key: 'delete', label: '', width: 46 },
    ];

    const cellStyle = (col, extra = {}) => ({
      width: col.width,
      minWidth: col.width,
      maxWidth: col.width,
      padding: '0 14px',
      height: 50,
      fontSize: 13,
      borderRight: '1px solid #F1F5F9',
      borderBottom: '1px solid #F1F5F9',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
      verticalAlign: 'middle',
      display: 'table-cell',
      position: col.sticky ? 'sticky' : undefined,
      left: col.sticky ? 0 : undefined,
      zIndex: col.sticky ? 2 : undefined,
      background: col.sticky ? '#fff' : undefined,
      ...extra,
    });

    const headerCellStyle = (col) => ({
      ...cellStyle(col),
      background: '#F8FAFC',
      fontWeight: 700,
      fontSize: 11,
      color: '#64748B',
      textTransform: 'uppercase',
      letterSpacing: '0.6px',
      height: 40,
      userSelect: 'none',
      cursor: 'pointer',
      zIndex: col.sticky ? 3 : 1,
      borderBottom: '2px solid #E2E8F0',
    });

    return (
      <>
        {/* Filter + toolbar row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
            {[
              { key: 'all', label: 'All', color: '#374151' },
              { key: 'active', label: 'Pipeline', color: '#003B76' },
              { key: 'not_started', label: 'Not Started', color: '#9CA3AF' },
              { key: 'connected', label: 'Has Connection', color: '#10B981' },
              { key: 'has_email', label: 'Has Email', color: '#059669' },
              { key: 'meeting_scheduled', label: 'Meetings', color: '#003B76' },
              { key: 'committed', label: 'Committed', color: '#059669' },
              { key: 'passed', label: 'Passed', color: '#6B7280' },
            ].map(f => {
              const isActive = statusFilter === f.key;
              const count = f.key === 'all' ? targets.length
                : f.key === 'active' ? targets.filter(t => ['identified', 'intro_requested', 'intro_made', 'meeting_scheduled', 'in_discussions'].includes(t.outreach_status)).length
                : f.key === 'connected' ? targets.filter(t => (t.connection_strength && t.connection_strength !== 'none') || (t.manual_connections && t.manual_connections.length > 0)).length
                : f.key === 'has_email' ? targets.filter(t => !!t.email).length
                : targets.filter(t => t.outreach_status === f.key).length;
              return (
                <button key={f.key} onClick={() => { setStatusFilter(f.key); setPage(0); }} style={{
                  padding: '5px 13px', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontWeight: 600,
                  border: isActive ? 'none' : '1.5px solid #E2E8F0',
                  background: isActive ? f.color : '#fff',
                  color: isActive ? '#fff' : '#64748B',
                  transition: 'all 0.15s',
                  boxShadow: isActive ? '0 2px 6px rgba(0,0,0,0.15)' : '0 1px 2px rgba(0,0,0,0.04)',
                }}>
                  {f.label} <span style={{ opacity: 0.7, fontWeight: 400 }}>{count}</span>
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1.5px solid #E2E8F0', borderRadius: 8, padding: '7px 12px', minWidth: 240, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <span style={{ color: '#94A3B8', fontSize: 13 }}>🔍</span>
              <input placeholder="Search name, company..." value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                style={{ border: 'none', background: 'none', outline: 'none', fontSize: 13, color: '#1D3557', width: '100%' }} />
            </div>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
              style={{ padding: '7px 10px', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 12, color: '#475569', background: '#fff', cursor: 'pointer' }}>
              <option value="company">Company A→Z</option>
              <option value="name">Contact Name</option>
              <option value="outreach_status">Status</option>
            </select>
            <button onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
              style={{ padding: '7px 10px', border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 13, background: '#fff', cursor: 'pointer', color: '#475569' }}>
              {sortDir === 'desc' ? '↓' : '↑'}
            </button>
            <span style={{ fontSize: 12, color: '#94A3B8', whiteSpace: 'nowrap', background: '#EEF4FF', padding: '5px 12px', borderRadius: 20, fontWeight: 600, color: '#1D3557' }}>
              {filtered.length} LP{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Airtable-style grid */}
        <div style={{
          border: '1px solid #E2E8F0',
          borderRadius: 12,
          overflow: 'auto',
          background: '#fff',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          maxHeight: 'calc(100vh - 250px)',
          position: 'relative',
        }}>
          <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
            <thead>
              <tr>
                {COLS.map(col => (
                  <th key={col.key} style={headerCellStyle(col)}
                    onClick={() => {
                      if (col.key === 'fit_score') { setSortBy('fit_score'); setSortDir(d => d === 'desc' ? 'asc' : 'desc'); }
                      if (col.key === 'name') { setSortBy('name'); setSortDir(d => d === 'desc' ? 'asc' : 'desc'); }
                      if (col.key === 'status') { setSortBy('outreach_status'); setSortDir(d => d === 'desc' ? 'asc' : 'desc'); }
                    }}>
                    {col.label}
                    {(col.key === 'fit_score' && sortBy === 'fit_score') || (col.key === 'name' && sortBy === 'name') || (col.key === 'status' && sortBy === 'outreach_status')
                      ? <span style={{ marginLeft: 4 }}>{sortDir === 'desc' ? '↓' : '↑'}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginated.map((t, rowIdx) => {
                const manualConns = t.manual_connections || [];
                const rowBg = rowIdx % 2 === 0 ? '#fff' : '#FAFAFA';
                return (
                  <tr key={t.id} style={{ cursor: 'pointer' }}
                    onMouseEnter={e => { Array.from(e.currentTarget.cells).forEach(c => c.style.background = '#FAFBFF'); }}
                    onMouseLeave={e => { Array.from(e.currentTarget.cells).forEach(c => c.style.background = ''); }}>

                    {/* Name / Company — sticky */}
                    <td style={{ ...cellStyle(COLS[0]), background: '#fff', fontWeight: 500 }}
                      onClick={() => setSelectedTarget(t.id)}>
                      <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#1D3557' }}>
                        {t.full_name || t.name}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748B', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.company}
                      </div>
                    </td>

                    {/* Status — inline editable */}
                    <td style={cellStyle(COLS[1])} onClick={(e) => { e.stopPropagation(); setEditingStatusId(t.id); }}>
                      {editingStatusId === t.id ? (
                        <select autoFocus
                          defaultValue={t.outreach_status}
                          onChange={(e) => handleInlineStatusChange(t.id, e.target.value)}
                          onBlur={() => setEditingStatusId(null)}
                          style={{ fontSize: 11, border: '1px solid var(--navy)', borderRadius: 3, padding: '2px 4px', width: '100%', outline: 'none' }}>
                          {Object.entries(OUTREACH_STATUS_LABELS).map(([v, l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      ) : (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                          background: (OUTREACH_STATUS_COLORS[t.outreach_status] || '#9CA3AF') + '28',
                          color: OUTREACH_STATUS_COLORS[t.outreach_status] || '#9CA3AF',
                          cursor: 'pointer', border: `1px solid ${(OUTREACH_STATUS_COLORS[t.outreach_status] || '#9CA3AF')}50`,
                          whiteSpace: 'nowrap',
                        }}>
                          {OUTREACH_STATUS_LABELS[t.outreach_status] || t.outreach_status || 'Not Started'}
                        </span>
                      )}
                    </td>

                    {/* Last Contact — inline editable date */}
                    <td style={cellStyle(COLS[2])} onClick={(e) => { e.stopPropagation(); setEditingLastContact(t.id); }}>
                      {editingLastContact === t.id ? (
                        <input type="date" autoFocus
                          defaultValue={t.last_contacted_at ? t.last_contacted_at.split('T')[0] : ''}
                          onBlur={async (e) => {
                            const val = e.target.value;
                            setEditingLastContact(null);
                            if (val !== (t.last_contacted_at || '').split('T')[0]) {
                              await updateLPTarget(t.id, { last_contacted_at: val || null });
                              setTargets(prev => prev.map(x => x.id === t.id ? { ...x, last_contacted_at: val } : x));
                            }
                          }}
                          style={{ fontSize: 10, width: '100%', border: '1px solid var(--navy)', borderRadius: 3, padding: '2px 4px', outline: 'none' }} />
                      ) : (
                        <span style={{ fontSize: 12, color: t.last_contacted_at ? '#374151' : '#CBD5E1', cursor: 'pointer' }}>
                          {t.last_contacted_at ? new Date(t.last_contacted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
                        </span>
                      )}
                    </td>

                    {/* Follow-up date — inline editable */}
                    <td style={cellStyle(COLS[3])} onClick={(e) => { e.stopPropagation(); setEditingFollowup(t.id); }}>
                      {editingFollowup === t.id ? (
                        <input type="date" autoFocus
                          defaultValue={t.next_followup_at ? t.next_followup_at.split('T')[0] : ''}
                          onBlur={async (e) => {
                            const val = e.target.value;
                            setEditingFollowup(null);
                            if (val !== (t.next_followup_at || '').split('T')[0]) {
                              await updateLPTarget(t.id, { next_followup_at: val || null });
                              setTargets(prev => prev.map(x => x.id === t.id ? { ...x, next_followup_at: val } : x));
                            }
                          }}
                          style={{ fontSize: 10, width: '100%', border: '1px solid var(--navy)', borderRadius: 3, padding: '2px 4px', outline: 'none' }} />
                      ) : (
                        <span style={{ fontSize: 11, color: t.next_followup_at ? (new Date(t.next_followup_at) < new Date() ? '#DC2626' : '#059669') : '#D1D5DB', cursor: 'pointer' }}>
                          {t.next_followup_at ? new Date(t.next_followup_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
                        </span>
                      )}
                    </td>

                    {/* Fund Type */}
                    <td style={cellStyle(COLS[4])} onClick={() => setSelectedTarget(t.id)}>
                      <span style={{ fontSize: 11, color: '#374151' }}>
                        {t.fund_type ? t.fund_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : <span style={{ color: '#D1D5DB' }}>—</span>}
                      </span>
                    </td>

                    {/* Geography */}
                    <td style={cellStyle(COLS[5])} onClick={() => setSelectedTarget(t.id)}>
                      <span style={{ fontSize: 11, color: '#374151' }}>
                        {t.geographic_focus || <span style={{ color: '#D1D5DB' }}>—</span>}
                      </span>
                    </td>

                    {/* Your Connections — from uploaded LinkedIn CSV */}
                    <td style={cellStyle(COLS[6], { overflow: 'visible', whiteSpace: 'normal', padding: '4px 10px' })}
                      onClick={() => setSelectedTarget(t.id)}>
                      {(() => {
                        const matches = t.linkedin_matches || [];
                        if (!matches.length) return <span style={{ color: '#D1D5DB', fontSize: 11 }}>—</span>;
                        return (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                            {matches.slice(0, 3).map((m, i) => (
                              <span key={i} title={`${m.connection_name}${m.connection_position ? ` — ${m.connection_position}` : ''}\nvia ${m.team_member_name}`}
                                style={{
                                  display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 10, fontWeight: 500,
                                  background: '#ECFDF5', color: '#065F46', border: '1px solid #A7F3D0',
                                  maxWidth: 85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default',
                                }}>
                                {m.connection_name.split(' ')[0]}
                              </span>
                            ))}
                            {matches.length > 3 && (
                              <span style={{ fontSize: 10, color: '#6B7280' }}>+{matches.length - 3}</span>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    {/* 2nd-Degree Connections (manual / Navigator-sourced) */}
                    <td style={cellStyle(COLS[7], { overflow: 'visible', whiteSpace: 'normal', padding: '4px 10px' })}
                      onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', minHeight: 28 }}>
                        {manualConns.slice(0, 3).map(conn => (
                          <a key={conn.id}
                            href={conn.linkedin_url || undefined}
                            target="_blank" rel="noopener noreferrer"
                            onClick={e => { if (!conn.linkedin_url) e.preventDefault(); }}
                            title={conn.relationship ? `${conn.name} — ${conn.relationship}` : conn.name}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 3,
                              padding: '2px 7px', borderRadius: 10, fontSize: 10, fontWeight: 500,
                              background: conn.linkedin_url ? '#EFF6FF' : '#F3F4F6',
                              color: conn.linkedin_url ? '#1D4ED8' : '#6B7280',
                              textDecoration: 'none', border: '1px solid ' + (conn.linkedin_url ? '#BFDBFE' : '#E5E7EB'),
                              maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                            {conn.linkedin_url && <span style={{ fontSize: 9 }}>in</span>}
                            {conn.name.split(' ')[0]}
                          </a>
                        ))}
                        {manualConns.length > 3 && (
                          <span style={{ fontSize: 10, color: '#6B7280', cursor: 'pointer' }}
                            onClick={() => setSelectedTarget(t.id)}>
                            +{manualConns.length - 3} more
                          </span>
                        )}
                        <button
                          title="Add 2nd-degree connection"
                          onClick={() => { setSelectedTarget(t.id); }}
                          style={{
                            width: 18, height: 18, borderRadius: '50%', border: '1px dashed #CBD5E1',
                            background: 'transparent', cursor: 'pointer', fontSize: 10, color: '#94A3B8',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0,
                            flexShrink: 0,
                          }}>+</button>
                      </div>
                    </td>

                    {/* Email */}
                    <td style={cellStyle(COLS[8])} onClick={() => setSelectedTarget(t.id)}>
                      {t.email
                        ? <span style={{ fontSize: 11, color: '#059669' }}>{t.email}</span>
                        : <span style={{ color: '#D1D5DB', fontSize: 11 }}>—</span>}
                    </td>

                    {/* Navigator search */}
                    <td style={cellStyle(COLS[9])} onClick={e => e.stopPropagation()}>
                      {(() => {
                        const personName = (t.full_name || t.name || '').replace(/,/g, '').trim();
                        const companyName = (t.company || '').trim();
                        const navHref = t.linkedin_url
                          ? t.linkedin_url
                          : personName && companyName
                            ? `https://www.linkedin.com/sales/search/people?query=(spellCorrectionEnabled:true,keywords:${encodeURIComponent(personName)},filters:List((type:CURRENT_COMPANY,values:List((text:${encodeURIComponent(companyName)},selectionType:INCLUDED)))))`
                            : `https://www.linkedin.com/sales/search/people?query=(spellCorrectionEnabled:true,keywords:${encodeURIComponent(personName || companyName)})`;
                        const navTitle = t.linkedin_url
                          ? `View ${personName || companyName}'s LinkedIn profile`
                          : `Find ${personName} at ${companyName} in Sales Navigator`;
                        return (
                          <a href={navHref} target="_blank" rel="noopener noreferrer" title={navTitle}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                              background: '#0077B5', color: '#fff', textDecoration: 'none',
                              border: 'none', cursor: 'pointer',
                            }}>
                            in Search
                          </a>
                        );
                      })()}
                    </td>

                    {/* Delete record */}
                    <td style={{ ...cellStyle(COLS[10]), textAlign: 'center', padding: '0 4px' }} onClick={e => e.stopPropagation()}>
                      <button
                        title="Delete this LP record"
                        onClick={async () => {
                          const name = (t.full_name || t.name || t.company || 'this record');
                          if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
                          try {
                            const token = localStorage.getItem('svc_token');
                            const res = await fetch(`/api/lp/targets/${t.id}`, {
                              method: 'DELETE',
                              headers: { Authorization: `Bearer ${token}` },
                            });
                            if (!res.ok) { alert('Delete failed — please try again.'); return; }
                            setTargets(prev => prev.filter(x => x.id !== t.id));
                          } catch (e) {
                            alert('Delete failed — please try again.');
                          }
                        }}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: '#9CA3AF', fontSize: 14, padding: '2px 4px',
                          borderRadius: 3, lineHeight: 1,
                          transition: 'color 0.15s',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = '#DC2626'}
                        onMouseLeave={e => e.currentTarget.style.color = '#9CA3AF'}
                      >
                        🗑
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!paginated.length && (
                <tr>
                  <td colSpan={COLS.length} style={{ textAlign: 'center', padding: 48, color: 'var(--muted)', fontSize: 13 }}>
                    {loading ? 'Loading...' : search ? 'No results for that search' : statusFilter !== 'all' ? 'No LPs match this filter' : 'No LP targets found — import a CSV to get started'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Row count */}
        <div style={{ padding: '8px 4px', fontSize: 11, color: 'var(--muted)' }}>
          {filtered.length} LP{filtered.length !== 1 ? 's' : ''}
        </div>
      </>
    );
  };

  // UPLOAD & SETUP TAB
  const renderUploadSetup = () => {
    return (
      <>
      {/* MY LINKEDIN CONNECTIONS — per-user, shown prominently at top */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>My LinkedIn Connections</h3>
        <div className="card">
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 4 }}>
                {user?.full_name || user?.email}
              </div>
              {myTeamMember ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {myTeamMember.connections_count
                    ? `${myTeamMember.connections_count.toLocaleString()} connections uploaded`
                    : 'No connections uploaded yet'}
                  {myTeamMember.last_upload_at && (
                    <span style={{ marginLeft: 8, color: '#9CA3AF' }}>
                      · Last updated {new Date(myTeamMember.last_upload_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading…</div>
              )}
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>
                Export your connections from LinkedIn: <strong>Settings &amp; Privacy → Data privacy → Get a copy of your data → Connections</strong>
              </div>
            </div>
            <label style={{ cursor: 'pointer', flexShrink: 0 }}>
              <input
                type="file"
                accept=".csv"
                style={{ display: 'none' }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setMyConnectionsUploading(true);
                  try {
                    const formData = new FormData();
                    formData.append('file', file);
                    const result = await uploadMyLinkedInCSV(formData);
                    alert(`✓ ${result.count} connections imported successfully`);
                    await loadMyTeamMember();
                    loadStats();
                    loadTargets();
                  } catch (err) {
                    alert(err.message || 'Upload failed');
                  } finally {
                    setMyConnectionsUploading(false);
                    e.target.value = '';
                  }
                }}
              />
              <span className="btn btn-primary" style={{ pointerEvents: myConnectionsUploading ? 'none' : 'auto', opacity: myConnectionsUploading ? 0.6 : 1 }}>
                {myConnectionsUploading ? 'Uploading…' : 'Upload My Connections CSV'}
              </span>
            </label>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Team Management */}
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Team Members</h3>

          {/* Add Member Form */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">Add Team Member</div>
            <div className="card-body">
              <div className="form-group">
                <label>Name</label>
                <input type="text" placeholder="John Doe" value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  style={{ padding: 8, border: '1px solid var(--border-light)', borderRadius: 4, width: '100%' }} />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" placeholder="john@example.com" value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                  style={{ padding: 8, border: '1px solid var(--border-light)', borderRadius: 4, width: '100%' }} />
              </div>
              <div className="form-group">
                <label>LinkedIn URL (optional)</label>
                <input type="text" placeholder="https://linkedin.com/in/john" value={newMemberLinkedin}
                  onChange={(e) => setNewMemberLinkedin(e.target.value)}
                  style={{ padding: 8, border: '1px solid var(--border-light)', borderRadius: 4, width: '100%' }} />
              </div>
              <button className="btn btn-primary" onClick={async () => {
                if (!newMemberName.trim() || !newMemberEmail.trim()) {
                  alert('Name and email required');
                  return;
                }
                try {
                  await addLPTeamMember({
                    full_name: newMemberName,
                    email: newMemberEmail,
                    linkedin_url: newMemberLinkedin || undefined,
                  });
                  setNewMemberName('');
                  setNewMemberEmail('');
                  setNewMemberLinkedin('');
                  loadTeamMembers();
                } catch (err) {
                  alert(err.message);
                }
              }}>Add Member</button>
            </div>
          </div>

          {/* Team List */}
          <div className="card">
            <div className="card-header">Team ({teamMembers.length})</div>
            <div className="card-body">
              {teamMembers.map((member) => (
                <div key={member.id} style={{
                  padding: 12, borderBottom: '1px solid var(--border-light)', display: 'flex',
                  justifyContent: 'space-between', alignItems: 'center', fontSize: 13
                }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{member.full_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{member.email}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <label style={{ cursor: 'pointer', display: 'inline-block' }}>
                      <input type="file" accept=".csv" style={{ display: 'none' }}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          try {
                            const formData = new FormData();
                            formData.append('file', file);
                            await uploadLinkedInCSV(member.id, formData);
                            alert('LinkedIn CSV uploaded successfully');
                            loadTeamMembers();
                          } catch (err) {
                            alert(err.message);
                          }
                        }} />
                      <span className="btn btn-sm btn-secondary">Upload CSV</span>
                    </label>
                    <button className="btn btn-sm btn-danger" onClick={async () => {
                      if (window.confirm(`Remove ${member.full_name}?`)) {
                        try {
                          await removeLPTeamMember(member.id);
                          loadTeamMembers();
                        } catch (err) {
                          alert(err.message);
                        }
                      }
                    }}>Remove</button>
                  </div>
                </div>
              ))}
              {!teamMembers.length && (
                <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>No team members yet</p>
              )}
            </div>
          </div>
        </div>

        {/* LP Import */}
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Import LP List</h3>
          <div className="card">
            <div className="card-body">
              <div className="upload-area" style={{ textAlign: 'center', padding: 32, border: '2px dashed var(--border-light)', borderRadius: 8 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Upload LP List CSV</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
                  Columns: name, company, email, title, fund_type, estimated_aum, typical_check_size, sector_interest, geographic_focus
                </div>
                <label style={{ cursor: 'pointer', display: 'inline-block' }}>
                  <input type="file" accept=".csv" style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        const formData = new FormData();
                        formData.append('file', file);
                        await importLPTargets(formData);
                        alert('LP list imported successfully');
                        loadStats();
                        loadTargets();
                      } catch (err) {
                        alert(err.message);
                      }
                    }} />
                  <span className="btn btn-primary">Choose File</span>
                </label>
              </div>

              <div style={{ marginTop: 24 }}>
                <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>CSV Format Example</h4>
                <div style={{
                  background: 'var(--card-bg)',
                  padding: 12,
                  borderRadius: 6,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  overflow: 'auto',
                  lineHeight: 1.4
                }}>
                  name,company,email,title,fund_type
                  <br />
                  John Doe,Acme VC,john@acme.vc,Managing Partner,Venture
                  <br />
                  Jane Smith,Beta Capital,jane@beta.cap,Partner,Growth
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Clay Integration Section */}
      <div style={{ marginTop: 32 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', color: 'white', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700 }}>CLAY</span>
          Enrichment Integration
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* Clay Config */}
          <div className="card">
            <div className="card-header">Clay Configuration</div>
            <div className="card-body">
              <div className="form-group">
                <label>Clay Table Webhook URL</label>
                <input type="text" placeholder="https://app.clay.com/api/v1/webhooks/..." value={clayFormUrl}
                  onChange={(e) => setClayFormUrl(e.target.value)}
                  style={{ padding: 8, border: '1px solid var(--border-light)', borderRadius: 4, width: '100%', fontSize: 12 }} />
                <span className="hint">Found in your Clay table → Sources → Webhook</span>
              </div>
              <div className="form-group">
                <label>Webhook Secret (optional)</label>
                <input type="password" placeholder="Secret for verifying incoming Clay callbacks" value={clayFormSecret}
                  onChange={(e) => setClayFormSecret(e.target.value)}
                  style={{ padding: 8, border: '1px solid var(--border-light)', borderRadius: 4, width: '100%', fontSize: 12 }} />
                <span className="hint">Protects the callback endpoint — add this as a header in Clay's HTTP action</span>
              </div>
              <div className="form-group">
                <label>Clay API Key (optional)</label>
                <input type="password" placeholder="For authenticated Clay webhook pushes" value={clayFormApiKey}
                  onChange={(e) => setClayFormApiKey(e.target.value)}
                  style={{ padding: 8, border: '1px solid var(--border-light)', borderRadius: 4, width: '100%', fontSize: 12 }} />
                {claySettings?.clay_api_key_masked && (
                  <span className="hint">Current: {claySettings.clay_api_key_masked}</span>
                )}
              </div>
              <button className="btn btn-primary" onClick={async () => {
                try {
                  const payload = { clay_table_webhook_url: clayFormUrl };
                  if (clayFormSecret) payload.clay_webhook_secret = clayFormSecret;
                  if (clayFormApiKey) payload.clay_api_key = clayFormApiKey;
                  await saveClaySettings(payload);
                  setClayConfigSaved(true);
                  setTimeout(() => setClayConfigSaved(false), 2000);
                  loadClaySettings();
                } catch (err) { alert(err.message); }
              }}>
                {clayConfigSaved ? '✓ Saved' : 'Save Settings'}
              </button>

              {/* Callback URL */}
              {clayWebhookUrl && (
                <div style={{ marginTop: 16, padding: 12, background: '#F0FDF4', borderRadius: 6, border: '1px solid #BBF7D0' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#166534', marginBottom: 4 }}>YOUR CALLBACK URL</div>
                  <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#166534', wordBreak: 'break-all' }}>{clayWebhookUrl}</div>
                  <div style={{ fontSize: 10, color: '#15803D', marginTop: 4 }}>
                    Add this as an HTTP POST action in Clay to push enriched data back automatically.
                  </div>
                  <button onClick={() => {
                    navigator.clipboard.writeText(clayWebhookUrl);
                  }} style={{
                    marginTop: 6, padding: '3px 10px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
                    border: '1px solid #166534', background: 'transparent', color: '#166534', fontWeight: 600
                  }}>Copy URL</button>
                </div>
              )}
            </div>
          </div>

          {/* Clay Actions */}
          <div>
            {/* Export to Clay */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header">Push to Clay</div>
              <div className="card-body">
                <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
                  Export LP targets to your Clay table for waterfall enrichment. Clay will find emails, phone numbers, LinkedIn profiles, and company data across 75+ providers.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-sm" disabled={clayExporting || !clayFormUrl}
                    style={{ background: '#6366F1', color: 'white', border: 'none', opacity: (clayExporting || !clayFormUrl) ? 0.5 : 1 }}
                    onClick={async () => {
                      setClayExporting(true);
                      try {
                        const result = await exportToClay({ filter: 'all' });
                        alert(`Exported ${result.pushed} of ${result.total_records} records to Clay.${result.errors ? ` (${result.errors} errors)` : ''}`);
                        loadClaySettings();
                      } catch (err) { alert(err.message); }
                      setClayExporting(false);
                    }}>
                    {clayExporting ? 'Exporting...' : 'Export All LPs'}
                  </button>
                  <button className="btn btn-sm" disabled={clayExporting || !clayFormUrl}
                    style={{ background: '#8B5CF6', color: 'white', border: 'none', opacity: (clayExporting || !clayFormUrl) ? 0.5 : 1 }}
                    onClick={async () => {
                      setClayExporting(true);
                      try {
                        const result = await exportToClay({ filter: 'unenriched' });
                        alert(`Exported ${result.pushed} unenriched records to Clay.`);
                        loadClaySettings();
                      } catch (err) { alert(err.message); }
                      setClayExporting(false);
                    }}>
                    {clayExporting ? 'Exporting...' : 'Export Unenriched Only'}
                  </button>
                  <button className="btn btn-sm" disabled={clayExporting || !clayFormUrl}
                    style={{ background: '#A855F7', color: 'white', border: 'none', opacity: (clayExporting || !clayFormUrl) ? 0.5 : 1 }}
                    onClick={async () => {
                      setClayExporting(true);
                      try {
                        const result = await exportToClay({ filter: 'all', include_contacts: true });
                        alert(`Exported ${result.pushed} records (LPs + Apollo contacts) to Clay.`);
                        loadClaySettings();
                      } catch (err) { alert(err.message); }
                      setClayExporting(false);
                    }}>
                    {clayExporting ? 'Exporting...' : 'Export LPs + Contacts'}
                  </button>
                </div>
                {!clayFormUrl && (
                  <div style={{ fontSize: 11, color: '#D97706', marginTop: 8 }}>Configure Clay webhook URL first →</div>
                )}
                {claySettings?.last_export_at && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                    Last export: {timeAgo(claySettings.last_export_at)} · {claySettings.export_count} total records exported
                  </div>
                )}
              </div>
            </div>

            {/* Import from Clay */}
            <div className="card">
              <div className="card-header">Import from Clay</div>
              <div className="card-body">
                <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
                  Upload an enriched CSV exported from your Clay table. Maps enriched fields (email, phone, LinkedIn) back to your LP targets automatically.
                </p>
                <label style={{ cursor: 'pointer', display: 'inline-block' }}>
                  <input type="file" accept=".csv" style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        const formData = new FormData();
                        formData.append('file', file);
                        const result = await importClayCSV(formData);
                        alert(`Imported ${result.updated} records from Clay CSV.\n${result.matched_by_name} matched by name.\n${result.skipped} skipped.`);
                        loadClaySettings();
                        loadTargets();
                      } catch (err) { alert(err.message); }
                    }} />
                  <span className="btn btn-sm" style={{ background: '#059669', color: 'white', border: 'none' }}>Upload Clay CSV</span>
                </label>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>
                  Or set up Clay's HTTP action to push enriched data to the callback URL automatically.
                </div>
                {claySettings?.last_import_at && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                    Last import: {timeAgo(claySettings.last_import_at)} · {claySettings.import_count} total records imported
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Sync Log */}
        {claySyncLog.length > 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header">Sync History</div>
            <div className="card-body" style={{ padding: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Direction</th>
                    <th>Records</th>
                    <th>Status</th>
                    <th>Details</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {claySyncLog.map((log) => {
                    const details = typeof log.details === 'string' ? JSON.parse(log.details) : (log.details || {});
                    return (
                      <tr key={log.id}>
                        <td>
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                            background: log.direction === 'export' ? '#EDE9FE' : '#ECFDF5',
                            color: log.direction === 'export' ? '#6366F1' : '#059669'
                          }}>
                            {log.direction === 'export' ? '→ Export' : '← Import'}
                          </span>
                        </td>
                        <td style={{ fontSize: 13, fontWeight: 600 }}>{log.records_count}</td>
                        <td>
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
                            background: log.status === 'success' ? '#ECFDF5' : '#FEF3C7',
                            color: log.status === 'success' ? '#059669' : '#D97706'
                          }}>
                            {log.status}
                          </span>
                        </td>
                        <td style={{ fontSize: 11, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {details.error || details.message || (details.updated != null ? `${details.updated} updated, ${details.skipped} skipped` : '')}
                        </td>
                        <td style={{ fontSize: 11, color: 'var(--muted)' }}>{timeAgo(log.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      </>
    );
  };

  // DETAIL PANEL
  const renderDetail = () => {
    if (!detail) return null;

    return (
      <>
        <div className="detail-overlay" onClick={() => setSelectedTarget(null)} />
        <div className="detail-panel open" style={{ maxHeight: '90vh', overflowY: 'auto' }}>
          <div className="detail-header" style={{ flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 2 }}>{detail.full_name || detail.name}</h2>
                <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 0 }}>
                  {detail.title ? `${detail.title} · ` : ''}{detail.company}
                </p>
              </div>
              <button onClick={() => setSelectedTarget(null)} style={{
                background: 'none', border: 'none', fontSize: 20, cursor: 'pointer',
                color: 'var(--muted)'
              }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
              <StatusBadge
                status={OUTREACH_STATUS_LABELS[detail.outreach_status] || 'Not Started'}
                color={OUTREACH_STATUS_COLORS[detail.outreach_status] || '#9CA3AF'}
              />
              {detail.fit_score > 0 && (
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 4,
                  background: getFitScoreColor(detail.fit_score) + '18',
                  color: getFitScoreColor(detail.fit_score)
                }}>
                  Fit: {detail.fit_score}
                </span>
              )}
              {detail.email && (
                <a href={`mailto:${detail.email}`} style={{
                  fontSize: 11, color: '#059669', textDecoration: 'none',
                  background: '#ECFDF5', padding: '4px 8px', borderRadius: 4
                }}>
                  {detail.email}
                </a>
              )}
              {detail.linkedin_url && (
                <a href={detail.linkedin_url} target="_blank" rel="noopener noreferrer" style={{
                  fontSize: 11, color: '#0077B5', textDecoration: 'none',
                  background: '#EFF6FF', padding: '4px 8px', borderRadius: 4
                }}>
                  LinkedIn →
                </a>
              )}
            </div>
          </div>

          <div className="detail-body">
            {/* Fit Score */}
            <div className="detail-section">
              <h3>Fit Score & Strength</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div style={{ padding: 12, background: 'var(--card-bg)', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>FIT SCORE</div>
                  <FitScoreBar score={detail.fit_score || 0} />
                </div>
                <div style={{ padding: 12, background: 'var(--card-bg)', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>CONNECTION</div>
                  <StatusBadge
                    status={CONNECTION_STRENGTH_LABELS[detail.connection_strength] || detail.connection_strength}
                    color={CONNECTION_STRENGTH_COLORS[detail.connection_strength] || '#9CA3AF'}
                  />
                </div>
              </div>
            </div>

            {/* Contact Info */}
            <div className="detail-section">
              <h3>Contact Info</h3>
              <div style={{ fontSize: 13, lineHeight: 2 }}>
                <div><strong>Title:</strong> {detail.title || '—'}</div>
                <div><strong>Email:</strong> {detail.email || '—'}</div>
              </div>
            </div>

            {/* LP Details */}
            <div className="detail-section">
              <h3>LP Profile</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
                <div style={{ padding: 10, background: 'var(--card-bg)', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>FUND TYPE</div>
                  <div style={{ fontWeight: 500 }}>{detail.fund_type || '—'}</div>
                </div>
                <div style={{ padding: 10, background: 'var(--card-bg)', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>EST. AUM</div>
                  <div style={{ fontWeight: 500 }}>{detail.estimated_aum || '—'}</div>
                </div>
                <div style={{ padding: 10, background: 'var(--card-bg)', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>CHECK SIZE</div>
                  <div style={{ fontWeight: 500 }}>{detail.typical_check_size || '—'}</div>
                </div>
                <div style={{ padding: 10, background: 'var(--card-bg)', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>GEO FOCUS</div>
                  <div style={{ fontWeight: 500 }}>{detail.geographic_focus || '—'}</div>
                </div>
              </div>
              {detail.sector_interest && detail.sector_interest.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>SECTORS</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {detail.sector_interest.map((sector, i) => (
                      <span key={i} className="badge" style={{
                        background: 'var(--accent)', color: 'white', padding: '4px 8px',
                        borderRadius: 4, fontSize: 11
                      }}>{sector}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* LinkedIn Enrichment */}
            <div className="detail-section">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#0077B5' }}>in</span> LinkedIn Profile
                {detail.linkedin_enrichment && (
                  <span style={{ fontSize: 10, background: '#059669', color: 'white', padding: '2px 6px', borderRadius: 10 }}>Enriched</span>
                )}
              </h3>
              {detail.linkedin_enrichment ? (() => {
                const enr = detail.linkedin_enrichment;
                return (
                  <div style={{ fontSize: 12 }}>
                    {/* Headline / Summary */}
                    {enr.headline && (
                      <div style={{ fontWeight: 500, marginBottom: 6, color: 'var(--text)' }}>{enr.headline}</div>
                    )}
                    {enr.summary && (
                      <div style={{ color: 'var(--muted)', marginBottom: 10, fontSize: 11, lineHeight: 1.5 }}>
                        {enr.summary.length > 200 ? enr.summary.slice(0, 200) + '...' : enr.summary}
                      </div>
                    )}
                    {/* Location / Industry */}
                    <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                      {enr.location && (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>📍 {enr.location}</span>
                      )}
                      {enr.industry && (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>🏢 {enr.industry}</span>
                      )}
                    </div>
                    {/* Job History */}
                    {enr.job_history && enr.job_history.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
                          Career History
                        </div>
                        {enr.job_history.slice(0, 5).map((job, ji) => (
                          <div key={ji} style={{
                            padding: '6px 10px', background: ji === 0 ? '#EFF6FF' : 'var(--card-bg)',
                            borderRadius: 4, marginBottom: 4, borderLeft: ji === 0 ? '3px solid #3B82F6' : '3px solid transparent'
                          }}>
                            <div style={{ fontWeight: 500 }}>{job.title || 'Unknown Role'}</div>
                            <div style={{ color: 'var(--muted)', fontSize: 11 }}>
                              {job.company || 'Unknown Company'}
                              {job.start_date && <span> · {job.start_date}{job.end_date ? ` – ${job.end_date}` : ' – Present'}</span>}
                            </div>
                          </div>
                        ))}
                        {enr.job_history.length > 5 && (
                          <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 10 }}>
                            +{enr.job_history.length - 5} more roles
                          </div>
                        )}
                      </div>
                    )}
                    {/* Education */}
                    {enr.education && enr.education.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
                          Education
                        </div>
                        {enr.education.map((edu, ei) => (
                          <div key={ei} style={{ padding: '4px 10px', fontSize: 12, marginBottom: 2 }}>
                            <span style={{ fontWeight: 500 }}>{edu.school || 'Unknown'}</span>
                            {edu.degree && <span style={{ color: 'var(--muted)' }}> — {edu.degree}</span>}
                            {edu.field_of_study && <span style={{ color: 'var(--muted)' }}> ({edu.field_of_study})</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Skills */}
                    {enr.skills && enr.skills.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
                          Skills
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {enr.skills.slice(0, 12).map((skill, si) => (
                            <span key={si} style={{
                              background: '#F3F4F6', color: '#374151', padding: '2px 8px',
                              borderRadius: 3, fontSize: 10
                            }}>{skill}</span>
                          ))}
                          {enr.skills.length > 12 && (
                            <span style={{ fontSize: 10, color: 'var(--muted)', padding: '2px 4px' }}>+{enr.skills.length - 12} more</span>
                          )}
                        </div>
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>
                      Enriched {enr.enriched_at ? timeAgo(enr.enriched_at) : 'recently'} via People Data Labs
                      {enr.pdl_likelihood && <span> · Confidence: {enr.pdl_likelihood}/10</span>}
                    </div>
                  </div>
                );
              })() : (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {detail.linkedin_url ? (
                    <div>
                      <div style={{ marginBottom: 8 }}>
                        <a href={detail.linkedin_url} target="_blank" rel="noopener noreferrer"
                          style={{ color: '#0077B5', fontSize: 12 }}>View LinkedIn Profile →</a>
                      </div>
                      <button className="btn btn-sm btn-secondary"
                        style={{ background: '#0077B5', color: 'white', border: 'none' }}
                        onClick={async () => {
                          try {
                            const res = await enrichLPTarget(detail.id);
                            const updated = await getLPTarget(detail.id);
                            setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log, manual_connections: updated.manual_connections || [] });
                          } catch (err) {
                            alert('Enrichment failed: ' + err.message);
                          }
                        }}>
                        Enrich from LinkedIn
                      </button>
                    </div>
                  ) : (
                    <span>No LinkedIn URL available for this LP target.</span>
                  )}
                </div>
              )}
            </div>

            {/* Outreach Status */}
            <div className="detail-section">
              <h3>Outreach Status</h3>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
                gap: 8
              }}>
                {Object.entries(OUTREACH_STATUS_LABELS).map(([key, label]) => (
                  <button key={key}
                    className={`btn btn-sm ${detail.outreach_status === key ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={async () => {
                      try {
                        await updateLPTarget(detail.id, { outreach_status: key });
                        const updated = await getLPTarget(detail.id);
                        setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log, manual_connections: updated.manual_connections || [] });
                        loadTargets();
                      } catch (err) {
                        alert(err.message);
                      }
                    }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── LP Intelligence Brief ── */}
            <div className="detail-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>
                  LP Intelligence Brief
                  {researchBrief?.researched_at && (
                    <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--muted)', marginLeft: 8 }}>
                      {new Date(researchBrief.researched_at).toLocaleDateString()}
                    </span>
                  )}
                </h3>
                <button
                  disabled={researchLoading}
                  onClick={async () => {
                    setResearchLoading(true);
                    setResearchError(null);
                    try {
                      const rd = await request(`/lp/targets/${detail.id}/research`, { method: 'POST', body: JSON.stringify({}) });
                      if (rd?.error) throw new Error(rd.error);
                      setResearchBrief(rd);
                    } catch (e) {
                      setResearchError(e.message || 'Research failed. Check API key configuration.');
                    } finally {
                      setResearchLoading(false);
                    }
                  }}
                  style={{
                    padding: '5px 12px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: researchLoading ? 'default' : 'pointer',
                    background: researchBrief ? 'transparent' : '#7C3AED', color: researchBrief ? '#7C3AED' : '#fff',
                    border: '1px solid #7C3AED', opacity: researchLoading ? 0.6 : 1, whiteSpace: 'nowrap'
                  }}>
                  {researchLoading ? '🔍 Researching…' : researchBrief ? '↻ Refresh' : '🔍 Run Research'}
                </button>
              </div>

              {researchError && (
                <div style={{ fontSize: 12, color: '#DC2626', padding: '8px 12px', background: '#FEF2F2', borderRadius: 4, marginBottom: 10 }}>
                  {researchError}
                </div>
              )}

              {researchLoading && !researchBrief && (
                <div style={{ fontSize: 12, color: 'var(--muted)', padding: '20px 0', textAlign: 'center' }}>
                  Researching {detail.company}… this takes ~15 seconds
                </div>
              )}

              {researchBrief?.brief && (() => {
                const b = researchBrief.brief;
                const fo = b.fund_overview || {};
                return (
                  <div style={{ fontSize: 12 }}>

                    {/* Fund Overview */}
                    {fo.strategy && (
                      <div style={{ padding: '10px 12px', background: '#F8F4FF', borderRadius: 6, borderLeft: '3px solid #7C3AED', marginBottom: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#7C3AED', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Fund Overview</div>
                        <div style={{ lineHeight: 1.5, color: 'var(--text)' }}>{fo.strategy}</div>
                        <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                          {fo.aum_estimate && fo.aum_estimate !== 'Unknown' && (
                            <span style={{ fontSize: 10, color: 'var(--muted)' }}>💰 AUM: <strong>{fo.aum_estimate}</strong></span>
                          )}
                          {fo.typical_commitment && fo.typical_commitment !== 'Unknown' && (
                            <span style={{ fontSize: 10, color: 'var(--muted)' }}>📋 Commitment: <strong>{fo.typical_commitment}</strong></span>
                          )}
                          {fo.stage_focus && (
                            <span style={{ fontSize: 10, color: 'var(--muted)' }}>🎯 Stage: <strong>{fo.stage_focus}</strong></span>
                          )}
                          {fo.confidence && (
                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 8, background: fo.confidence === 'high' ? '#ECFDF5' : fo.confidence === 'medium' ? '#FFF7ED' : '#FEF2F2', color: fo.confidence === 'high' ? '#059669' : fo.confidence === 'medium' ? '#D97706' : '#DC2626' }}>
                              {fo.confidence} confidence
                            </span>
                          )}
                        </div>
                        {fo.notable_gp_relationships && fo.notable_gp_relationships.length > 0 && fo.notable_gp_relationships[0] !== 'Unknown' && (
                          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--muted)' }}>
                            Known GP relationships: {fo.notable_gp_relationships.slice(0, 4).join(', ')}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Warm Intro Angles */}
                    {b.warm_intro_angles && b.warm_intro_angles.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>🤝 Warm Intro Angles</div>
                        {b.warm_intro_angles.slice(0, 3).map((a, i) => (
                          <div key={i} style={{ padding: '8px 10px', background: '#F0FDF4', borderRadius: 4, borderLeft: '3px solid #059669', marginBottom: 6 }}>
                            <div style={{ fontWeight: 600, color: '#065F46', marginBottom: 2 }}>{a.angle}</div>
                            <div style={{ color: 'var(--muted)', lineHeight: 1.4 }}>{a.rationale}</div>
                            {a.suggested_approach && (
                              <div style={{ marginTop: 4, fontSize: 11, color: '#059669', fontStyle: 'italic' }}>→ {a.suggested_approach}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Talking Points */}
                    {b.talking_points && b.talking_points.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>💬 Talking Points</div>
                        {b.talking_points.map((pt, i) => (
                          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5, alignItems: 'flex-start' }}>
                            <span style={{ color: '#7C3AED', fontSize: 10, marginTop: 2, flexShrink: 0 }}>▸</span>
                            <span style={{ lineHeight: 1.4, color: 'var(--text)' }}>{pt}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Recent Activity */}
                    {b.recent_activity && b.recent_activity.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>📰 Recent Activity</div>
                        {b.recent_activity.slice(0, 4).map((ev, i) => (
                          <div key={i} style={{ padding: '6px 10px', background: 'var(--card-bg)', borderRadius: 4, marginBottom: 4 }}>
                            {ev.approximate_date && (
                              <span style={{ fontSize: 10, color: 'var(--muted)', marginRight: 6 }}>{ev.approximate_date}</span>
                            )}
                            <span style={{ color: 'var(--text)' }}>{ev.event}</span>
                            {ev.relevance && (
                              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, fontStyle: 'italic' }}>↳ {ev.relevance}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Red Flags */}
                    {b.red_flags && b.red_flags.length > 0 && b.red_flags[0] && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#DC2626', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>⚠️ Watch Points</div>
                        {b.red_flags.map((f, i) => (
                          <div key={i} style={{ fontSize: 11, color: '#B91C1C', padding: '4px 10px', background: '#FEF2F2', borderRadius: 4, marginBottom: 3 }}>{f}</div>
                        ))}
                      </div>
                    )}

                    {/* Recommended Approach */}
                    {b.recommended_approach && (
                      <div style={{ padding: '8px 12px', background: '#EFF6FF', borderRadius: 4, borderLeft: '3px solid #3B82F6', marginBottom: 6 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#1D4ED8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 3 }}>Recommended Approach</div>
                        <div style={{ color: '#1E3A8A', lineHeight: 1.5 }}>{b.recommended_approach}</div>
                      </div>
                    )}

                    {/* Sources badge */}
                    {b.data_quality?.sources_used && (
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>
                        Sources: {b.data_quality.sources_used.map(s => s.replace(/_/g, ' ')).join(' · ')}
                        {b.data_quality.notes && ` · ${b.data_quality.notes}`}
                      </div>
                    )}
                  </div>
                );
              })()}

              {!researchBrief && !researchLoading && (
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                  AI-powered research brief: fund strategy, warm intro angles, and tailored talking points synthesised from Apollo, LinkedIn, and web data.
                </p>
              )}
            </div>

            {/* Intro Email Generator */}
            <div className="detail-section">
              <h3>Generate Intro Email</h3>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                Drafts a personalised intro from <strong>{user?.full_name || user?.name || 'you'}</strong> to {detail?.company}.
              </p>
              <button
                disabled={generatingIntro}
                onClick={async () => {
                  setGeneratingIntro(true);
                  try {
                    const data = await request(`/lp/targets/${detail.id}/draft-intro`, { method: 'POST', body: JSON.stringify({}) });
                    setIntroEmail(data);
                  } finally {
                    setGeneratingIntro(false);
                  }
                }}
                style={{ padding: '6px 14px', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: generatingIntro ? 'default' : 'pointer',
                  background: '#003B76', color: '#fff', border: 'none', opacity: generatingIntro ? 0.6 : 1 }}>
                {generatingIntro ? 'Generating…' : '✉ Draft Intro Email'}
              </button>

              {introEmail && introEmail.lp_company === detail?.company && (
                <div style={{ marginTop: 14, border: '1px solid var(--border-light)', borderRadius: 6, overflow: 'hidden' }}>
                  <div style={{ background: '#F8FAFC', padding: '10px 14px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Subject</div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{introEmail.subject}</div>
                    </div>
                    <button onClick={() => { navigator.clipboard.writeText(`Subject: ${introEmail.subject}\n\n${introEmail.body}`); }}
                      style={{ fontSize: 11, padding: '4px 10px', border: '1px solid var(--border-light)', borderRadius: 4, background: '#fff', cursor: 'pointer' }}>
                      Copy
                    </button>
                  </div>
                  <textarea
                    value={introEmail.body}
                    onChange={e => setIntroEmail(prev => ({ ...prev, body: e.target.value }))}
                    style={{ width: '100%', minHeight: 280, padding: '12px 14px', fontSize: 12, lineHeight: 1.6, border: 'none', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
                  />
                </div>
              )}
            </div>

            {/* Email Draft */}
            <div className="detail-section">
              <h3>Draft Outreach Email</h3>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: showEmailDraft ? 12 : 0 }}>
                <button
                  onClick={() => generateEmailDraft('cold')}
                  style={{
                    padding: '5px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600,
                    border: '1px solid #003B76', background: emailDraftType === 'cold' && showEmailDraft ? '#003B76' : 'transparent',
                    color: emailDraftType === 'cold' && showEmailDraft ? 'white' : '#003B76'
                  }}>
                  Cold Outreach
                </button>
                {detail.connectors && detail.connectors.length > 0 && (
                  <button
                    onClick={() => generateEmailDraft('warm_intro')}
                    style={{
                      padding: '5px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600,
                      border: '1px solid #059669', background: emailDraftType === 'warm_intro' && showEmailDraft ? '#059669' : 'transparent',
                      color: emailDraftType === 'warm_intro' && showEmailDraft ? 'white' : '#059669'
                    }}>
                    Warm Intro
                  </button>
                )}
                {detail.warm_intro_paths && detail.warm_intro_paths.length > 0 && (
                  <button
                    onClick={() => generateEmailDraft('warm_intro_path')}
                    style={{
                      padding: '5px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600,
                      border: '1px solid #7C3AED', background: emailDraftType === 'warm_intro_path' && showEmailDraft ? '#7C3AED' : 'transparent',
                      color: emailDraftType === 'warm_intro_path' && showEmailDraft ? 'white' : '#7C3AED'
                    }}>
                    Mutual Contact
                  </button>
                )}
                <button
                  onClick={() => generateEmailDraft('follow_up')}
                  style={{
                    padding: '5px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600,
                    border: '1px solid #F59E0B', background: emailDraftType === 'follow_up' && showEmailDraft ? '#F59E0B' : 'transparent',
                    color: emailDraftType === 'follow_up' && showEmailDraft ? 'white' : '#F59E0B'
                  }}>
                  Follow Up
                </button>
              </div>
              {showEmailDraft && emailDraft && (
                <div style={{ background: 'var(--card-bg)', borderRadius: 8, padding: 12, border: '1px solid var(--border-light)' }}>
                  {emailDraft.to && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                      To: <span style={{ color: 'var(--text)' }}>{emailDraft.to}</span>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                    Subject: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{emailDraft.subject}</span>
                  </div>
                  <textarea
                    value={emailDraft.body}
                    onChange={(e) => setEmailDraft({ ...emailDraft, body: e.target.value })}
                    style={{
                      width: '100%', minHeight: 180, padding: 10, borderRadius: 6,
                      border: '1px solid var(--border-light)', background: 'var(--bg)',
                      color: 'var(--text)', fontSize: 12, lineHeight: 1.6, resize: 'vertical',
                      fontFamily: 'inherit'
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`Subject: ${emailDraft.subject}\n\n${emailDraft.body}`);
                        setEmailCopied(true);
                        setTimeout(() => setEmailCopied(false), 2000);
                      }}
                      style={{
                        padding: '5px 14px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600,
                        border: 'none', background: emailCopied ? '#059669' : '#003B76', color: 'white'
                      }}>
                      {emailCopied ? '✓ Copied' : 'Copy to Clipboard'}
                    </button>
                    {emailDraft.to && (
                      <a
                        href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(emailDraft.to)}&su=${encodeURIComponent(emailDraft.subject)}&body=${encodeURIComponent(emailDraft.body)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          padding: '5px 14px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                          border: 'none', background: '#EA4335', color: 'white',
                          textDecoration: 'none', display: 'inline-block'
                        }}>
                        Open in Gmail →
                      </a>
                    )}
                    <button
                      onClick={() => setShowEmailDraft(false)}
                      style={{
                        padding: '5px 14px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600,
                        border: '1px solid var(--border-light)', background: 'transparent', color: 'var(--muted)',
                        marginLeft: 'auto'
                      }}>
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Connectors */}
            {detail.connectors && detail.connectors.length > 0 && (
              <div className="detail-section">
                <h3>Connectors ({detail.connectors.length})</h3>
                {detail.connectors.map((conn, i) => (
                  <div key={i} style={{
                    padding: 10, background: 'var(--card-bg)', borderRadius: 6, marginBottom: 8,
                    fontSize: 12
                  }}>
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>{conn.name}</div>
                    {conn.email && <div style={{ color: 'var(--muted)' }}>{conn.email}</div>}
                    {conn.connection_type && (
                      <div style={{ marginTop: 4 }}>
                        <span className="badge" style={{
                          background: CONNECTION_STRENGTH_COLORS[conn.connection_type] || '#9CA3AF',
                          color: 'white', padding: '2px 6px', borderRadius: 3, fontSize: 10
                        }}>
                          {CONNECTION_STRENGTH_LABELS[conn.connection_type] || conn.connection_type}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Warm Intro Paths (Known Contacts at this Company) */}
            {detail.warm_intro_paths && detail.warm_intro_paths.length > 0 && (
              <div className="detail-section">
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#F59E0B' }}>🤝</span> Warm Intro Paths
                  <span style={{ fontSize: 11, background: '#F59E0B', color: 'white', padding: '2px 8px', borderRadius: 10 }}>
                    {detail.warm_intro_paths.reduce((sum, p) => sum + p.known_contacts.length, 0)} contact{detail.warm_intro_paths.reduce((sum, p) => sum + p.known_contacts.length, 0) !== 1 ? 's' : ''}
                  </span>
                </h3>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
                  People your team knows at <strong>{detail.company}</strong> who could make introductions.
                </div>
                {detail.warm_intro_paths.map((path, pi) => (
                  <div key={pi} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#D97706', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
                      via {path.team_member_name}
                    </div>
                    {path.known_contacts.map((kc, ci) => (
                      <div key={ci} style={{
                        padding: 10, background: '#FFFBEB', borderRadius: 6, marginBottom: 6,
                        borderLeft: '3px solid #F59E0B', fontSize: 12
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div>
                            <div style={{ fontWeight: 600, color: '#92400E' }}>{kc.full_name}</div>
                            {kc.title && <div style={{ color: '#78716C', marginTop: 2 }}>{kc.title}</div>}
                            {kc.seniority && (
                              <span style={{
                                display: 'inline-block', marginTop: 4,
                                background: SENIORITY_COLORS[kc.seniority] || '#6B7280',
                                color: 'white', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600
                              }}>
                                {SENIORITY_LABELS[kc.seniority] || kc.seniority}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                            {kc.email && (
                              <span style={{ fontSize: 10, color: '#059669', background: '#ECFDF5', padding: '2px 6px', borderRadius: 3 }}>
                                Has email
                              </span>
                            )}
                            {kc.linkedin_url && (
                              <a href={kc.linkedin_url} target="_blank" rel="noopener noreferrer"
                                style={{ fontSize: 10, color: '#0077B5' }}>LinkedIn →</a>
                            )}
                          </div>
                        </div>
                        {kc.relationship_note && (
                          <div style={{ marginTop: 6, fontSize: 11, color: '#92400E', fontStyle: 'italic' }}>
                            "{kc.relationship_note}"
                          </div>
                        )}
                        <div style={{ marginTop: 6, fontSize: 11, color: '#92400E', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ opacity: 0.6 }}>{path.team_member_name}</span>
                          <span style={{ opacity: 0.4 }}>→</span>
                          <span>{kc.full_name}</span>
                          <span style={{ opacity: 0.4 }}>→</span>
                          <span style={{ fontWeight: 500 }}>{detail.full_name || detail.name}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Manual Connections (Navigator / 2nd-degree) */}
            <div className="detail-section">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ color: '#0077B5' }}>in</span> 2nd-Degree Connections
                {(detail.manual_connections || []).length > 0 && (
                  <span style={{ fontSize: 11, background: '#0077B5', color: 'white', padding: '2px 8px', borderRadius: 10 }}>
                    {(detail.manual_connections || []).length}
                  </span>
                )}
                <button
                  onClick={() => setShowAddConnection(v => !v)}
                  style={{
                    marginLeft: 'auto', padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                    border: '1px solid #0077B5', background: showAddConnection ? '#0077B5' : 'transparent',
                    color: showAddConnection ? '#fff' : '#0077B5', cursor: 'pointer',
                  }}>
                  {showAddConnection ? '✕ Cancel' : '+ Add'}
                </button>
              </h3>

              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                People you found via LinkedIn Navigator who can connect you to <strong>{detail.company || detail.full_name}</strong>.
              </div>

              {/* Add connection form */}
              {showAddConnection && (
                <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: 8, padding: 14, marginBottom: 14 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: '#0369A1', display: 'block', marginBottom: 4 }}>Name *</label>
                      <input value={newConnName} onChange={e => setNewConnName(e.target.value)}
                        placeholder="John Smith"
                        style={{ width: '100%', padding: '6px 8px', border: '1px solid #BAE6FD', borderRadius: 4, fontSize: 12, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: '#0369A1', display: 'block', marginBottom: 4 }}>Relationship</label>
                      <input value={newConnRelationship} onChange={e => setNewConnRelationship(e.target.value)}
                        placeholder="e.g. Co-investor at Acme"
                        style={{ width: '100%', padding: '6px 8px', border: '1px solid #BAE6FD', borderRadius: 4, fontSize: 12, boxSizing: 'border-box' }} />
                    </div>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: '#0369A1', display: 'block', marginBottom: 4 }}>LinkedIn URL</label>
                    <input value={newConnLinkedin} onChange={e => setNewConnLinkedin(e.target.value)}
                      placeholder="https://linkedin.com/in/..."
                      style={{ width: '100%', padding: '6px 8px', border: '1px solid #BAE6FD', borderRadius: 4, fontSize: 12, boxSizing: 'border-box' }} />
                  </div>
                  <button
                    disabled={addingConn || !newConnName.trim()}
                    onClick={async () => {
                      setAddingConn(true);
                      try {
                        await addManualConnection(detail.id, {
                          name: newConnName.trim(),
                          relationship: newConnRelationship.trim() || undefined,
                          linkedin_url: newConnLinkedin.trim() || undefined,
                        });
                        setNewConnName(''); setNewConnRelationship(''); setNewConnLinkedin('');
                        setShowAddConnection(false);
                        const updated = await getLPTarget(detail.id);
                        setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log, manual_connections: updated.manual_connections || [] });
                        loadTargets();
                      } catch (err) {
                        alert(err.message);
                      } finally {
                        setAddingConn(false);
                      }
                    }}
                    style={{
                      padding: '7px 16px', background: '#0077B5', color: '#fff', border: 'none',
                      borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: addingConn || !newConnName.trim() ? 'not-allowed' : 'pointer',
                      opacity: addingConn || !newConnName.trim() ? 0.6 : 1,
                    }}>
                    {addingConn ? 'Adding...' : 'Save Connection'}
                  </button>
                </div>
              )}

              {/* Connection list */}
              {(detail.manual_connections || []).length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(detail.manual_connections || []).map(conn => (
                    <div key={conn.id} style={{
                      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                      padding: '8px 12px', background: '#F0F9FF', borderRadius: 6,
                      border: '1px solid #BAE6FD', fontSize: 12,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 600, color: '#1E40AF' }}>{conn.name}</span>
                          {conn.linkedin_url && (
                            <a href={conn.linkedin_url} target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: 10, color: '#0077B5', textDecoration: 'none', background: '#DBEAFE', padding: '1px 5px', borderRadius: 3 }}>
                              LinkedIn ↗
                            </a>
                          )}
                        </div>
                        {conn.relationship && (
                          <div style={{ fontSize: 11, color: '#64748B', marginTop: 2, fontStyle: 'italic' }}>{conn.relationship}</div>
                        )}
                      </div>
                      <button
                        onClick={async () => {
                          if (!confirm(`Remove ${conn.name}?`)) return;
                          try {
                            await deleteManualConnection(detail.id, conn.id);
                            const updated = await getLPTarget(detail.id);
                            setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log, manual_connections: updated.manual_connections || [] });
                            loadTargets();
                          } catch (err) {
                            alert(err.message);
                          }
                        }}
                        style={{
                          padding: '2px 7px', borderRadius: 4, fontSize: 10, border: '1px solid #FCA5A5',
                          background: 'transparent', color: '#DC2626', cursor: 'pointer', marginLeft: 8, flexShrink: 0,
                        }}>✕</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center', padding: '16px 0' }}>
                  No connections added yet. Use LinkedIn Navigator to find warm paths, then add them above.
                </div>
              )}
            </div>

            {/* Apollo Contacts */}
            <div className="detail-section">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#6366F1' }}>⚡</span> Apollo Contacts
                {apolloContacts.length > 0 && (
                  <span style={{ fontSize: 11, background: '#6366F1', color: 'white', padding: '2px 8px', borderRadius: 10 }}>
                    {apolloContacts.length}
                  </span>
                )}
              </h3>
              {apolloContacts.length > 0 && apolloContacts.some(c => !c.enriched) && (
                <button
                  className="btn btn-sm"
                  style={{ marginBottom: 10, background: '#6366F1', color: 'white', border: 'none', fontSize: 11 }}
                  onClick={async () => {
                    try {
                      const res = await enrichApolloContactsBatch(selectedTarget);
                      alert(`Enriched ${res.enriched} contacts${res.errors ? ` (${res.errors} errors)` : ''}`);
                      const apolloData = await getApolloContacts(selectedTarget);
                      setApolloContacts(apolloData.contacts || []);
                    } catch (err) {
                      alert('Batch enrich failed: ' + err.message);
                    }
                  }}
                >
                  Enrich All Contacts (LinkedIn + Email)
                </button>
              )}
              {apolloContacts.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                  {[
                    { key: 'all', label: 'All' },
                    { key: 'c_suite', label: 'C-Suite' },
                    { key: 'vp', label: 'VP+' },
                    { key: 'has_email', label: 'Has Email' },
                    { key: 'known', label: 'Known' },
                  ].map(f => (
                    <button key={f.key} onClick={() => setContactFilter(f.key)} style={{
                      padding: '3px 10px', borderRadius: 12, fontSize: 10, cursor: 'pointer', fontWeight: 600,
                      border: contactFilter === f.key ? 'none' : '1px solid var(--border-light)',
                      background: contactFilter === f.key ? '#6366F1' : 'transparent',
                      color: contactFilter === f.key ? 'white' : 'var(--muted)',
                    }}>{f.label}</button>
                  ))}
                </div>
              )}
              {apolloContacts.length === 0 && !apolloLoading && apolloKeyStatus?.has_key && (
                <button
                  className="btn btn-sm"
                  style={{ marginBottom: 10, background: '#6366F1', color: 'white', border: 'none', fontSize: 11 }}
                  onClick={async () => {
                    setApolloLoading(true);
                    try {
                      const res = await apolloLiveSearch(selectedTarget, 25);
                      const apolloData = await getApolloContacts(selectedTarget);
                      setApolloContacts(apolloData.contacts || []);
                      await loadApolloStats();
                      if (!res.inserted) alert(`Apollo found ${res.total_found || 0} senior people. ${res.skipped_reason || 'No new contacts inserted.'}`);
                    } catch (err) {
                      alert('Apollo live search failed: ' + err.message);
                    } finally {
                      setApolloLoading(false);
                    }
                  }}
                >
                  ⚡ Search Apollo Live
                </button>
              )}
              {apolloLoading ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading Apollo data...</div>
              ) : apolloContacts.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {apolloContacts
                    .filter(contact => {
                      if (contactFilter === 'all') return true;
                      if (contactFilter === 'c_suite') return contact.seniority === 'c_suite';
                      if (contactFilter === 'vp') return contact.seniority === 'c_suite' || contact.seniority === 'vp';
                      if (contactFilter === 'has_email') return !!contact.email;
                      if (contactFilter === 'known') return contact.known_by && contact.known_by.length > 0;
                      return true;
                    })
                    .sort((a, b) => (SENIORITY_ORDER[a.seniority] || 99) - (SENIORITY_ORDER[b.seniority] || 99))
                    .map((contact, i) => {
                    const isKnown = contact.known_by && contact.known_by.length > 0;
                    return (
                    <div key={contact.id || i} style={{
                      padding: 12, background: isKnown ? '#FFFBEB' : 'var(--card-bg)', borderRadius: 8,
                      borderLeft: `3px solid ${isKnown ? '#F59E0B' : (SENIORITY_COLORS[contact.seniority] || '#6B7280')}`,
                      fontSize: 12
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>
                            {contact.full_name || `${contact.first_name} ${contact.last_name}`}
                            {contact.full_name && contact.last_name && contact.last_name.includes('***') && (
                              <span style={{ fontSize: 9, color: '#059669', marginLeft: 6, fontWeight: 400 }}>resolved</span>
                            )}
                          </div>
                          <div style={{ color: 'var(--muted)', marginTop: 2 }}>{contact.title}</div>
                          <div style={{ color: 'var(--muted)', marginTop: 2 }}>{contact.company_name}</div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                          {contact.seniority && (
                            <span style={{
                              background: SENIORITY_COLORS[contact.seniority] || '#6B7280',
                              color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600
                            }}>
                              {SENIORITY_LABELS[contact.seniority] || contact.seniority}
                            </span>
                          )}
                          {contact.email && (
                            <a href={`mailto:${contact.email}`} style={{ fontSize: 11, color: '#059669', textDecoration: 'none' }} title={contact.email}>
                              {contact.email}
                            </a>
                          )}
                        </div>
                      </div>
                      {(contact.city || contact.state || contact.country) && (
                        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                          📍 {[contact.city, contact.state, contact.country].filter(Boolean).join(', ')}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        {contact.linkedin_url && (
                          <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer"
                            style={{ fontSize: 11, color: '#0077B5' }}>
                            View LinkedIn →
                          </a>
                        )}
                        {contact.enriched && contact.email ? (
                          <span style={{ fontSize: 10, color: '#059669', background: '#ECFDF5', padding: '2px 6px', borderRadius: 3 }}>Enriched</span>
                        ) : contact.enriched && !contact.email ? (
                          <span style={{ fontSize: 10, color: '#D97706', background: '#FFFBEB', padding: '2px 6px', borderRadius: 3 }}>Enriched · No email</span>
                        ) : contact.full_name && contact.last_name && contact.last_name.includes('***') ? (
                          <span style={{ fontSize: 10, color: '#6366F1', background: '#EEF2FF', padding: '2px 6px', borderRadius: 3 }}>Name resolved</span>
                        ) : contact.last_name && contact.last_name.includes('***') ? (
                          <span style={{ fontSize: 10, color: '#9CA3AF', background: '#F3F4F6', padding: '2px 6px', borderRadius: 3 }}>Obfuscated</span>
                        ) : null}
                        {!contact.enriched && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await enrichApolloContact(contact.id, {
                                  linkedin_url: contact.linkedin_url || undefined,
                                  override_name: contact.full_name || undefined,
                                });
                                const apolloData = await getApolloContacts(selectedTarget);
                                setApolloContacts(apolloData.contacts || []);
                              } catch (err) {
                                alert('Enrich failed: ' + err.message);
                              }
                            }}
                            style={{
                              padding: '2px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
                              border: '1px solid #6366F1', background: 'transparent', color: '#6366F1', fontWeight: 600
                            }}
                          >
                            {contact.linkedin_url ? 'Enrich via RocketReach' : 'Enrich'}
                          </button>
                        )}
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              if (isKnown) {
                                await unflagKnownContact(contact.id);
                              } else {
                                await flagKnownContact(contact.id);
                              }
                              // Reload Apollo contacts to reflect change
                              const apolloData = await getApolloContacts(selectedTarget);
                              setApolloContacts(apolloData.contacts || []);
                              // Reload detail for warm intro paths
                              const data = await getLPTarget(selectedTarget);
                              setDetail({ ...(data.lp_target || data.target), connectors: data.connectors, warm_intro_paths: data.warm_intro_paths || [], linkedin_enrichment: data.linkedin_enrichment || null, activity: data.activity_log, manual_connections: data.manual_connections || [] });
                            } catch (err) { console.error('Flag error:', err); }
                          }}
                          style={{
                            marginLeft: 'auto',
                            padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                            border: isKnown ? '1px solid #F59E0B' : '1px solid var(--border-light)',
                            background: isKnown ? '#F59E0B' : 'transparent',
                            color: isKnown ? 'white' : 'var(--muted)',
                          }}
                        >
                          {isKnown ? '✓ I know them' : 'I know them'}
                        </button>
                      </div>
                      {isKnown && (
                        <div style={{ marginTop: 6, fontSize: 11, color: '#B45309', fontStyle: 'italic' }}>
                          Known by: {contact.known_by.map(k => k.team_member_name).join(', ')}
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 13, background: 'var(--card-bg)', borderRadius: 8 }}>
                  No Apollo contacts found yet for this company.
                  <br />
                  <span style={{ fontSize: 11 }}>Apollo enrichment is being processed progressively.</span>
                </div>
              )}
            </div>

            {/* Activity Log */}
            {detail.activity && detail.activity.length > 0 && (
              <div className="detail-section">
                <h3>Activity Log</h3>
                {detail.activity.map((a, i) => (
                  <div key={i} className="activity-item">
                    <div className="activity-dot" />
                    <div style={{ flex: 1 }}>
                      <div>
                        <strong>{a.action}</strong>
                      </div>
                      {a.details && (
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                          {typeof a.details === 'string' ? a.details : JSON.stringify(a.details)}
                        </div>
                      )}
                      <div className="activity-time">{timeAgo(a.created_at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Log Activity */}
            <div className="detail-section">
              <h3>Log Outreach Activity</h3>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <select value={activityAction} onChange={(e) => setActivityAction(e.target.value)}
                  style={{ padding: 8, border: '1px solid var(--border-light)', borderRadius: 4, flex: 1 }}>
                  <option value="email_sent">Email Sent</option>
                  <option value="call">Call</option>
                  <option value="intro_requested">Intro Requested</option>
                  <option value="intro_made">Intro Made</option>
                  <option value="meeting">Meeting Scheduled</option>
                  <option value="follow_up">Follow Up</option>
                </select>
                <button className="btn btn-primary" onClick={async () => {
                  try {
                    await addLPActivity(detail.id, {
                      action: activityAction,
                      details: activityDetails || undefined,
                    });
                    setActivityAction('email_sent');
                    setActivityDetails('');
                    const updated = await getLPTarget(detail.id);
                    setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log, manual_connections: updated.manual_connections || [] });
                  } catch (err) {
                    alert(err.message);
                  }
                }}>Log</button>
              </div>
              <textarea value={activityDetails} onChange={(e) => setActivityDetails(e.target.value)}
                placeholder="Add details (optional)" rows={2}
                style={{
                  width: '100%', padding: 8, border: '1px solid var(--border-light)',
                  borderRadius: 4, fontSize: 12, resize: 'none'
                }} />
            </div>

            {/* Notes */}
            <div className="detail-section">
              <h3>Internal Notes</h3>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Add a note..." rows={2}
                  style={{
                    flex: 1, padding: 8, border: '1px solid var(--border-light)',
                    borderRadius: 4, fontSize: 12, resize: 'none'
                  }} />
                <button className="btn btn-primary btn-sm" onClick={async () => {
                  if (!noteText.trim()) return;
                  try {
                    await updateLPTarget(detail.id, { notes: (detail.notes || '') + '\n' + noteText });
                    setNoteText('');
                    const updated = await getLPTarget(detail.id);
                    setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log, manual_connections: updated.manual_connections || [] });
                  } catch (err) {
                    alert(err.message);
                  }
                }} style={{ alignSelf: 'flex-end' }}>Add</button>
              </div>
              {detail.notes && (
                <div style={{
                  padding: 10, background: 'var(--card-bg)', borderRadius: 6,
                  fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap'
                }}>
                  {detail.notes}
                </div>
              )}
            </div>
          </div>
        </div>
      </>
    );
  };

  return (
    <>
      <div className="top-bar">
        <h1>LP Outreach</h1>
        <div className="top-bar-actions">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {stats ? `${stats.with_connector} LPs with connections` : ''}
          </span>
        </div>
      </div>

      <div className="page-body">
        {/* Tabs */}
        <div className="tab-bar">
          <button className={`tab-btn ${tab === 'lp-list' ? 'active' : ''}`}
            onClick={() => setTab('lp-list')}>
            LP List <span className="cnt">{targets.length}</span>
          </button>
          <button className={`tab-btn ${tab === 'setup' ? 'active' : ''}`}
            onClick={() => setTab('setup')}>
            Upload & Setup
          </button>
          <button className={`tab-btn ${tab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setTab('dashboard')}>
            Dashboard
          </button>
        </div>

        {/* Tab Content */}
        {tab === 'dashboard' && renderDashboard()}
        {tab === 'lp-list' && renderLPList()}
        {tab === 'setup' && renderUploadSetup()}
      </div>

      {/* Detail Panel */}
      {selectedTarget && renderDetail()}
    </>
  );
}
