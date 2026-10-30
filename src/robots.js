/**
 * Small, focused robots.txt parser (RFC 9309-style subset):
 *  - groups by User-agent tokens (exact token match wins over `*`)
 *  - rules: Allow / Disallow with `*` wildcards and trailing `$`
 *  - longest path wins; on a tie, Allow wins
 *  - captures Sitemap: lines and Crawl-delay (informational)
 */

const RETRIEVAL_AGENTS = [
  'chatgpt-user', 'oai-searchbot', 'claude-user', 'claude-searchbot', 'claudebot',
  'perplexity-user', 'perplexitybot', 'applebot-extended', 'googlebot', 'bingbot',
];
const TRAINING_AGENTS = ['gptbot', 'ccbot', 'google-extended', 'bytespider', 'anthropic-ai', 'applebot-extended', 'imagesift', 'omgilibot', 'omgili', 'diffbot', 'meta-externalagent', 'amazonbot'];

export { RETRIEVAL_AGENTS, TRAINING_AGENTS };

export const KNOWN_AI_AGENTS = [...new Set([...RETRIEVAL_AGENTS, ...TRAINING_AGENTS])];

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;

  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const hash = line.indexOf('#');
    if (hash !== -1) line = line.slice(0, hash);
    line = line.trim();
    if (!line) { lastWasAgent = false; continue; }
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const field = line.slice(0, ci).trim().toLowerCase();
    let value = line.slice(ci + 1).trim();

    if (field === 'user-agent') {
      const tokens = value.toLowerCase().split(/[\s,]+/).filter(Boolean);
      for (const t of tokens) {
        let g = groups.find((x) => x.agent === t);
        if (!g) { g = { agent: t, allow: [], disallow: [], crawlDelay: null }; groups.push(g); }
        if (current !== g) { current = g; }
      }
      lastWasAgent = true;
      continue;
    }

    if (!current) continue;
    if (!lastWasAgent && field !== 'allow' && field !== 'disallow' && field !== 'sitemap' && field !== 'crawl-delay') {
      // rule fields attach to most recent group anyway
    }

    if (field === 'allow' || field === 'disallow') {
      if (value === '') {
        if (field === 'disallow') { /* empty disallow = allow everything */ }
        continue;
      }
      const rx = pathToRegex(value);
      if (rx) (field === 'allow' ? current.allow : current.disallow).push(rx);
    } else if (field === 'sitemap') {
      if (sitemaps.length < 20) sitemaps.push(value);
    } else if (field === 'crawl-delay') {
      const n = parseFloat(value);
      if (Number.isFinite(n) && current.crawlDelay == null) current.crawlDelay = n;
    }
  }

  function pathToRegex(p) {
    if (!p) return null;
    let rx = '';
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === '*') rx += '.*';
      else if (ch === '$') { rx += '$'; }
      else rx += ch.replace(/[.+?^{}()|[\]\\]/g, '\\$&');
    }
    try { return new RegExp('^(?:' + rx + ')', 'i'); } catch { return null; }
  }

  return { groups, sitemaps, ok: groups.length > 0 || sitemaps.length > 0 };
}

function groupFor(parsed, uaToken) {
  const ua = String(uaToken || '').toLowerCase();
  // exact token match
  const direct = parsed.groups.filter((g) => g.agent !== '*' && (ua === g.agent || ua.startsWith(g.agent + '/')));
  if (direct.length) return direct;
  const star = parsed.groups.filter((g) => g.agent === '*');
  return star;
}

function bestRule(rules, path) {
  let best = null;
  for (const { allow, rx } of rules) {
    if (rx.test(path)) {
      const len = rx.source.length;
      if (!best || len > best.len) best = { allow, rx, len };
      else if (len === best.len && allow && !best.allow) best = { allow, rx, len };
    }
  }
  return best;
}

export function isAllowed(parsed, uaToken, url) {
  let path;
  try { path = new URL(url).pathname + (new URL(url).search || ''); } catch { return true; }
  const groups = groupFor(parsed, uaToken);
  if (!groups.length) return true; // no applicable group
  const rules = [];
  for (const g of groups) {
    for (const rx of g.allow) rules.push({ allow: true, rx });
    for (const rx of g.disallow) rules.push({ allow: false, rx });
  }
  if (!rules.length) return true;
  const best = bestRule(rules, path);
  if (!best) return true;
  return best.allow;
}

/** Evaluate a specific named crawler against every robots group. */
export function agentVerdict(parsed, uaToken, urls = []) {
  const groups = groupFor(parsed, uaToken);
  if (!groups.length) {
    return { mentioned: false, applies: false, allowedAll: true, blocked: [] };
  }
  const blocked = [];
  for (const u of urls) {
    if (!isAllowed(parsed, uaToken, u)) blocked.push(u);
  }
  return { mentioned: true, applies: true, allowedAll: blocked.length === 0, blocked };
}
