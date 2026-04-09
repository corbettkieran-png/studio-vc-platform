import { useState, useRef } from 'react';

const SECTORS = [
  { value: '', label: 'Select sector' },
  { value: 'fintech', label: 'Fintech' },
  { value: 'b2b_saas', label: 'B2B SaaS' },
  { value: 'enterprise_ai', label: 'Enterprise AI' },
  { value: 'healthtech', label: 'HealthTech' },
  { value: 'edtech', label: 'EdTech' },
  { value: 'climate', label: 'Climate / CleanTech' },
  { value: 'consumer', label: 'Consumer' },
  { value: 'other', label: 'Other' },
];

const STAGES = [
  { value: '', label: 'Select stage' },
  { value: 'pre_seed', label: 'Pre-Seed' },
  { value: 'seed', label: 'Seed' },
  { value: 'series_a', label: 'Series A' },
  { value: 'series_b', label: 'Series B+' },
];

const ARR_RANGES = [
  { value: '', label: 'Select range' },
  { value: 'pre_revenue', label: 'Pre-Revenue' },
  { value: 'under_250k', label: '< $250K' },
  { value: '250k_500k', label: '$250K – $500K' },
  { value: '500k_1m', label: '$500K – $1M' },
  { value: '1m_5m', label: '$1M – $5M' },
  { value: '5m_plus', label: '$5M+' },
];

const GROWTH = [
  { value: '', label: 'Select range' },
  { value: 'na', label: 'N/A (Pre-Revenue)' },
  { value: 'negative', label: 'Negative' },
  { value: '0_50', label: '0 – 50%' },
  { value: '50_100', label: '50 – 100%' },
  { value: '100_200', label: '100 – 200%' },
  { value: '200_plus', label: '200%+' },
];

