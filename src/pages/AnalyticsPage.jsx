import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, MousePointerClick, TrendingUp, Loader2 } from 'lucide-react';
import { api } from '../services/api.js';

export default function AnalyticsPage() {
  const { shortCode } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getAnalytics(shortCode)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [shortCode]);

  if (loading) {
    return (
      <div className="page page-center">
        <Loader2 size={32} className="spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h2>Analytics unavailable</h2>
        <p className="error">{error}</p>
        <Link to="/" className="btn btn-primary"><ArrowLeft size={16} /> Back home</Link>
      </div>
    );
  }

  const maxClicks = Math.max(...data.clicksLast7Days.map((d) => d.count), 1);

  return (
    <div className="page">
      <Link to="/links" className="back-link"><ArrowLeft size={16} /> Back to links</Link>
      <h2>Analytics — <code>{data.shortCode}</code></h2>
      <p className="page-sub truncate" title={data.longUrl}>{data.longUrl}</p>

      <div className="stats-grid">
        <div className="stat-card">
          <MousePointerClick size={20} />
          <span className="stat-value">{data.totalClicks}</span>
          <span className="stat-label">Total clicks</span>
        </div>
        <div className="stat-card">
          <TrendingUp size={20} />
          <span className="stat-value">
            {data.clicksLast7Days.reduce((s, d) => s + d.count, 0)}
          </span>
          <span className="stat-label">Last 7 days</span>
        </div>
      </div>

      <div className="chart-card">
        <h3>Clicks — last 7 days</h3>
        <div className="chart">
          {data.clicksLast7Days.map((day) => (
            <div key={day.date} className="chart-bar-wrap">
              <div
                className="chart-bar"
                style={{ height: `${(day.count / maxClicks) * 100}%` }}
                title={`${day.count} clicks`}
              />
              <span className="chart-label">{day.date.slice(5)}</span>
            </div>
          ))}
        </div>
      </div>

      {data.recentClicks.length > 0 && (
        <div className="table-card">
          <h3>Recent clicks</h3>
          <table>
            <thead>
              <tr><th>Time</th><th>Referer</th></tr>
            </thead>
            <tbody>
              {data.recentClicks.map((click, i) => (
                <tr key={i}>
                  <td>{new Date(click.clickedAt).toLocaleString()}</td>
                  <td className="truncate">{click.referer ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
