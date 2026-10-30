/*
 * test/probe.mjs — ad-hoc diagnostics: boot fixture + server (CUMULUS_ALLOW_PRIVATE=1),
 * audit the fixture, and stream the audit record with logs so fetch failures
 * surface with their kind/code/message.
 *
 * Usage: node test/probe.mjs [fixturePort] [appPort]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FIXTURE_PORT = Number(process.argv[2] || 4708);
const APP_PORT = Number(process.argv[3] || 4728);
const FIX = `http://127.0.0.1:${FIXTURE_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;

async function j(url, opts = {}) {
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  let body = null;
  if (ct.includes('json')) body = await res.json().catch(() => null);
  else body = await res.text();
  return { status: res.status, body };
}

async function main() {
  const { createFixture } = await import('./fixture.js');
  const fixtureServer = createFixture({ port: FIXTURE_PORT });
  console.log(`[probe] fixture on ${FIX}`);

  // 1. isolate safeFetch against the fixture before involving the server
  const { safeFetch } = await import('../src/safefetch.js');
  const { config } = await import('../src/config.js');
  console.log(`[probe] config.allowPrivate=${config.allowPrivate} (probe process)`);
  for (const u of [`${FIX}/robots.txt`, `${FIX}/`, `${FIX}/sitemap.xml`]) {
    const t0 = Date.now();
    const r = await safeFetch(u, { timeoutMs: 8000 });
    console.log(`[safefetch] ${u} → ${r.ok ? `ok HTTP ${r.status} bytes=${r.bytes}` : `FAIL kind=${r.kind} code=${r.code} msg=${r.message}`} (${Date.now() - t0}ms)`);
  }

  fs.rmSync(path.join(ROOT, 'data-probe'), { recursive: true, force: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', CUMULUS_ALLOW_PRIVATE: '1', CUMULUS_DATA_DIR: 'data-probe', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not boot: ' + serverOut.slice(-3000))), 20_000);
    const ping = async () => {
      try { const r = await fetch(`${APP}/health`); if (r.ok) { clearTimeout(t); resolve(); return; } } catch { /* */ }
      setTimeout(ping, 300);
    };
    ping();
  });
  console.log(`[probe] server on ${APP}`);

  const start = await j(`${APP}/api/v1/audits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: FIX }) });
  if (start.status !== 202 || !start.body || !start.body.id) {
    console.error('[probe] POST failed:', start.status, JSON.stringify(start.body));
    process.exit(1);
  }
  const id = start.body.id;
  console.log(`[probe] audit ${id} — streaming…`);

  const t0 = Date.now();
  const TIMEOUT = 150_000;
  let lastStage = '';
  for (;;) {
    const { status, body } = await j(`${APP}/api/v1/audits/${id}?logs=1`);
    if (status !== 200) { console.log(`[probe] GET ${status}`); break; }
    const tag = `${body.pct}% ${body.stage}`;
    if (tag !== lastStage) { console.log(`[probe] ${tag}`); lastStage = tag; }
    for (const line of body.logs || []) {
      console.log(`  [${line.t}] (${line.kind}) ${line.msg}`);
    }
    if (['complete', 'failed', 'cancelled'].includes(body.status)) {
      console.log(`[probe] audit status: ${body.status}${body.error ? ` error: ${body.error}` : ''}`);
      if (body.report) {
        const byId = {};
        for (const cat of body.report.categories || []) for (const c of cat.checks || []) byId[c.id] = c;
        console.log('[probe] score:', JSON.stringify(body.report.score), 'coverage:', body.report.coverage?.pct);
        for (const c of Object.values(byId)) {
          console.log(`  ${c.id.padEnd(4)} ${String(c.status).padEnd(11)} ${String(c.title).slice(0, 52)}`);
        }
        console.log('[probe] counts:', JSON.stringify(Object.fromEntries((body.report.categories || []).map((c) => [c.id, c.counts]))));
      }
      break;
    }
    if (Date.now() - t0 > TIMEOUT) {
      console.log('[probe] TIMEOUT waiting for audit');
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  server.kill('SIGINT');
  fixtureServer.close(() => process.exit(0));
}

main().catch((err) => {
  console.error('[probe] crashed:', err);
  process.exit(1);
});