export default function SubmitDeck() {
  const [form, setForm] = useState({
    founder_name: '', founder_email: '', founder_phone: '', founder_linkedin: '',
    company_name: '', one_liner: '', website: '', sector: '', stage: '',
    arr: '', yoy_growth: '', fundraising_amount: '',
  });
  const [deck, setDeck] = useState(null);
  const [video, setVideo] = useState(null);
  const [videoPreview, setVideoPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const videoRef = useRef();
  const deckInputRef = useRef();
  const videoInputRef = useRef();

  const update = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const handleDeck = (e) => {
    const file = e.target.files[0];
    if (file) setDeck(file);
  };

  const handleVideo = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      if (v.duration > 125) {
        alert('Video must be under 2 minutes. Please trim and re-upload.');
        URL.revokeObjectURL(url);
        return;
      }
      setVideo(file);
      setVideoPreview(url);
    };
    v.src = url;
  };

  const removeVideo = () => {
    if (videoPreview) URL.revokeObjectURL(videoPreview);
    setVideo(null);
    setVideoPreview(null);
    if (videoInputRef.current) videoInputRef.current.value = '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => { if (v) fd.append(k, v); });
      if (deck) fd.append('deck', deck);
      if (video) fd.append('video', video);

      const apiBase = import.meta.env.VITE_API_URL || '/api';
      const res = await fetch(`${apiBase}/submissions`, { method: 'POST', body: fd });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error);
      setResult(data);
    } catch (err) {
      alert(err.message || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    const matched = result.screening?.matched;
    return (
      <div className="submit-page">
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 48, maxWidth: 520, width: '90%', textAlign: 'center', boxShadow: '0 20px 40px rgba(0,0,0,0.08)' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24, background: matched ? 'rgba(22,163,74,0.1)' : 'rgba(0,59,118,0.08)' }}>
              {matched ? '✓' : '→'}
            </div>
            <h2 style={{ fontSize: 22, color: 'var(--navy)', marginBottom: 12 }}>
              {matched ? 'Submission Received' : 'Thank You for Submitting'}
            </h2>
            <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 20 }}>
              {matched
                ? `${result.company} matches our investment thesis. Our team will review your submission and follow up within 5 business days.`
                : `We've received your submission for ${result.company}. While it doesn't match our current focus areas, we'll keep it in our records and may reach out if our thesis evolves.`
              }
            </p>
            <button className="btn btn-primary" onClick={() => { setResult(null); setForm({ founder_name: '', founder_email: '', founder_phone: '', founder_linkedin: '', company_name: '', one_liner: '', website: '', sector: '', stage: '', arr: '', yoy_growth: '', fundraising_amount: '' }); setDeck(null); removeVideo(); }}>
              Submit Another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="submit-page">
      <div className="submit-hero">
        <h1>Studio VC</h1>
        <div className="submit-hero-title">Invest. Collaborate. Build.</div>
        <p className="subtitle">We partner with exceptional seed-stage founders building transformative companies in fintech, enterprise AI, and beyond.</p>
      </div>

      <form className="submit-form" onSubmit={handleSubmit}>
        <h2 style={{ fontSize: 20, color: 'var(--navy)', marginBottom: 4 }}>Founder Information</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 24 }}>Tell us about yourself</p>

        <div className="form-row">
          <div className="form-group">
            <label>Full Name <span className="req">*</span></label>
            <input value={form.founder_name} onChange={update('founder_name')} required placeholder="Jane Smith" />
          </div>
          <div className="form-group">
            <label>Email <span className="req">*</span></label>
            <input type="email" value={form.founder_email} onChange={update('founder_email')} required placeholder="jane@company.com" />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Phone</label>
            <input value={form.founder_phone} onChange={update('founder_phone')} placeholder="+1 (555) 000-0000" />
          </div>
          <div className="form-group">
            <label>LinkedIn</label>
            <input value={form.founder_linkedin} onChange={update('founder_linkedin')} placeholder="linkedin.com/in/janesmith" />
          </div>
        </div>

        <h2 style={{ fontSize: 20, color: 'var(--navy)', marginBottom: 4, marginTop: 32 }}>Company Details</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 24 }}>About your company and traction</p>

        <div className="form-row">
          <div className="form-group">
            <label>Company Name <span className="req">*</span></label>
            <input value={form.company_name} onChange={update('company_name')} required placeholder="Acme Inc." />
          </div>
          <div className="form-group">
            <label>Website</label>
            <input value={form.website} onChange={update('website')} placeholder="https://acme.com" />
          </div>
        </div>

        <div className="form-group">
          <label>One-Liner</label>
          <input value={form.one_liner} onChange={update('one_liner')} placeholder="What does your company do in one sentence?" />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Sector <span className="req">*</span></label>
            <select value={form.sector} onChange={update('sector')} required>
              {SECTORS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Stage <span className="req">*</span></label>
            <select value={form.stage} onChange={update('stage')} required>
              {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Annual Recurring Revenue</label>
            <select value={form.arr} onChange={update('arr')}>
              {ARR_RANGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Year-over-Year Growth</label>
            <select value={form.yoy_growth} onChange={update('yoy_growth')}>
              {GROWTH.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        </div>

        <div className="form-group">
          <label>Fundraising Amount</label>
          <input value={form.fundraising_amount} onChange={update('fundraising_amount')} placeholder="e.g. $2M" />
        </div>

        <h2 style={{ fontSize: 20, color: 'var(--navy)', marginBottom: 4, marginTop: 32 }}>Upload Materials</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 24 }}>Share your deck and an optional 2-minute video pitch</p>

        <div className="form-group">
          <label>Pitch Deck</label>
          <div className={`upload-area ${deck ? 'has-file' : ''}`} onClick={() => deckInputRef.current?.click()}>
            <input ref={deckInputRef} type="file" accept=".pdf,.pptx,.ppt,.key" onChange={handleDeck} style={{ display: 'none' }} />
            {deck ? (
              <p style={{ color: 'var(--success)', fontWeight: 500 }}>{deck.name}</p>
            ) : (
              <>
                <p><strong>Click to upload</strong> or drag and drop</p>
                <p style={{ fontSize: 11, color: '#999' }}>PDF, PPTX, PPT, KEY (max 25MB)</p>
              </>
            )}
          </div>
        </div>

        <div className="form-group">
          <label>Founder Video (Optional, max 2 min)</label>
          <div className={`upload-area ${video ? 'has-file' : ''}`} onClick={() => !video && videoInputRef.current?.click()}>
            <input ref={videoInputRef} type="file" accept="video/mp4,video/quicktime,video/webm" onChange={handleVideo} style={{ display: 'none' }} />
            {video ? (
              <p style={{ color: 'var(--success)', fontWeight: 500 }}>{video.name}</p>
            ) : (
              <>
                <p><strong>Click to upload</strong> a short video pitch</p>
                <p style={{ fontSize: 11, color: '#999' }}>MP4, MOV, WebM (max 2 minutes)</p>
              </>
            )}
          </div>
          {videoPreview && (
            <div style={{ marginTop: 8 }}>
              <video ref={videoRef} src={videoPreview} controls style={{ width: '100%', maxHeight: 300, borderRadius: 8 }} />
              <button type="button" onClick={removeVideo} className="btn btn-danger btn-sm" style={{ marginTop: 8 }}>
                Remove Video
              </button>
            </div>
          )}
        </div>

        <button type="submit" className="btn btn-primary" disabled={submitting}
          style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 15, marginTop: 16 }}>
          {submitting ? 'Submitting...' : 'Submit Deck'}
        </button>
      </form>
    </div>
  );
}
