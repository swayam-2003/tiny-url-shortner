/**
 * k6 Load Test — Redirect hot path (read-heavy)
 *
 * Simulates concurrent users clicking short links.
 * Default: 50 virtual users for 60 seconds.
 *
 * Run:
 *   docker run --rm -v "${PWD}/benchmark:/scripts" grafana/k6 run /scripts/k6-redirect.js
 *   K6_BASE_URL=http://host.docker.internal npm run benchmark:k6
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE = __ENV.K6_BASE_URL || 'http://host.docker.internal:3001';
const VUS = Number(__ENV.K6_VUS || 50);
const DURATION = __ENV.K6_DURATION || '60s';

const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
const redirectDuration = new Trend('redirect_duration', true);
const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    redirect_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<50', 'p(99)<100'],
    errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const res = http.post(
    `${BASE}/api/v1/urls`,
    JSON.stringify({ longUrl: `https://example.com/k6-setup-${Date.now()}` }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const body = res.json();
  if (!body?.data?.shortCode) {
    throw new Error(`Setup failed: ${res.status} ${res.body}`);
  }
  // Warm cache
  http.get(`${BASE}/${body.data.shortCode}`, { redirects: 0 });
  return { shortCode: body.data.shortCode };
}

export default function (data) {
  const res = http.get(`${BASE}/${data.shortCode}`, {
    redirects: 0,
    tags: { name: 'redirect' },
  });

  const ok = check(res, {
    'status is 301': (r) => r.status === 301,
    'has Location header': (r) => r.headers.Location !== undefined,
  });

  errorRate.add(!ok);
  redirectDuration.add(res.timings.duration);

  const cache = res.headers['X-Cache'];
  if (cache === 'HIT') cacheHits.add(1);
  else if (cache === 'MISS') cacheMisses.add(1);

  sleep(0.4); // ~2.5 req/s per VU — stays under Express 200 req/min limit
}

export function handleSummary(data) {
  const summary = {
    test: 'redirect_load',
    base_url: BASE,
    virtual_users: VUS,
    duration: DURATION,
    total_requests: data.metrics.http_reqs?.values?.count ?? 0,
    requests_per_second: data.metrics.http_reqs?.values?.rate ?? 0,
    latency_avg_ms: data.metrics.http_req_duration?.values?.avg ?? 0,
    latency_p95_ms: data.metrics.http_req_duration?.values['p(95)'] ?? 0,
    latency_p99_ms: data.metrics.http_req_duration?.values['p(99)'] ?? 0,
    error_rate: data.metrics.errors?.values?.rate ?? 0,
    cache_hits: data.metrics.cache_hits?.values?.count ?? 0,
    cache_misses: data.metrics.cache_misses?.values?.count ?? 0,
  };

  return {
    stdout: textSummary(data, summary),
    '/scripts/results/k6-redirect-summary.json': JSON.stringify(summary, null, 2),
  };
}

function textSummary(data, s) {
  return `
╔══════════════════════════════════════════════════════════╗
║  k6 Redirect Load Test — Results                         ║
╚══════════════════════════════════════════════════════════╝
  Target URL        : ${s.base_url}
  Virtual Users     : ${s.virtual_users}
  Duration          : ${s.duration}
  Total Requests    : ${s.total_requests}
  Throughput        : ${s.requests_per_second.toFixed(2)} req/s
  Latency Avg       : ${s.latency_avg_ms.toFixed(2)} ms
  Latency P95       : ${s.latency_p95_ms.toFixed(2)} ms
  Latency P99       : ${s.latency_p99_ms.toFixed(2)} ms
  Error Rate        : ${(s.error_rate * 100).toFixed(2)}%
  Cache Hits        : ${s.cache_hits}
  Cache Misses      : ${s.cache_misses}
`;
}
