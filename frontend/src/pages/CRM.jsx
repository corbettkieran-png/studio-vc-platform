import { useState, useEffect, useCallback } from 'react';
import { getSubmissions, getStats, updateStatus, addNote, addProgressCheck, getActivity, analyzeSubmission, setIntroSource, getContacts } from '../services/api';
import { useAuth } from '../hooks/useAuth';

const STATUS_LABELS = {
  matched: 'Matched', reviewing: 'Reviewing', contacted: 'Contacted',
  passed: 'Passed', rejected: 'Rejected',
};

const SECTOR_LABELS = {
  fintech: 'Fintech', b2b_saas: 'B2B SaaS', enterprise_ai: 'Enterprise AI',
  healthtech: 'HealthTech', edtech: 'EdTech', climate: 'Climate',
  consumer: 'Consumer', other: 'Other',
};

const ARR_LABELS = {
  pre_revenue: 'Pre-Revenue', under_250k: '< $250K', '250k_500k': '$250K–$500K',
  '500k_1m': '$500K–$1M', '1m_5m': '$1M–$5M', '5m_plus': '$5M+',
};

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function CRM() {
  const { user } = useAuth();
  const [tab, setTab] = useState('matched');
  const [stats, setStats] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [activityFeed, setActivityFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const statusesByTab = {
    matched: 'matched',
    pipeline: 'reviewing,contacted,passed',
    rejected: 'rejected',
  };

  const loadData = useCallback(async () => {
    try {
      const [statsData, subData] = await Promise.all([
        getStats(),
        getSubmissions({
          status: statusesByTab[tab],
          search: search || undefined,
        }),
      ]);
      setStats(statsData);
      setSubmissions(subData.submissions);
    } catch (err) {
      console.error('Load error:', err);
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  useEffect(() => { loadData(); }, [loadData]);

  // Load detail when selected
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    const sub = submissions.find((s) => s.id === selected);
    if (sub) {
      // Fetch full detail with notes/activity
      import('../services/api').then(({ getSubmission }) => {
        getSubmission(selected).then(setDetail).catch(console.error);
      });
    }
  }, [selected]);

  const handleStatusChange = async (id, newStatus) => {
    try {
      await updateStatus(id, newStatus);
      loadData();
      if (detail?.id === id) {
        const { getSubmission } = await import('../services/api');
        setDetail(await getSubmission(id));
      }
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAddNote = async () => {
    if (!noteText.trim() || !detail) return;
    try {
      await addNote(detail.id, noteText);
      setNoteText('');
      const { getSubmission } = await import('../services/api');
      setDetail(await getSubmission(detail.id));
    } catch (err) {
      alert(err.message);
    }
  };

  const refreshDetail = async (id) => {
    const { getSubmission } = await import('../services/api');
    setDetail(await getSubmission(id));
  };

  const handleSetIntroSource = async (id, payload) => {
    try {
      await setIntroSource(id, payload);
      await refreshDetail(id);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAnalyzeDeck = async (id) => {
    setAnalyzing(true);
    try {
      await analyzeSubmission(id);
      const { getSubmission } = await import('../services/api');
      setDetail(await getSubmission(id));
    } catch (err) {
      alert(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleProgressCheck = async (id) => {
    try {
      await addProgressCheck(id, {
        summary: 'Manual progress check initiated',
        sources: [
          { label: 'Google', url: `https://google.com/search?q=${encodeURIComponent(detail?.company_name || '')}` },
          { label: 'LinkedIn', url: `https://linkedin.com/search/results/companies/?keywords=${encodeURIComponent(detail?.company_name || '')}` },
          { label: 'Crunchbase', url: `https://crunchbase.com/discover/organization.companies/${encodeURIComponent(detail?.company_name?.toLowerCase().replace(/\s+/g, '-') || '')}` },
        ],
      });
      const { getSubmission } = await import('../services/api');
      setDetail(await getSubmission(id));
    } catch (err) {
      alert(err.message);
    }
  };

  const matchedCount = stats ? parseInt(stats.matched) : 0;
  const pipelineCount = stats ? parseInt(stats.reviewing) + parseInt(stats.contacted) + parseInt(stats.passed || 0) : 0;
  const rejectedCount = stats ? parseInt(stats.rejected) : 0;

  return (
    <>
      <div className="top-bar">
        <h1>Deal Pipeline</h1>
        <div className="top-bar-actions">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {stats ? `${stats.last_7d} new this week` : ''}
          </span>
        </div>
      </div>

      <div className="page-body">
        {/* Stats */}
        {stats && (
          <div className="stats-row">
            <div className="stat-card hl">
              <div className="stat-value">{stats.total}</div>
              <div className="stat-label">Total</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.matched}</div>
              <div className="stat-label">Matched</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.reviewing}</div>
              <div className="stat-label">Reviewing</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.contacted}</div>
              <div className="stat-label">Contacted</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.rejected}</div>
              <div className="stat-label">Didn't Match</div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="tab-bar">
          <button className={`tab-btn ${tab === 'matched' ? 'active' : ''}`} onClick={() => setTab('matched')}>
            Matched <span className="cnt">{matchedCount}</span>
          </button>
          <button className={`tab-btn ${tab === 'pipeline' ? 'active' : ''}`} onClick={() => setTab('pipeline')}>
            Pipeline <span className="cnt">{pipelineCount}</span>
          </button>
          <button className={`tab-btn ${tab === 'rejected' ? 'active' : ''}`} onClick={() => setTab('rejected')}>
            Didn't Match <span className="cnt">{rejectedCount}</span>
          </button>
        </div>

        {/* Table */}
        <div className="table-box">
          <div className="table-toolbar">
            <div className="search-input">
              <span>🔍</span>
              <input placeholder="Search companies, founders..." value={search}
                onChange={(e) => setSearch(e.target.value)} />
            </div>
            {tab === 'rejected' && (
              <button className="btn btn-primary btn-sm" onClick={() => alert('Bulk progress check — coming soon')}>
                Check All Progress
              </button>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Sector</th>
                <th>ARR</th>
                <th>Growth</th>
                <th>Status</th>
                <th>Video</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id} onClick={() => setSelected(s.id)}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{s.company_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.one_liner}
                    </div>
                  </td>
                  <td>{SECTOR_LABELS[s.sector] || s.sector}</td>
                  <td style={{ fontWeight: 600, color: 'var(--navy)' }}>{ARR_LABELS[s.arr] || s.arr || '—'}</td>
                  <td>{s.yoy_growth?.replace('_', '–').replace('plus', '+') || '—'}</td>
                  <td><span className={`badge badge-${s.status}`}>{STATUS_LABELS[s.status]}</span></td>
                  <td style={{ fontSize: 11 }}>{s.video_path ? <span style={{ color: 'var(--navy)' }}>▶ Yes</span> : <span style={{ color: '#CCC' }}>—</span>}</td>
                  <td style={{ fontSize: 12, color: 'var(--muted)' }}>{timeAgo(s.submitted_at)}</td>
                </tr>
              ))}
              {!submissions.length && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
                  {loading ? 'Loading...' : 'No submissions found'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Panel */}
      {selected && detail && (
        <>
          <div className="detail-overlay" onClick={() => setSelected(null)} />
          <div className="detail-panel open">
            <div className="detail-header">
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{detail.company_name}</h2>
                <p style={{ fontSize: 13, color: 'var(--muted)' }}>{detail.one_liner}</p>
              </div>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
            </div>

            <div className="detail-body">
              {/* Status */}
              <div className="detail-section">
                <h3>Status</h3>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {Object.entries(STATUS_LABELS).map(([key, label]) => (
                    <button key={key}
                      className={`btn btn-sm ${detail.status === key ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => handleStatusChange(detail.id, key)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Founder Info */}
              <div className="detail-section">
                <h3>Founder</h3>
                <div style={{ fontSize: 13, lineHeight: 2 }}>
                  <div><strong>{detail.founder_name}</strong></div>
                  <div>{detail.founder_email}</div>
                  {detail.founder_phone && <div>{detail.founder_phone}</div>}
                  {detail.founder_linkedin && <div><a href={detail.founder_linkedin} target="_blank" rel="noopener">LinkedIn →</a></div>}
                </div>
              </div>

              {/* Key Metrics */}
              <div className="detail-section">
                <h3>Key Metrics</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
                  <div style={{ padding: 10, background: 'var(--card-bg)', borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>SECTOR</div>
                    <div style={{ fontWeight: 500 }}>{SECTOR_LABELS[detail.sector]}</div>
                  </div>
                  <div style={{ padding: 10, background: 'var(--card-bg)', borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>STAGE</div>
                    <div style={{ fontWeight: 500 }}>{detail.stage}</div>
                  </div>
                  <div style={{ padding: 10, background: 'var(--card-bg)', borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>ARR</div>
                    <div style={{ fontWeight: 600, color: 'var(--navy)' }}>{ARR_LABELS[detail.arr] || '—'}</div>
                  </div>
                  <div style={{ padding: 10, background: 'var(--card-bg)', borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>YoY GROWTH</div>
                    <div style={{ fontWeight: 500 }}>{detail.yoy_growth?.replace('_', '–').replace('plus', '+') || '—'}</div>
                  </div>
                </div>
              </div>

              {/* Files */}
              <div className="detail-section">
                <h3>Materials</h3>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {detail.deck_path && (
                    <a href={`/uploads/${detail.deck_path.split(/[\\/]/).pop()}`} target="_blank" rel="noopener" className="btn btn-secondary btn-sm">
                      📄 View Deck
                    </a>
                  )}
                  {detail.video_path && (
                    <a href={`/uploads/${detail.video_path.split(/[\\/]/).pop()}`} target="_blank" rel="noopener" className="btn btn-secondary btn-sm">
                      ▶ Watch Video
                    </a>
                  )}
                  {detail.website && (
                    <a href={detail.website} target="_blank" rel="noopener" className="btn btn-secondary btn-sm">
                      🌐 Website
                    </a>
                  )}
                  {!detail.deck_path && !detail.video_path && !detail.website && (
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>No materials uploaded</span>
                  )}
                </div>
              </div>

              {/* Intro Source */}
              <IntroSourceSection
                detail={detail}
                onSave={(payload) => handleSetIntroSource(detail.id, payload)}
              />

              {/* AI Deck Analysis */}
              <div className="detail-section">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h3 style={{ margin: 0 }}>AI Investment Memo</h3>
                  {detail.deck_path && (
                    <button className="btn btn-secondary btn-sm" onClick={() => handleAnalyzeDeck(detail.id)} disabled={analyzing}>
                      {analyzing ? 'Analyzing…' : (detail.deck_analysis ? 'Re-analyze' : 'Analyze Deck')}
                    </button>
                  )}
                </div>
                {!detail.deck_path && (
                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>No deck uploaded — nothing to analyze.</p>
                )}
                {detail.deck_path && !detail.deck_analysis && detail.deck_analysis_status === 'running' && (
                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>Analysis in progress…</p>
                )}
                {detail.deck_path && !detail.deck_analysis && detail.deck_analysis_status === 'failed' && (
                  <p style={{ fontSize: 13, color: 'var(--red, #b00)' }}>Analysis failed: {detail.deck_analysis_error || 'Unknown error'}</p>
                )}
                {detail.deck_path && !detail.deck_analysis && !detail.deck_analysis_status && (
                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>Not yet analyzed.</p>
                )}
                {detail.deck_analysis && (() => {
                  const a = typeof detail.deck_analysis === 'string' ? JSON.parse(detail.deck_analysis) : detail.deck_analysis;
                  const recColor = a.recommendation === 'strong_interest' ? '#0a7f3f' : a.recommendation === 'explore' ? '#b8860b' : '#8a1f1f';
                  const recLabel = { strong_interest: 'Strong Interest', explore: 'Explore', pass: 'Pass' }[a.recommendation] || a.recommendation;
                  return (
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                        <span style={{ padding: '4px 10px', background: recColor, color: 'white', borderRadius: 4, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>{recLabel}</span>
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Confidence: {a.confidence}</span>
                      </div>
                      <div style={{ marginBottom: 10 }}><strong>Summary:</strong> {a.summary}</div>
                      {a.recommendation_rationale && (
                        <div style={{ marginBottom: 10, padding: 10, background: 'var(--card-bg)', borderRadius: 6 }}>
                          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>RATIONALE</div>
                          {a.recommendation_rationale}
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                        <div><strong>Problem:</strong> {a.problem}</div>
                        <div><strong>Solution:</strong> {a.solution}</div>
                        <div><strong>Market:</strong> {a.market}</div>
                        <div><strong>Model:</strong> {a.business_model}</div>
                        <div><strong>Team:</strong> {a.team}</div>
                        <div><strong>Differentiation:</strong> {a.differentiation}</div>
                      </div>
                      {a.traction && (
                        <div style={{ marginBottom: 10 }}>
                          <strong>Traction:</strong>{' '}
                          ARR: {a.traction.arr} · MRR: {a.traction.mrr} · Growth: {a.traction.growth} · Customers: {a.traction.customers}
                          {a.traction.other && a.traction.other !== 'Not disclosed' && ` · ${a.traction.other}`}
                        </div>
                      )}
                      {a.strengths?.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>Strengths:</strong>
                          <ul style={{ margin: '4px 0 0 18px' }}>{a.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                        </div>
                      )}
                      {a.risks?.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>Risks:</strong>
                          <ul style={{ margin: '4px 0 0 18px' }}>{a.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
                        </div>
                      )}
                      {a.diligence_questions?.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>Diligence Questions:</strong>
                          <ol style={{ margin: '4px 0 0 18px' }}>{a.diligence_questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
                        </div>
                      )}
                      {a.competitors?.length > 0 && (
                        <div style={{ marginBottom: 8 }}><strong>Competitors:</strong> {a.competitors.join(', ')}</div>
                      )}
                      {a.ask && <div style={{ marginBottom: 8 }}><strong>Ask:</strong> {a.ask}</div>}
                      {a.confidence_rationale && (
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                          {a.confidence_rationale}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Progress Checks (rejected only) */}
              {detail.status === 'rejected' && (
                <div className="detail-section">
                  <h3>Progress Tracking</h3>
                  <button className="btn btn-primary btn-sm" onClick={() => handleProgressCheck(detail.id)} style={{ marginBottom: 12 }}>
                    Check Progress
                  </button>
                  {detail.progress_checks?.map((pc) => (
                    <div key={pc.id} className="note-item">
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span className="note-author">{pc.checked_by_name || 'System'}</span>
                        <span className="note-time">{timeAgo(pc.checked_at)}</span>
                      </div>
                      <div className="note-content">{pc.summary}</div>
                      {pc.sources && (
                        <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                          {(typeof pc.sources === 'string' ? JSON.parse(pc.sources) : pc.sources).map((src, i) => (
                            <a key={i} href={src.url} target="_blank" rel="noopener" style={{ fontSize: 11 }}>{src.label} →</a>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {!detail.progress_checks?.length && (
                    <p style={{ fontSize: 13, color: 'var(--muted)' }}>No progress checks yet</p>
                  )}
                </div>
              )}

              {/* Notes */}
              <div className="detail-section">
                <h3>Internal Notes</h3>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Add a note..." rows={2}
                    style={{ flex: 1, padding: 10, border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, resize: 'none' }} />
                  <button className="btn btn-primary btn-sm" onClick={handleAddNote}
                    style={{ alignSelf: 'flex-end' }}>Add</button>
                </div>
                {detail.notes?.map((n) => (
                  <div key={n.id} className="note-item">
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span className="note-author">{n.author_name}</span>
                      <span className="note-time">{timeAgo(n.created_at)}</span>
                    </div>
                    <div className="note-content">{n.content}</div>
                  </div>
                ))}
                {!detail.notes?.length && (
                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>No notes yet</p>
                )}
              </div>

              {/* Activity Log */}
              <div className="detail-section">
                <h3>Activity</h3>
                {detail.activity?.map((a) => (
                  <div key={a.id} className="activity-item">
                    <div className="activity-dot" />
                    <div style={{ flex: 1 }}>
                      <div>
                        <strong>{a.user_name || 'System'}</strong>{' '}
                        {a.action === 'submitted' && 'submitted this company'}
                        {a.action === 'status_change' && `changed status: ${a.details?.from} → ${a.details?.to}`}
                        {a.action === 'note_added' && 'added a note'}
                        {a.action === 'progress_check' && 'ran a progress check'}
                      </div>
                      <div className="activity-time">{timeAgo(a.created_at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── Intro Source Section ──────────────────────────────────────────
function IntroSourceSection({ detail, onSave }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ full_name: '', email: '', company: '', title: '', relationship_strength: 'warm', notes: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) { setSearchResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const data = await getContacts({ search: searchQuery, limit: 8 });
        if (!cancelled) setSearchResults(data.contacts || []);
      } catch (e) {
        // silent
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [searchQuery]);

  const startEdit = () => {
    setForm({
      full_name: detail.intro_contact_name || detail.intro_source_raw_name || '',
      email: detail.intro_contact_email || detail.intro_source_raw_email || '',
      company: detail.intro_contact_company || '',
      title: detail.intro_contact_title || '',
      relationship_strength: detail.intro_contact_strength || 'warm',
      notes: detail.intro_source_notes || '',
    });
    setEditing(true);
  };

  const pickContact = (c) => {
    onSave({ contact_id: c.id, notes: form.notes });
    setEditing(false);
    setSearchQuery('');
    setSearchResults([]);
  };

  const saveNew = () => {
    if (!form.full_name.trim()) return;
    onSave({
      full_name: form.full_name,
      email: form.email,
      company: form.company,
      title: form.title,
      relationship_strength: form.relationship_strength,
      notes: form.notes,
    });
    setEditing(false);
  };

  const clearSource = () => {
    if (!confirm('Clear intro source?')) return;
    onSave({ contact_id: null });
  };

  const strengthColor = {
    close: '#0a7f3f', warm: '#b8860b', weak: '#888', cold: '#8a1f1f',
  };
  const hasContact = !!detail.intro_contact_id;
  const hasRaw = !hasContact && (detail.intro_source_raw_name || detail.intro_source_raw_email);

  return (
    <div className="detail-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Intro Source</h3>
        {!editing && (
          <button className="btn btn-secondary btn-sm" onClick={startEdit}>
            {hasContact || hasRaw ? 'Edit' : 'Add Source'}
          </button>
        )}
      </div>

      {!editing && !hasContact && !hasRaw && (
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>Inbound — no referrer captured.</p>
      )}

      {!editing && hasContact && (
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <strong>{detail.intro_contact_name}</strong>
            <span style={{ padding: '2px 8px', background: strengthColor[detail.intro_contact_strength] || '#888', color: 'white', borderRadius: 4, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
              {detail.intro_contact_strength}
            </span>
          </div>
          {(detail.intro_contact_title || detail.intro_contact_company) && (
            <div style={{ color: 'var(--muted)' }}>
              {detail.intro_contact_title}{detail.intro_contact_title && detail.intro_contact_company ? ' · ' : ''}{detail.intro_contact_company}
            </div>
          )}
          {detail.intro_contact_email && <div>{detail.intro_contact_email}</div>}
          {detail.intro_contact_linkedin && (
            <div><a href={detail.intro_contact_linkedin} target="_blank" rel="noopener">LinkedIn →</a></div>
          )}
          {detail.intro_source_notes && (
            <div style={{ marginTop: 6, padding: 8, background: 'var(--card-bg)', borderRadius: 4, fontSize: 12 }}>
              {detail.intro_source_notes}
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={clearSource} style={{ marginTop: 8 }}>Clear</button>
        </div>
      )}

      {!editing && hasRaw && (
        <div style={{ fontSize: 13 }}>
          <div><strong>{detail.intro_source_raw_name || '—'}</strong></div>
          {detail.intro_source_raw_email && <div style={{ color: 'var(--muted)' }}>{detail.intro_source_raw_email}</div>}
          {detail.intro_source_notes && <div style={{ marginTop: 4 }}>{detail.intro_source_notes}</div>}
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
            Captured from intake form. Click Edit to convert to a tracked contact.
          </p>
        </div>
      )}

      {editing && (
        <div style={{ fontSize: 13 }}>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>SEARCH EXISTING CONTACTS</label>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Type a name, email, or company..."
              style={{ width: '100%', padding: 6, fontSize: 13 }}
            />
            {searching && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Searching…</div>}
            {searchResults.length > 0 && (
              <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 4, maxHeight: 180, overflowY: 'auto', marginTop: 4 }}>
                {searchResults.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => pickContact(c)}
                    style={{ padding: 8, cursor: 'pointer', borderBottom: '1px solid var(--border, #eee)' }}
                  >
                    <div style={{ fontWeight: 500 }}>{c.full_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {c.email}{c.company ? ` · ${c.company}` : ''} · {c.deals_sourced || 0} deals
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--border, #eee)', paddingTop: 8, marginTop: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>OR CREATE NEW</div>
            <input
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              placeholder="Full name *"
              style={{ width: '100%', padding: 6, marginBottom: 4 }}
            />
            <input
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="Email"
              style={{ width: '100%', padding: 6, marginBottom: 4 }}
            />
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <input
                value={form.company}
                onChange={(e) => setForm({ ...form, company: e.target.value })}
                placeholder="Company"
                style={{ flex: 1, padding: 6 }}
              />
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Title"
                style={{ flex: 1, padding: 6 }}
              />
            </div>
            <select
              value={form.relationship_strength}
              onChange={(e) => setForm({ ...form, relationship_strength: e.target.value })}
              style={{ width: '100%', padding: 6, marginBottom: 4 }}
            >
              <option value="close">Close — direct relationship</option>
              <option value="warm">Warm — known, occasional contact</option>
              <option value="weak">Weak — loose connection</option>
              <option value="cold">Cold — inbound / no real relationship</option>
            </select>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Notes (how you know them, context, etc.)"
              style={{ width: '100%', padding: 6, minHeight: 50 }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={saveNew}>Save</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
