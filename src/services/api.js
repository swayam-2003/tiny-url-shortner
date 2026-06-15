const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message ?? `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  shorten: (body) => request('/api/v1/urls', { method: 'POST', body: JSON.stringify(body) }),
  getUrl: (shortCode) => request(`/api/v1/urls/${shortCode}`),
  getAnalytics: (shortCode) => request(`/api/v1/urls/${shortCode}/analytics`),
  deactivate: (shortCode) => request(`/api/v1/urls/${shortCode}`, { method: 'DELETE' }),
  health: () => request('/health'),
};
