/*
 * scoring.js — turns raw check results into the public report shape.
 *
 * The model published on the landing page, implemented exactly:
 *   credit        pass = 1 · partial = 0.5 · fail = 0
 *   weight        critical 5 · high 3 · medium 2 · low 1
 *   category      Σ(weight × credit) ÷ Σ(weight of evaluated checks)
 *   overall       mean of category scores that have ≥1 evaluated check
 *   coverage      tested weight ÷ applicable weight
 *
 * Statuses that carry no credit (blocked / inconclusive / error / n/a) are
 * never counted as failures; they are reported under "not established"
 * (blocked etc.) or excluded entirely (n/a).
 */
import { config } from './config.js';
import { WEIGHTS } from './checks.js';
import { describeFinding } from './findings.js';

export { WEIGHTS };

export const CATEGORIES = [
  { id: 'discovery', name: 'Discovery', q: 'Can agents find your important pages, docs, products and pricing?' },
  { id: 'access', name: 'Access', q: 'Can agents actually retrieve the information?' },
  { id: 'usability', name: 'Usability', q: 'Can agents understand pages and navigate key workflows?' },
  { id: 'payments', name: 'Payments', q: 'Can agents find pricing, understand plans and reach checkout?' },
];

export const CREDIT = { pass: 1, partial: 0.5 };
export const STATUS_LABEL = {
  pass: 'Pass', partial: 'Partial', fail: 'Fail',
  blocked: 'Blocked', inconclusive: 'Inconclusive', error: 'Error', 'n/a': 'N/A',
};
export const OPEN_STATUSES = ['blocked', 'inconclusive', 'error'];

function gradeFor(score) {
  if (score == null) return { grade: 'Not established', glyph: 'fog' };
  if (score >= 90) return { grade: 'Clear skies' };
  if (score >= 75) return { grade: 'Mostly clear' };
  if (score >= 60) return { grade: 'Partly cloudy' };
  if (score >= 40) return { grade: 'Mostly cloudy' };
  if (score >= 22) return { grade: 'Cloudy' };
  return { grade: 'Overcast' };
}

function proofRound(n) {
  return n == null ? null : Math.round(n);
}

