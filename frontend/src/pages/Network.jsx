import { useState, useEffect, useCallback } from 'react';
import {
  getContactsLeaderboard,
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
} from '../services/api';

const STRENGTH_LABELS = {
  close: 'Close',
  warm: 'Warm',
  weak: 'Weak',
  cold: 'Cold',
};

const STRENGTH_COLORS = {
  close: '#0a7f3f',
  warm: '#b8860b',
  weak: '#888',
  cold: '#8a1f1f',
};

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function Network() {
  const [tab, setTab] = useState('leaderboard');
  const [leaderboard, setLeaderboard] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState('');
  const [strengthFilter, setStrengthFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadLeaderboard = useCallback(async () => {
    try {
      const data = await getContactsLeaderboard();
      setLeaderboard(data.leaderboard || []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const loadContacts = useCallback(async () => {
    try {
      const data = await getContacts({
        search,
        strength: strengthFilter,
        limit: 200,
      });
      setContacts(data.contacts || []);
    } catch (e) {
      console.error(e);
    }
  }, [search, strengthFilter]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadLeaderboard(), loadContacts()]).finally(() => setLoading(false));
  }, [loadLeaderboard, loadContacts]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    getContact(selected).then(setDetail).catch(console.error);
  }, [selected]);

  const handleCreate = async (form) => {
    try {
      await createContact(form);
      setShowCreate(false);
      await Promise.all([loadLeaderboard(), loadContacts()]);
    } catch (e) {
      alert(e.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this contact? Submissions will keep their reference but unlinked.')) return;
    try {
      await deleteContact(id);
      setSelected(null);
      await Promise.all([loadLeaderboard(), loadContacts()]);
    } catch (e) {
      alert(e.message);
    }
  };

  // Aggregate stats
  const totalContacts = contacts.length;
  const totalSourced = leaderboard.reduce((acc, r) => acc + parseInt(r.deals_sourced || 0), 0);
  const totalAdvanced = leaderboard.reduce((acc, r) => acc + parseInt(r.deals_advanced || 0), 0);

  return (
    <>
      <div className="top-bar">
        <h1>Network</h1>
        <div className="top-bar-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            + Add Contact
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="stats-row">
          <div className="stat-card hl">
            <div className="stat-value">{totalContacts}</div>
            <div className="stat-label">Contacts</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{leaderboard.length}</div>
            <div className="stat-label">Active Sources</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{totalSourced}</div>
            <div className="stat-label">Deals Sourced</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{totalAdvanced}</div>
            <div className="stat-label">Advanced</div>
          </div>
        </div>

        <div className="tab-bar">
          <button className={`tab-btn ${tab === 'leaderboard' ? 'active' : ''}`} onClick={() => setTab('leaderboard')}>
            Top Sources <span className="cnt">{leaderboard.length}</span>
          </button>
          <button className={`tab-btn ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
            All Contacts <span className="cnt">{totalContacts}</span>
          </button>
        </div>

        <div className="table-box">
          {tab === 'leaderboard' && (
            <>
              <div className="table-toolbar">
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Ranked by deal volume and advance rate
                </span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Strength</th>
                    <th style={{ textAlign: 'right' }}>Sourced</th>
                    <th style={{ textAlign: 'right' }}>Advanced</th>
                    <th style={{ textAlign: 'right' }}>Advance %</th>
                    <th>Last Referral</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.length === 0 && (
                    <tr><td colSpan="6" style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                      No referrals tracked yet. Tag intro sources on submissions to populate this view.
                    </td></tr>
                  )}
                  {leaderboard.map((r) => (
                    <tr key={r.id} onClick={() => setSelected(r.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{r.full_name}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                          {r.title}{r.title && r.company ? ' · ' : ''}{r.company}
                        </div>
                      </td>
                      <td>
                        <span style={{ padding: '2px 8px', background: STRENGTH_COLORS[r.relationship_strength] || '#888', color: 'white', borderRadius: 4, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                          {r.relationship_strength}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.deals_sourced}</td>
                      <td style={{ textAlign: 'right' }}>{r.deals_advanced}</td>
                      <td style={{ textAlign: 'right' }}>{r.advance_rate || 0}%</td>
                      <td>{timeAgo(r.last_referral_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {tab === 'all' && (
            <>
              <div className="table-toolbar">
                <div className="search-input">
                  <span>🔍</span>
                  <input
                    placeholder="Search contacts..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <select
                  value={strengthFilter}
                  onChange={(e) => setStrengthFilter(e.target.value)}
                  style={{ marginLeft: 8 }}
                >
                  <option value="">All strengths</option>
                  <option value="close">Close</option>
                  <option value="warm">Warm</option>
                  <option value="weak">Weak</option>
                  <option value="cold">Cold</option>
                </select>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Company</th>
                    <th>Strength</th>
                    <th style={{ textAlign: 'right' }}>Deals</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.length === 0 && (
                    <tr><td colSpan="6" style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                      {loading ? 'Loading…' : 'No contacts yet.'}
                    </td></tr>
                  )}
                  {contacts.map((c) => (
                    <tr key={c.id} onClick={() => setSelected(c.id)} style={{ cursor: 'pointer' }}>
                      <td style={{ fontWeight: 500 }}>{c.full_name}</td>
                      <td style={{ color: 'var(--muted)' }}>{c.email || '—'}</td>
                      <td>{c.company || '—'}</td>
                      <td>
                        <span style={{ padding: '2px 8px', background: STRENGTH_COLORS[c.relationship_strength] || '#888', color: 'white', borderRadius: 4, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                          {c.relationship_strength}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>{c.deals_sourced || 0}</td>
                      <td style={{ fontSize: 11, color: 'var(--muted)' }}>{c.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      {detail && (
        <ContactDetailDrawer
          detail={detail}
          onClose={() => { setSelected(null); setDetail(null); }}
          onSaved={async () => {
            await Promise.all([loadLeaderboard(), loadContacts()]);
            const fresh = await getContact(detail.id);
            setDetail(fresh);
          }}
          onDelete={() => handleDelete(detail.id)}
        />
      )}

      {showCreate && (
        <CreateContactModal
          onClose={() => setShowCreate(false)}
          onSave={handleCreate}
        />
      )}
    </>
  );
}

// ─── Contact detail drawer ─────────────────────────────────────────
function ContactDetailDrawer({ detail, onClose, onSaved, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    full_name: detail.full_name || '',
    email: detail.email || '',
    company: detail.company || '',
    title: detail.title || '',
    linkedin_url: detail.linkedin_url || '',
    relationship_strength: detail.relationship_strength || 'warm',
    notes: detail.notes || '',
  });

  useEffect(() => {
    setForm({
      full_name: detail.full_name || '',
      email: detail.email || '',
      company: detail.company || '',
      title: detail.title || '',
      linkedin_url: detail.linkedin_url || '',
      relationship_strength: detail.relationship_strength || 'warm',
      notes: detail.notes || '',
    });
  }, [detail.id]);

  const save = async () => {
    try {
      await updateContact(detail.id, form);
      setEditing(false);
      onSaved();
    } catch (e) {
      alert(e.message);
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, width: 480, height: '100vh',
      background: 'white', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', overflowY: 'auto', zIndex: 100,
    }}>
      <div style={{ padding: 20, borderBottom: '1px solid var(--border, #eee)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>{detail.full_name}</h2>
          {(detail.title || detail.company) && (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              {detail.title}{detail.title && detail.company ? ' · ' : ''}{detail.company}
            </p>
          )}
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer' }}>×</button>
      </div>

      <div style={{ padding: 20 }}>
        {!editing && (
          <>
            <div style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
              {detail.email && <div><strong>Email:</strong> {detail.email}</div>}
              {detail.linkedin_url && <div><strong>LinkedIn:</strong> <a href={detail.linkedin_url} target="_blank" rel="noopener">View →</a></div>}
              <div><strong>Strength:</strong> {STRENGTH_LABELS[detail.relationship_strength]}</div>
              <div><strong>Source:</strong> {detail.source}</div>
              {detail.notes && (
                <div style={{ marginTop: 8, padding: 10, background: 'var(--card-bg, #f7f7f9)', borderRadius: 6 }}>
                  {detail.notes}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>Edit</button>
              <button className="btn btn-secondary btn-sm" onClick={onDelete}>Delete</button>
            </div>
          </>
        )}

        {editing && (
          <div style={{ marginBottom: 20 }}>
            <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Full name" style={{ width: '100%', padding: 6, marginBottom: 4 }} />
            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" style={{ width: '100%', padding: 6, marginBottom: 4 }} />
            <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Company" style={{ width: '100%', padding: 6, marginBottom: 4 }} />
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title" style={{ width: '100%', padding: 6, marginBottom: 4 }} />
            <input value={form.linkedin_url} onChange={(e) => setForm({ ...form, linkedin_url: e.target.value })} placeholder="LinkedIn URL" style={{ width: '100%', padding: 6, marginBottom: 4 }} />
            <select value={form.relationship_strength} onChange={(e) => setForm({ ...form, relationship_strength: e.target.value })} style={{ width: '100%', padding: 6, marginBottom: 4 }}>
              <option value="close">Close</option>
              <option value="warm">Warm</option>
              <option value="weak">Weak</option>
              <option value="cold">Cold</option>
            </select>
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes" style={{ width: '100%', padding: 6, minHeight: 60 }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}

        <h3 style={{ fontSize: 14, marginBottom: 8, borderTop: '1px solid var(--border, #eee)', paddingTop: 16 }}>
          Sourced Deals ({detail.sourced_deals?.length || 0})
        </h3>
        {(!detail.sourced_deals || detail.sourced_deals.length === 0) && (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>No deals sourced from this contact yet.</p>
        )}
        {detail.sourced_deals?.map((d) => (
          <div key={d.id} style={{ padding: 10, borderBottom: '1px solid var(--border, #f0f0f0)', fontSize: 13 }}>
            <div style={{ fontWeight: 500 }}>{d.company_name}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {d.founder_name} · {d.sector} · {d.stage} · <strong>{d.status}</strong> · {timeAgo(d.submitted_at)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Create contact modal ──────────────────────────────────────────
function CreateContactModal({ onClose, onSave }) {
  const [form, setForm] = useState({
    full_name: '', email: '', company: '', title: '',
    linkedin_url: '', relationship_strength: 'warm', notes: '',
  });

  const submit = () => {
    if (!form.full_name.trim()) return alert('Name is required');
    onSave(form);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 200,
    }}>
      <div style={{ background: 'white', borderRadius: 8, padding: 24, width: 460 }}>
        <h2 style={{ fontSize: 18, marginBottom: 16 }}>Add Contact</h2>
        <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Full name *" style={{ width: '100%', padding: 8, marginBottom: 6 }} autoFocus />
        <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" style={{ width: '100%', padding: 8, marginBottom: 6 }} />
        <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Company" style={{ width: '100%', padding: 8, marginBottom: 6 }} />
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title" style={{ width: '100%', padding: 8, marginBottom: 6 }} />
        <input value={form.linkedin_url} onChange={(e) => setForm({ ...form, linkedin_url: e.target.value })} placeholder="LinkedIn URL" style={{ width: '100%', padding: 8, marginBottom: 6 }} />
        <select value={form.relationship_strength} onChange={(e) => setForm({ ...form, relationship_strength: e.target.value })} style={{ width: '100%', padding: 8, marginBottom: 6 }}>
          <option value="close">Close — direct relationship</option>
          <option value="warm">Warm — known, occasional contact</option>
          <option value="weak">Weak — loose connection</option>
          <option value="cold">Cold — inbound / no real relationship</option>
        </select>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes" style={{ width: '100%', padding: 8, minHeight: 60 }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit}>Add</button>
        </div>
      </div>
    </div>
  );
}
