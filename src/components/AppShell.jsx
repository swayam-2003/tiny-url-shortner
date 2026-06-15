import { Link, useLocation } from 'react-router-dom';
import { Link2, BarChart3, List } from 'lucide-react';

export default function AppShell({ children }) {
  const { pathname } = useLocation();

  const nav = [
    { to: '/', label: 'Shorten', icon: Link2 },
    { to: '/links', label: 'My Links', icon: List },
  ];

  return (
    <div className="app">
      <header className="header">
        <Link to="/" className="brand">
          <Link2 size={22} />
          <span>TinyURL</span>
        </Link>
        <nav className="nav">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={`nav-link ${pathname === to ? 'active' : ''}`}
            >
              <Icon size={16} />
              {label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="main">{children}</main>

      <footer className="footer">
        <BarChart3 size={14} />
        <span>Enterprise URL Shortener — Base62 · Redis · PostgreSQL</span>
      </footer>
    </div>
  );
}
