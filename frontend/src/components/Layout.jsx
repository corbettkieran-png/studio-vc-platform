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
        {/* Brand mark — mirrors studio.vc logo treatment */}
        <div className="sidebar-logo">
          <span>Studio VC</span>
          <div className="tagline">Deal Flow Platform</div>
        </div>

        <nav className="sidebar-nav">
          <NavLink
            to="/crm"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
          >
            <span className="icon">▤</span> Deal Pipeline
          </NavLink>
          <NavLink
            to="/analytics"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
          >
            <span className="icon">↗</span> Analytics
          </NavLink>
          <NavLink
            to="/network"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
          >
            <span className="icon">◉</span> Network
          </NavLink>

          <div className="sidebar-nav-divider" />

          <NavLink
            to="/lp-outreach"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
          >
            <span className="icon">◈</span> LP Outreach
          </NavLink>
          <a
            href="/submit"
            target="_blank"
            rel="noopener"
            className="sidebar-link"
          >
            <span className="icon">⧉</span> Submission Form
          </a>
        </nav>

        <div className="sidebar-user">
          <div className="name">{user?.full_name || user?.name}</div>
          <div className="role">{user?.role}</div>
          <button
            onClick={handleLogout}
            style={{
              marginTop: 10,
              background: 'none',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(255,255,255,0.4)',
              fontSize: 10,
              fontFamily: 'Roboto, sans-serif',
              fontWeight: 700,
              letterSpacing: '1px',
              textTransform: 'uppercase',
              cursor: 'pointer',
              padding: '5px 12px',
              borderRadius: 50,
              transition: 'all 0.2s',
            }}
            onMouseEnter={e => {
              e.target.style.color = '#fff';
              e.target.style.borderColor = 'rgba(255,255,255,0.3)';
            }}
            onMouseLeave={e => {
              e.target.style.color = 'rgba(255,255,255,0.4)';
              e.target.style.borderColor = 'rgba(255,255,255,0.12)';
            }}
          >
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
