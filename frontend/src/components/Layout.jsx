import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="app-layout">
      <aside className="app-sidebar">
        <div className="sidebar-logo">Studio VC</div>
        <nav className="sidebar-nav">
          <NavLink to="/crm" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="icon">📋</span> Deal Pipeline
          </NavLink>
          <NavLink to="/analytics" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="icon">📊</span> Analytics
          </NavLink>
          <NavLink to="/lp-outreach" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="icon">🤝</span> LP Outreach
          </NavLink>
          <a href="/submit" target="_blank" rel="noopener" className="sidebar-link">
            <span className="icon">🔗</span> Submission Form
          </a>
        </nav>
        <div className="sidebar-user">
          <div className="name">{user?.full_name || user?.name}</div>
          <div>{user?.role}</div>
          <button onClick={handleLogout} style={{
            marginTop: 8, background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)',
            fontSize: 12, cursor: 'pointer', padding: 0
          }}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="app-main">
        {children}
      </main>
    </div>
  );
}
