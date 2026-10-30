/*
 * api.js — the documented REST surface (/api/v1) + legacy aliases (/api).
 *
 *   POST   /api/v1/audits              start an audit          → 202 {id,…}
 *   GET    /api/v1/audits              list recent audits
 *   GET    /api/v1/audits/:id          record (incl. report when complete)
 *   GET    /api/v1/audits/:id/findings findings with remediation detail
 *   GET    /api/v1/audits/:id/fix-kit  the zip archive
 *   GET    /api/v1/audits/:id/events   SSE progress stream
 *   DELETE /api/v1/audits/:id          cancel a running audit
 *   GET    /api/v1/history?host=…      per-host previous audits (score deltas)
 *   GET    /api/v1/meta                registry: checks, statuses, scoring model
 *   GET    /api/v1/openapi.json        machine-readable spec
 *
 * Same data as the dashboard reads — one source of truth.
 */
import express from 'express';
import { config } from './config.js';
import { PolicyError } from './netguard.js';
import { normalizeInputUrl } from './engine.js';
import { CHECKS, CHECKS_BY_ID } from './checks.js';
import { CATEGORIES, STATUS_LABEL, CREDIT, WEIGHTS } from './scoring.js';
import { describeFinding } from './findings.js';
import { buildFixKit, fixKitName } from './fixkit.js';

