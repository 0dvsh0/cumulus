/*
 * test/e2e.mjs — full-stack test against a local fixture site.
 *
 * Boots:
 *   1. the fixture site (express, private 127.0.0.1 — allowed because the
 *      Cumulus server runs with CUMULUS_ALLOW_PRIVATE=1)
 *   2. the real Cumulus server as a child process (npm start equivalent)
 *
 * Then verifies: API lifecycle, the 33-check report, scoring math, task
 * outcomes on a controlled site, fix-kit zip, SSRF refusals (in a separate
 * hardened server without the allow-private flag), history + meta + MCP.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FIXTURE_PORT = 4701;
const APP_PORT = 4710;
const FIX = `http://127.0.0.1:${FIXTURE_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;

const results = [];
let failed = 0;
let serverOut = '';
let serverProc = null;

function ok(cond, label, extra = '') {
  const pass = !!cond;
  results.push({ pass, label });
  if (!pass) failed++;
  console.log(`${pass ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
}

async function j(url, opts = {}) {
  const res = await fetch(url, opts);
  let body = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) body = await res.json().catch(() => null);
  else if (ct.includes('zip')) body = Buffer.from(await res.arrayBuffer()); // binary-safe
  else body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

async function waitForAudit(id, timeoutMs = 170_000) {
  const t0 = Date.now();
  for (;;) {
    const { status, body } = await j(`${APP}/api/v1/audits/${id}`);
    if (status === 200 && body && ['complete', 'failed', 'cancelled'].includes(body.status)) return body;
    if (Date.now() - t0 > timeoutMs) return body && body.status ? body : { status: 'timeout' };
    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function main() {
  console.log('\n== booting fixture + server ==');
  const { createFixture } = await import('./fixture.js');
  const fixtureServer = createFixture({ port: FIXTURE_PORT });

  fs.rmSync(path.join(ROOT, 'data-test'), { recursive: true, force: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      CUMULUS_ALLOW_PRIVATE: '1',
      CUMULUS_DATA_DIR: 'data-test',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  serverProc = server;
  server.stdout.on('data', (d) => { serverOut += d; console.error('[server]', ...String(d).trim().split('\n')); });
  server.stderr.on('data', (d) => { serverOut += d; console.error('[server:err]', ...String(d).trim().split('\n')); });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not boot: ' + serverOut.slice(-2000))), 20_000);
    const ping = async () => {
      try { const r = await fetch(`${APP}/health`); if (r.ok) { clearTimeout(t); resolve(); return; } } catch { /* retry */ }
      setTimeout(ping, 300);
    };
    ping();
  });
  ok(true, 'server + fixture booted');

  /* ---------------- 1. lifecycle ---------------- */
  console.log('\n== audit lifecycle on fixture ==');
  const start = await j(`${APP}/api/v1/audits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: FIX }) });
  ok(start.status === 202 && start.body && start.body.id, 'POST /audits → 202 + id', JSON.stringify(start.body && start.body.error || ''));

  const events = await new Promise((resolve) => {
    const ctrl = new AbortController();
    const parts = [];
    fetch(`${APP}/api/v1/audits/${start.body.id}/events`, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } })
      .then(async (res) => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const txt = dec.decode(value, { stream: true });
            if (txt.includes('event: done')) { parts.push(txt); ctrl.abort(); break; }
            if (parts.length < 200) parts.push(txt);
          }
        } catch { /* aborted — expected */ }
        resolve(parts.join(''));
      })
      .catch(() => resolve(parts.join('')));
  });
  ok(events.includes('event: progress'), 'SSE progress events stream');
  ok(events.includes('event: done'), 'SSE terminal done event');

  const finished = await waitForAudit(start.body.id);
  ok(finished.status === 'complete', 'audit completes', finished.status);
  const report = finished.report;

  /* ---------------- 2. report shape + scoring ---------------- */
  console.log('\n== report shape + scoring ==');
  ok(!!report, 'report present');
  const allChecks = report.categories.flatMap((c) => c.checks);
  ok(allChecks.length === 33, 'all 33 checks present', String(allChecks.length));
  ok(new Set(allChecks.map((c) => c.id)).size === 33, '33 unique check ids');

  const W = { critical: 5, high: 3, medium: 2, low: 1 };
  let mathErr = null;
  for (const cat of report.categories) {
    let credit = 0, evaluated = 0;
    for (const ck of cat.checks) {
      const w = W[ck.sev] ?? 1;
      if (ck.status === 'pass') { credit += w; evaluated += w; }
      else if (ck.status === 'partial') { credit += w * 0.5; evaluated += w; }
      else if (ck.status === 'fail') evaluated += w;
    }
    const expect = evaluated ? Math.round((credit / evaluated) * 100) : null;
    if (expect !== cat.score) { mathErr = `${cat.id}: expected ${expect} got ${cat.score}`; break; }
  }
  ok(mathErr === null, 'category scores match the published formula', mathErr || '');

  const scoredCats = report.categories.filter((c) => c.score != null);
  const expectOverall = Math.round(scoredCats.reduce((n, c) => n + c.score, 0) / scoredCats.length);
  ok(report.score.overall === expectOverall, 'overall = mean of category scores', `${report.score.overall} vs ${expectOverall}`);

  const applicable = allChecks.filter((c) => c.status !== 'n/a');
  const tested = applicable.filter((c) => ['pass', 'partial', 'fail'].includes(c.status));
  const expectCov = Math.round((tested.reduce((n, c) => n + (W[c.sev] ?? 1), 0) / applicable.reduce((n, c) => n + (W[c.sev] ?? 1), 0) * 100));
  ok(report.coverage.pct === expectCov, 'coverage matches tested/applicable weights', `${report.coverage.pct}%`);

  /* ---------------- 3. fixture determinism (agent tasks etc.) ---------------- */
  console.log('\n== fixture outcomes (deterministic site) ==');
  const byId = Object.fromEntries(allChecks.map((c) => [c.id, c]));
  ok(byId.P1.status === 'pass', 'P1 find pricing = pass', byId.P1.status);
  ok(byId.P2.status === 'pass', 'P2 extract plans = pass', byId.P2.status);
  ok((byId.P2.evidence || []).some(([, v]) => /Starter|Pro|Scale/.test(String(v))), 'P2 evidence names plans');
  ok(byId.P3.status === 'pass', 'P3 prices in initial HTML = pass', byId.P3.status);
  ok(byId.P4.status === 'pass', 'P4 offer Structured Data = pass', byId.P4.status);
  ok(byId.P5.status === 'pass', 'P5 reach checkout = pass', byId.P5.status);
  ok(byId.P6.status === 'pass', 'P6 plan CTAs are links = pass', byId.P6.status);
  ok(byId.U8.status === 'pass', 'U8 locate signup = pass', byId.U8.status);
  ok(byId.U9.status === 'pass', 'U9 locate docs = pass', byId.U9.status);
  ok(byId.A2.status === 'pass', 'A2 content in initial HTML = pass', byId.A2.status);
  ok(byId.A3.status === 'pass', 'A3 no bot challenge = pass', byId.A3.status);
  ok(byId.D1.status === 'pass', 'D1 robots published = pass', byId.D1.status);
  ok(byId.D2.status === 'pass', 'D2 retrieval agents allowed = pass', byId.D2.status);
  ok(byId.D3.status === 'pass', 'D3 sitemap discoverable = pass', byId.D3.status);
  ok(byId.D4.status === 'pass', 'D4 sitemap lists key pages = pass', byId.D4.status);
  ok(byId.D5.status === 'pass', 'D5 llms.txt = pass', byId.D5.status);
  ok(byId.D8.status === 'pass', 'D8 JSON-LD = pass', byId.D8.status);
  ok(byId.D9.status === 'pass', 'D9 nav exposes key pages = pass', byId.D9.status);
  ok(byId.U3.status === 'partial' || /U3/.test(JSON.stringify(byId.U3.evidence)), 'U3 img alt flagged (fixture has one alt-less image)', byId.U3.status);
  ok(byId.U6.status === 'pass', 'U6 labelled form fields = pass', byId.U6.status);
  ok(byId.A8.status === 'pass', 'A8 key pages load = pass', byId.A8.status);

  const failing = report.findings.filter((f) => f.status === 'fail');
  const blocked = report.open.filter((o) => o.status === 'blocked');
  ok(report.findings.every((f) => f.problem && f.impact && f.fix?.length && f.acceptance?.length), 'findings carry complete remediation detail');
  ok(allChecks.every((c) => ['n/a'].includes(c.status) || (c.evidence && c.evidence.length)), 'every non-n/a check has evidence rows');

  /* ---------------- 4. findings + fix kit ---------------- */
  console.log('\n== findings + fix kit ==');
  const fnd = await j(`${APP}/api/v1/audits/${start.body.id}/findings?detail=1`);
  ok(fnd.status === 200 && Array.isArray(fnd.body.data), 'GET findings works');
  ok(fnd.body.data.every((f) => f.problem && f.impact && Array.isArray(f.fix)), 'finding detail embedded');

  const kit = await j(`${APP}/api/v1/audits/${start.body.id}/fix-kit`);
  ok(kit.status === 200 && kit.headers.get('content-type') === 'application/zip', 'fix kit is a zip');
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(kit.body);
  const names = Object.keys(zip.files);
  ok(names.includes('README.md') && names.includes('report.json'), 'zip has README + report.json', names.join(', '));
  const fCount = report.findings.length;
  ok(names.filter((n) => n.endsWith('.md') && n !== 'README.md').length === fCount, `zip has ${fCount} finding files`);
  if (fCount) {
    const first = report.findings[0];
    const mdFile = zip.file(names.find((n) => n.includes(`-${first.id}-`)) || names.find((n) => n.startsWith('0') && n.endsWith('.md')));
    const text = await mdFile.async('string');
    ok(text.includes('# ' + first.id) && /## Evidence/.test(text) && /## Acceptance criteria/.test(text), 'finding md contains evidence + acceptance');
  }
  const readme = await zip.file('README.md').async('string');
  ok(readme.includes('Fix order') || readme.includes('No failing checks'), 'README documents fix order');

  /* ---------------- 5. history + meta + openapi ---------------- */
  console.log('\n== history/meta ===');
  const hist = await j(`${APP}/api/v1/history?host=127.0.0.1`);
  ok(hist.status === 200 && hist.body.data.length >= 1, 'history endpoint has the audit');
  const meta = await j(`${APP}/api/v1/meta`);
  ok(meta.status === 200 && meta.body.checkCount === 33 && meta.body.checks.length === 33, 'meta exposes 33 checks');
  const oa = await j(`${APP}/api/v1/openapi.json`);
  ok(oa.status === 200 && oa.body.openapi.startsWith('3.'), 'openapi.json served');

  /* ---------------- 6. SSRF refusals (hardened server, no allow-private) ---------------- */
  console.log('\n== SSRF guards (default server config) ==');
  const HARD_PORT = 4711;
  const hard = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(HARD_PORT), HOST: '127.0.0.1', CUMULUS_DATA_DIR: 'data-test-hard', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const HARD = `http://127.0.0.1:${HARD_PORT}`;
  await new Promise((resolve) => { const t = setInterval(async () => { try { const r = await fetch(`${HARD}/health`); if (r.ok) { clearInterval(t); resolve(); } } catch { /* */ } }, 250); });
  const refusals = [
    [FIX, 'private IP literal (loopback)'],
    ['http://localhost:8080', 'localhost hostname'],
    ['http://169.254.169.254/latest/meta-data', 'link-local metadata'],
    ['http://10.0.0.5', 'private 10/8 IP '],
    ['http://[::1]:8080', 'IPv6 loopback'],
    ['https://user:pass@example.com', 'embedded credentials'],
    ['http://example-scanner-fixture.test:8080/x', 'non-standard port'],
    ['ftp://example.com/x', 'non-http scheme'],
    ['http://singlelabel', 'single-label hostname'],
  ];
  for (const [url, label] of refusals) {
    const r = await j(`${HARD}/api/v1/audits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    ok(r.status === 400, `refused: ${label}`, `HTTP ${r.status}`);
  }
  const okPublic = await j(`${HARD}/api/v1/audits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }) });
  const accepted = okPublic.status === 202 || okPublic.status === 429; // 429 acceptable if this test box has no outside net — main thing: not 400
  ok(accepted, 'public URL passes the URL policy gate', `HTTP ${okPublic.status}`);
  // deterministic cooldown: second POST for the same origin lands inside the 20s window
  const again = await j(`${HARD}/api/v1/audits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }) });
  ok(again.status === 429, 'per-origin cooldown → 429', `HTTP ${again.status}`);
  hard.kill('SIGKILL');

  /* ---------------- 7. MCP ---------------- */
  console.log('\n== MCP ==');
  const mcpInit = await j(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  ok(mcpInit.status === 200 && mcpInit.body.result && mcpInit.body.result.protocolVersion, 'initialize returns protocolVersion');
  const mcpTools = await j(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  ok(mcpTools.body.result.tools.length === 6, 'tools/list has 6 tools');
  const mcpReport = await j(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_report', arguments: { id: start.body.id, terse: true } } }) });
  ok(mcpReport.status === 200 && mcpReport.body.result.content[0].type === 'text', 'get_report tool returns content');
  const repObj = JSON.parse(mcpReport.body.result.content[0].text);
  ok(repObj.score && repObj.categories.length === 4, 'MCP report carries score + 4 categories');
  const mcpBad = await j(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'bogus/method' }) });
  ok(mcpBad.status === 404 && mcpBad.body.error && mcpBad.body.error.code === -32601, 'unknown MCP method → -32601');

  /* ---------------- 8. cancel + 404s ---------------- */
  console.log('\n== guards ==');
  const cancel = await j(`${APP}/api/v1/audits/aaaaaaaaaaaaaaaa/nope`, { method: 'DELETE' });
  ok(cancel.status === 404, 'unknown audit id → 404');
  const legacy = await j(`${APP}/api/audits/${start.body.id}`);
  ok(legacy.status === 200 && legacy.body.id === start.body.id, 'legacy /api/audits/:id alias works');

  /* ---------------- done ---------------- */
  console.log(`\n== results: ${results.filter((r) => r.pass).length} passed, ${failed} failed ==`);
  server.kill('SIGINT');
  fixtureServer.close();
  setTimeout(() => process.exit(failed ? 1 : 0), 400);
}

main().catch((err) => {
  console.error('\nE2E crashed:', err);
  console.error(err.stack);
  if (serverOut) console.error('--- server output tail ---\n' + serverOut.slice(-4000));
  try { serverProc && serverProc.kill('SIGKILL'); } catch { /* */ }
  process.exit(1);
});
