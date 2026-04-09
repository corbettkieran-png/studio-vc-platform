import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/crm');
    } catch (err) {
      setError(err.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img
            src="/assets/logo.svg"
            alt="Studio VC"
            style={{ width: 160, filter: 'invert(1) brightness(0) saturate(0) invert(0.2) sepia(0.5) hue-rotate(180deg) brightness(0.3)' }}
          />
        </div>
        <p className="subtitle">Invest. Collaborate. Build.</p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="kieran@studiovc.com" required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password" required />
          </div>
          {error && <p style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}
            style={{ width: '100%', justifyContent: 'center', padding: '13px 0' }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
        <p style={{ textAlign: 'center', marginTop: 28, fontSize: 11, color: 'var(--muted)', letterSpacing: '0.3px' }}>
          Demo: kieran@studiovc.com / demo123
        </p>
      </div>
    </div>
  );
}