export function createApiRouter({ engine, store }) {
  const router = express.Router();
  const lastStart = new Map(); // origin → ts of last POST

  /* ---------------- auth (optional) ---------------- */
  router.use((req, res, next) => {
    if (!config.apiKey) return next();
    const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
    if (provided && String(provided) === config.apiKey) return next();
    return res.status(401).json({ error: { code: 'unauthorized', message: 'Set Authorization: Bearer <CUMULUS_API_KEY>' } });
  });

  /* ---------------- helpers ---------------- */

  function baseUrl(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}`;
  }

  function links(id, req) {
    const root = `${baseUrl(req)}/api/v1/audits/${id}`;
    return {
      self: root,
      events: `${root}/events`,
      findings: `${root}/findings`,
      fixKit: `${root}/fix-kit`,
      ui: `${baseUrl(req)}/report/${id}`,
    };
  }

  function present(rec, req, { withLogs = false, withReport = null } = {}) {
    if (!rec) return null;
    const out = {
      id: rec.id,
      url: rec.url,
      origin: rec.origin,
      host: rec.host,
      status: rec.status,
      stage: rec.stage || null,
      stageId: rec.stageId || null,
      pct: rec.pct ?? 0,
      createdAt: rec.createdAt,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt || null,
      error: rec.error || null,
      links: links(rec.id, req),
    };
    if (withLogs) out.logs = rec.logs || [];
    if (withReport !== false && rec.report) out.report = rec.report; // running audits: absent
    if (withReport !== false && rec.status === 'complete' && rec.report) {
      out.history = store.historyForHost(rec.host, rec.id, 8);
    }
    return out;
  }

  function policyToHttp(err, res) {
    const isBlocked = err instanceof PolicyError && err.code === 'blocked_target';
    res.status(400).json({
      error: {
        code: err.code || 'bad_request',
        message: err.message,
        hint: isBlocked
          ? 'Cumulus audits public http(s) websites on standard ports only. IP literals, private ranges, internal hostnames and embedded credentials are refused.'
          : 'Submit a public domain name, with or without the https:// prefix.',
      },
    });
  }

  /* ---------------- start an audit ---------------- */

  router.post('/audits', express.json({ limit: '32kb' }), async (req, res) => {
    const raw = (req.body && req.body.url) || req.query.url || '';
    if (!raw || typeof raw !== 'string') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Body must be JSON {"url": "https://example.com"}' } });
    }

    let norm;
    try {
      norm = normalizeInputUrl(raw);
    } catch (err) {
      return policyToHttp(err, res);
    }
    const origin = norm.origin.replace(/\/$/, '');

    // per-origin cooldown (protects a target from accidental stampedes)
    const now = Date.now();
    const last = lastStart.get(origin) || 0;
    const waitMs = config.limits.perOriginCooldownMs - (now - last);
    if (waitMs > 0) {
      return res.status(429).json({
        error: {
          code: 'cooldown',
          message: `An audit of ${origin} started ${Math.round((now - last) / 1000)}s ago. Wait ${Math.ceil(waitMs / 1000)}s before re-running it.`,
          retryAfterSec: Math.ceil(waitMs / 1000),
        },
      });
    }

    // global concurrency limit
    if (engine.running.size >= config.limits.concurrentAudits) {
      return res.status(503).json({ error: { code: 'busy', message: `${engine.running.size} audits are running; capacity is ${config.limits.concurrentAudits}. Retry shortly.`, retryAfterSec: 5 } });
    }

    const a = engine.start(norm.href);
    lastStart.set(origin, Date.now());
    const rec = store.snapshot(a);
    return res.status(202).json(present({ ...rec }, req));
  });

  /* ---------------- list ---------------- */

  router.get('/audits', (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
    const host = req.query.host ? String(req.query.host).replace(/^www\./, '') : null;
    if (host) {
      const recs = [...store.mem.values()]
        .filter((r) => r.host && r.host.replace(/^www\./, '') === host)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, limit)
        .map((r) => ({
          id: r.id, url: r.url, host: r.host, createdAt: r.createdAt, finishedAt: r.finishedAt, status: r.status,
          score: r.report && r.report.score && r.report.score.overall,
          grade: r.report && r.report.score && r.report.score.grade,
        }));
      return res.json({ host, data: recs });
    }
    return res.json({ data: store.recent(limit) });
  });

  /* ---------------- single record ---------------- */

  router.get('/audits/:id', (req, res) => {
    const rec = store.find(engine, req.params.id);
    if (!rec) return notFound(res, 'audit');
    const withLogs = req.query.logs === '1';
    // if the record is running and log freshness matters, snapshot from engine
    const asRec = rec.report || rec.status !== 'running' ? rec : store.snapshot(engine.running.get(req.params.id) || {});
    return res.json(present(asRec, req, { withLogs }));
  });

  /* ---------------- findings ---------------- */

  router.get('/audits/:id/findings', (req, res) => {
    const rec = store.find(engine, req.params.id);
    if (!rec) return notFound(res, 'audit');
    if (!rec.report) {
      return res.status(rec.status === 'running' ? 425 : 409).json({
        error: {
          code: rec.status === 'running' ? 'audit_running' : 'no_report',
          message: rec.status === 'running' ? `Audit ${rec.id} is ${rec.stage || 'running'} — findings appear when it completes.` : 'This audit did not produce a report.',
        },
      });
    }
    const findings = rec.report.findings || [];
    const openItems = rec.report.open || [];
    const detail = req.query.detail === '1';
    const data = findings.map((f) => {
      const d = detail ? describeFinding(f.id, { evidence: f.evidence, note: f.summary }) : null;
      return d ? { ...f, ...d } : f;
    });
    res.json({
      data,
      openItems,
      note: 'Findings are checks that failed or partially passed. statuses blocked/inconclusive/error are listed under openItems with their reasons — they are never scored as failure.',
    });
  });

  /* ---------------- fix kit zip ---------------- */

  router.get(['/audits/:id/fix-kit', '/audits/:id/fix-kit.zip'], async (req, res) => {
    const rec = store.find(engine, req.params.id);
    if (!rec) return notFound(res, 'audit');
    if (!rec.report) {
      return res.status(rec.status === 'running' ? 425 : 409).json({ error: { code: 'no_report', message: 'No report yet — the fix kit is generated from a completed audit.' } });
    }
    try {
      const zip = await buildFixKit(rec.report);
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', `attachment; filename="${fixKitName(rec.report)}"`);
      res.setHeader('cache-control', 'no-store');
      return res.send(zip);
    } catch (err) {
      return res.status(500).json({ error: { code: 'fixkit_error', message: err && err.message ? err.message : 'fix kit failed' } });
    }
  });

  /* ---------------- SSE progress ---------------- */

  router.get('/audits/:id/events', (req, res) => {
    const id = req.params.id;
    recMiss(id, req, res, () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');

      const rec = store.find(engine, id);
      const send = (event, payload) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* closed */ }
      };
      // initial snapshot
      if (rec) {
        send('progress', { id, stage: rec.stage, pct: rec.pct ?? 0, status: rec.status, logs: (rec.logs || []).slice(-50) });
        if (['complete', 'failed', 'cancelled'].includes(rec.status)) {
          send('done', { id, status: rec.status, report: rec.report || null });
          return res.end();
        }
      }

      const onProgress = (msg) => {
        if (msg.id !== id) return;
        send('progress', { ...msg, log: msg.log || null });
      };
      const onEnd = (a) => {
        if (a.id !== id) return;
        send('done', { id, status: a.status, report: a.report || null, error: a.error || null });
        cleanup();
        res.end();
      };
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 15_000);
      const cleanup = () => {
        clearInterval(beat);
        engine.off('progress', onProgress);
        engine.off('audit-end', onEnd);
      };
      engine.on('progress', onProgress);
      engine.on('audit-end', onEnd);
      req.on('close', cleanup);
      res.on('error', cleanup);
    });
  });

  /* ---------------- cancel ---------------- */

  router.delete('/audits/:id', (req, res) => {
    const rec = store.find(engine, req.params.id);
    if (!rec) return notFound(res, 'audit');
    const ok = engine.cancel(req.params.id);
    res.json({ id: rec.id, status: rec.status, cancelRequested: ok });
  });

  /* ---------------- history (per host) ---------------- */

  router.get('/history', (req, res) => {
    const host = String(req.query.host || '').trim();
    if (!host) return res.status(400).json({ error: { code: 'bad_request', message: 'Provide ?host=example.com' } });
    const data = store.historyForHost(host.replace(/^www\./, ''));
    res.json({ host, data });
  });

  /* ---------------- meta (registry) ---------------- */

  router.get('/meta', (req, res) => {
    res.json({
      name: config.brand.name,
      version: config.brand.version,
      userAgent: config.userAgentAudit,
      checks: CHECKS.map((c) => ({ id: c.id, cat: c.cat, sev: c.sev, title: c.title, why: c.why, requiresBrowser: c.requiresBrowser === true })),
      checkCount: CHECKS.length,
      categories: CATEGORIES,
      statuses: STATUS_LABEL,
      statusCredit: CREDIT,
      weights: WEIGHTS,
      scoring: {
        credit: 'pass = 1 · partial = 0.5 · fail = 0',
        category: 'Σ(weight × credit) ÷ Σ(weight of evaluated checks)',
        overall: 'mean of category scores with ≥1 evaluated check',
        coverage: 'tested weight ÷ applicable weight; blocked/inconclusive/error count as applicable, n/a excluded',
        note: 'An untested check is never a failure.',
      },
      limits: {
        auditMs: config.limits.auditMs,
        crawlMaxPages: config.limits.crawlMaxPages,
        concurrency: config.limits.concurrentAudits,
        perOriginCooldownMs: config.limits.perOriginCooldownMs,
      },
      endpoints: {
        startAudit: 'POST /api/v1/audits {"url":"https://example.com"}',
        audit: 'GET /api/v1/audits/:id',
        findings: 'GET /api/v1/audits/:id/findings?detail=1',
        fixKit: 'GET /api/v1/audits/:id/fix-kit',
        events: 'GET /api/v1/audits/:id/events (SSE)',
        cancel: 'DELETE /api/v1/audits/:id',
        history: 'GET /api/v1/history?host=example.com',
      },
      auth: config.apiKey ? 'Authorization: Bearer <key>' : 'open (set CUMULUS_API_KEY to require a bearer token)',
    });
  });

  function notFound(res, what) {
    return res.status(404).json({ error: { code: 'not_found', message: `No such ${what}` } });
  }

  function recMiss(id, req, res, proceed) {
    const rec = store.find(engine, id);
    if (!rec) return notFound(res, 'audit');
    proceed(rec);
  }

  /* ---------------- openapi ---------------- */

  router.get('/openapi.json', (req, res) => {
    res.json(openapi(baseUrl(req)));
  });

  router.get('/', (req, res) => {
    res.json({
      name: config.brand.name,
      description: 'Audits how AI agents experience a website: discovery, access, usability, payments.',
      version: 'v1',
      endpoints: '/api/v1/openapi.json',
      meta: '/api/v1/meta',
    });
  });

  return router;
}

/* ---------------- openapi document ---------------- */

function openapi(base) {
  const responses = {
    audit: { 202: { description: 'Audit started' }, 400: { description: 'Invalid or refused URL' }, 429: { description: 'Origin cooldown' }, 503: { description: 'Capacity exhausted' } },
    record: { 200: { description: 'Audit record (with report when complete)' }, 404: { description: 'Unknown id' }, 425: { description: 'Still running' } },
  };
  const auditRefSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      host: { type: 'string' },
      status: { type: 'string', enum: ['running', 'complete', 'failed', 'cancelled'] },
      pct: { type: 'integer' },
      stage: { type: 'string' },
      report: { type: 'object', description: 'Present when complete: score, categories, findings, coverage, journey, stats, agents' },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Cumulus API',
      version: '1.0.0',
      description: 'Audit how easily AI agents can discover, access, understand and buy from a website. Returns the same results as the dashboard. Optional bearer auth via CUMULUS_API_KEY.',
    },
    servers: [{ url: base }],
    paths: {
      '/api/v1/audits': {
        post: { summary: 'Start an audit of a URL (never submits forms or payments)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', examples: ['https://example.com'] } } } } } }, responses: responses.audit },
        get: { summary: 'List recent audits', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 15 } }], responses: { 200: { description: 'Recent audits' } } },
      },
      '/api/v1/audits/{id}': {
        get: { summary: 'Fetch an audit record', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'logs', in: 'query', schema: { type: 'string', enum: ['1'] } }], responses: responses.record },
        delete: { summary: 'Request cancellation', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Cancellation requested' }, 404: { description: 'Unknown id' } } },
      },
      '/api/v1/audits/{id}/events': { get: { summary: 'Server-sent events with audit progress and terminal report', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'text/event-stream' } } } },
      '/api/v1/audits/{id}/findings': { get: { summary: 'Findings (fail/partial) with evidence and remediation detail', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'detail', in: 'query', schema: { type: 'string', enum: ['1'] } }], responses: { 200: { description: 'Findings' }, 404: { description: 'Unknown id' }, 409: { description: 'No report' }, 425: { description: 'Still running' } } } },
      '/api/v1/audits/{id}/fix-kit': { get: { summary: 'Download the fix kit zip', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'application/zip' }, 404: { description: 'Unknown id' }, 409: { description: 'No report' }, 425: { description: 'Still running' } } } },
      '/api/v1/history': { get: { summary: 'Per-host finished audits (for score deltas)', parameters: [{ name: 'host', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'History', content: { 'application/json': { schema: { type: 'object' } } } } } } },
      '/api/v1/meta': { get: { summary: 'Check registry + scoring model', responses: { 200: { description: '33 checks, statuses, weights, limits, endpoints' } } } },
      '/mcp': { post: { summary: 'Model Context Protocol HTTP endpoint (JSON-RPC 2.0, streamable HTTP)', responses: { 200: { description: 'JSON-RPC response' }, 202: { description: 'Notification accepted' }, 400: { description: 'Bad JSON-RPC' } } } },
    },
    'x-schemas': { audit: auditRefSchema },
    'x-notes': [
      'Legacy aliases without the /v1 segment are kept for convenience: POST /api/audits etc.',
      'Privately-routed, private-range and credential-bearing URLs are refused; robots.txt is respected (blocked checks are never failures).',
    ],
  };
}
