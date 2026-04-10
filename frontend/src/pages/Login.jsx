import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { loginWithGoogle } from '../services/api';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, login: setSession } = useAuth();
  const navigate = useNavigate();
  const googleBtnRef = useRef(null);

  // Load Google Identity Services and render the button
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    const scriptId = 'google-gsi';
    if (!document.getElementById(scriptId)) {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }

    function initGoogle() {
      if (!window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCredential,
        auto_select: false,
      });
      if (googleBtnRef.current) {
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: 'outline',
          size: 'large',
          width: googleBtnRef.current.offsetWidth || 340,
          text: 'signin_with',
        });
      }
    }

    // GSI may already be loaded or may finish after us
    if (window.google?.accounts?.id) {
      initGoogle();
    } else {
      const existing = document.getElementById(scriptId);
      existing.addEventListener('load', initGoogle);
      return () => existing.removeEventListener('load', initGoogle);
    }
  }, []);

  const handleGoogleCredential = async ({ credential }) => {
    setError('');
    setLoading(true);
    try {
      const data = await loginWithGoogle(credential);
      localStorage.setItem('svc_token', data.token);
      localStorage.setItem('svc_user', JSON.stringify(data.user));
      // Trigger auth context update by calling login with the resolved data
      window.dispatchEvent(new CustomEvent('svc:login', { detail: data }));
      navigate('/crm');
    } catch (err) {
      setError(err.message || 'Google sign-in failed');
    } finally {
      setLoading(false);
    }
  };

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

        {/* Google Sign-In */}
        {GOOGLE_CLIENT_ID && (
          <>
            <div ref={googleBtnRef} style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border-light)' }} />
              <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>or sign in with email</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border-light)' }} />
            </div>
          </>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@studio.vc" required />
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
      </div>
    </div>
  );
}
