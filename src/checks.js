import { isAllowed } from './robots.js';

/* ------------------------------------------------------------------ */
/* Severity weights + status semantics                                  */
/* ------------------------------------------------------------------ */

export const WEIGHTS = { critical: 5, high: 3, medium: 2, low: 1 };
export const REQUIRES_BROWSER = ['U2', 'U3', 'U8', 'U9', 'P1', 'P2', 'P5', 'P6', 'A2', 'A3'];

/* ------------------------------------------------------------------ */
/* Result helpers                                                       */
/* ------------------------------------------------------------------ */

function clip(s, n = 300) {
  s = String(s ?? '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function res(status, evidence = [], extra = {}) {
  return { status, evidence: evidence.filter(Boolean).map(([k, v]) => [String(k), Array.isArray(v) ? v : clip(v)]), ...extra };
}

const rowlist = (arr, n = 24) => (arr.length ? arr.slice(0, n).join('\n') : 'none');

const RETRIEVAL_LABELS = {
  'chatgpt-user': 'ChatGPT-User', 'oai-searchbot': 'OAI-SearchBot', 'claude-user': 'Claude-User',
  'claude-searchbot': 'Claude-SearchBot', 'claudebot': 'ClaudeBot', 'perplexity-user': 'Perplexity-User',
  'perplexitybot': 'PerplexityBot',
};
const agentLabel = (a) => RETRIEVAL_LABELS[a] || a;
const groupCount = (r) => (r && r.groupCount) || 0;

/* ------------------------------------------------------------------ */
/* Check registry — 33 independently defined checks                     */
/* ------------------------------------------------------------------ */

export const CHECKS = [
  /* ---------------- Discovery ---------------- */
  {
    id: 'D1', cat: 'discovery', sev: 'medium', title: 'robots.txt is published and readable',
    why: 'Robots.txt is the first file every compliant agent reads: policy plus a pointer to the sitemap.',
    run: async (ctx) => {
      const r = ctx.robots;
      if (!r || !r.fetched) {
        return r && r.err ? res('error', [['fetch', `robots.txt: ${r.err}`]]) : res('fail', [['fetch', 'robots.txt could not be fetched']]);
      }
      if (r.httpStatus === 200) {
        const ev = [['url', `${ctx.origin}/robots.txt`], ['http status', '200'], ['bytes', String(r.bytes ? r.bytes.toLocaleString() : 0)], ['groups', String(r.groupCount || 0)], ['sitemaps referenced', String(r.sitemaps.length)]];
        if (r.groupCount > 0) ev.push(['excerpt', clip(r.text, 400)]);
        return res(r.groupCount + r.sitemaps.length > 0 ? 'pass' : 'partial', ev);
      }
      if (r.httpStatus === 404 || r.httpStatus === 410) return res('fail', [['url', `${ctx.origin}/robots.txt`], ['http status', String(r.httpStatus)], ['meaning', 'No robots.txt published — agents must guess at policy and cannot discover sitemaps from it.']]);
      return res('fail', [['url', `${ctx.origin}/robots.txt`], ['http status', String(r.httpStatus)], ['meaning', 'robots.txt did not return 200.']]);
    },
  },
  {
    id: 'D2', cat: 'discovery', sev: 'critical', title: 'AI retrieval agents are allowed',
    why: 'Retrieval assistants (ChatGPT-User, ClaudeBot, PerplexityBot…) obey robots.txt and are the front door for agent users.',
    run: async (ctx) => {
      const p = ctx.robots && ctx.robots.parsed;
      if (ctx.robots && ctx.robots.fetched && !p) return res('error', [['state', 'robots.txt fetched but parsing failed']]);
      if (!p) return res('inconclusive', [['robots.txt', 'could not be fetched (see D1)'], ['default', 'agents default to allowing the site when robots.txt is missing, but network failures leave the policy unknown']]);
      if (!p.groups.length) return res('pass', [['policy', 'No applicable robots.txt rules — agents are allowed by default.'], ['note', 'Still worth publishing robots.txt (see D1).']]);
      const verdicts = ctx.robotsRetrievalVerdicts || {};
      const agents = Object.keys(verdicts);
      if (!agents.length) return res('n/a', [['reason', 'retrieval-agent evaluation unavailable']]);
      const blocked = agents.filter((a) => !verdicts[a].allowedAll);
      const ev = [['_user-agents evaluated', agents.join(', ')], ['robots', `${groupCount(ctx.robots)} rule groups`]];
      for (const a of agents) {
        const v = verdicts[a];
        ev.push([agentLabel(a), v.allowedAll ? 'allowed' : `BLOCKED on /${v.blocked.length} path(s)`]);
      }
      // training-crawler opt-outs are a deliberate, separate choice — note them without failing
      const trainingNote = ctx.robotsTrainingVerdicts && Object.entries(ctx.robotsTrainingVerdicts)
        .filter(([, v]) => !v.allowedAll && v.mentioned)
        .map(([a]) => agentLabel(a));
      if (trainingNote && trainingNote.length) ev.push(['note', `Training crawlers deliberately excluded (accepted choice): ${trainingNote.join(', ')}`]);
      if (!blocked.length) return res('pass', ev);
      if (blocked.length === agents.length) return res('fail', [...ev, ['detail', 'every retrieval assistant tested is disallowed in robots.txt']]);
      return res('partial', [...ev, ['detail', `${blocked.length} of ${agents.length} retrieval assistants are blocked: ${blocked.join(', ')}`]]);
    },
  },
  {
    id: 'D3', cat: 'discovery', sev: 'high', title: 'XML sitemap is discoverable',
    why: 'Sitemaps enumerate pages that are not prominently linked and tell agents what content exists.',
    run: async (ctx) => {
      const s = ctx.sitemap;
      if (!s) return res('error', [['state', 'sitemap probe skipped']]);
      if (s.blocked) return res('blocked', [['detail', 'sitemap fetch skipped: disallowed by robots.txt for the auditor']], { note: s.blockedDetail });
      if (!s.found) return res('fail', [['checked locations', 'Sitemap: directives from robots.txt, then /sitemap.xml, /sitemap_index.xml, /sitemap-index.xml, /wp-sitemap.xml'], ['result', 'no parseable sitemap found']]);
      const ev = [['sitemap url', s.url], ['source', s.source], ['kind', s.kind], ['urls listed', String(s.urlCount)]];
      if (s.samples && s.samples.length) ev.push(['sample urls', rowlist(s.samples, 6)]);
      return res('pass', ev);
    },
  },
  {
    id: 'D4', cat: 'discovery', sev: 'medium', title: 'Sitemap lists key pages',
    why: 'If pricing, docs and signup are missing from the sitemap, agents that use it find nothing.',
    run: async (ctx) => {
      const s = ctx.sitemap;
      if (!s || !s.found || !s.urls) return res('n/a', [['reason', 'no usable sitemap (see D3)']]);
      const hits = s.urlMatches || {};
      const found = Object.entries(hits).filter(([, list]) => list.length).map(([k]) => k);
      const ev = [['pricing urls', rowlist(hits.pricing || [], 3)], ['docs urls', rowlist(hits.docs || [], 3)], ['signup urls', rowlist(hits.signup || [], 3)]];
      if (found.length >= 2) return res('pass', ev);
      if (found.length === 1) return res('partial', ev);
      return res('fail', [...ev, ['detail', 'sitemap exists but lists none of: pricing, docs, signup']]);
    },
  },
  {
    id: 'D5', cat: 'discovery', sev: 'low', title: 'llms.txt is published',
    why: 'A curated Markdown map (/llms.txt) is an emerging convention that lets agents ingest the site without layout parsing.',
    run: async (ctx) => {
      const l = ctx.llms;
      if (!l) return res('error', [['state', 'llms.txt probe skipped']]);
      if (l.blocked) return res('blocked', [['detail', 'llms.txt fetch already known disallowed by robots.txt']]);
      if (l.ok && (l.bytes || 0) > 5) return res('pass', [['url', `${ctx.origin}/llms.txt`], ['http status', String(l.status)], ['bytes', String(l.bytes)], ['excerpt', clip(l.text, 300)]]);
      if (l.ok) return res('partial', [['url', `${ctx.origin}/llms.txt`], ['http status', String(l.status)], ['detail', 'file exists but is empty']]);
      if (l.status === 404 || l.status === 410) return res('fail', [['url', `${ctx.origin}/llms.txt`], ['http status', String(l.status)], ['meaning', 'No llms.txt published — agents fall back to parsing every page individually.']]);
      if (l.kind === 'error' || l.kind === 'timeout' || l.kind === 'tls') return res('error', [['fetch', `${l.kind}: ${l.message}`]]);
      return res('fail', [['url', `${ctx.origin}/llms.txt`], ['http status', String(l.status ?? 'n/a')]]);
    },
  },
  {
    id: 'D6', cat: 'discovery', sev: 'high', title: 'Title and meta description in HTML',
    why: 'The summary agents use to decide whether to read a page at all.',
    run: async (ctx) => {
      const d = ctx.homeDom || (ctx.rendered && ctx.rendered.home);
      if (!d) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'homepage HTML not parsed']]);
      const ev = [['title', d.title || '(empty)'], ['title length', String(d.titleLen)], ['description', d.metaDesc ? clip(d.metaDesc, 220) : '(none)'], ['description length', String(d.metaDescLen)]];
      const goodT = d.titleLen >= 4 && d.titleLen <= 90;
      const goodD = d.metaDescLen >= 20 && d.metaDescLen <= 300;
      if (goodT && goodD) return res('pass', ev);
      if (d.titleLen > 0 || d.metaDescLen > 0) return res('partial', ev);
      return res('fail', ev);
    },
  },
  {
    id: 'D7', cat: 'discovery', sev: 'low', title: 'Canonical URL is declared',
    why: 'Tells agents which URL variant is authoritative across http/https, www, query-string and path variants.',
    run: async (ctx) => {
      const d = ctx.homeDom || (ctx.rendered && ctx.rendered.home);
      if (!d) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'homepage HTML not parsed']]);
      const canonical = d.canonicalHref;
      if (canonical) {
        let abs = false; try { abs = new URL(canonical, d.url || ctx.origin).hostname.length > 0; } catch { abs = false; }
        return res('pass', [['canonical', canonical], ['absolute', abs ? 'yes' : 'no (relative)']]);
      }
      if (d.og.url) return res('partial', [['canonical', 'missing'], ['og:url', d.og.url], ['detail', 'og:url hints at the canonical URL but is not the declared linked form']]);
      return res('fail', [['canonical', 'not declared (no link[rel=canonical], no og:url)']]);
    },
  },
  {
    id: 'D8', cat: 'discovery', sev: 'medium', title: 'Valid JSON-LD structured data',
    why: 'Unambiguous facts about the organisation and pages, readable without DOM walking.',
    run: async (ctx) => {
      const d = ctx.homeDom || (ctx.rendered && ctx.rendered.home);
      if (!d) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'homepage HTML not parsed']]);
      const blocks = d.jsonLd || [];
      const okBlocks = blocks.filter((b) => b && b.ok && (b.type || (b.raw && false)));
      const types = [];
      for (const b of blocks) { if (b && !b.ok && b.raw) types.push('(unparseable block)'); }
      const valid = blocks.filter((b) => b && b.ok);
      const typeTags = valid.map((b) => b.type).filter(Boolean);
      const ev = [['ld+json blocks', String(blocks.length)], ['parsed ok', String(valid.length)], ['types found', rowlist(typeTags, 12)]];
      if (blocks.length && valid.length === 0) ev.push(['broken blocks', String(blocks.length)]);
      if (valid.length && typeTags.length) return res('pass', ev);
      if (valid.length) return res('partial', [...ev, ['detail', 'valid JSON but no @type declared']]);
      if (blocks.length) return res('fail', [...ev, ['detail', 'all ld+json blocks failed to parse as JSON']]);
      return res('fail', ev);
    },
  },
  {
    id: 'D9', cat: 'discovery', sev: 'high', title: 'Navigation exposes key destinations',
    why: 'Agents pick links by visible labels. If pricing, docs and signup are not linked, they are invisible on purpose-free fetches too.',
    run: async (ctx) => {
      const d = ctx.homeDom;
      if (!d || !d.navLinks) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'homepage HTML not parsed']]);
      const hits = ctx.navHits || {};
      const ev = [['anchors scanned (header/nav areas)', String(d.navLinks.length)], ['pricing link', hits.pricing ? `${hits.pricing.text || '(untitled)'} → ${hits.pricing.href}` : 'none'], ['docs link', hits.docs ? `${hits.docs.text || '(untitled)'} → ${hits.docs.href}` : 'none'], ['signup link', hits.signup ? `${hits.signup.text || '(untitled)'} → ${hits.signup.href}` : 'none']];
      const n = ['pricing', 'docs', 'signup'].filter((k) => hits[k]).length;
      if (n === 3) return res('pass', ev);
      if (n >= 2) return res('partial', ev);
      return res('fail', ev);
    },
  },
  {
    id: 'D10', cat: 'discovery', sev: 'low', title: 'Open Graph metadata',
    why: 'og:title and og:image keep link previews consistent for both humans and agents that summarise by card.',
    run: async (ctx) => {
      const d = ctx.homeDom || (ctx.rendered && ctx.rendered.home);
      if (!d) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'homepage HTML not parsed']]);
      const ev = [['og:title', d.og.title || '(none)'], ['og:image', d.og.image || '(none)']];
      if (d.og.title && d.og.image) return res('pass', ev);
      if (d.og.title || d.og.image) return res('partial', ev);
      return res('fail', ev);
    },
  },

  /* ---------------- Access ---------------- */
  {
    id: 'A1', cat: 'access', sev: 'critical', title: 'Homepage reachable over HTTPS',
    why: 'If the homepage is not reachable with a plain HTTP client, nothing else can be audited — and no agent can read the site.',
    run: async (ctx) => {
      const h = ctx.home;
      if (!h) return res('error', [['fetch', 'homepage fetch did not run']]);
      if (!h.ok) {
        if (h.kind === 'timeout') return res('error', [['fetch', 'homepage fetch timed out']]);
        return res('fail', [['fetch', `${h.code || ''} ${h.message || ''}`.trim()], ['url', ctx.origin + '/']]);
      }
      const https = String(h.finalUrl).startsWith('https://');
      const isHtml = String(h.headers['content-type'] || '').includes('text/html');
      const ev = [['final url', h.finalUrl], ['http status', String(h.status)], ['content-type', String(h.headers['content-type'] || '(none)')], ['tls', 'certificate verified'], ['fetch time', `${h.ms} ms`]];
      if (h.status === 200 && isHtml && https) return res('pass', ev);
      if (h.status === 200 && isHtml && !https) return res('fail', [...ev, ['detail', 'reachable only over plain HTTP; agents mostly default to HTTPS and many tools refuse it']]);
      if (h.status === 200 && !isHtml) return res('fail', [...ev, ['detail', 'homepage did not respond with text/html']]);
      return res('fail', [...ev, ['detail', `homepage returned ${h.status}`]].filter(Boolean));
    },
  },
  {
    id: 'A2', cat: 'access', sev: 'critical', title: 'Core content is in the initial HTML',
    why: 'Fetch-only agents receive the server HTML verbatim. If the content is assembled by JavaScript, they see an empty shell.',
    run: async (ctx) => {
      const raw = ctx.homeDom && ctx.homeDom.textChars;
      const rend = ctx.rendered && ctx.rendered.home && ctx.rendered.home.textChars;
      if (raw == null || rend == null) {
        const reason = !ctx.rendered || !ctx.rendered.home ? 'rendered DOM unavailable (browser phase skipped or blocked)' : 'raw HTML unavailable';
        return res((ctx.browserUnavailable ? 'error' : 'blocked'), [['state', reason]]);
      }
      const ev = [['text in initial HTML', `${raw.toLocaleString()} chars`], ['text in rendered DOM', `${rend.toLocaleString()} chars`], ['initial-html share', rend ? Math.round((raw / rend) * 100) + '%' : 'n/a'], ['raw excerpt', clip(ctx.homeDom.textSample, 180)]];
      if (rend < 200) return res('n/a', [...ev, ['detail', 'rendered page too sparse to compare']]);
      if ((raw >= 250 && raw >= rend * 0.55)) return res('pass', ev);
      if ((raw >= 100 && raw >= rend * 0.2)) return res('partial', [...ev, ['detail', 'some content renders later — key passages may be invisible to fetchers']]);
      const r = res('fail', [...ev, ['detail', 'primary content appears only after JavaScript runs']]);
      return r;
    },
  },
  {
    id: 'A3', cat: 'access', sev: 'critical', title: 'No bot challenge on public pages',
    why: 'CAPTCHAs and "verify you are human" interstials stop autonomous agents at the door even when the page would load.',
    run: async (ctx) => {
      const a = ctx.agentFetch;
      if (a && a.robotsBlocked) return res('blocked', [['detail', 'robots.txt disallows this agent user-agent; fetch skipped to respect policy (robots policy itself is scored in D2).']]);
      const ev = [];
      if (a && a.ok) { ev.push([`fetch as "${a.ua}"`, `${a.status} in ${a.ms} ms, ${a.bytes.toLocaleString()} bytes`]); ev.push(['agent fetch content-type', String(a.headers['content-type'] || '')]); }
      const rendered = ctx.rendered && ctx.rendered.home;
      if (rendered && rendered.challenge) ev.push(['rendered challenge', rendered.challengeDetail || 'detected challenge markers in rendered page']);
      if (a && a.ok && a.status === 200 && !a.challenge && !(rendered && rendered.challenge)) return res('pass', ev.length ? [...ev, ['detail', 'no challenge markers found']] : [['detail', 'no evidence of a challenge (agent fetch skipped)']]);
      if (a && a.ok && a.status === 429) return res('inconclusive', [...ev, ['detail', 'rate-limited (429) — may reflect load, not policy; try again later']]);
      if ((a && a.ok && (a.status === 401 || a.status === 403)) || (a && a.challenge) || (rendered && rendered.challenge)) {
        if (a && a.ok && a.status !== 200) ev.push([`fetch as "${a.ua}"`, `${a.status} — blocked by WAF/gateway`]);
        return res('fail', [...ev, ['detail', 'requests from an agent user-agent are challenged or blocked']]);
      }
      if (a && !a.ok) return res('inconclusive', [['agent fetch', `${a.kind}: ${a.message}`]]);
      return res('pass', ev.length ? ev : [['detail', 'no challenge signals observed (probe skipped)']]);
    },
  },
  {
    id: 'A4', cat: 'access', sev: 'high', title: 'Pages are not marked noindex',
    why: 'noindex is a standing instruction for retrieval systems to forget the page — often applied to catalogues or docs by accident.',
    run: async (ctx) => {
      const list = ctx.noindexScan || [];
      if (!list.length) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'no page directives scanned (raw pages unavailable)']]);
      const ev = list.map((p) => [`${p.label}: ${new URL(p.url, ctx.origin).pathname}`, p.directives ? `directives: ${p.directives}` : 'none']);
      const noindexed = list.filter((p) => p.directives && /\bnoindex\b/i.test(p.directives));
      if (noindexed.length) return res('fail', [...ev, ['detail', `${noindexed.length} public page(s) tell search/agent systems not to index them`]]);
      return res('pass', [...ev, ['detail', 'no noindex directives on public pages']]);
    },
  },
  {
    id: 'A5', cat: 'access', sev: 'medium', title: 'HTML is a reasonable size',
    why: 'Fetchers with capped context windows truncate or drop oversized documents before the useful part is reached.',
    run: async (ctx) => {
      const h = ctx.home;
      if (!h || !h.ok) return res('n/a', [['reason', 'homepage not fetched']]);
      const b = h.bytes || 0;
      const ev = [['html size', `${b.toLocaleString()} bytes`], ['note', 'uncompressed HTML']];
      if (b <= 300_000) return res('pass', ev);
      if (b <= 1_000_000) return res('partial', [...ev, ['detail', 'largely above the safe truncation threshold of many fetchers']]);
      return res('fail', [...ev, ['detail', 'very large; agents may only see the head of the document']]);
    },
  },
  {
    id: 'A6', cat: 'access', sev: 'low', title: 'Document language is declared',
    why: 'Helps agents pick language handling for extraction, translation and locale-sensitive answers.',
    run: async (ctx) => {
      const d = ctx.homeDom || (ctx.rendered && ctx.rendered.home);
      if (!d) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'homepage HTML not parsed']]);
      const ev = [['html lang', d.lang || '(none)']];
      if (/^[a-z]{2,3}(-[a-z0-9-]+)?$/i.test(d.lang || '')) return res('pass', ev);
      if (d.lang) return res('partial', [...ev, ['detail', 'lang attribute present but not a valid BCP-47 primary tag']]);
      return res('fail', ev);
    },
  },
  {
    id: 'A7', cat: 'access', sev: 'low', title: 'Machine-readable alternate advertised',
    why: 'Advertised feeds or Markdown alternatives let agents consume content without DOM parsing.',
    run: async (ctx) => {
      const d = ctx.homeDom || (ctx.rendered && ctx.rendered.home);
      if (!d) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'homepage HTML not parsed']]);
      const alts = d.alternates || [];
      const machine = alts.filter((a) => /application\/(rss|atom|feed|json|markdown)|text\/markdown|\.md\b|\.xml\b/.test(a.type + ' ' + a.href) && !a.hreflang);
      const ev = [['alternate links', String(alts.length)], ['machine-readable', rowlist(machine.map((a) => `${a.type || 'untyped'} ${a.href}`), 6)]];
      if (machine.length) return res('pass', ev);
      if (alts.length) return res('partial', [...ev, ['detail', 'only hreflang alternates found (human languages, not machine formats)']]);
      return res('fail', [...ev, ['detail', 'no advertised RSS/Atom/Markdown alternate']]);
    },
  },
  {
    id: 'A8', cat: 'access', sev: 'high', title: 'Key pages return successful responses',
    why: 'Discovered pricing, docs and signup pages must actually load with a normal agent user-agent.',
    run: async (ctx) => {
      const pages = ctx.rawKeyPages || [];
      if (!pages.length) return res('n/a', [['reason', 'no key pages discovered to verify (see D9 / browser tasks)']]);
      const ev = pages.map((p) => [`${p.label}: ${new URL(p.url, ctx.origin).pathname}`, p.blocked ? 'skipped — robots disallow' : `HTTP ${p.status}${p.ok ? ' ✓' : ''}`]);
      const ok = pages.filter((p) => p.ok).length;
      const blocked = pages.filter((p) => p.blocked).length;
      if (blocked && ok === 0) return res('blocked', ev);
      if (ok === pages.length) return res('pass', ev);
      if (ok > 0) return res('partial', [...ev, ['detail', `${pages.length - ok} key page(s) failed`]]);
      return res('fail', [...ev, ['detail', 'all discovered key pages failed to load']]);
    },
  },

  /* ---------------- Usability ---------------- */
  {
    id: 'U1', cat: 'usability', sev: 'medium', title: 'Heading structure is clear',
    why: 'One h1 plus an ordered outline lets agents segment a page the way readers do.',
    run: async (ctx) => {
      const d = ctx.homeDom || (ctx.rendered && ctx.rendered.home);
      if (!d) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'homepage HTML not parsed']]);
      let skips = 0; let prev = 0;
      for (const h of d.headingSeq.slice(0, 60)) {
        const lvl = Number(h.tag[1]);
        if (prev && lvl > prev + 1) skips++;
        prev = lvl;
      }
      const ev = [['h1 count', String(d.h1Count)], ['outline (first entries)', rowlist(d.headingSeq.slice(0, 10).map((h) => `<${h.tag}> ${h.text.slice(0, 48)}`), 10)], ['level skips', String(skips)]];
      if (d.h1Count === 1 && skips === 0) return res('pass', ev);
      if (d.h1Count === 1 && skips <= 1) return res('partial', ev);
      if (d.h1Count >= 2 && d.h1Count <= 3) return res('partial', [...ev, ['detail', 'multiple h1 elements — level intent unclear']]);
      return res('fail', [...ev, ['detail', d.h1Count === 0 ? 'no h1 heading at all' : 'multiple h1 elements and/or broken outline']]);
    },
  },
  {
    id: 'U2', cat: 'usability', sev: 'medium', title: 'Semantic landmarks are used',
    why: 'main, nav and footer separate content from chrome; without them agents must guess which text matters.',
    run: async (ctx) => {
      const src = (ctx.rendered && ctx.rendered.home) || ctx.homeDom;
      if (!src || src.landmarks == null) return res('blocked', [['state', 'DOM landmarks unavailable (no HTML parsed, no render)']]);
      const l = src.landmarks;
      const ev = [['<main> / role=main', l.main ? 'present' : 'missing'], ['<nav> / role=navigation', l.nav ? 'present' : 'missing'], ['<footer>', l.footer ? 'present' : 'missing']];
      const n = ['main', 'nav', 'footer'].filter((k) => l[k]).length;
      if (n >= 3) return res('pass', ev);
      if (n === 2) return res('partial', ev);
      return res('fail', ev);
    },
  },
  {
    id: 'U3', cat: 'usability', sev: 'low', title: 'Images have alt text',
    why: 'Agents cannot see screenshots, diagrams or chart images — alt text is what they read.',
    run: async (ctx) => {
      const src = (ctx.rendered && ctx.rendered.home) || ctx.homeDom;
      if (!src || src.imgTotal == null) return res('blocked', [['state', 'image scan unavailable']]);
      const t = src.imgTotal;
      if (t === 0) return res('n/a', [['images', '0 on the tested page']]);
      const miss = src.imgMissingAlt;
      const pct = Math.round((miss / t) * 100);
      const ev = [['images', String(t)], ['missing alt/aria', String(miss)], ['coverage', `${100 - pct}%`]];
      if (src.missingAltSamples && miss) ev.push(['examples', rowlist(src.missingAltSamples.map((s) => `(src: ${(s.src || 'inline').slice(0, 70)}${s.src && s.src.length > 70 ? '…' : ''})`).slice(0, 6), 6)]);
      if (miss === 0) return res('pass', ev);
      if (pct <= 50) return res('partial', ev);
      return res('fail', [...ev, ['detail', `${pct}% of images carry no text that an agent can read`]]);
    },
  },
  {
    id: 'U4', cat: 'usability', sev: 'medium', title: 'Links have descriptive names',
    why: 'Agents choose links by their text; empty or icon-only anchors are dead ends in the link graph.',
    run: async (ctx) => {
      const src = (ctx.rendered && ctx.rendered.home) || ctx.homeDom;
      if (!src || !src.anchorCount) return res(src ? 'n/a' : 'blocked', [['anchors', '0 on the tested page']]);
      const t = src.anchorCount;
      const unnamedN = src.unnamedAnchors ?? 0;
      const pct = Math.round((unnamedN / t) * 100);
      const ev = [['anchors scanned', String(t)], ['without visible text or aria-label', String(unnamedN)]];
      if (pct <= 5) return res('pass', ev);
      if (pct <= 20) return res('partial', ev);
      return res('fail', [...ev, ['detail', `${pct}% of links have no text an agent can act on`]]);
    },
  },
  {
    id: 'U5', cat: 'usability', sev: 'medium', title: 'Buttons have accessible names',
    why: 'Icon-only buttons (hamburger, close, "→") cannot be reasoned about by text-only agents.',
    run: async (ctx) => {
      const src = (ctx.rendered && ctx.rendered.home) || ctx.homeDom;
      if (!src || !src.buttonsTotal) return res('n/a', [['buttons', 'none found on the tested page']]);
      const t = src.buttonsTotal, un = src.buttonsUnnamed;
      const pct = Math.round((un / t) * 100);
      const ev = [['buttons scanned', String(t)], ['without name', String(un)]];
      if (src.unnamedBufferSamples && un) ev.push(['examples', rowlist(src.unnamedBufferSamples.slice(0, 5).map((c) => `<button class="${clip(c, 60)}">`), 5)]);
      if (pct === 0) return res('pass', ev);
      if (pct <= 30) return res('partial', ev);
      return res('fail', [...ev, ['detail', `${pct}% of buttons are unnamed`]]);
    },
  },
  {
    id: 'U6', cat: 'usability', sev: 'medium', title: 'Form fields are labelled',
    why: 'Labelled fields are the only way an agent could ever (legitimately) assist with a form; placeholders alone are ambiguous.',
    run: async (ctx) => {
      const d = ctx.homeDom || (ctx.rendered && ctx.rendered.home);
      if (!d) return res(ctx.home && ctx.home.ok ? 'error' : 'blocked', [['state', 'homepage HTML not parsed']]);
      const forms = d.forms || [];
      if (!forms.length) return res('n/a', [['forms', 'none on the homepage']]);
      const unlabeled = forms.reduce((n, f) => n + f.unlabeled, 0);
      const total = forms.reduce((n, f) => n + f.fields.length, 0);
      const ev = [['forms', String(forms.length)], ['fields', String(total)], ['fields without label', String(unlabeled)], ['note', 'the auditor never fills or submits forms']];
      for (const f of forms.slice(0, 3)) ev.push([`form ${f.action || '(no action)'}`, `${f.fields.length} fields, ${f.unlabeled} unlabelled`]);
      if (unlabeled === 0) return res('pass', ev);
      if (unlabeled <= Math.max(1, Math.round(total * 0.2))) return res('partial', ev);
      return res('fail', ev);
    },
  },
  {
    id: 'U7', cat: 'usability', sev: 'high', title: 'Navigation uses real links',
    why: 'href="#" and click-handler-only "links" cannot be followed by a fetcher; only real anchors work for every agent class.',
    run: async (ctx) => {
      const src = (ctx.rendered && ctx.rendered.home) || ctx.homeDom;
      if (!src || src.navRealLinks == null) return res('blocked', [['state', 'navigation scan unavailable']]);
      const real = src.navRealLinks, pseudo = src.navPseudoLinks;
      const ev = [['real hrefs in nav areas', String(real)], ['href="#" / javascript:', String(pseudo)]];
      if (real === 0 && pseudo === 0) return res('n/a', [...ev, ['detail', 'no nav area with links found (see U2)']]);
      if (real >= 3 && pseudo === 0) return res('pass', ev);
      if (real >= 1 && pseudo <= Math.max(1, real)) return res('partial', [...ev, ['detail', 'some navigation entries are not followable links']]);
      return res('fail', [...ev, ['detail', 'navigation is mostly unfollowable for plain fetchers']]);
    },
  },
  {
    id: 'U8', cat: 'usability', sev: 'high', title: 'Agent task: locate signup',
    why: 'An agent helping a new customer must find the way to create an account. The task is followed with links only — never submitted.',
    run: async (ctx) => {
      const t = ctx.tasks && ctx.tasks.signup;
      if (!t) return res(ctx.browserOk() ? 'error' : 'blocked', [['state', ctx.browserOk() ? 'signup task did not run' : 'browser phase unavailable/challenge-blocked']]);
      const ev = t.evidenceRow();
      return res(t.status, ev, { note: t.note });
    },
  },
  {
    id: 'U9', cat: 'usability', sev: 'medium', title: 'Agent task: locate docs or help',
    why: 'Agents answer "how do I…" questions from your docs. If they cannot find them, they answer from guesses.',
    run: async (ctx) => {
      const t = ctx.tasks && ctx.tasks.docs;
      if (!t) return res(ctx.browserOk() ? 'error' : 'blocked', [['state', 'docs task did not run']]);
      if (t.status === 'fail' && t.notApplicableReason) return res('n/a', t.evidenceRow());
      const ev = t.evidenceRow();
      return res(t.status, ev, { note: t.note });
    },
  },

  /* ---------------- Payments ---------------- */
  {
    id: 'P1', cat: 'payments', sev: 'critical', title: 'Agent task: find pricing',
    why: 'The most commonly delegated commercial question. If a link-following agent cannot reach pricing, it cannot answer it.',
    run: async (ctx) => {
      const t = ctx.tasks && ctx.tasks.pricing;
      if (!t) return res(ctx.browserOk() ? 'error' : 'blocked', [['state', 'pricing task did not run']]);
      if (t.status === 'fail' && t.notApplicableReason) return res('n/a', t.evidenceRow());
      const ev = t.evidenceRow();
      return res(t.status, ev, { note: t.note });
    },
  },
  {
    id: 'P2', cat: 'payments', sev: 'high', title: 'Agent task: extract plan details',
    why: 'Price, currency period and plan names as plain text — half the value of a pricing page for an agent.',
    run: async (ctx) => {
      const t = ctx.tasks && ctx.tasks.plans;
      if (!t) return res(ctx.browserOk() ? 'error' : 'blocked', [['state', 'plan extraction task did not run']]);
      if (t.status === 'na' || t.status === 'n/a') return res('n/a', t.evidenceRow());
      const ev = t.evidenceRow();
      return res(t.status, ev, { note: t.note });
    },
  },
  {
    id: 'P3', cat: 'payments', sev: 'high', title: 'Prices present in the initial HTML',
    why: 'Plan prices must exist in the server HTML; JavaScript-injected prices are missed by every fetch-only agent.',
    run: async (ctx) => {
      const tasks = ctx.tasks || {};
      const pricingUrl = ctx.pricingUrl;
      const p = ctx.rawKeyPages && ctx.rawKeyPages.find((p) => p.label === 'pricing');
      if (!pricingUrl) return res('n/a', [['reason', 'no pricing page found (see P1)']]);
      if (!p) return res(tasks.pricing && tasks.pricing.status === 'blocked' ? 'blocked' : 'error', [['state', tasks.pricing && tasks.pricing.status === 'blocked' ? 'pricing raw fetch skipped — robots disallow' : 'pricing page fetch unavailable']]);
      const plans = tasks.plans || {}; void plans;
      const ev = [['pricing page', pricingUrl], ['http status', String(p.status)], ['plan prices expected', rowlist((ctx.planPriceRequests || []), 8)]];
      const matched = ctx.p3 || {};
      ev.push(['found in raw HTML', rowlist(matched.found || [], 8)]);
      ev.push(['missing from raw HTML', rowlist(matched.missing || [], 8)]);
      if (!matched.renders) return res('partial', [...ev, ['detail', 'plan prices extracted from rendered page; raw comparison inconclusive']]);
      const nf = (matched.missing || []).length, f = (matched.found || []).length;
      if (!f && !nf) return res('n/a', [...ev, ['detail', 'no plan prices were extracted to compare']]);
      if (f && !nf) return res('pass', ev);
      if (f && nf) return res('partial', [...ev, ['detail', `${f} of ${f + nf} plan prices exist in the server HTML`]]);
      return res('fail', [...ev, ['detail', 'none of the plan prices exist in the server HTML — prices are injected by JavaScript']]);
    },
  },
  {
    id: 'P4', cat: 'payments', sev: 'medium', title: 'Offers described with structured data',
    why: 'schema.org Product/Offer markup states price, currency and availability without layout parsing.',
    run: async (ctx) => {
      if (!ctx.pricingUrl) return res('n/a', [['reason', 'no pricing page found (see P1)']]);
      const p = (ctx.rendKeyPages || []).find((p) => p.label === 'pricing');
      const raw = (ctx.rawKeyPages || []).find((p) => p.label === 'pricing');
      const dom = (p && p.snapshot) || null;
      if (!dom) return res('blocked', [['state', 'pricing page DOM unavailable for structured-data scan']]);
      const ld = dom.jsonLd || [];
      void raw;
      const types = [];
      let offerish = 0;
      let priced = 0;
      const pricedExamples = [];
      const jsonTypes = ld.flatMap((b) => (b && b.ok ? [b] : []));
      jsonTypes.forEach((b) => {
        const t = b.type || '';
        types.push(t);
        if (/offer|product|service|offercatalog|pricespecification/i.test(t)) {
          offerish++;
          if (hasPrice(b.data)) {
            priced++;
            if (pricedExamples.length < 6) pricedExamples.push(searchPrice(b.data));
          }
        }
      });
      const ev = [['ld+json blocks on pricing', String(ld.length)], ['types', rowlist(types, 10)], ['offer-like types', String(offerish)], ['priced offers', String(priced)], ['priced examples', rowlist(pricedExamples, 6)]];
      if (priced > 0) return res('pass', ev);
      if (offerish > 0) return res('partial', [...ev, ['detail', 'Product/Offer types present but without machine-readable price fields']]);
      return res('fail', [...ev, ['detail', 'no offer / product / price structured data on the pricing page (JSON-LD only — microdata/RDFa not parsed)']]);
    },
  },
  {
    id: 'P5', cat: 'payments', sev: 'critical', title: 'Agent task: reach the checkout interface',
    why: 'Following plan CTAs to checkout is the end of the purchase journey. The auditor stops as soon as a payment interface loads and enters nothing.',
    run: async (ctx) => {
      const t = ctx.tasks && ctx.tasks.checkout;
      if (!t) return res(ctx.browserOk() ? 'error' : 'blocked', [['state', 'checkout task did not run']]);
      if (t.status === 'fail' && t.notApplicableReason) return res('n/a', t.evidenceRow());
      const ev = t.evidenceRow();
      return res(t.status, ev, { note: t.note });
    },
  },
  {
    id: 'P6', cat: 'payments', sev: 'high', title: 'Plan CTAs are real links',
    why: 'Script-only buy buttons ("Upgrade" with an onclick handler) cannot be followed by fetchers — and never appear in the link graph.',
    run: async (ctx) => {
      if (!ctx.pricingUrl) return res('n/a', [['reason', 'no pricing page found (see P1)']]);
      const pg = (ctx.rendKeyPages || []).find((p) => p.label === 'pricing');
      if (!pg || !pg.snapshot) return res('blocked', [['state', 'rendered pricing page unavailable for CTA scan']]);
      const ctas = ctx.pricingCtas || { anchors: 0, scripts: 0, samples: [] };
      const ev = [['plan CTAs scanned', String(ctas.anchors + ctas.scripts)], ['real <a href> links', String(ctas.anchors)], ['script-only buttons', String(ctas.scripts)], ['cta texts', rowlist(ctas.samples, 8)]];
      if (ctas.anchors + ctas.scripts === 0) return res('n/a', [...ev, ['detail', 'no plan CTAs found on the pricing page']]);
      if (ctas.anchors > 0 && ctas.scripts === 0) return res('pass', ev);
      if (ctas.anchors > 0) return res('partial', [...ev, ['detail', 'some plan CTAs render as followable links, others do not']]);
      return res('fail', [...ev, ['detail', 'plan CTAs are not followable links at all']]);
    },
  },
];

