import { useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { api } from '../services/api.js';
import { saveLink } from '../hooks/useLinks.js';
import ShortUrlResult from './ShortUrlResult.jsx';

export default function UrlShortenerForm() {
  const [longUrl, setLongUrl] = useState('');
  const [customAlias, setCustomAlias] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const body = { longUrl };
      if (customAlias.trim()) body.customAlias = customAlias.trim();
      if (expiresInDays) body.expiresInDays = Number(expiresInDays);

      const { data } = await api.shorten(body);
      setResult(data);
      saveLink(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return <ShortUrlResult result={result} onReset={() => { setResult(null); setLongUrl(''); setCustomAlias(''); }} />;
  }

  return (
    <form className="form-card" onSubmit={handleSubmit}>
      <div className="form-header">
        <Link2 size={28} className="form-icon" />
        <div>
          <h1>Shorten your URL</h1>
          <p>Paste a long link and get a compact, secure short URL instantly.</p>
        </div>
      </div>

      <label className="field">
        <span>Long URL</span>
        <input
          type="url"
          placeholder="https://example.com/very/long/url"
          value={longUrl}
          onChange={(e) => setLongUrl(e.target.value)}
          required
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Custom alias <em>(optional)</em></span>
          <input
            type="text"
            placeholder="my-link"
            value={customAlias}
            onChange={(e) => setCustomAlias(e.target.value)}
            maxLength={12}
          />
        </label>
        <label className="field">
          <span>Expires in days <em>(optional)</em></span>
          <input
            type="number"
            placeholder="1825"
            min="1"
            max="3650"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
          />
        </label>
      </div>

      {error && <p className="error">{error}</p>}

      <button type="submit" className="btn btn-primary" disabled={loading}>
        {loading ? <><Loader2 size={18} className="spin" /> Shortening...</> : 'Shorten URL'}
      </button>
    </form>
  );
}