/** Build the report consumed by the dashboard UI, REST API and MCP tools. */
export function buildReport({ id, url, origin, host, startedAt, finishedAt, ctx, results, checks }) {
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const resultById = new Map(results.map((r) => [r.id, r]));

  /* ---------- categories ---------- */
  const categories = CATEGORIES.map((cat) => {
    const checksInCat = results.filter((r) => r.cat === cat.id);
    let creditSum = 0;
    let evaluated = 0;           // denominator weight
    let applicableWinner = 0;    // everything except n/a (coverage denominator)
    const counts = { pass: 0, partial: 0, fail: 0, blocked: 0, inconclusive: 0, error: 0, 'n/a': 0 };
    for (const c of checksInCat) {
      const w = WEIGHTS[c.sev] ?? 1;
      counts[c.status] = (counts[c.status] || 0) + 1;
      if (c.status === 'pass' || c.status === 'partial' || c.status === 'fail') {
        creditSum += w * (CREDIT[c.status] ?? 0);
        evaluated += w;
      } else if (c.status !== 'n/a') {
        applicableWinner += w;
      }
    }
    const score = evaluated > 0 ? Math.round((creditSum / evaluated) * 100) : null;
    return {
      id: cat.id,
      name: cat.name,
      q: cat.q,
      score,
      counts,
      evaluatedWeight: evaluated,
      openWeight: applicableWinner,
      checks: checksInCat.map((c) => ({
        id: c.id, title: c.title, sev: c.sev, status: c.status,
        evidence: c.evidence || [], note: c.note || null,
      })),
    };
  });

  const catsWithScore = categories.filter((c) => c.score != null);
  const overall = catsWithScore.length
    ? Math.round(catsWithScore.reduce((n, c) => n + c.score, 0) / catsWithScore.length)
    : null;
  const { grade } = gradeFor(overall);

  /* ---------- coverage ---------- */
  let testedWeight = 0;
  let applicableWeight = 0;      // not n/a
  let totalWeight = 0;
  const openCounts = { pass: 0, partial: 0, fail: 0, open: 0, 'n/a': 0 };
  for (const c of results) {
    const w = WEIGHTS[c.sev] ?? 1;
    totalWeight += w;
    if (c.status === 'n/a') { openCounts['n/a']++; continue; }
    applicableWeight += w;
    if (c.status === 'pass' || c.status === 'partial' || c.status === 'fail') { testedWeight += w; openCounts[c.status]++; }
    else openCounts.open++;
  }
  const coverage = {
    pct: applicableWeight > 0 ? Math.round((testedWeight / applicableWeight) * 100) : 0,
    testedWeight,
    applicableWeight,
    totalWeight,
    counts: openCounts,
    byCategory: Object.fromEntries(categories.map((c) => {
      let t = 0, a = 0;
      for (const ck of c.checks) {
        const w = WEIGHTS[ck.sev] ?? 1;
        if (ck.status === 'n/a') continue;
        a += w;
        if (ck.status === 'pass' || ck.status === 'partial' || ck.status === 'fail') t += w;
      }
      return [c.id, a ? Math.round((t / a) * 100) : null];
    })),
  };

  /* ---------- findings (failures + partials, ordered by severity × status) ---------- */
  const failing = results.filter((r) => r.status === 'fail' || r.status === 'partial');
  failing.sort((x, y) => (sevRank[x.sev] ?? 9) - (sevRank[y.sev] ?? 9) || (x.status === 'fail' ? -1 : y.status === 'fail' ? 1 : 0));
  const findings = failing.map((r) => {
    const def = checks[r.id] || {};
    const d = describeFinding(r.id, { evidence: r.evidence || [], note: r.note });
    return {
      id: r.id,
      cat: r.cat, catName: (CATEGORIES.find((c) => c.id === r.cat) || {}).name || r.cat,
      sev: r.sev,
      status: r.status,
      title: def.title || d.title,
      summary: d.summary,
      evidence: r.evidence || [],
      problem: d.problem,
      impact: d.impact,
      fix: d.fix,
      acceptance: d.ac,
      verify: d.verify,
      weight: WEIGHTS[r.sev] ?? 1,
    };
  });

  /* ---------- open items (blocked / inconclusive / error) ---------- */
  const open = results
    .filter((r) => OPEN_STATUSES.includes(r.status))
    .map((r) => ({
      id: r.id, cat: r.cat, sev: r.sev, status: r.status,
      title: (checks[r.id] || {}).title || r.id,
      detail: (r.evidence || []).filter(([k]) => ['state', 'detail', 'fetch', 'reason', 'agent fetch'].includes(k)).map(([, v]) => v).join(' · ') || r.note || 'no evidence recorded',
    }));

  /* ---------- agent tasks summary for the journey panel ---------- */
  const tasks = {};
  for (const key of ['pricing', 'plans', 'signup', 'checkout', 'docs']) {
    const t = ctx.tasks && ctx.tasks[key];
    tasks[key] = {
      status: t ? t.status : 'missing',
      finalUrl: (t && t.finalUrl) || null,
      steps: (t && t.steps) || [],
    };
  }

  /* ---------- stats ---------- */
  const stats = {
    pagesFetched: (ctx.crawlPages || []).length,
    pages: (ctx.crawlPages || []).slice(0, 24).map((p) => ({ url: p.url, status: p.status ?? null, ms: p.ms ?? null })),
    crawlStopped: (ctx.crawl || {}).stopped || null,
    keyPages: Object.fromEntries((ctx.rawKeyPages || []).map((p) => [p.label, { url: p.url, status: p.blocked ? 'blocked' : p.status, ok: !!p.ok }])),
    sitemap: (ctx.sitemap && { found: ctx.sitemap.found, url: ctx.sitemap.url, urlCount: ctx.sitemap.urlCount, source: ctx.sitemap.source }) || null,
    llmsTxt: (ctx.llms && { ok: !!ctx.llms.ok, status: ctx.llms.status || null, bytes: ctx.llms.bytes || 0 }) || null,
    robots: (ctx.robots && { fetched: !!ctx.robots.fetched, httpStatus: ctx.robots.httpStatus ?? null, groupCount: ctx.robots.groupCount ?? 0, sitemaps: (ctx.robots.sitemaps || []).length }) || null,
    browser: {
      ran: !!ctx.browser && !!ctx.browser.ok,
      unavailable: !!ctx.browserUnavailable,
      reason: (ctx.browser && !ctx.browser.ok && ctx.browser.reason) || null,
      requests: (ctx.browser && ctx.browser.requests) || 0,
      blockedRequests: ctx.blockedRequests || 0,
    },
    challengeOnHomepage: !!(ctx.browserChallenge),
    soft404: (ctx.soft404 && (ctx.soft404.blocked ? { blocked: true } : { status: ctx.soft404.status ?? null, is404: !!ctx.soft404.is404, ok: !!ctx.soft404.ok })) || null,
  };

  /* ---------- agent (robots) verdicts for the docs/agents panel ---------- */
  const agents = [];
  for (const [ua, v] of Object.entries(ctx.robotsRetrievalVerdicts || {})) {
    agents.push({ agent: ua, allowed: v.allowedAll, blocked: v.blocked || [], mentioned: v.mentioned !== false, group: 'retrieval' });
  }
  for (const [ua, v] of Object.entries(ctx.robotsTrainingVerdicts || {})) {
    agents.push({ agent: ua, allowed: v.allowedAll, blocked: v.blocked || [], mentioned: v.mentioned !== false, group: 'training' });
  }

  /* ---------- verdict copy ---------- */
  const verdict = verdictText({ overall, categories, findings, stats, coverage });

  return {
    meta: {
      id,
      url, origin, host,
      startedAt, finishedAt,
      durationMs: finishedAt - startedAt,
      auditor: { name: config.brand.name, version: config.brand.version, license: 'MIT', ua: config.userAgentAudit },
    },
    status: 'complete',
    score: { overall, grade },
    coverage,
    categories,
    findings,
    open,
    journey: ctx.journey || [],
    tasks,
    stats,
    agents,
    nonCommercial: !!ctx.nonCommercial,
  };
}

