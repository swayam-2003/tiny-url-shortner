import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check, Trash2, BarChart3, ExternalLink } from 'lucide-react';
import { getLinks, removeLink } from '../hooks/useLinks.js';
import { api } from '../services/api.js';

export default function LinksPage() {
  const [links, setLinks] = useState([]);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    setLinks(getLinks());
  }, []);

  async function handleCopy(shortUrl, shortCode) {
    await navigator.clipboard.writeText(shortUrl);
    setCopied(shortCode);
    setTimeout(() => setCopied(''), 2000);
  }

  async function handleDelete(shortCode) {
    try {
      await api.deactivate(shortCode);
    } catch {
      // still remove locally if already gone
    }
    removeLink(shortCode);
    setLinks(getLinks());
  }

  if (links.length === 0) {
    return (
      <div className="empty-state">
        <h2>No links yet</h2>
        <p>Shorten your first URL to see it here.</p>
        <Link to="/" className="btn btn-primary">Shorten a URL</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <h2>My Links</h2>
      <p className="page-sub">Links created in this browser session.</p>
      <ul className="link-list">
        {links.map((link) => (
          <li key={link.shortCode} className="link-item">
            <div className="link-info">
              <a href={link.shortUrl} target="_blank" rel="noreferrer" className="link-short">
                {link.shortUrl}
              </a>
              <p className="link-long" title={link.longUrl}>
                <ExternalLink size={12} />
                {link.longUrl}
              </p>
            </div>
            <div className="link-actions">
              <button
                type="button"
                className="btn-icon"
                onClick={() => handleCopy(link.shortUrl, link.shortCode)}
                title="Copy"
              >
                {copied === link.shortCode ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <Link to={`/analytics/${link.shortCode}`} className="btn-icon" title="Analytics">
                <BarChart3 size={16} />
              </Link>
              <button
                type="button"
                className="btn-icon danger"
                onClick={() => handleDelete(link.shortCode)}
                title="Deactivate"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
