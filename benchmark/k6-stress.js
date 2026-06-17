/**
 * k6 STRESS Test — 1000+ virtual users, maximum throughput
 *
 * Ramps from 0 → 1000 VUs to find peak RPS and rate-limit behavior.
 * No sleep between requests — fires as fast as possible.
 *
 * Run:
 *   npm run benchmark:k6:stress
 *   K6_VUS=2000 K6_DURATION=60s npm run benchmark:k6:stress
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.K6_BASE_URL || 'http://host.docker.internal';
const TARGET_VUS = Number(__ENV.K6_VUS || 1000);
const DURATION = __ENV.K6_DURATION || '60s';
const RAMP_UP = __ENV.K6_RAMP_UP || '30s';

const success301 = new Counter('status_301');
const rateLimited429 = new Counter('status_429');
const otherErrors = new Counter('status_other');
const errorRate = new Rate('errors');
const redirectMs = new Trend('redirect_ms', true);

export const options = {
  scenarios: {
    stress_ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: TARGET_VUS },
        { duration: DURATION, target: TARGET_VUS },
        { duration: '10s', target: 0 },
      ],
    },
  },
};

export function setup() {
  const res = http.post(
    `${BASE}/api/v1/urls`,
    JSON.stringify({ longUrl: `https://example.com/stress-${Date.now()}` }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const code = res.json('data.shortCode');
  http.get(`${BASE}/${code}`, { redirects: 0 });
  return { shortCode: code };
}

export default function (data) {
  const res = http.get(`${BASE}/${data.shortCode}`, { redirects: 0 });

  if (res.status === 301) success301.add(1);
  else if (res.status === 429) rateLimited429.add(1);
  else otherErrors.add(1);

  const ok = check(res, { '301 or 429': (r) => r.status === 301 || r.status === 429 });
  errorRate.add(!ok);
  redirectMs.add(res.timings.duration);
}

export function handleSummary(data) {
  const s301 = data.metrics.status_301?.values?.count ?? 0;
  const s429 = data.metrics.status_429?.values?.count ?? 0;
  const sOther = data.metrics.status_other?.values?.count ?? 0;
  const total = data.metrics.http_reqs?.values?.count ?? 0;
  const rps = data.metrics.http_reqs?.values?.rate ?? 0;

  const summary = {
    test: 'stress_ramp',
    base_url: BASE,
    target_vus: TARGET_VUS,
    ramp_up: RAMP_UP,
    hold_duration: DURATION,
    total_requests: total,
    requests_per_second: rps,
    successful_301: s301,
    rate_limited_429: s429,
    other_errors: sOther,
    success_rate_pct: total ? ((s301 / total) * 100) : 0,
    rate_limit_pct: total ? ((s429 / total) * 100) : 0,
    latency_avg_ms: data.metrics.http_req_duration?.values?.avg ?? 0,
    latency_p50_ms: data.metrics.http_req_duration?.values?.med ?? 0,
    latency_p95_ms: data.metrics.http_req_duration?.values?.['p(95)'] ?? 0,
    latency_p99_ms: data.metrics.http_req_duration?.values?.['p(99)'] ?? 0,
    latency_max_ms: data.metrics.http_req_duration?.values?.max ?? 0,
  };

  return {
    stdout: `
╔══════════════════════════════════════════════════════════════════╗
║  k6 STRESS TEST — ${TARGET_VUS} Virtual Users                              ║
╚══════════════════════════════════════════════════════════════════╝
  Target            : ${BASE}
  Virtual Users     : 0 → ${TARGET_VUS} (ramp ${RAMP_UP}) → hold ${DURATION}
  Total Requests    : ${total.toLocaleString()}
  Throughput        : ${rps.toFixed(2)} req/s

  Response Breakdown:
    301 Success     : ${s301.toLocaleString()} (${summary.success_rate_pct.toFixed(1)}%)
    429 Rate Limited: ${s429.toLocaleString()} (${summary.rate_limit_pct.toFixed(1)}%)
    Other Errors    : ${sOther.toLocaleString()}

  Latency:
    Avg             : ${summary.latency_avg_ms.toFixed(2)} ms
    P50             : ${summary.latency_p50_ms.toFixed(2)} ms
    P95             : ${summary.latency_p95_ms.toFixed(2)} ms
    P99             : ${summary.latency_p99_ms.toFixed(2)} ms
    Max             : ${summary.latency_max_ms.toFixed(2)} ms
`,
    '/scripts/results/k6-stress-summary.json': JSON.stringify(summary, null, 2),
  };
}
