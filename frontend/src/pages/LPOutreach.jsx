import { useState, useEffect, useCallback } from 'react';
import {
  getLPTeam, addLPTeamMember, removeLPTeamMember, uploadLinkedInCSV,
  importLPTargets, getLPTargets, getLPTarget, updateLPTarget, addLPActivity,
  runLPMatching, getLPStats, getApolloStatus, getApolloContacts,
  flagKnownContact, unflagKnownContact, enrichLPTarget,
  enrichApolloContact, enrichApolloContactsBatch
} from '../services/api';
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
  const [tab, setTab] = useState('dashboard');
  const [stats, setStats] = useState(null);
  const [targets, setTargets] = useState([]);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('fit_score');
  const [sortDir, setSortDir] = useState('desc');
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
        limit: 100,
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

  // Load team members
  const loadTeamMembers = useCallback(async () => {
    try {
      const data = await getLPTeam();
      setTeamMembers(data.team_members || data.team || []);
    } catch (err) {
      console.error('Load team error:', err);
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

  // Initial loads
  useEffect(() => {
    loadStats();
    loadTeamMembers();
    loadApolloStats();
  }, [loadStats, loadTeamMembers, loadApolloStats]);

  useEffect(() => {
    loadTargets();
  }, [loadTargets]);

  // Load detail when target selected
  useEffect(() => {
    if (!selectedTarget) {
      setDetail(null);
      setApolloContacts([]);
      return;
    }
    const loadDetail = async () => {
      try {
        const data = await getLPTarget(selectedTarget);
        setDetail({ ...(data.lp_target || data.target), connectors: data.connectors, warm_intro_paths: data.warm_intro_paths || [], linkedin_enrichment: data.linkedin_enrichment || null, activity: data.activity_log });
        // Load Apollo contacts for this LP
        setApolloLoading(true);
        try {
          const apolloData = await getApolloContacts(selectedTarget);
          setApolloContacts(apolloData.contacts || []);
        } catch { setApolloContacts([]); }
        setApolloLoading(false);
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

        {/* Status Breakdown */}
        {stats.by_status && Object.keys(stats.by_status).length > 0 && (
          <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Outreach Status Breakdown</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {Object.entries(stats.by_status).map(([status, count]) => (
                <div key={status} className="card" style={{ padding: 16, textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--navy)', marginBottom: 4 }}>
                    {count}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {OUTREACH_STATUS_LABELS[status] || status}
                  </div>
                </div>
              ))}
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

  // LP LIST TAB
  const renderLPList = () => {
    return (
      <>
        <div className="table-box">
          <div className="table-toolbar">
            <div className="search-input">
              <span>🔍</span>
              <input placeholder="Search LP name, company..." value={search}
                onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--border-light)', borderRadius: 4, fontSize: 12 }}>
                <option value="fit_score">Sort: Fit Score</option>
                <option value="connection_strength">Sort: Strength</option>
                <option value="name">Sort: Name</option>
                <option value="outreach_status">Sort: Status</option>
              </select>
              <select value={sortDir} onChange={(e) => setSortDir(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--border-light)', borderRadius: 4, fontSize: 12 }}>
                <option value="desc">↓ Descending</option>
                <option value="asc">↑ Ascending</option>
              </select>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Name / Company</th>
                <th>Fit Score</th>
                <th>Connector / Apollo</th>
                <th>Strength</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.id} onClick={() => setSelectedTarget(t.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{t.full_name || t.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{t.company}</div>
                  </td>
                  <td>
                    <FitScoreBar score={t.fit_score || 0} />
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {t.best_connector_name || '—'}
                    {t.total_connectors > 0 && (
                      <div style={{ fontSize: 10, color: '#6366F1', marginTop: 2 }}>
                        {t.total_connectors} contact{t.total_connectors !== 1 ? 's' : ''}
                      </div>
                    )}
                  </td>
                  <td>
                    <StatusBadge
                      status={CONNECTION_STRENGTH_LABELS[t.connection_strength] || t.connection_strength || 'No Connection'}
                      color={CONNECTION_STRENGTH_COLORS[t.connection_strength] || '#9CA3AF'}
                    />
                  </td>
                  <td>
                    <StatusBadge
                      status={OUTREACH_STATUS_LABELS[t.outreach_status] || t.outreach_status}
                      color={OUTREACH_STATUS_COLORS[t.outreach_status] || '#9CA3AF'}
                    />
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-sm btn-secondary" onClick={() => setSelectedTarget(t.id)}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
              {!targets.length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
                  {loading ? 'Loading...' : 'No LP targets found'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  // UPLOAD & SETUP TAB
  const renderUploadSetup = () => {
    return (
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
    );
  };

  // DETAIL PANEL
  const renderDetail = () => {
    if (!detail) return null;

    return (
      <>
        <div className="detail-overlay" onClick={() => setSelectedTarget(null)} />
        <div className="detail-panel open" style={{ maxHeight: '90vh', overflowY: 'auto' }}>
          <div className="detail-header">
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{detail.full_name || detail.name}</h2>
              <p style={{ fontSize: 13, color: 'var(--muted)' }}>{detail.company}</p>
            </div>
            <button onClick={() => setSelectedTarget(null)} style={{
              background: 'none', border: 'none', fontSize: 20, cursor: 'pointer',
              color: 'var(--muted)'
            }}>✕</button>
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
                            setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log });
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
                        setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log });
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
              {apolloLoading ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading Apollo data...</div>
              ) : apolloContacts.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {apolloContacts.map((contact, i) => {
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
                              setDetail({ ...(data.lp_target || data.target), connectors: data.connectors, warm_intro_paths: data.warm_intro_paths || [], linkedin_enrichment: data.linkedin_enrichment || null, activity: data.activity_log });
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
                    setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log });
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
                    setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, warm_intro_paths: updated.warm_intro_paths || [], linkedin_enrichment: updated.linkedin_enrichment || null, activity: updated.activity_log });
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
          <button className={`tab-btn ${tab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setTab('dashboard')}>
            Dashboard
          </button>
          <button className={`tab-btn ${tab === 'lp-list' ? 'active' : ''}`}
            onClick={() => setTab('lp-list')}>
            LP List <span className="cnt">{targets.length}</span>
          </button>
          <button className={`tab-btn ${tab === 'setup' ? 'active' : ''}`}
            onClick={() => setTab('setup')}>
            Upload & Setup
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
