/*
 * engine.js — orchestration for a full audit run.
 *
 * Pipeline: setup → robots → home → static-parse → crawl → key pages →
 *   browser (render + agent tasks) → score → complete.
 * Progress is streamed to subscribers; every artifact lands in ctx and each
 * of the 33 checks in checks.js runs against it.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { config } from './config.js';
import { safeFetch, safeProbe } from './safefetch.js';
import { parseRobots, isAllowed, RETRIEVAL_AGENTS, TRAINING_AGENTS } from './robots.js';
import { domSnapshot } from './parse.js';
import { policyCheckUrl, PolicyError } from './netguard.js';
import { runBrowserPhase, CHALLENGE_MARKERS } from './browser.js';
import { CHECKS, CHECKS_BY_ID } from './checks.js';
import { buildReport } from './scoring.js';

/**
 * Status vocabulary coming out of checks/tasks:
 *   pass · partial · fail · blocked · inconclusive · error · na · skipped
 * Normalized (single vocabulary for the report/API):
 *   pass · partial · fail · blocked · inconclusive · error · n/a
 */
export function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'na') return 'n/a';
  if (s === 'skipped') return 'blocked';
  if (s === 'n/a') return 'n/a';
  return s;
}

const STAGES = [
  { id: 'setup', label: 'Preparing audit', weight: 3 },
  { id: 'robots', label: 'Reading robots.txt', weight: 7 },
  { id: 'home', label: 'Fetching homepage', weight: 12 },
  { id: 'static', label: 'Extracting structure', weight: 8 },
  { id: 'crawl', label: 'Crawling key pages', weight: 16 },
  { id: 'keys', label: 'Probing key pages', weight: 6 },
  { id: 'browser', label: 'Rendering pages + agent tasks', weight: 43 },
  { id: 'score', label: 'Computing score', weight: 5 },
];

function nowMs() { return Date.now(); }
function short(url, n = 90) { try { const u = new URL(url); return (u.pathname + u.search).slice(0, n) || '/'; } catch { return url.slice(0, n); } }

export class AuditEngine extends EventEmitter {
  constructor() {
    super();
    this.running = new Map();   // id → audit record
    this.history = [];          // completed audit ids (newest first)
  }

  /* ---------------- record + progress plumbing ---------------- */

  emitStatus(a, stageId, frac, msg, kind = 'info') {
    const idx = STAGES.findIndex((s) => s.id === stageId);
    let done = 0;
    for (let i = 0; i < idx; i++) done += STAGES[i].weight;
    const pct = Math.min(100, Math.round(((done + STAGES[idx].weight * (frac ?? 0)) / STAGES.reduce((n, s) => n + s.weight, 0)) * 100));
    a.stage = STAGES[idx].label;
    a.stageId = stageId;
    a.pct = pct;
    if (msg) {
      const t = new Date();
      a.logs.push({ t: `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`, msg, kind });
      if (a.logs.length > 400) a.logs.splice(0, a.logs.length - 400);
    }
    this.emit('progress', { id: a.id, stage: a.stage, pct: a.pct, log: msg ? { t: a.logs[a.logs.length - 1].t, msg, kind } : null, status: a.status });
  }

  /* ---------------- entry point ---------------- */

  start(urlRaw) {
    const norm = normalizeInputUrl(urlRaw);
    const id = 'a' + crypto.randomBytes(6).toString('hex');
    const origin = norm.origin.replace(/\/$/, '');
    const host = new URL(origin).hostname;
    const a = {
      id, url: norm.href, origin, host,
      createdAt: nowMs(), startedAt: nowMs(), finishedAt: null,
      status: 'running', stage: 'Starting', stageId: 'setup', pct: 0,
      logs: [], report: null, error: null,
      cancelFlag: false, subs: new Set(),
    };
    this.running.set(id, a);
    // fire and forget; errors captured into record
    this.runAudit(a).then(() => {
      if (a.status === 'running') a.status = 'complete';
      a.finishedAt = nowMs();
      a.durationMs = a.finishedAt - a.startedAt;
      this.emit('audit-end', a);
      this.persist(a);
    }).catch((err) => {
      a.status = 'failed';
      a.error = err && err.message ? err.message : 'Audit crashed unexpectedly.';
      a.finishedAt = nowMs();
      a.durationMs = a.finishedAt - a.startedAt;
      this.emitStatus(a, 'score', 1, `audit failed: ${a.error}`, 'warn');
      this.emit('audit-end', a);
      this.persist(a);
    });
    return a;
  }

