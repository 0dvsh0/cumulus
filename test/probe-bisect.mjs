/*
 * test/probe-bisect.mjs — bisect http.request options against a live fixture
 * to find which one breaks the connection.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4721;
const fixture = spawn(process.execPath, ['test/fixture.js'], {
  env: { ...process.env, FIXTURE_PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'],
});
await sleep(1500);

function tryReq(label, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (msg) => { if (!done) { done = true; console.log(`${label}: ${msg} (${Date.now() - t0}ms)`); resolve(); } };
    const req = http.request(opts, (res) => { finish(`HTTP ${res.statusCode}`); res.resume(); res.on('close', () => finish('ok')) });
    req.on('error', (e) => finish(`error ${e.code} ${e.message}`));
    req.on('timeout', () => { finish('SOCKET TIMEOUT'); req.destroy(); });
    req.end();
    setTimeout(() => { if (!done) { finish('HARD TIMEOUT (no events at all)'); req.destroy(); } }, 7000);
  });
}

const base = { hostname: '127.0.0.1', port: PORT, path: '/robots.txt', method: 'GET' };

await tryReq('1. base', { ...base });
await tryReq('2. base + port as string', { ...base, port: String(PORT) });
await tryReq('3. + headers(close/UA/accept-encoding)', { ...base, headers: { 'user-agent': 'CumulusBot/1.0', accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en', connection: 'close' } });
await tryReq('4. + timeout opt', { ...base, timeout: 6400 });
await tryReq('5. + setNoDelay', { ...base, setNoDelay: true });
await tryReq('6. + rejectUnauthorized', { ...base, rejectUnauthorized: true });
await tryReq('7. + servername undefined', { ...base, servername: undefined });
await tryReq('8. + pinned lookup', { ...base, lookup: (h, o, cb) => { if (typeof o === 'function') { cb = o; o = {}; } process.nextTick(() => cb(null, '127.0.0.1', 4)) } });
await tryReq('9. + pinned lookup ALL-form', { ...base, lookup: (h, o, cb) => { if (typeof o === 'function') { cb = o; o = {}; } process.nextTick(() => cb(null, [{ address: '127.0.0.1', family: 4 }])) } });
await tryReq('10. everything at once', {
  ...base, port: String(PORT),
  headers: { 'user-agent': 'CumulusBot/1.0', accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en', connection: 'close' },
  timeout: 6400, setNoDelay: true, rejectUnauthorized: true, servername: undefined,
  lookup: (h, o, cb) => { if (typeof o === 'function') { cb = o; o = {}; } process.nextTick(() => cb(null, '127.0.0.1', 4)) },
});

console.log('node', process.version);
fixture.kill();
process.exit(0);
