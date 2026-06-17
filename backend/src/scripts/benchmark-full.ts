/**
 * Full system benchmark — POST, GET, redirect, load balancer
 *
 * Usage:
 *   npm run benchmark:full                    # default http://localhost:3001
 *   BENCHMARK_URL=http://localhost npm run benchmark:full   # via Nginx LB
 */

import '../config/env.js';

const BASE = process.env.BENCHMARK_URL ?? 'http://localhost:3001';
const ITERATIONS = Number(process.env.BENCHMARK_ITERATIONS ?? 30);
const POST_ITERATIONS = Number(process.env.BENCHMARK_POST_ITERATIONS ?? 10);

interface Timing {
  label: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  cache?: string;
  serverId?: string;
  upstream?: string;
}

function stats(times: number[]) {
  const s = [...times].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    avg,
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    min: s[0],
    max: s[s.length - 1],
  };
}

function printStats(label: string, times: number[], extra?: string): void {
  const s = stats(times);
  console.log(`\n┌─ ${label}${extra ? ` ${extra}` : ''}`);
  console.log(`│  Samples : ${times.length}`);
  console.log(`│  Avg     : ${s.avg.toFixed(2)} ms`);
  console.log(`│  P50     : ${s.p50.toFixed(2)} ms`);
  console.log(`│  P95     : ${s.p95.toFixed(2)} ms`);
  console.log(`│  Min/Max : ${s.min.toFixed(2)} / ${s.max.toFixed(2)} ms`);
  console.log(`└${'─'.repeat(44)}`);
}

async function request(
  method: string,
  path: string,
  body?: object
): Promise<Timing> {
  const start = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const ms = performance.now() - start;
  return {
    label: '',
    method,
    path,
    status: res.status,
    ms,
    cache: res.headers.get('X-Cache') ?? undefined,
    serverId: res.headers.get('X-Server-Id') ?? undefined,
    upstream: res.headers.get('X-Upstream-Addr') ?? undefined,
  };
}

async function checkHealth(): Promise<void> {
  console.log('\n══ HEALTH CHECK ══');
  const t = await request('GET', '/health');
  console.log(`  Status     : ${t.status}`);
  console.log(`  Latency    : ${t.ms.toFixed(2)} ms`);
  console.log(`  Server     : ${t.serverId ?? 'n/a'}`);
  console.log(`  Upstream   : ${t.upstream ?? 'direct (no nginx)'}`);
  if (t.status === 200) {
    const data = (await fetch(`${BASE}/health`).then((r) => r.json())) as Record<string, unknown>;
    console.log(`  DB/Redis   : ${JSON.stringify(data.services)}`);
  }
}

async function benchPostShorten(): Promise<string> {
  console.log('\n══ POST /api/v1/urls (Shorten) ══');
  const times: number[] = [];
  let lastCode = '';

  for (let i = 0; i < POST_ITERATIONS; i++) {
    const start = performance.now();
    const res = await fetch(`${BASE}/api/v1/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ longUrl: `https://example.com/bench-${Date.now()}-${i}` }),
    });
    const ms = performance.now() - start;
    const data = (await res.json()) as { data?: { shortCode: string }; message?: string };
    if (res.ok && data.data?.shortCode) {
      times.push(ms);
      lastCode = data.data.shortCode;
    } else if (res.status === 429) {
      console.log(`  Rate limited at request ${i + 1} — waiting 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
      i--;
      continue;
    }
  }

  printStats('POST shorten (write path)', times, `[${times.length} creates]`);
  console.log(`  Sample code: ${lastCode}`);
  return lastCode;
}

async function benchGetRedirect(shortCode: string): Promise<void> {
  console.log('\n══ GET /:shortCode (301 Redirect) ══');

  // CACHE MISS — first hit on fresh code
  const freshRes = await fetch(`${BASE}/api/v1/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: `https://example.com/fresh-${Date.now()}` }),
  });
  const freshData = (await freshRes.json()) as { data?: { shortCode: string } };
  const freshCode = freshData.data?.shortCode ?? '';

  if (freshCode) {
    const miss = await request('GET', `/${freshCode}`);
    console.log(`\n  CACHE MISS (1st redirect)`);
    console.log(`  Status   : ${miss.status}`);
    console.log(`  X-Cache  : ${miss.cache ?? 'n/a'}`);
    console.log(`  Latency  : ${miss.ms.toFixed(2)} ms`);
    console.log(`  Server   : ${miss.serverId ?? 'n/a'}`);
  }

  // CACHE HIT — warm then benchmark
  if (shortCode) {
    await request('GET', `/${shortCode}`);
    const hitTimes: number[] = [];
    const servers: Record<string, number> = {};

    for (let i = 0; i < ITERATIONS; i++) {
      const t = await request('GET', `/${shortCode}`);
      hitTimes.push(t.ms);
      const sid = t.serverId ?? 'unknown';
      servers[sid] = (servers[sid] ?? 0) + 1;
    }

    printStats('GET redirect CACHE HIT', hitTimes, `[code: ${shortCode}]`);
    console.log(`  X-Cache  : HIT (expected)`);
    console.log(`  Server distribution: ${JSON.stringify(servers)}`);
  }
}