  cancel(id) {
    const a = this.running.get(id);
    if (!a) return false;
    if (a.status === 'running') {
      a.cancelFlag = true;
      for (const ac of a.aborters || []) { try { ac.abort('cancelled'); } catch {} }
      this.emitStatus(a, a.stageId || 'setup', a.pct / 100 < 1 ? 0.95 : 1, 'Cancellation requested — finishing the current step only.', 'warn');
    }
    return true;
  }

  canceled(a) {
    if (!a.cancelFlag) return false;
    a.status = 'cancelled';
    return true;
  }

  /* ---------------- the pipeline ---------------- */

  async runAudit(a) {
    const ctx = {
      origin: a.origin, host: a.host, inputUrl: a.url,
      cache: new Map(),
      aborters: [],
      deadline: nowMs() + config.limits.auditMs,
      logs: (msg, kind) => this.emitStatus(a, ctx.stageId || 'setup', ctx.frac ?? 0, msg, kind),
      browserOk() { return !!ctx.browser && ctx.browser.ok; },
    };
    a.aborters = new Set();

    /* -------- stage 0: setup -------- */
    ctx.stageId = 'setup';
    this.emitStatus(a, 'setup', 0.1, `target: ${a.origin}`);
    policyCheckUrl(a.url); // defensible normalization (also throws for bad input)

    /* -------- stage 1: robots.txt -------- */
    ctx.stageId = 'robots'; ctx.frac = 0;
    await this.fetchRobots(a, ctx);
    if (this.canceled(a)) return;

    /* -------- stage 2: homepage -------- */
    ctx.stageId = 'home'; ctx.frac = 0;
    await this.fetchHome(a, ctx);
    if (this.canceled(a)) return;

    /* -------- stage 3: static parse -------- */
    ctx.stageId = 'static'; ctx.frac = 0.2;
    await this.staticParse(a, ctx);
    if (this.canceled(a)) return;

    /* -------- stage 4: crawl -------- */
    ctx.stageId = 'crawl'; ctx.frac = 0.2;
    await this.crawl(a, ctx);
    if (this.canceled(a)) return;

    /* -------- stage 5: key pages (raw) -------- */
    ctx.stageId = 'keys'; ctx.frac = 0;
    await this.keyPages(a, ctx);
    if (this.canceled(a)) return;

    /* -------- stage 6: browser phase -------- */
    ctx.stageId = 'browser'; ctx.frac = 0;
    await this.browserPhase(a, ctx);
    if (this.canceled(a)) return;

    /* -------- stage 7: scoring -------- */
    ctx.stageId = 'score';
    this.emitStatus(a, 'score', 0.3, 'aggregating 33 checks…');
    const report = await this.score(a, ctx);
    a.report = report;
    this.emitStatus(a, 'score', 1, `audit complete — score ${report.score?.overall ?? 'n/a'}/100`, 'ok');
  }

  /* -------- individual stages -------- */

