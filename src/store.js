/*
 * store.js — audit records.
 *
 * Records are the engine's per-audit objects (small) plus the finished report.
 * Everything that a GET /api/v1/audits/:id needs is kept in memory so the
 * store answers instantly for running audits too, with JSONL persistence
 * for restart-survivable history. Old records are pruned from memory but the
 * JSONL keeps the host history (used for score deltas).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MEMORY_LIMIT = 300;         // in-memory audit records
const LOAD_LIMIT = 500;           // read back from disk on boot
const LOG_LIMIT = 200;            // log lines kept per persisted audit

function slim(a) {
  // minimal shape used by API/history surfaces; report included when present
  const rec = {
    id: a.id,
    url: a.url,
    origin: a.origin,
    host: a.host,
    createdAt: a.createdAt,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    status: a.status,
    stage: a.stage,
    stageId: a.stageId,
    pct: a.pct,
  };
  return rec;
}

export class AuditStore {
  constructor(opts = {}) {
    this.dir = path.resolve(process.cwd(), opts.dir || config.dataDir);
    this.file = path.join(this.dir, 'audits.jsonl');
    this.mem = new Map();      // id → { slim record, report? , logs? }
    this.hostIndex = new Map(); // host → [ids newest first]
    this.waits = new Map();    // reserved: id → resolver for long-poll waits
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.hydrate();
    return this;
  }

  hydrate() {
    if (!fs.existsSync(this.file)) return;
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const tail = lines.slice(Math.max(0, lines.length - LOAD_LIMIT));
      for (const line of tail) {
        try {
          const rec = JSON.parse(line);
          this.mem.set(rec.id, rec);
          this.indexHost(rec);
        } catch { /* skip broken line */ }
      }
    } catch { /* unreadable file — start clean in memory */ }
  }

  indexHost(rec) {
    if (!rec.host) return;
    let arr = this.hostIndex.get(rec.host);
    if (!arr) { arr = []; this.hostIndex.set(rec.host, arr); }
    if (!arr.includes(rec.id)) arr.unshift(rec.id);
  }

  /** Subscribe to the engine's persist events. */
  attach(engine) {
    engine.on('persist', (a) => this.put(a));
  }

  put(a, { durably = true } = {}) {
    let rec = this.mem.get(a.id);
    if (!rec) rec = {};
    Object.assign(rec, slim(a));
    rec.report = a.report || rec.report || null;
    rec.logs = (a.logs || []).slice(-LOG_LIMIT);
    rec.error = a.error || null;
    this.mem.set(a.id, rec);
    this.indexHost(rec);

    // memory prune
    if (this.mem.size > MEMORY_LIMIT) {
      for (const id of this.mem.keys()) {
        if (this.mem.size <= MEMORY_LIMIT) break;
        const old = this.mem.get(id);
        if (old.status !== 'running') this.mem.delete(id);
      }
    }

    if (durably) this.append(rec);
    return rec;
  }

  append(rec) {
    try {
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    } catch { // disk trouble must never take down audits
    }
  }

  get(id) {
    return this.mem.get(id) || null;
  }

  /** Running-out records exist in the engine, not yet persisted; combined lookup helper. */
  find(engine, id) {
    const rec = this.mem.get(id);
    if (rec) return rec;
    const running = engine && engine.running && engine.running.get(id);
    if (running) return this.snapshot(running);
    return null;
  }

  /** Read-only shape of a live audit without parking it in the index. */
  snapshot(a) {
    return { ...slim(a), report: a.report || null, logs: (a.logs || []).slice(-LOG_LIMIT), error: a.error || null };
  }

  /** Per-host history, newest first: [{id, score, grade, createdAt, status}] */
  historyForHost(host, excludeId = null, limit = 12) {
    const ids = this.hostIndex.get(host) || [];
    const out = [];
    for (const id of ids) {
      if (out.length >= limit) break;
      if (excludeId && id === excludeId) continue;
      const rec = this.mem.get(id);
      if (!rec || rec.status !== 'complete' || !rec.report) continue;
      out.push({
        id: rec.id,
        host: rec.host,
        createdAt: rec.createdAt,
        finishedAt: rec.finishedAt,
        score: rec.report.score && rec.report.score.overall,
        grade: rec.report.score && rec.report.score.grade,
        categories: Object.fromEntries((rec.report.categories || []).map((c) => [c.id, c.score])),
        coverage: rec.report.coverage && rec.report.coverage.pct,
      });
    }
    return out;
  }

  recent(limit = 20, status = null) {
    const all = [...this.mem.values()].filter((r) => (status ? r.status === status : true));
    all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return all.slice(0, limit).map((r) => ({
      id: r.id, url: r.url, host: r.host, createdAt: r.createdAt, finishedAt: r.finishedAt,
      status: r.status, score: r.report && r.report.score && r.report.score.overall,
      grade: r.report && r.report.score && r.report.score.grade,
    }));
  }
}