async function benchGetMetadata(shortCode: string): Promise<void> {
  if (!shortCode) return;
  console.log('\n══ GET /api/v1/urls/:code (Metadata) ══');
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t = await request('GET', `/api/v1/urls/${shortCode}`);
    times.push(t.ms);
  }
  printStats('GET metadata (read API)', times);
}

async function benchLoadBalancer(): Promise<void> {
  console.log('\n══ LOAD BALANCER DISTRIBUTION ══');
  const servers: Record<string, number> = {};
  const upstreams: Record<string, number> = {};
  const times: number[] = [];

  for (let i = 0; i < ITERATIONS * 2; i++) {
    const t = await request('GET', '/health');
    times.push(t.ms);
    const sid = t.serverId ?? 'unknown';
    servers[sid] = (servers[sid] ?? 0) + 1;
    if (t.upstream) {
      upstreams[t.upstream] = (upstreams[t.upstream] ?? 0) + 1;
    }
  }

  printStats('GET /health via LB', times);
  console.log(`  X-Server-Id distribution:`);
  for (const [k, v] of Object.entries(servers).sort()) {
    const pct = ((v / (ITERATIONS * 2)) * 100).toFixed(1);
    console.log(`    ${k.padEnd(12)} : ${v} requests (${pct}%)`);
  }
  if (Object.keys(upstreams).length > 0) {
    console.log(`  X-Upstream-Addr (Nginx):`);
    for (const [k, v] of Object.entries(upstreams).sort()) {
      console.log(`    ${k.padEnd(20)} : ${v} requests`);
    }
  } else {
    console.log(`  X-Upstream-Addr: not present — hitting API directly (no Nginx)`);
    console.log(`  Tip: docker compose --profile full up -d --build`);
    console.log(`       BENCHMARK_URL=http://localhost npm run benchmark:full`);
  }
}

async function benchCacheStats(): Promise<void> {
  console.log('\n══ GET /api/v1/cache/stats (Redis Policy) ══');
  const t = await request('GET', '/api/v1/cache/stats');
  console.log(`  Status  : ${t.status}`);
  console.log(`  Latency : ${t.ms.toFixed(2)} ms`);
  if (t.status === 200) {
    const data = await fetch(`${BASE}/api/v1/cache/stats`).then((r) => r.json());
    console.log(`  Policy  : ${JSON.stringify(data, null, 2).split('\n').join('\n           ')}`);
  }
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     TinyURL — Full System Benchmark                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Target     : ${BASE}`);
  console.log(`  Iterations : ${ITERATIONS}`);

  await checkHealth();
  const shortCode = await benchPostShorten();
  await benchGetRedirect(shortCode);
  await benchGetMetadata(shortCode);
  await benchCacheStats();
  await benchLoadBalancer();

  console.log('\n══ BYPASS TEST (optional) ══');
  console.log('  docker compose stop redis');
  console.log('  npm run benchmark:redis-down');
  console.log('  docker compose start redis');
  console.log('');
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err.message);
  console.error('Ensure services are running:');
  console.error('  docker compose up -d');
  console.error('  npm run dev:backend');
  process.exit(1);
});
