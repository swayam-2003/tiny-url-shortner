import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check, ExternalLink, BarChart3 } from 'lucide-react';

export default function ShortUrlResult({ result, onReset }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(result.shortUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="result-card">
      <p className="result-label">Your short link is ready</p>
      <div className="result-url-row">
        <a href={result.shortUrl} target="_blank" rel="noreferrer" className="result-url">
          {result.shortUrl}
        </a>
        <button type="button" className="btn-icon" onClick={handleCopy} title="Copy">
          {copied ? <Check size={18} /> : <Copy size={18} />}
        </button>
      </div>
      <p className="result-original" title={result.longUrl}>
        <ExternalLink size={14} />
        {result.longUrl}
      </p>
      <div className="result-actions">
        <Link to={`/analytics/${result.shortCode}`} className="btn btn-secondary">
          <BarChart3 size={16} />
          View Analytics
        </Link>
        <button type="button" className="btn btn-ghost" onClick={onReset}>
          Shorten another
        </button>
      </div>
    </div>
  );
}