function hasPrice(json) {
  let n = 0;
  const walk = (x, depth = 0) => {
    if (!x || typeof x !== 'object' || depth > 6 || n > 12) return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, depth + 1)); return; }
    if (typeof x.price === 'number' && x.price > 0) n++;
    else if (typeof x.price === 'string' && /\d/.test(x.price)) n++;
    if (x.lowPrice != null || x.highPrice != null) n++;
    if (x.priceCurrency || x.offers) walk(x.offers, depth + 1);
    for (const k of Object.keys(x)) if (k !== '@graph' && x[k] && typeof x[k] === 'object') walk(x[k], depth + 1);
  };
  walk(json);
  return n > 0;
}

function searchPrice(json) {
  const found = [];
  const walk = (x, depth = 0) => {
    if (!x || typeof x !== 'object' || depth > 6 || found.length > 4) return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, depth + 1)); return; }
    if (x.price != null && found.length < 4) {
      found.push(`${x.price != null ? String(x.price) : '?'}${x.priceCurrency ? ' ' + x.priceCurrency : ''}`.trim());
    }
    for (const k of Object.keys(x)) if (typeof x[k] === 'object') walk(x[k], depth + 1);
  };
  walk(json);
  return found.join('; ');
}

export const CHECKS_BY_ID = Object.fromEntries(CHECKS.map((c) => [c.id, c]));
