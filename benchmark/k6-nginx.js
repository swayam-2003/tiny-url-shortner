/**
 * k6 Load Test — Nginx load balancer distribution
 *
 * Sends health + redirect requests through Nginx (port 80).
 * Tracks X-Server-Id header to verify api1/api2 distribution.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.K6_BASE_URL || 'http://host.docker.internal';
const VUS = Number(__ENV.K6_VUS || 30);
const DURATION = __ENV.K6_DURATION || '30s';

const api1Count = new Counter('server_api1');
const api2Count = new Counter('server_api2');
const otherServer = new Counter('server_other');

export const options = {
  scenarios: {
    lb_distribution: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
};

export function setup() {
  const res = http.post(
    `${BASE}/api/v1/urls`,
    JSON.stringify({ longUrl: `https://example.com/k6-lb-${Date.now()}` }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  return { shortCode: res.json('data.shortCode') };
}

export default function (data) {
  const res = http.get(`${BASE}/${data.shortCode}`, { redirects: 0 });

  check(res, { '301': (r) => r.status === 301 });

  const serverId = res.headers['X-Server-Id'];
  if (serverId === 'api1') api1Count.add(1);
  else if (serverId === 'api2') api2Count.add(1);
  else otherServer.add(1);

  sleep(0.1);
}

export function handleSummary(data) {
  const api1 = data.metrics.server_api1?.values?.count ?? 0;
  const api2 = data.metrics.server_api2?.values?.count ?? 0;
  const total = api1 + api2 + (data.metrics.server_other?.values?.count ?? 0);

  return {
    stdout: `
╔══════════════════════════════════════════════════════════╗
║  k6 Nginx Load Balancer — Distribution Results           ║
╚══════════════════════════════════════════════════════════╝
  Target            : ${BASE} (Nginx → api1 + api2)
  Virtual Users     : ${VUS}
  Duration          : ${DURATION}
  Total Requests    : ${data.metrics.http_reqs?.values?.count ?? 0}
  Throughput        : ${(data.metrics.http_reqs?.values?.rate ?? 0).toFixed(2)} req/s
  Latency P95       : ${(data.metrics.http_req_duration?.values?.['p(95)'] ?? 0).toFixed(2)} ms

  Load Balancer Split:
    api1  : ${api1} (${total ? ((api1 / total) * 100).toFixed(1) : 0}%)
    api2  : ${api2} (${total ? ((api2 / total) * 100).toFixed(1) : 0}%)
`,
    '/scripts/results/k6-nginx-summary.json': JSON.stringify({
      api1, api2, total,
      api1_pct: total ? (api1 / total) * 100 : 0,
      api2_pct: total ? (api2 / total) * 100 : 0,
      p95_ms: data.metrics.http_req_duration?.values?.['p(95)'],
      rps: data.metrics.http_reqs?.values?.rate,
    }, null, 2),
  };
}