function verdictText({ overall, categories, findings, stats, coverage }) {
  if (overall == null) {
    return 'The audit could not establish a score — most checks did not run. Check connectivity or robots policy and try again.';
  }
  const scoredCats = categories.filter((c) => c.score != null);
  const weakest = scoredCats.filter((c) => c.score < 50).sort((a, b) => a.score - b.score);
  const strongest = scoredCats.filter((c) => c.score >= 85).sort((a, b) => b.score - a.score);
  const criticalBlocked = findings.filter((f) => f.sev === 'critical' && f.status === 'fail');
  const parts = [];
  if (criticalBlocked.length) {
    parts.push(`Critical blockers: ${criticalBlocked.slice(0, 3).map((f) => f.title.toLowerCase()).join('; ')}.`);
  } else if (weakest.length) {
    parts.push(`The weak stretch is ${weakest.map((c) => c.name.toLowerCase()).join(' and ')} (${weakest.map((c) => c.score + '/100').join(', ')}).`);
  } else {
    parts.push('No category scored under 50 — the basics are solid.');
  }
  if (strongest.length) {
    parts.push(`${strongest.map((c) => c.name).join(' and ')} came through clearest.`);
  }
  if (stats.browser.unavailable) {
    parts.push('Note: the rendered-browser phase could not run, so task checks were not established.');
  }
  if (stats.challengeOnHomepage) {
    parts.push('A bot challenge was presented to the rendered-browser visit.');
  }
  if (coverage && coverage.pct < 60) {
    parts.push(`Coverage was ${coverage.pct}% — treat as preliminary.`);
  }
  return parts.join(' ');
}
