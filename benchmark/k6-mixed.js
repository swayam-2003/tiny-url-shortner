/**
 * k6 Load Test — Mixed workload (100:1 read/write ratio)
 *
 * Simulates realistic URL shortener traffic:
 *   ~1% POST (shorten) + ~99% GET (redirect)
 *
 * Default: 100 virtual users for 60 seconds.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.K6_BASE_URL || 'http://host.docker.internal:3001';
const VUS = Number(__ENV.K6_VUS || 100);
const DURATION = __ENV.K6_DURATION || '60s';

const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    mixed_traffic: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<100'],
    errors: ['rate<0.05'],
  },
};

export function setup() {
  const res = http.post(
    `${BASE}/api/v1/urls`,
    JSON.stringify({ longUrl: `https://example.com/k6-mixed-${Date.now()}` }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const shortCode = res.json('data.shortCode');
  http.get(`${BASE}/${shortCode}`, { redirects: 0 });
  return { shortCode };
}

export default function (data) {
  // ~1% writes, 99% reads (mimics 100:1 ratio)
  if (Math.random() < 0.01) {
    const res = http.post(
      `${BASE}/api/v1/urls`,
      JSON.stringify({ longUrl: `https://example.com/u-${__VU}-${Date.now()}` }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'shorten' } }
    );
    const ok = check(res, { 'shorten ok': (r) => r.status === 201 || r.status === 429 });
    errorRate.add(!ok && res.status !== 429);
  } else {
    const res = http.get(`${BASE}/${data.shortCode}`, {
      redirects: 0,
      tags: { name: 'redirect' },
    });
    const ok = check(res, { 'redirect 301': (r) => r.status === 301 });
    errorRate.add(!ok);
  }

  sleep(0.05);
}

export function handleSummary(data) {
  const shorten = data.metrics['http_req_duration{name:shorten}'];
  const redirect = data.metrics['http_req_duration{name:redirect}'];

  const summary = {
    test: 'mixed_100_to_1',
    base_url: BASE,
    virtual_users: VUS,
    duration: DURATION,
    total_requests: data.metrics.http_reqs?.values?.count ?? 0,
    throughput_rps: data.metrics.http_reqs?.values?.rate ?? 0,
    redirect_p95_ms: redirect?.values?.['p(95)'] ?? data.metrics.http_req_duration?.values?.['p(95)'],
    shorten_p95_ms: shorten?.values?.['p(95)'] ?? null,
    error_rate: data.metrics.errors?.values?.rate ?? 0,
  };

  return {
    stdout: `
╔══════════════════════════════════════════════════════════╗
║  k6 Mixed Workload (100:1 read/write) — Results          ║
╚══════════════════════════════════════════════════════════╝
  Virtual Users     : ${summary.virtual_users}
  Duration          : ${summary.duration}
  Total Requests    : ${summary.total_requests}
  Throughput        : ${summary.throughput_rps.toFixed(2)} req/s
  Redirect P95      : ${summary.redirect_p95_ms?.toFixed(2) ?? 'n/a'} ms
  Shorten P95       : ${summary.shorten_p95_ms?.toFixed(2) ?? 'n/a'} ms
  Error Rate        : ${(summary.error_rate * 100).toFixed(2)}%
`,
    '/scripts/results/k6-mixed-summary.json': JSON.stringify(summary, null, 2),
  };
}
