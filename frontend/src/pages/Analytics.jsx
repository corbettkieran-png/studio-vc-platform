import { useState, useEffect } from 'react';
import { getAnalytics, getStats, getActivity } from '../services/api';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
         PieChart, Pie, Cell, LineChart, Line, Legend } from 'recharts';

const COLORS = ['#003B76', '#55BCEA', '#16A34A', '#D97706', '#DC2626', '#6B7280', '#8B5CF6', '#EC4899'];

const STATUS_COLORS = {
  matched: '#16A34A', reviewing: '#003B76', contacted: '#D97706',
  passed: '#6B7280', rejected: '#DC2626',
};

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

export default function Analytics() {
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getAnalytics(), getStats(), getActivity({ limit: 15 })])
      .then(([analytics, statsData, actData]) => {
        setData(analytics);
        setStats(statsData);
        setActivity(actData.activity);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}>Loading analytics...</div>;

  // Process funnel data
  const funnelData = data?.funnel?.map((f) => ({
    name: f.status.charAt(0).toUpperCase() + f.status.slice(1),
    value: parseInt(f.count),
    fill: STATUS_COLORS[f.status] || '#6B7280',
  })) || [];

  // Process sector data
  const sectorMap = {};
  data?.by_sector?.forEach((r) => {
    if (!sectorMap[r.sector]) sectorMap[r.sector] = { sector: r.sector, total: 0 };
    sectorMap[r.sector].total += parseInt(r.count);
  });
  const sectorData = Object.values(sectorMap).sort((a, b) => b.total - a.total);

  // Process match rate data
  const matchRateData = data?.match_rate?.map((r) => ({
    sector: r.sector.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    rate: parseFloat(r.match_pct),
    total: parseInt(r.total),
  })) || [];

  // Process time series
  const timeData = {};
  data?.over_time?.forEach((r) => {
    const week = new Date(r.week).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (!timeData[week]) timeData[week] = { week, total: 0 };
    timeData[week].total += parseInt(r.count);
  });
  const timeSeriesData = Object.values(timeData);

  return (
    <>
      <div className="top-bar">
        <h1>Analytics</h1>
      </div>

      <div className="page-body">
        {/* Summary Stats */}
        {stats && (
          <div className="stats-row">
            <div className="stat-card hl">
              <div className="stat-value">{stats.total}</div>
              <div className="stat-label">Total Submissions</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.last_30d}</div>
              <div className="stat-label">Last 30 Days</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.last_7d}</div>
              <div className="stat-label">This Week</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{stats.with_video}</div>
              <div className="stat-label">With Video</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">
                {stats.total > 0 ? Math.round(100 * (parseInt(stats.total) - parseInt(stats.rejected)) / parseInt(stats.total)) : 0}%
              </div>
              <div className="stat-label">Match Rate</div>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
          {/* Pipeline Funnel */}
          <div className="card">
            <div className="card-header"><h2>Pipeline Funnel</h2></div>
            <div className="card-body">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={funnelData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {funnelData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Sector Breakdown */}
          <div className="card">
            <div className="card-header"><h2>By Sector</h2></div>
            <div className="card-body">
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={sectorData} dataKey="total" nameKey="sector" cx="50%" cy="50%"
                    outerRadius={100} label={({ sector, total }) => `${sector} (${total})`}
                    labelLine={{ strokeWidth: 1 }}>
                    {sectorData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Submissions Over Time */}
          <div className="card">
            <div className="card-header"><h2>Submissions Over Time</h2></div>
            <div className="card-body">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={timeSeriesData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                  <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="total" stroke="#003B76" strokeWidth={2} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Match Rate by Sector */}
          <div className="card">
            <div className="card-header"><h2>Match Rate by Sector</h2></div>
            <div className="card-body">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={matchRateData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                  <XAxis dataKey="sector" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} unit="%" />
                  <Tooltip formatter={(val) => `${val}%`} />
                  <Bar dataKey="rate" fill="#003B76" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Recent Activity Feed */}
        <div className="card">
          <div className="card-header"><h2>Recent Activity</h2></div>
          <div className="card-body">
            {activity.map((a) => (
              <div key={a.id} className="activity-item">
                <div className="activity-dot" style={{
                  background: a.action === 'submitted' ? 'var(--success)' :
                    a.action === 'status_change' ? 'var(--navy)' : 'var(--warning)'
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13 }}>
                    <strong>{a.user_name || 'System'}</strong>{' '}
                    {a.action === 'submitted' && <>submitted <strong>{a.company_name}</strong></>}
                    {a.action === 'status_change' && <>changed <strong>{a.company_name}</strong> to {a.details?.to}</>}
                    {a.action === 'note_added' && <>added a note on <strong>{a.company_name}</strong></>}
                    {a.action === 'progress_check' && <>checked progress on <strong>{a.company_name}</strong></>}
                  </div>
                  <div className="activity-time">{timeAgo(a.created_at)}</div>
                </div>
              </div>
            ))}
            {!activity.length && <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>No activity yet</p>}
          </div>
        </div>
      </div>
    </>
  );
}