  async fetchRobots(a, ctx) {
    const r = { fetched: false, err: null, text: '', bytes: 0, httpStatus: null, groupCount: 0, sitemaps: [], parsed: null, blockedForUs: false };
    try {
      const res = await safeFetch(`${ctx.origin}/robots.txt`, { cache: ctx.cache, timeoutMs: 10_000 });
      if (!res.ok) {
        r.err = `${res.kind}: ${res.message}`;
        if (res.kind === 'blocked' && String(ctx.origin).includes('http')) r.err = 'network policy';
      } else {
        r.fetched = true; r.httpStatus = res.status; r.bytes = res.bytes;
        r.text = res.body.toString('utf8').slice(0, 20_000);
        r.parsed = parseRobots(r.text);
        r.groupCount = r.parsed.groups.length;
        r.sitemaps = r.parsed.sitemaps;
        if (r.groupCount === 0 && res.bytes > 0) r.sitemaps = r.sitemaps.length ? r.sitemaps : [];
        // does robots disallow our auditor UA on the homepage?
        r.blockedForUs = r.parsed.groups.length > 0 && !isAllowed(r.parsed, 'cumulusbot', `${ctx.origin}/`);
        this.emitStatus(a, 'robots', 0.6, r.httpStatus === 200 ? `robots.txt: ${r.groupCount} rule group(s)${r.sitemaps.length ? `, ${r.sitemaps.length} sitemap(s) referenced` : ''}` : `robots.txt returns HTTP ${r.httpStatus}`, r.httpStatus === 200 ? 'ok' : 'warn');
        // agent verdicts for retrieval agents against '/' and known key paths
        ctx.robotsRetrievalVerdicts = {};
        for (const ag of RETRIEVAL_AGENTS) {
          const blockedPaths = [];
          const paths = ['/', '/pricing', '/docs'];
          for (const p of paths) {
            if (r.parsed.groups.length && !isAllowed(r.parsed, ag, ctx.origin + p)) blockedPaths.push(p);
          }
          ctx.robotsRetrievalVerdicts[ag] = { mentioned: true, applies: true, allowedAll: blockedPaths.length === 0, blocked: blockedPaths };
        }
        ctx.robotsTrainingVerdicts = {};
        for (const ag of TRAINING_AGENTS) {
          if (!ctx.robotsRetrievalVerdicts) continue;
          const any = r.parsed.groups.some((g) => g.agent === ag);
          if (!any) { ctx.robotsTrainingVerdicts[ag] = { mentioned: false, allowedAll: true, blocked: [] }; continue; }
          const blocked = r.parsed.groups.length && !isAllowed(r.parsed, ag, ctx.origin + '/');
          ctx.robotsTrainingVerdicts[ag] = { mentioned: true, applies: true, allowedAll: !blocked, blocked: blocked ? ['/'] : [] };
        }
      }
    } catch (err) { r.err = err.message || String(err); }
    ctx.robots = r;
    this.emitStatus(a, 'robots', 1);
  }

  async fetchHome(a, ctx) {
    let home = null;
    if (ctx.robots && ctx.robots.blockedForUs) {
      // respect robots even for homepage fetch
      home = { skipped: true, reason: 'robots.txt disallows the auditor UA on /.', ok: false, kind: 'blocked' };
      this.emitStatus(a, 'home', 0.4, 'robots.txt disallows CumulusBot on / — homepage fetch skipped to respect policy.', 'warn');
    } else {
      home = await safeFetch(a.url, { cache: ctx.cache, accept: 'text/html,application/xhtml+xml', timeoutMs: 15_000 });
      if (!home.ok) this.emitStatus(a, 'home', 0.5, `homepage fetch failed: ${home.kind} (${home.message})`, 'fail');
      else this.emitStatus(a, 'home', 0.7, `homepage: HTTP ${home.status}, ${home.bytes.toLocaleString()} bytes in ${home.ms} ms`, 'ok');
    }
    ctx.homeFetch = home.ok ? home : (home.skipped ? { blocked: true, reason: home.reason } : null);
    ctx.home = home.ok ? home : null;

    /* ---- A3 pre-pass: second fetch wearing an agent-assistant-shaped UA ----
     * Tests gateway/WAF behaviour against non-browser user agents. The
     * `*` robots group is what applies to such unnamed agents; if it
     * disallows them we mark the probe robots-blocked (never a failure). */
    ctx.agentFetch = null;
    const parsed = ctx.robots && ctx.robots.parsed;
    const starForbidden = parsed && parsed.groups.length && !isAllowed(parsed, '*', a.url);
    if (a.cancelFlag || starForbidden) {
      ctx.agentFetch = { robotsBlocked: true };
      if (starForbidden) this.emitStatus(a, 'home', 0.9, 'agent-shape fetch skipped — robots.txt `*` group disallows it (A3 reported as blocked)', 'warn');
    } else {
      const agentUa = 'CumulusAgentFetch/1.0 (+retrieval-agent-shaped fetch; no browser present; respects robots.txt)';
      try {
        const f = await safeFetch(a.url, { ua: agentUa, timeoutMs: 12_000, maxBytes: 900_000, cache: ctx.cache });
        if (f.ok) {
          const hay = f.body.toString('utf8', 0, 200_000).toLowerCase();
          const markers = CHALLENGE_MARKERS.filter((mk) => hay.includes(mk));
          ctx.agentFetch = {
            ok: true,
            ua: agentUa.split(' ')[0],
            status: f.status,
            ms: f.ms,
            bytes: f.bytes,
            headers: f.headers,
            challenge: markers.length > 0,
            challengeDetail: markers.length ? `markers: ${markers.slice(0, 3).join(', ')}` : null,
          };
        } else {
          ctx.agentFetch = { ok: false, kind: f.kind, message: f.message, ua: agentUa.split(' ')[0] };
        }
      } catch (err) {
        ctx.agentFetch = { ok: false, kind: 'error', message: err && err.message ? err.message : 'agent fetch crashed', ua: 'CumulusAgentFetch' };
      }
    }
    this.emitStatus(a, 'home', 1);
  }

