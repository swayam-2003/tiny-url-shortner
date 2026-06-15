/**
 * Redis latency benchmark
 *
 * Measures redirect latency across three cache states:
 *   HIT    — Redis cache hit
 *   MISS   — Redis empty, PostgreSQL lookup
 *   BYPASS — Redis unavailable, PostgreSQL only
 *
 * Usage:
 *   npm run benchmark
 *   npm run benchmark:redis-down   (stop Redis first)
 */

import '../config/env.js';

const BASE = process.env.BENCHMARK_URL ?? 'http://localhost:3001';
const ITERATIONS = Number(process.env.BENCHMARK_ITERATIONS ?? 50);
const redisDown = process.argv.includes('--redis-down');

interface Sample {
  cache: string;
  ms: number;
}

async function shorten(): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: `https://example.com/bench-${Date.now()}` }),
  });
  const data = (await res.json()) as { message?: string; data?: { shortCode: string } };
  if (!res.ok) throw new Error(data.message ?? 'Shorten failed');
  return data.data!.shortCode;
}

async function redirect(shortCode: string): Promise<Sample> {
  const start = performance.now();
  const res = await fetch(`${BASE}/${shortCode}`, { redirect: 'manual' });
  const ms = performance.now() - start;
  return {
    cache: res.headers.get('X-Cache') ?? 'UNKNOWN',
    ms: Number(res.headers.get('X-Response-Time')?.replace('ms', '') ?? ms.toFixed(2)),
  };
}

function stats(samples: Sample[]) {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return {
    avg,
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
    min: times[0],
    max: times[times.length - 1],
  };
}

async function run(label: string, shortCode: string): Promise<void> {
  const samples: Sample[] = [];
  for (let i = 0; i < ITERATIONS; i++) samples.push(await redirect(shortCode));
  const s = stats(samples);
  console.log(`\n── ${label} (X-Cache: ${samples[0]?.cache}) ──`);
  console.log(`  Iterations : ${ITERATIONS}`);
  console.log(`  Avg        : ${s.avg.toFixed(2)} ms`);
  console.log(`  P50        : ${s.p50.toFixed(2)} ms`);
  console.log(`  P95        : ${s.p95.toFixed(2)} ms`);
  console.log(`  Min / Max  : ${s.min.toFixed(2)} / ${s.max.toFixed(2)} ms`);
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   TinyURL — Redis Latency Benchmark      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Target: ${BASE}  |  Iterations: ${ITERATIONS}`);

  if (redisDown) {
    console.log('\n⚠  BYPASS mode — ensure Redis is stopped: docker compose stop redis\n');
    const code = await shorten();
    await run('BYPASS (Redis down → PostgreSQL only)', code);
    return;
  }

  const hitCode = await shorten();
  await redirect(hitCode);
  await run('CACHE HIT (Redis)', hitCode);

  const missCode = await shorten();
  const missSample = await redirect(missCode);
  console.log(`\n── CACHE MISS (PostgreSQL → populate Redis) (X-Cache: ${missSample.cache}) ──`);
  console.log(`  First request latency : ${missSample.ms.toFixed(2)} ms`);
  console.log(`  (Subsequent requests hit Redis cache)`);

  console.log('\n── To test BYPASS (Redis down) ──');
  console.log('  1. docker compose stop redis');
  console.log('  2. npm run benchmark:redis-down');
  console.log('  3. docker compose start redis');
}

main().catch((err) => {
  console.error('Benchmark failed:', err.message);
  process.exit(1);
});
