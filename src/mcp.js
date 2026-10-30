/*
 * mcp.js — Model Context Protocol endpoint (streamable HTTP mapping).
 *
 * A stateless JSON-RPC 2.0 server at POST /mcp handling:
 *   initialize · notifications/initialized · ping · tools/list · tools/call
 *
 * Tools mirror the REST surface so an authorized agent can do the whole
 * flow: start_audit → get_audit_status → get_report → list_findings →
 * get_fix_kit, without any separate account.
 *
 * Desktop clients that speak stdio can use scripts/mcp-stdio.mjs as a
 * line-delimited JSON-RPC bridge to this endpoint.
 */
import express from 'express';
import { config } from './config.js';
import { CHECKS } from './checks.js';
import { CATEGORIES, STATUS_LABEL, CREDIT, WEIGHTS } from './scoring.js';

const PROTOCOL_VERSION = '2025-06-18';

class CrudErr extends Error {
  constructor(code, message) { super(message); this.mcpCode = code; }
}

export function attachMcp(app, { engine, store }) {
  const mcp = express.Router();

  const TOOL_DEFS = [
    {
      name: 'start_audit',
      description: 'Start a Cumulus audit of a public website URL. Returns an audit id you can poll. Navigation-only: the auditor never submits forms, creates accounts or pays.',
      inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The site to audit, e.g. https://example.com' } } },
    },
    {
      name: 'get_audit_status',
      description: 'Get live status of an audit (stage, percent, whether the report is ready).',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'audit id from start_audit' } } },
    },
    {
      name: 'get_report',
      description: 'Full audit report: overall score/100, category scores, coverage, per-check statuses with evidence, agent-task journey.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: {
          id: { type: 'string' },
          terse: { type: 'boolean', description: 'omit per-check evidence rows (default false)' },
        },
      },
    },
    {
      name: 'list_findings',
      description: 'Findings of a completed audit: what failed or partially passed, with evidence, impact, fix steps and acceptance criteria.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'filter by severity' },
        },
      },
    },
    {
      name: 'get_fix_kit',
      description: 'Information about the downloadable fix-kit zip (per-finding Markdown remediation files + report.json) with its URL and file contents.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
    {
      name: 'check_catalogue',
      description: 'The 33 checks Cumulus runs (discovery/access/usability/payments), severities, why each matters, and the scoring model (weights 5/3/2/1; untested checks never count as failure).',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  const json = (body, status = 200, extraHeaders = {}) => ({ body, status, extraHeaders });

  async function dispatch(method, params) {
    switch (method) {
      case 'ping': return json({});
      case 'initialize': {
        return json({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: config.brand.name.toLowerCase(), title: config.brand.name, version: config.brand.version },
          instructions:
            'Cumulus audits how easily AI agents can discover, access, understand and buy from a website. ' +
            'Typical flow: start_audit(url) → poll get_audit_status(id) until report ready (~30–90s) → get_report(id) / list_findings(id) / get_fix_kit(id). ' +
            'The auditor respects robots.txt, refuses internal targets, and never submits forms or payments.',
        });
      }
      case 'tools/list':
        return json({ tools: TOOL_DEFS });
      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const out = await callTool(name, args, { engine, store });
        return json({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out });
      }
      default:
        return { error: { code: -32601, message: `Method not found: ${method}` }, status: 404 };
    }
  }

  async function callTool(name, args, { engine, store }) {
    const need = (v, msg) => { if (!v) { throw new CrudErr('invalid_args', msg); } return v; };

    try {
      if (name === 'start_audit') {
        need(args.url, 'url is required');
        try {
          const a = engine.start(args.url);
          return { id: a.id, url: a.url, status: a.status, note: 'Poll get_audit_status; allow 30–90 s.' };
        } catch (err) {
          return { error: err.message, hint: 'Only public http(s) sites on standard ports are audited; IP literals, private ranges, internal hostnames and embedded credentials are refused.' };
        }
      }
      if (name === 'get_audit_status') {
        const rec = store.find(engine, need(args.id, 'id is required'));
        if (!rec) throw new CrudErr('not_found', `No audit ${args.id}`);
        return {
          id: rec.id, url: rec.url, status: rec.status, stage: rec.stage || null, pct: rec.pct ?? 0,
          error: rec.error || null,
        };
      }
      if (name === 'get_report') {
        const rec = store.find(engine, need(args.id, 'id is required'));
        if (!rec) throw new CrudErr('not_found', `No audit ${args.id}`);
        if (!rec.report) throw new CrudErr('not_ready', `Audit ${rec.id} is ${rec.status === 'running' ? rec.stage || 'running' : rec.status}; no report yet.`);
        const r = rec.report;
        const out = {
          id: rec.id, url: r.meta.url, host: r.meta.host,
          startedAt: r.meta.startedAt, durationMs: r.meta.durationMs,
          score: r.score, coverage: r.coverage,
          categories: r.categories.map((c) => ({ id: c.id, name: c.name, score: c.score, counts: c.counts })),
          findings: r.findings.map((f) => ({ id: f.id, sev: f.sev, status: f.status, title: f.title, summary: f.summary })),
          open: r.open,
          journey: r.journey,
          tasks: r.tasks,
          stats: r.stats,
          agents: r.agents,
        };
        if (!args.terse) out.checks = r.categories.flatMap((c) => c.checks);
        return out;
      }
      if (name === 'list_findings') {
        const rec = store.find(engine, need(args.id, 'id is required'));
        if (!rec) throw new CrudErr('not_found', `No audit ${args.id}`);
        if (!rec.report) throw new CrudErr('not_ready', `Audit ${rec.id} is ${rec.status === 'running' ? 'running' : rec.status}; findings come with the finished report.`);
        let findings = rec.report.findings || [];
        if (args.severity) findings = findings.filter((f) => f.sev === args.severity);
        return { count: findings.length, findings, openItems: rec.report.open || [] };
      }
      if (name === 'get_fix_kit') {
        const rec = store.find(engine, need(args.id, 'id is required'));
        if (!rec) throw new CrudErr('not_found', `No audit ${args.id}`);
        if (!rec.report) throw new CrudErr('not_ready', `Audit ${rec.id} has no report yet.`);
        const base = args.baseUrl && /^https?:\/\/\S+$/.test(String(args.baseUrl)) ? String(args.baseUrl).replace(/\/$/, '') : `http://localhost:${config.port}`;
        return {
          id: rec.id,
          download: `${base}/api/v1/audits/${rec.id}/fix-kit`,
          contents: 'README.md (score, coverage, fix order) · one Markdown file per finding (problem / evidence / impact / fix / acceptance criteria / verification) · report.json',
          findings: (rec.report.findings || []).map((f) => f.id),
        };
      }
      if (name === 'check_catalogue') {
        return {
          checkCount: CHECKS.length,
          checks: CHECKS.map((c) => ({ id: c.id, cat: c.cat, sev: c.sev, title: c.title, why: c.why })),
          statuses: STATUS_LABEL,
          weights: WEIGHTS,
          credit: CREDIT,
          categories: CATEGORIES,
          scoring: 'category = Σ(weight × credit) ÷ Σ(evaluated weight); overall = mean of categories with ≥1 evaluated check; coverage = tested/applicable. Blocked, inconclusive, error and n/a are never counted as failures.',
        };
      }
      throw new CrudErr('unknown_tool', `Unknown tool: ${name}. Available: ${TOOL_DEFS.map((t) => t.name).join(', ')}`);
    } catch (err) {
      if (err instanceof CrudErr) return { error: err.mcpCode, message: err.message };
      return { error: 'tool_error', message: err && err.message ? err.message : String(err) };
    }
  }

  /* ---------------- express glue ---------------- */

  mcp.use(express.json({ limit: '1mb' }));

  mcp.post('/', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body must be JSON' } });
    }
    const id = body.id ?? null;

    if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') {
      return res.status(202).json({});
    }

    const out = await dispatch(body.method, body.params);
    if (out && out.error !== undefined && out.error && out.status) {
      return res.status(out.status).json({ jsonrpc: '2.0', id, error: out.error });
    }
    if (out && 'body' in out) return res.status(out.status ?? 200).json({ jsonrpc: '2.0', id, result: out.body });
    // fallback passthrough from dispatch errors
    return res.status(200).json({ jsonrpc: '2.0', id, result: out && out.body });
  });

  mcp.get('/', (req, res) => {
    // stateless server: no SSE stream endpoint; clients use POST only
    res.set('Allow', 'POST');
    res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'GET not supported on this MCP (stateless) server; POST JSON-RPC messages.' } });
  });

  mcp.use((req, res) => {
    res.set('Allow', 'POST');
    res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST with a JSON-RPC 2.0 message.' } });
  });

  app.use('/mcp', mcp);

  return mcp;
}