  async staticParse(a, ctx) {
    let dom = null;
    if (ctx.homeFetch && ctx.homeFetch.ok) {
      dom = domSnapshot(ctx.homeFetch.body.toString('utf8'), { url: ctx.homeFetch.finalUrl });
    }
    ctx.homeDom = dom;
    // navigation clearance from raw homepage: pricing/docs/signup classes
    const navHits = matchNav(dom, a.origin);
    ctx.navHits = navHits;
    ctx.pricingUrl = ctx.pricingUrl || (navHits.pricing ? absolute(navHits.pricing.href, a.origin) : null);
    this.emitStatus(a, 'static', 0.6, dom ? `parsed homepage: ${dom.anchorCount} anchors, ${dom.buttonsTotal} buttons, ${dom.forms.length} forms` : 'homepage HTML unavailable to parse', dom ? 'ok' : 'warn');
    this.emitStatus(a, 'static', 1);
  }

  async crawl(a, ctx) {
    const seen = new Set([normalizeKey(a.url)]);
    const pages = [];
    const deadLinks = [];
    const disallowed = [];
    let stopped = 'page_limit';
    const queue = [a.url];
    const cancelled = () => !!a.cancelFlag;
    const budgetLeft = () => nowMs() < ctx.deadline;

    let i = 0;
    while (pages.length < config.limits.crawlMaxPages && queue.length && i < 60) {
      i++;
      if (cancelled()) { stopped = 'cancelled'; break; }
      if (!budgetLeft()) { stopped = 'time'; this.emitStatus(a, 'crawl', 0.9, 'crawl stopped: time budget reached', 'warn'); break; }
      const u = queue.shift();
      const path = new URL(u).pathname + new URL(u).search;
      if (ctx.robots && ctx.robots.blockedForUs) { disallowed.push(path); continue; }
      if (ctx.robots && ctx.robots.parsed && ctx.robots.parsed.groups.length && !isAllowed(ctx.robots.parsed, 'cumulusbot', u)) { disallowed.push(path); continue; }
      const resFetch = await safeFetch(u, { cache: ctx.cache, headersOnly: false, accept: 'text/html,application/xhtml+xml', timeoutMs: 12_000 });
      if (!resFetch.ok) { deadLinks.push({ url: u, status: resFetch.status ?? 0, err: resFetch.kind }); continue; }
      if (pages.length) await sleep(Math.min(400, config.limits.crawlDelayMs));
      const isHtml = String(resFetch.headers['content-type'] || '').includes('text/html');
      const snap = isHtml ? domSnapshot(resFetch.body.toString('utf8'), { url: resFetch.finalUrl }) : null;
      pages.push({ url: resFetch.finalUrl, requestedUrl: u, status: resFetch.status, ms: resFetch.ms, bytes: resFetch.bytes, dom: snap, ok: resFetch.status === 200 && isHtml });
      if (pages.length === 1) this.emitStatus(a, 'crawl', 0.35, `crawled ${short(resFetch.finalUrl)} — ${snap ? snap.anchorCount + ' links' : 'not html'}`, 'ok');
      else if (pages.length < 6 || pages.length % 4 === 0) this.emitStatus(a, 'crawl', 0.35 + (pages.length / config.limits.crawlMaxPages) * 0.6, `crawled ${pages.length} page(s)…`);
      // enqueue
      if (snap) {
        for (const anc of snap.anchors) {
          if (queue.length > 40) break;
          let link = anc.href;
          if (!link || link === '#' || /^javascript:/i.test(link)) continue;
          try {
            const abs = absolute(link, resFetch.finalUrl);
            const nx = new URL(abs);
            nx.hash = '';
            // strip common tracking params
            for (const p of [...nx.searchParams.keys()]) if (/utm_|ref|fbclid|gclid|mc_/i.test(p)) nx.searchParams.delete(p);
            const keyUrl = nx.href;
            if (nx.hostname.replace(/^www\./, '') !== a.host.replace(/^www\./, '')) continue;
            if (nx.pathname.length > 220) continue;
            if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|json|xml|txt|woff2?|ttf|mp4|webm|zip|dmg|exe|mov|mp3|wav)$/i.test(nx.pathname)) continue;
            if (seen.has(normalizeKey(keyUrl))) continue;
            seen.add(normalizeKey(keyUrl));
            queue.push(keyUrl);
          } catch { /* bad link */ }
        }
      } else {
        // non-200 or non-html via redirect (count), dead-link-ish
      }
      if (resFetch.status >= 400) deadLinks.push({ url: resFetch.url, status: resFetch.status });
    }
    if (stopped === 'page_limit' && pages.length >= config.limits.crawlMaxPages) { /* page cap reached */ }
    if (stopped === 'page_limit' && pages.length < config.limits.crawlMaxPages && !queue.length) stopped = 'no_more_links';

    ctx.crawl = { pages, deadLinks: deadLinks.filter((d) => d.status >= 400 || d.err).slice(0, 12), disallowed: disallowed.slice(0, 10), stopped, visited: pages.length, queueLeft: queue.length };
    this.emitStatus(a, 'crawl', 1, `crawl finished: ${pages.length} page(s) fetched, stopped: ${stopped}`, 'ok');

    ctx.crawlPages = pages;

    // soft-404 probe
    const rnd = crypto.randomBytes(6).toString('hex');
    const probeUrl = `${ctx.origin}/cumulus-404-probe-${rnd}`;
    if (ctx.robots && ctx.robots.blockedForUs) {
      ctx.soft404 = { blocked: true };
    } else {
      const pr = await safeProbe(probeUrl, { cache: ctx.cache, timeoutMs: 10_000 });
      if (pr.ok) ctx.soft404 = { ok: true, status: pr.status, is404: pr.status >= 400 && pr.status < 500 };
      else ctx.soft404 = { ok: false, kind: pr.kind, message: pr.message };
      this.emitStatus(a, 'crawl', 1, ctx.soft404.is404 !== undefined ? `soft-404 probe: HTTP ${ctx.soft404.status}${ctx.soft404.is404 ? ' (correct 404)' : ' (returns ' + ctx.soft404.status + ' — soft 404!)'}` : `soft-404 probe failed: ${ctx.soft404.kind}`, ctx.soft404.is404 ? 'ok' : 'warn');
    }
  }

  async keyPages(a, ctx) {
    // collect candidates
    const cands = ctx.knownPages || {};
    if (ctx.pricingUrl) cands.pricing = ctx.pricingUrl;
    const docHit = (ctx.navHits || {}).docs;
    if (docHit && !cands.docs) cands.docs = absolute(docHit.href, a.origin);
    // pull docs-looking URL from sitemap after crawl if nav did not name one
    if (!cands.docs) {
      for (const pg of (ctx.crawl && ctx.crawl.pages) || []) {
        if (!pg.dom) continue;
        const hit = (pg.dom.navLinks || []).find((l) => /docs?|documentation|help(-|\/)?center|knowledge|support|guides/i.test(`${l.text} ${l.href}`));
        if (hit) { cands.docs = absolute(hit.href, a.origin); break; }
      }
    }
    if (!cands.docs && (ctx.sitemap && ctx.sitemap.urls)) {
      const d = ctx.sitemap.urls.find((u) => /\/(docs?|help|kb|support|guides)/i.test(u));
      if (d) cands.docs = d;
    }
    if (!cands.pricing && (ctx.sitemap && ctx.sitemap.urls)) {
      const pr = ctx.sitemap.urls.find((u) => /\/(pricing|plans)/i.test(u));
      if (pr) cands.pricing = pr;
    }
    ctx.knownPages = cands;
    ctx.rawKeyPages = [];
    let j = 0;
    for (const [label, u] of Object.entries(cands).slice(0, 4)) {
      if (!u) continue;
      if (nowMs() > ctx.deadline - 20_000) { this.emitStatus(a, 'keys', 0.5, 'key-page probes skipped: time budget', 'warn'); break; }
      if (a.cancelFlag) break;
      const disallowed = ctx.robots && ctx.robots.blockedForUs || (ctx.robots && ctx.robots.parsed && ctx.robots.parsed.groups.length && !isAllowed(ctx.robots.parsed, 'cumulusbot', u));
      if (disallowed) {
        ctx.rawKeyPages.push({ label, url: u, blocked: true, ok: false });
        this.emitStatus(a, 'keys', 0.2 + j * 0.2, `${label} page skipped — robots.txt disallow`, 'warn');
      } else {
        const res = await safeFetch(u, { cache: ctx.cache, accept: 'text/html', timeoutMs: 12_000 });
        const dom = res.ok ? domSnapshot(res.body.toString('utf8'), { url: res.url || u }) : null;
        ctx.rawKeyPages.push({ label, url: res.ok ? res.finalUrl : u, status: res.ok ? res.status : null, ok: res.ok && res.status === 200, bytes: res.ok ? res.bytes : 0, snapshot: dom, blocked: false });
        this.emitStatus(a, 'keys', 0.2 + j * 0.2, res.ok ? `${label} page: HTTP ${res.status} (${res.bytes.toLocaleString()} bytes)` : `${label} page failed: ${res.kind}`, res.ok ? 'ok' : 'warn');
      }
      j++;
    }

    /* ---- A4 pre-pass: collect robots meta directives from pages we already have ---- */
    ctx.noindexScan = [];
    if (ctx.homeDom) ctx.noindexScan.push({ label: 'home', url: ctx.homeDom.url || a.url, directives: ctx.homeDom.robotsMeta || '' });
    for (const p of ctx.rawKeyPages) {
      if (p.snapshot) ctx.noindexScan.push({ label: p.label, url: p.url, directives: p.snapshot.robotsMeta || '' });
    }
    for (const pg of (ctx.crawlPages || []).slice(0, 6)) {
      if (pg && pg.dom) ctx.noindexScan.push({ label: 'page', url: pg.url, directives: pg.dom.robotsMeta || '' });
    }
    ctx.noindexScan = ctx.noindexScan.slice(0, 10);
    // sitemap probing (belongs to discovery)
    await this.probeSitemap(a, ctx);
    await this.probeLlms(a, ctx);
  }

  async probeSitemap(a, ctx) {
    const s = { found: false, blocked: false, urls: null, urlCount: 0, url: null, source: null, samples: [], urlMatches: {} };
    const tryFetch = async (u, source) => {
      const robotsDisallowed = ctx.robots.blockedForUs;
      if (robotsDisallowed) { s.blocked = true; return null; }
      const res = await safeFetch(u, { cache: ctx.cache, accept: 'application/xml,text/xml,*/*', timeoutMs: 10_000, maxBytes: 1_500_000 });
      if (!res.ok) return null;
      const txt = res.body.toString('utf8').slice(0, 2_000_000);
      const kind = /<sitemapindex/i.test(txt) ? 'sitemapindex' : /<urlset/i.test(txt) ? 'urlset' : null;
      if (!kind) return null;
      const urls = extractSitemapUrls(txt, kind === 'sitemapindex' ? 'sitemapindex' : 'urlset').slice(0, 3000);
      return { u, source, kind, urls, status: res.status };
    };
    try {
      let hit = null;
      // 1. from robots
      if (ctx.robots && ctx.robots.sitemaps && ctx.robots.sitemaps.length) {
        for (const sm of ctx.robots.sitemaps.slice(0, 3)) {
          const abs = absolute(sm, ctx.origin);
          if (new URL(abs).hostname.replace(/^www\./, '') !== ctx.host.replace(/^www\./, '')) continue;
          hit = await tryFetch(abs, 'robots.txt directive');
          if (hit && hit.urls.length) break;
        }
      }
      // 2. common paths
      if (!hit) {
        for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml']) {
          if (ctx.robots.blockedForUs) break;
          const u = ctx.origin + p;
          if (ctx.robots.parsed && ctx.robots.parsed.groups.length && !isAllowed(ctx.robots.parsed, 'cumulusbot', u)) continue;
          hit = await tryFetch(u, 'standard location probe');
          if (hit && hit.urls.length) break;
          hit = null;
        }
      }
      if (hit) {
        s.found = true; s.url = hit.u; s.source = hit.source; s.kind = hit.kind; s.urls = hit.urls; s.urlCount = hit.urls.length;
        s.samples = hit.urls.slice(0, 8);
        s.urlMatches = {
          pricing: hit.urls.filter((u) => /price|pricing|plans/i.test(u)).slice(0, 3),
          docs: hit.urls.filter((u) => /docs?|documentation|help|kb|guides/i.test(u)).slice(0, 3),
          signup: hit.urls.filter((u) => /(sign)?[-_]?up|register|create[-_]account|login|log[-_]?in/i.test(u)).slice(0, 3),
        };
        this.emitStatus(a, 'keys', 0.85, `sitemap: ${s.urlCount} URLs from ${s.url} (via ${s.source})`, 'ok');
      } else if (s.blocked) {
        this.emitStatus(a, 'keys', 0.85, 'sitemap probing skipped — robots disallow', 'warn');
      } else {
        this.emitStatus(a, 'keys', 0.85, 'sitemap: none found (robots + standard locations)', 'warn');
      }
    } catch (err) { s.error = err.message; }
    ctx.sitemap = s;
  }

  async probeLlms(a, ctx) {
    const l = { ok: false, blocked: false, status: null, bytes: 0, text: '' };
    if (ctx.robots.blockedForUs) { l.blocked = true; ctx.llms = l; return; }
    const res = await safeFetch(`${ctx.origin}/llms.txt`, { cache: ctx.cache, accept: 'text/plain,text/markdown,*/*', timeoutMs: 8_000 });
    if (res.ok && res.status === 200) { l.ok = true; l.status = res.status; l.bytes = res.bytes; l.text = res.body.toString('utf8').slice(0, 3000); }
    else if (res.ok) { l.status = res.status; }
    else { l.kind = res.kind; l.message = res.message; }
    ctx.llms = l;
  }

  /* -------- browser phase -------- */

  async browserPhase(a, ctx) {
    ctx.rendered = {};
    ctx.tasks = {};
    try {
      await runBrowserPhase(this, a, ctx);
    } catch (err) {
      ctx.browserUnavailable = true;
      ctx.browser = { ok: false, reason: err && err.message ? err.message : 'browser phase crashed' };
      this.emitStatus(a, 'browser', 1, `browser phase unavailable: ${ctx.browser.reason}`, 'warn');
    }
  }

  async score(a, ctx) {
    computeP3(ctx);
    const results = [];
    for (const def of CHECKS) {
      let r;
      try {
        r = await def.run(ctx);
      } catch (err) {
        r = { status: 'error', evidence: [['unexpected error', String(err && err.message || err)]], note: 'check crashed — see open items' };
      }
      if (!r || !r.status) r = { status: 'error', evidence: [['state', 'check returned no result']] };
      results.push({ id: def.id, ...r, status: normalizeStatus(r.status), sev: def.sev, cat: def.cat });
    }
    const report = buildReport({
      url: a.url, origin: a.origin, host: a.host,
      startedAt: a.startedAt, finishedAt: nowMs(),
      ctx, results, checks: CHECKS_BY_ID,
    });
    for (const c of results) {
      if (c.status === 'blocked' || c.status === 'inconclusive' || c.status === 'error') {
        this.emitStatus(a, 'score', 0.6 + results.indexOf(c) / results.length * 0.3, `check ${c.id}: ${c.status}`, 'warn');
      }
    }
    return report;
  }

  /* ---------------- persistence ---------------- */

  persist(a) {
    try { this.emit('persist', a); } catch { /* store takes it */ }
  }
}

