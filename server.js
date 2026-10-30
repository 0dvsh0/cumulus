/*
 * server.js — Cumulus entrypoint.
 *
 *   npm start  →  http://localhost:3000
 *
 * Serves: landing (index.html), report/:id, docs, static assets,
 * the REST API (/api/v1 + legacy /api aliases), the MCP endpoint (/mcp),
 * and wires engine → store persistence.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { AuditEngine } from './src/engine.js';
import { AuditStore } from './src/store.js';
import { createApiRouter } from './src/api.js';
import { attachMcp } from './src/mcp.js';
import { localBaseUrl } from './src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const engine = new AuditEngine();
const store = new AuditStore().init();
store.attach(engine);          // engine 'persist' → durable record

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ---------------- security headers (tight CSP for our own assets) ---------------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  if (req.method === 'OPTIONS') res.setHeader('Allow', 'GET, POST, DELETE');
  next();
});

/* ---------------- auth gate (optional) for API + MCP ---------------- */
app.use((req, res, next) => {
  const guarded = req.path.startsWith('/api') || req.path.startsWith('/mcp');
  if (!guarded || !config.apiKey) return next();
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  if (provided && provided === config.apiKey) return next();
  return res.status(401).json({ error: { code: 'unauthorized', message: 'Set Authorization: Bearer <CUMULUS_API_KEY>' } });
});

/* ---------------- API ---------------- */
const api = createApiRouter({ engine, store });
app.use('/api/v1', api);
app.use('/api', api); // legacy aliases: POST /api/audits ≡ /api/v1/audits

/* ---------------- MCP ---------------- */
attachMcp(app, { engine, store });

/* ---------------- static ---------------- */
const STATIC_ROOT = path.join(__dirname);
app.use(express.static(STATIC_ROOT, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

/* health + readiness */
app.get('/health', (req, res) => {
  res.json({ ok: true, name: config.brand.name, version: config.brand.version, engine: { running: engine.running.size, completed: engine.history.length } });
});

/* ---------------- page routes ---------------- */
app.get('/report/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'report.html'));
});
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'docs.html'));
});

/* legacy: some links may point at /report without id */
app.get('/report', (req, res) => res.redirect('/'));

/* ---------------- errors ---------------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err && err.type === 'entity.parse.failed' ? 400 : err && err.status ? err.status : 500;
  if (req.path.startsWith('/api') || req.path.startsWith('/mcp')) {
    return res.status(status).json({ error: { code: 'server_error', message: err && err.message ? err.message : 'Internal error' } });
  }
  return res.status(status).send(`${config.brand.name} — ${err && err.message ? err.message : 'error'}`);
});

/* ---------------- boot ---------------- */
const server = app.listen(config.port, config.host, () => {
  console.log(`${config.brand.name} v${config.brand.version} listening on ${localBaseUrl()}   (docs: /docs · API: /api/v1/meta · MCP: /mcp)`);
  if (config.apiKey) console.log('API auth: bearer token required (CUMULUS_API_KEY is set)');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    for (const [, a] of engine.running) {
      a.cancelFlag = true;
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}

export { app, engine, store };
