import { useState, useEffect, createContext, useContext } from 'react';
import { login as apiLogin, getMe } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('svc_token');
    if (token) {
      getMe()
        .then((data) => setUser(data.user))
        .catch(() => {
          localStorage.removeItem('svc_token');
          localStorage.removeItem('svc_user');
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }

    // Google OAuth sets token in localStorage then fires this event
    const handleGoogleLogin = (e) => {
      if (e.detail?.user) setUser(e.detail.user);
    };
    window.addEventListener('svc:login', handleGoogleLogin);
    return () => window.removeEventListener('svc:login', handleGoogleLogin);
  }, []);

  const login = async (email, password) => {
    const data = await apiLogin(email, password);
    localStorage.setItem('svc_token', data.token);
    localStorage.setItem('svc_user', JSON.stringify(data.user));
    setUser(data.user);
    return data;
  };

  const logout = () => {
    localStorage.removeItem('svc_token');
    localStorage.removeItem('svc_user');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