/* helpers */

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function normalizeInputUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new PolicyError('bad_target', 'Empty URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = policyCheckUrl(s); } catch (err) { throw err; }
  // strip hash, default to homepage of that rest-of-path
  u.hash = '';
  return u;
}

export function normalizeKey(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    // strip trailing slashes for equivalency
    let p = x.pathname.replace(/\/+$/, '') || '/';
    return x.hostname.replace(/^www\./, '') + p + x.search;
  } catch { return u; }
}

export function absolute(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

/* nav key-page matcher — reused for D9 and pricing discovery */
const NAV_PATTERNS = {
  pricing: /pricing|plans|plans\b|prices|quotas?|tiers?|subscriptions?|buy(?:\s|$)/i,
  docs: /\bdocs?\b|documentation|docs\b|help(?:[-_ ]center)?|knowledge[-_ ]?base|support\b|guides\b|faq|wiki|manual/i,
  signup: /sign[-_ ]?up|register|create[-_ ]account|get[-_ ]started|start[-_ ]free|try[-_ ]free|join(?:\s|$)|sign[-_ ]in|log[-_ ]?in/i,
};
export function matchNav(dom, origin) {
  const hits = {};
  if (!dom || !dom.navLinks) return hits;
  for (const l of dom.navLinks) {
    for (const [k, rx] of Object.entries(NAV_PATTERNS)) {
      if (hits[k]) continue;
      const hay = `${l.text} ${l.href}`;
      if (rx.test(hay)) hits[k] = { text: l.text, href: absolute(l.href, origin) || l.href };
    }
  }
  return hits;
}

function extractSitemapUrls(xml, kind) {
  const out = [];
  const rx = kind === 'sitemapindex'
    ? /<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi
    : null;
  if (kind === 'urlset') {
    const blocks = splitUrlBlocks(xml);
    for (const b of blocks) {
      const loc = b.match(/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/i);
      if (loc) out.push(loc[1]);
      if (out.length >= 3000) break;
    }
    return out;
  }
  let m;
  if (rx) while ((m = rx.exec(xml))) { out.push(m[1]); if (out.length >= 200) break; }
  return out;
}

function splitUrlBlocks(xml) {
  return (xml.match(/<url>[\s\S]*?<\/url>/gi) || []).slice(0, 3000);
}

function normalizeAmount(value) {
  const m = String(value || '').replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  return parseFloat(m[0].replace(/,/g, ''));
}

/**
 * P3 pre-computation: which rendered plan prices demonstrably exist in the raw
 * pricing HTML's own price strings (numbers compared by normalized amount).
 */
function computeP3(ctx) {
  ctx.planPriceRequests = [];
  const t = ctx.tasks && ctx.tasks.plans;
  if (!t || !Array.isArray(t.plans)) { ctx.p3 = { renders: false }; return; }
  const rendered = [...new Set(t.plans.map((p) => p && p.price).filter(Boolean))].slice(0, 8);
  ctx.planPriceRequests = rendered;
  if (!rendered.length) { ctx.p3 = { renders: true, found: [], missing: [] }; return; }
  const raw = (ctx.rawKeyPages || []).find((p) => p.label === 'pricing');
  if (!raw || !raw.snapshot) { ctx.p3 = { renders: !!raw, found: [], missing: rendered }; return; }
  const rawAmounts = new Set();
  for (const s of raw.snapshot.prices || []) {
    const n = normalizeAmount(s);
    if (n != null) rawAmounts.add(n.toFixed(2).replace(/\.00$/, ''));
  }
  const found = [], missing = [];
  for (const p of rendered) {
    const n = normalizeAmount(p);
    const key = n == null ? null : n.toFixed(2).replace(/\.00$/, '');
    if (key != null && rawAmounts.has(key)) found.push(p); else missing.push(p);
  }
  ctx.p3 = { renders: true, found, missing };
}

export { config };
