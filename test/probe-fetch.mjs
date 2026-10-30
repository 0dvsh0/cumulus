/*
 * test/probe-fetch.mjs — minimal connectivity matrix:
 *  1. spawn fixture in a SEPARATE process
 *  2. plain global fetch → baseline
 *  3. safeFetch (this project) with allowPrivate enabled
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4719;
const FIX = `http://127.0.0.1:${PORT}`;

const fixture = spawn(process.execPath, ['test/fixture.js'], {
  env: { ...process.env, FIXTURE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
fixture.stdout.on('data', (d) => console.log('[fixture]', d.toString().trim()));
fixture.stderr.on('data', (d) => console.log('[fixture-err]', d.toString().trim()));

process.env.CUMULUS_ALLOW_PRIVATE = '1';
const { safeFetch } = await import('../src/safefetch.js');
const { config } = await import('../src/config.js');
console.log('allowPrivate =', config.allowPrivate);

await sleep(1500); // let fixture boot

for (const [label, fn] of [
  ['plain fetch', () => fetch(`${FIX}/robots.txt`).then(async (r) => `HTTP ${r.status}: ${(await r.text()).slice(0, 40)}`)],
  ['safeFetch(dbg)', () => safeFetch(`${FIX}/robots.txt`, { timeoutMs: 8000 }).then((r) => r.ok ? `HTTP ${r.status} bytes=${r.bytes} body=${r.body.toString().slice(0, 40)}` : `FAIL ${r.kind} ${r.code} ${r.message}`)],
]) {
  const t0 = Date.now();
  try { console.log(`${label}:`, await Promise.race([fn(), sleep(12_000, 'RACE-TIMEOUT')]), `(${Date.now() - t0}ms)`); }
  catch (e) { console.log(`${label}: threw ${e.code || ''} ${e.message}`); }
}

fixture.kill();
process.exit(0);

