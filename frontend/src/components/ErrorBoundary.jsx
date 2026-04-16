import { Component } from 'react';

/**
 * ErrorBoundary — catches any unhandled React render errors and shows a
 * recovery UI instead of a blank white screen. Wraps the entire app.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Caught render error:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#F0F4F8', fontFamily: '-apple-system, BlinkMacSystemFont, Inter, sans-serif',
      }}>
        <div style={{
          background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
          padding: '40px 48px', maxWidth: 480, textAlign: 'center',
          boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
        }}>
          <div style={{ fontSize: 36, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1D3557', marginBottom: 8 }}>
            Something went wrong
          </h2>
          <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24, lineHeight: 1.6 }}>
            The platform encountered an unexpected error. Your data is safe — this is a display issue only.
          </p>
          <div style={{
            background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 6,
            padding: '10px 14px', marginBottom: 24, textAlign: 'left',
          }}>
            <code style={{ fontSize: 11, color: '#64748B', wordBreak: 'break-all' }}>
              {this.state.error?.message || 'Unknown error'}
            </code>
          </div>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            style={{
              background: '#1D3557', color: '#fff', border: 'none',
              borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload Platform
          </button>
        </div>
      </div>
    );
  }
}
