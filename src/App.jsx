import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell.jsx';
import ShortenPage from './pages/ShortenPage.jsx';
import LinksPage from './pages/LinksPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<ShortenPage />} />
          <Route path="/links" element={<LinksPage />} />
          <Route path="/analytics/:shortCode" element={<AnalyticsPage />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}
