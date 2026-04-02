import { useState, useEffect, useCallback } from 'react';
import {
  getLPTeam, addLPTeamMember, removeLPTeamMember, uploadLinkedInCSV,
  importLPTargets, getLPTargets, getLPTarget, updateLPTarget, addLPActivity,
  runLPMatching, getLPStats
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
  none: 'No Connection',
};

const CONNECTION_STRENGTH_COLORS = {
  direct_email: '#059669',
  direct_name: '#10B981',
  company_match: '#F59E0B',
  none: '#9CA3AF',
};

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
        search: search || undefined,
        sort_by: sortBy,
        sort_dir: sortDir,
        limit: 100,
      };
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

  // Initial loads
  useEffect(() => {
    loadStats();
    loadTeamMembers();
  }, [loadStats, loadTeamMembers]);

  useEffect(() => {
    loadTargets();
  }, [loadTargets]);

  // Load detail when target selected
  useEffect(() => {
    if (!selectedTarget) {
      setDetail(null);
      return;
    }
    const loadDetail = async () => {
      try {
        const data = await getLPTarget(selectedTarget);
        setDetail({ ...(data.lp_target || data.target), connectors: data.connectors, activity: data.activity_log });
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
                <th>Best Connector</th>
                <th>Strength</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.id} onClick={() => setSelectedTarget(t.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{t.company}</div>
                  </td>
                  <td>
                    <FitScoreBar score={t.fit_score || 0} />
                  </td>
                  <td style={{ fontSize: 12 }}>{t.best_connector_name || '—'}</td>
                  <td>
                    <StatusBadge
                      status={CONNECTION_STRENGTH_LABELS[t.connection_strength] || t.connection_strength}
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
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{detail.name}</h2>
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
                        setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, activity: updated.activity_log });
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
                    setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, activity: updated.activity_log });
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
                    setDetail({ ...(updated.lp_target || updated.target), connectors: updated.connectors, activity: updated.activity_log });
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
