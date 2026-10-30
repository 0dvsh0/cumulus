/*
 * report.js — live progress + dashboard for /report/:id
 *
 * Flow: GET /api/v1/audits/:id →
 *   running  → subscribe SSE /audits/:id/events, animate progress, then rerender
 *   complete → render dashboard from the report object
 *   failed   → show the error panel
 */
import { $, $$, esc, md, boot, fmtDate, ago, ICONS } from './common.js';
import { scoreOrbSVG, animateOrb, sparkSVG } from './visuals.js';

const AUDIT_ID_RX = /^a[0-9a-f]{12}$/;
const STAGES = [
  ['Preparing audit', 'setup'],
  ['Reading robots.txt', 'robots'],
  ['Fetching homepage', 'home'],
  ['Extracting structure', 'static'],
  ['Crawling key pages', 'crawl'],
  ['Probing key pages', 'keys'],
  ['Rendering pages + agent tasks', 'browser'],
  ['Computing score', 'score'],
];

const id = (() => {
  const m = decodeURIComponent(location.pathname).match(/\/report\/([a-z0-9]+)/i);
  if (m && AUDIT_ID_RX.test(m[1])) return m[1];
  const q = new URLSearchParams(location.search).get('id');
  if (q && AUDIT_ID_RX.test(q)) return q;
  if (q === 'sample' || !m) return 'sample';
  showNotFound();
  return null;
})();

const CAT_LABEL = { discovery: 'Discovery', access: 'Access', usability: 'Usability', payments: 'Payments' };
const URL_KEYS = ['url', 'final url', 'pricing page', 'sitemap url', 'canonical'];
let apiBase = '';

boot();

let rec = null;
let meta = null;
let report = null;
let startedNow = Date.now();

if (id) fetchOnce();

async function fetchOnce() {
  let data;
  if (id === 'sample') {
    try {
      const res = await fetch('data/sample-report.json');
      if (!res.ok) throw new Error('Sample report not found');
      data = await res.json();
    } catch (err) {
      console.error('Error fetching sample data:', err);
      return showError('Could not load sample audit data.');
    }
  } else {
    try {
      const res = await fetch(`/api/v1/audits/${id}`, { headers: { accept: 'application/json' } });
      if (res.status === 404) return showNotFound();
      data = await res.json();
    } catch (err) {
      try {
        const fallback = await fetch('data/sample-report.json');
        if (fallback.ok) data = await fallback.json();
        else throw err;
      } catch {
        console.error('Network error fetching audit data:', err);
        return showError('Could not reach the Cumulus API — is the server running?');
      }
    }
  }

  try {
    rec = data;
    report = data.report || null;
    meta = data;
    if (data.status === 'running') showProgress();
    else if (data.status === 'complete' && report) renderReport();
    else showError(data.error || `Audit ${data.status || 'did not complete'}.`);
  } catch (err) {
    console.error('Error rendering audit report:', err);
    showError(err && err.message ? `Render error: ${err.message}` : 'The audit report could not be displayed.');
  }
}

/* ================================================================
 * progress
 * ================================================================ */

function showProgress() {
  $('#progress-wrap').hidden = false;
  $('#error-wrap').hidden = true;
  $('#report-top').hidden = true;
  $('#cats-wrap').hidden = true;
  $('#dashboard').hidden = true;
  document.title = `Cumulus — auditing ${new URL(rec.url).hostname}`;

  $('#p-target').textContent = rec.url;
  $('#p-id').textContent = rec.id;
  renderSteps(rec.stage, rec.pct);
  paintLogs(rec.logs || []);
  startTicker();
  openStream();
}

let ticker = null;
function startTicker() {
  if (ticker) clearInterval(ticker);
  const t0 = rec.startedAt || Date.now();
  const el = $('#p-elapsed');
  ticker = setInterval(() => {
    const s = Math.max(0, Math.round((Date.now() - t0) / 1000));
    el.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }, 1000);
}

function renderSteps(activeLabel, pct) {
  const ol = $('#p-steps');
  ol.innerHTML = STAGES.map(([label]) => `<li><span class="dot"></span>${esc(label)}</li>`).join('');
  const idx = STAGES.findIndex(([l]) => l === activeLabel);
  [...ol.children].forEach((li, i) => {
    if (idx === -1) { if (i > 0 && pct > 95) li.classList.add('done'); return; }
    if (i < idx) li.classList.add('done');
    if (i === idx) li.classList.add('active');
  });
  $('#p-bar').style.width = `${Math.max(2, pct || 0)}%`;
}

function paintLogs(logs) {
  const box = $('#p-log');
  box.innerHTML = logs.map((l) => `<div><span class="t">${esc(l.t)}</span>${esc(l.msg)}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}

function pushLogTo(log) {
  if (!log) return;
  const box = $('#p-log');
  box.insertAdjacentHTML('beforeend', `<div><span class="t">${esc(log.t)}</span>${esc(log.msg)}</div>`);
  box.scrollTop = box.scrollHeight;
}

function openStream() {
  let es = null;
  let lastEvent = Date.now();
  try {
    es = new EventSource(`/api/v1/audits/${id}/events`);
  } catch {
    startPolling();
    return;
  }
  es.addEventListener('progress', (ev) => {
    lastEvent = Date.now();
    let msg = {};
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.stage) renderSteps(msg.stage, msg.pct);
    if (typeof msg.pct === 'number') $('#p-bar').style.width = `${Math.max(2, msg.pct)}%`;
    if (msg.log) pushLogTo(msg.log);
    if (msg.logs && Array.isArray(msg.logs)) {
      const box = $('#p-log');
      if (!box.children.length) paintLogs(msg.logs);
    }
  });
  es.addEventListener('done', () => {
    es.close();
    es = null;
    fetchOnce();
  });
  es.onerror = () => {
    // network blip or final close; switch to resilient polling
    es.close();
    es = null;
    startPolling();
  };

  function startPolling() {
    if (pollHandle) return;
    pollHandle = setInterval(async () => {
      if (Date.now() - lastEvent < 6000) return;
      try {
        const res = await fetch(`/api/v1/audits/${id}`);
        if (res.status === 404) { clearInterval(pollHandle); pollHandle = null; return showNotFound(); }
        const data = await res.json();
        if (data.pct != null && data.stage) renderSteps(data.stage, data.pct);
        if (data.status !== 'running') { clearInterval(pollHandle); pollHandle = null; fetchOnce(); }
      } catch { /* server hiccup; keep polling */ }
    }, 2500);
  }
}
let pollHandle = null;

/* ================================================================
 * dashboard render
 * ================================================================ */

function showNotFound() {
  hideAll();
  $('#error-wrap').hidden = false;
  $('#error-msg').textContent = 'This audit id does not exist (or was pruned). Run a new audit from the landing page.';
  $('#error-retry').hidden = true;
}

function showError(msg) {
  hideAll();
  $('#progress-wrap').hidden = true;
  $('#error-wrap').hidden = false;
  $('#error-msg').textContent = typeof msg === 'string' ? msg : 'The audit could not be completed.';
  if (rec && rec.id) {
    $('#error-retry').href = `/report/${rec.id}`;
    $('#error-retry').hidden = false;
  }
}

function hideAll() {
  $('#progress-wrap').hidden = true;
  $('#report-top').hidden = true;
  $('#cats-wrap').hidden = true;
  $('#dashboard').hidden = true;
}

function weightOf(sev) {
  return { critical: 5, high: 3, medium: 2, low: 1 }[sev] || 1;
}

function renderReport() {
  hideAll();
  if (ticker) { clearInterval(ticker); ticker = null; }

  document.title = `Cumulus — ${new URL(meta.url).hostname} scored ${report.score.overall ?? 'n/a'}/100`;

  /* ---- hero ---- */
  $('#report-top').hidden = false;
  $('#crumbs-host').textContent = report.meta.host;
  $('#crumbs-id').textContent = meta.id;
  const hostEl = $('#site-host');
  hostEl.textContent = report.meta.origin;
  hostEl.href = report.meta.origin;

  const orbEl = $('#orb');
  orbEl.querySelectorAll('svg').forEach((s) => s.remove());
  orbEl.insertAdjacentHTML('afterbegin', scoreOrbSVG(report.score.overall, report.coverage.pct / 100));
  $('#orb-num').textContent = report.score.overall ?? '–';
  $('#orb-grade').textContent = report.score.grade;
  $('#orb-cov').textContent = `${report.coverage.pct}% coverage`;
  animateOrb(orbEl);

  const dur = Math.round((report.meta.durationMs || 0) / 1000);
  $('#meta-sub').innerHTML = [
    fmtDate(report.meta.startedAt),
    `${dur}s wall clock`,
    `${report.stats.pagesFetched} page(s) crawled`,
    report.stats.browser.ran ? 'rendered in Chromium' : 'browser phase skipped',
  ].map((s) => `<span>${esc(s)}</span>`).join('');

  $('#verdict').textContent = verdictText();

  /* ---- coverage bar ---- */
  const mix = statusWeights(report);
  const bar = $('#cov-bar');
  const segments = [
    ['var(--pass)', mix.pass],
    ['var(--warn)', mix.partial],
    ['var(--fail)', mix.fail],
    ['var(--open)', mix.open + mix.na],
  ];
  bar.innerHTML = segments.map(([color, w]) => w ? `<i style="width:${((w / mix.total) * 100).toFixed(1)}%;background:${color}"></i>` : '').join('');
  $('#cov-label').textContent = `${report.coverage.pct}% of applicable weight tested`;
  $('#cov-keys').innerHTML = [
    `<span style="color:var(--pass)">Pass ${report.coverage.counts.pass}</span>`,
    `<span style="color:var(--warn)">Partial ${report.coverage.counts.partial}</span>`,
    `<span style="color:var(--fail)">Fail ${report.coverage.counts.fail}</span>`,
    `<span style="color:var(--open)">Not established ${report.coverage.counts.open}</span>`,
    `<span>N/A ${report.coverage.counts['n/a']} (excluded)</span>`,
  ].join('');

  /* ---- buttons ---- */
  apiBase = `/api/v1/audits/${meta.id}`;
  $('#fixkit-btn').href = `${apiBase}/fix-kit`;
  $('#fixkit-side').href = `${apiBase}/fix-kit`;
  $('#json-btn').href = id === 'sample' ? 'data/sample-report.json' : apiBase;
  $('#findings-api').href = `${apiBase}/findings`;
  $('#rerun-btn').addEventListener('click', (e) => { e.preventDefault(); rerun(); });

  renderCats();
  renderFindings();
  renderChecks();
  renderJourney();
  renderAgents();
  renderFacts();
  renderHistory();
  renderPages();

  $('#cats-wrap').hidden = false;
  $('#dashboard').hidden = false;
  $('#error-wrap').hidden = true;
  $('#progress-wrap').hidden = true;
  requestAnimationFrame(animateMeters);
}

function verdictText() {
  return report.meta.verdict || reportCVerdict();
}

function reportCVerdict() {
  const scored = report.categories.filter((c) => c.score != null);
  const weak = scored.filter((c) => c.score < 50).sort((a, b) => a.score - b.score);
  const strong = scored.filter((c) => c.score >= 85).sort((a, b) => b.score - a.score);
  const crit = report.findings.filter((f) => f.sev === 'critical' && f.status === 'fail');
  const parts = [];
  if (crit.length) parts.push(`Critical blockers: ${crit.slice(0, 3).map((f) => f.title.toLowerCase()).join('; ')}.`);
  else if (weak.length) parts.push(`The weak stretch is ${weak.map((c) => c.name.toLowerCase()).join(' and ')} (${weak.map((c) => c.score + '/100').join(', ')}).`);
  else parts.push('No category scored under 50 — the basics are solid.');
  if (strong.length) parts.push(`${strong.map((c) => c.name).join(' and ')} came through clearest.`);
  return parts.join(' ');
}

function statusWeights(r) {
  const acc = { pass: 0, partial: 0, fail: 0, open: 0, na: 0, total: 0 };
  for (const cat of r.categories) {
    for (const ck of cat.checks) {
      const w = weightOf(ck.sev);
      acc.total += w;
      if (ck.status === 'n/a') acc.na += w;
      else if (ck.status === 'pass') acc.pass += w;
      else if (ck.status === 'partial') acc.partial += w;
      else if (ck.status === 'fail') acc.fail += w;
      else acc.open += w;
    }
  }
  return acc;
}

/* ---- categories ---- */

const prev = () => (Array.isArray(meta.history) && meta.history[0]) || null;

function deltaFor(catId) {
  const p = prev();
  if (!p || !p.categories || !(catId in p.categories)) return null;
  const nowSc = report.categories.find((c) => c.id === catId);
  if (!nowSc || nowSc.score == null || p.categories[catId] == null) return null;
  return nowSc.score - p.categories[catId];
}

function countsString(counts) {
  const lbl = { pass: 'pass', partial: 'partial', fail: 'fail', blocked: 'blocked', inconclusive: 'inconcl.', error: 'error', 'n/a': 'n/a' };
  return Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${lbl[k]}`).join(' · ') || '—';
}

function renderCats() {
  const el = $('#cats');
  el.innerHTML = report.categories.map((c) => {
    const d = deltaFor(c.id);
    const delta = d == null ? '' : `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d)} vs prev</span>`;
    return `<div class="cat-card">
      <div class="row"><h3>${esc(c.name)}</h3><span class="s">${c.score == null ? 'n/a' : c.score}<small>/100</small></span></div>
      <div class="q">${esc(c.q)}</div>
      <div class="meter"><i data-w="${c.score == null ? 0 : c.score}"></i></div>
      <div class="counts">${esc(countsString(c.counts))}</div>
      ${delta}
    </div>`;
  }).join('');
  $('#cats-note').innerHTML = 'Category score: Σ(weight × credit) ÷ Σ(evaluated weight) — <a href="/docs#scoring" style="color:var(--text-2)">methodology</a>. Untested checks never count as failure.';
}

function animateMeters() {
  $$('#cats .meter i').forEach((i) => { i.style.width = `${i.dataset.w}%`; });
}

/* ---- findings + checks (accordions) ---- */

function statusPill(status) {
  const cls = { pass: 'st-pass', partial: 'st-warn', fail: 'st-fail', blocked: 'st-blocked', inconclusive: 'st-inconclusive', error: 'st-error', 'n/a': 'st-na' }[status] || 'st-open';
  const label = { pass: 'Pass', partial: 'Partial', fail: 'Fail', blocked: 'Blocked', inconclusive: 'Inconclusive', error: 'Error', 'n/a': 'N/A' }[status] || status;
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function evidenceHtml(rows) {
  if (!rows || !rows.length) return '<p class="dim">No evidence recorded.</p>';
  return `<div class="evidence">${rows.map(([k, v]) => {
    const val = Array.isArray(v) ? v.join('\n') : String(v);
    const isUrl = URL_KEYS.includes(String(k).toLowerCase()) && /^https?:\/\//.test(val.trim());
    return `<div class="er"><span>${esc(k)}</span><div>${isUrl ? `<a href="${esc(val.trim())}" target="_blank" rel="noopener">${esc(val)}</a>` : esc(val)}</div></div>`;
  }).join('')}</div>`;
}

let findingFilter = 'all';

function renderFindings() {
  const wrap = $('#findings-list');
  const fs = report.findings || [];
  const openItems = report.open || [];
  const groups = [
    ['fail', fs.filter((f) => f.status === 'fail')],
    ['partial', fs.filter((f) => f.status === 'partial')],
  ];

  const filters = [
    ['all', 'All', fs.length],
    ['fail', 'Fail', groups[0][1].length],
    ['partial', 'Partial', groups[1][1].length],
    ['open', 'Not established', openItems.length],
  ];
  $('#finding-filters').innerHTML = filters.map(([k, label, n]) =>
    `<button type="button" data-f="${k}" aria-pressed="${findingFilter === k}">${esc(label)} <span class="dim">${n}</span></button>`).join('');
  $('#finding-filters').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    findingFilter = b.dataset.f;
    renderFindings();
  };

  let out = '';
  if (findingFilter === 'open') {
    if (openItems.length) {
      for (const it of openItems) {
        out += `<div class="finding open-list-item" style="border-top:1px solid var(--line)">
          <div style="display:grid;grid-template-columns:48px 1fr auto;gap:14px;padding:14px 22px;align-items:start">
          <span class="fid">${esc(it.id)}</span>
          <span><span class="ft">${esc(it.title)}</span><p>${esc(it.detail)}</p></span>
          ${statusPill(it.status)}</div></div>`;
      }
    } else {
      out = '<div class="panel-b"><p class="dim">Nothing blocked, inconclusive or errored — full evidence coverage.</p></div>';
    }
  } else {
    const list = fs.filter((f) => findingFilter === 'all' ? true : f.status === findingFilter);
    if (list.length) {
      out = list.map((f, i) => accordion({
        open: findingFilter !== 'all' && i === 0,
        id: f.id, title: f.title, sub: f.summary, sev: f.sev, status: f.status,
        body: `<h4>Evidence</h4>${evidenceHtml(f.evidence)}
          <h4>Problem</h4><p>${esc(f.problem)}</p>
          <h4>Impact</h4><p>${esc(f.impact)}</p>
          <h4>How to fix</h4><ol>${(f.fix || []).map((s) => `<li>${md(s)}</li>`).join('')}</ol>
          <h4>Acceptance criteria</h4><ul class="checklist">${(f.acceptance || f.ac || []).map((s) => `<li>${md(s)}</li>`).join('')}</ul>
          <h4>Verification</h4><pre class="snippet">${esc(f.verify || 'Re-run the Cumulus audit.')}</pre>
          <div class="row-actions"><a class="btn small ghost" href="/api/v1/audits/${meta.id}/fix-kit" download>${ICONS.down || ''} in fix kit</a></div>`,
      })).join('');
    } else {
      out = '<div class="panel-b"><p class="dim" style="color:var(--pass)">No failing or partial checks — a clear stretch of sky. 🎉</p></div>';
    }
  }
  wrap.innerHTML = out;
  wireAccordions(wrap);
}

function accordion({ open, id: checkId, title, sub, sev, status, body }) {
  return `<div class="finding${open ? ' open' : ''}">
    <button type="button" aria-expanded="${!!open}" data-check="${esc(checkId)}">
      <span class="fid">${esc(checkId)}</span>
      <span><span class="ft">${esc(title)}</span><span class="fs">${esc(sub || '')}</span></span>
      <span class="pill ${pillClass(status)}">${esc(statusLabel(status))} · <span class="sev sev-${esc(sev)}">${esc(sev)}</span></span>
      ${ICONS.chev}
    </button>
    <div class="detail">${body}</div>
  </div>`;
}

function pillClass(status) {
  return ({ pass: 'st-pass', partial: 'st-warn', fail: 'st-fail', blocked: 'st-blocked', inconclusive: 'st-inconclusive', error: 'st-error', 'n/a': 'st-na' })[status] || 'st-open';
}
function statusLabel(status) {
  return ({ pass: 'Pass', partial: 'Partial', fail: 'Fail', blocked: 'Blocked', inconclusive: 'Inconclusive', error: 'Error', 'n/a': 'N/A' })[status] || status;
}

function wireAccordions(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.finding > button');
    if (!b) return;
    const f = b.parentElement;
    const isOpen = f.classList.toggle('open');
    b.setAttribute('aria-expanded', String(isOpen));
  });
}

/* ---- checks panel ---- */

let checkFilter = 'allcat';

function renderChecks() {
  const wrap = $('#checks-list');
  const checksAll = report.categories.flatMap((c) => c.checks.map((ck) => ({ ...ck, cat: c.id, catName: c.name })));
  $('#check-filters').innerHTML = [['allcat', 'All', checksAll.length], ...report.categories.map((c) => ['cat:' + c.id, c.name, c.checks.length])]
    .map(([k, label, n]) => `<button type="button" data-f="${k}" aria-pressed="${checkFilter === k}">${esc(label)} <span class="dim">${n}</span></button>`).join('');
  $('#check-filters').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    checkFilter = b.dataset.f;
    renderChecks();
  };
  const list = checkFilter === 'allcat' ? checksAll : checksAll.filter((c) => c.cat === checkFilter.slice(4));
  wrap.innerHTML = list.map((ck) => accordion({
    open: false,
    id: ck.id, title: ck.title, sub: '',
    sev: ck.sev, status: ck.status,
    body: `<h4>Evidence</h4>${evidenceHtml(ck.evidence)}${ck.note ? `<h4>Note</h4><p>${esc(ck.note)}</p>` : ''}<p class="dim" style="margin-top:14px;font-size:12.5px">${esc(ck.catName)} · weight ${weightOf(ck.sev)} · re-tested on every audit</p>`,
  })).join('');
  wireAccordions(wrap);
}

/* ---- journey ---- */

const TASKS = [
  ['pricing', 'P1 · find pricing'],
  ['plans', 'P2 · extract plans'],
  ['signup', 'U8 · locate signup'],
  ['checkout', 'P5 · reach checkout'],
  ['docs', 'U9 · locate docs'],
];

function renderJourney() {
  const el = $('#journey');
  const rows = [];
  for (const [key, label] of TASKS) {
    const t = report.tasks && report.tasks[key];
    if (!t) continue;
    const ok = t.status === 'pass';
    rows.push(`<li class="${ok ? '' : 'bad'}"><span class="task">${esc(label)}</span><span class="d">${esc(statusLabel(t.status))}</span>${t.finalUrl ? `<span class="u">${esc(t.finalUrl)}</span>` : ''}</li>`);
  }
  const steps = (report.journey || []).map((j) => `<li><span class="d">${esc(j.detail || '')}</span>${j.url ? `<span class="u">${esc(j.url)}</span>` : ''}</li>`);
  el.innerHTML = steps.join('');
}

/* ---- agents ---- */

function renderAgents() {
  const el = $('#agents');
  const groups = { retrieval: [], training: [] };
  for (const a of report.agents || []) (groups[a.group] || (groups[a.group] = [])).push(a);
  const row = (a) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)">
    <span class="mono" style="font-size:12px">${esc(a.agent)}</span>
    ${a.allowed ? '<span class="pill st-pass" style="height:20px">allowed</span>' : `<span class="pill st-fail" style="height:22px">blocked → ${esc(a.blocked.join(', ') || '/')}</span>`}
  </div>`;
  el.innerHTML = `
    <p class="note" style="margin:0 0 8px">Retrieval assistants (fetch pages for users)</p>
    ${groups.retrieval.map(row).join('') || '<p class="dim">Not evaluated</p>'}
    <p class="note" style="margin:14px 0 8px">Training crawlers (deliberate opt-out is fine)</p>
    ${groups.training.map(row).join('') || ''}`;
}

/* ---- facts ---- */

function renderFacts() {
  const s = report.stats;
  const kv = [
    ['Started', fmtDate(report.meta.startedAt)],
    ['Duration', `${Math.round((report.meta.durationMs || 0) / 1000)} s`],
    ['Audit UA', report.meta.auditor.ua],
    ['Pages fetched', String(s.pagesFetched)],
    ['Crawl stopped', s.crawlStopped],
    ['robots.txt', s.robots ? `HTTP ${s.robots.httpStatus ?? '—'} · ${s.robots.groupCount} groups · ${s.robots.sitemaps} sitemap(s)` : 'not fetched'],
    ['Sitemap', s.sitemap && s.sitemap.found ? `${s.sitemap.url} (${s.sitemap.urlCount} urls)` : 'not found'],
    ['llms.txt', s.llmsTxt ? (s.llmsTxt.ok ? `${s.llmsTxt.bytes} bytes` : `HTTP ${s.llmsTxt.status ?? '—'}`) : '—'],
    ['Browser', s.browser.ran ? `Chromium · ${s.browser.requests} reqs · ${s.browser.blockedRequests} blocked` : `unavailable${s.browser.reason ? ` — ${s.browser.reason.slice(0, 80)}` : ''}`],
    ['Bot challenge', s.challengeOnHomepage ? 'seen on rendered homepage' : 'none detected'],
    ['Soft-404 probe', s.soft404 ? (s.soft404.blocked ? 'blocked by robots' : `HTTP ${s.soft404.status}${s.soft404.is404 ? ' ✓' : ''}`) : '—'],
    ['Fix kit', `${apiBase}/fix-kit`],
  ].filter(([, v]) => v != null && v !== '');
  $('#facts').innerHTML = kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

/* ---- history ---- */

function renderHistory() {
  const hist = meta.history || [];
  const el = $('#hist');
  if (!hist.length) {
    el.innerHTML = '<a class="current" style="pointer-events:none"><span class="mono">this audit</span><span class="sc">' + (report.score.overall ?? '–') + '</span><span class="when">first on record</span></a>';
    $('#spark').innerHTML = '';
    $('#hist-note').textContent = 'no prior audits of this host';
    return;
  }
  el.innerHTML = hist.map((h, i) => `<a href="report.html?id=${esc(h.id)}" class="">
    <span class="mono dim">${esc(new Date(h.finishedAt || h.createdAt).toLocaleDateString())}${i === 0 ? ' (prev)' : ''}</span>
    <span class="sc">${h.score ?? '–'}</span>
    <span class="when">${esc(h.grade || '')}</span>
  </a>`).join('');
  $('#hist-note').textContent = `${hist.length + 1} audit(s) of this host`;
  const spark = [report.score.overall, ...hist.map((h) => h.score)].filter((x) => x != null).reverse();
  $('#spark').innerHTML = sparkSVG(spark) || '';
}

/* ---- pages ---- */

function renderPages() {
  const table = $('#pages');
  const pages = (report.stats && report.stats.pages) || [];
  $('#pages-note').textContent = pages.length ? `${report.stats.pagesFetched} fetched, showing ${pages.length}` : 'no pages';
  if (!pages.length) {
    table.innerHTML = '<tr><td>no pages were crawled (see audit facts)</td><td></td></tr>';
    return;
  }
  table.innerHTML = pages.map((p) => {
    const short = p.url && p.url.startsWith(report.meta.origin) ? p.url.slice(report.meta.origin.length) || '/' : p.url;
    return `<tr><td>${esc(short)}</td><td>${p.status == null ? '' : esc(String(p.status))}</td></tr>`;
  }).join('');
}

async function rerun() {
  const targetUrl = (report && report.meta && report.meta.url) || (rec && rec.url);
  if (!targetUrl) return;
  const btn = $('#rerun-btn');
  if (btn) btn.textContent = 'Starting…';
  try {
    const res = await fetch('/api/v1/audits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
    });
    const data = await res.json();
    if (res.status === 202 && data && data.id) {
      window.location.href = `/report/${data.id}`;
      return;
    }
    alert((data && data.error && data.error.message) || 'Could not start re-audit.');
  } catch (err) {
    alert('Failed to connect to auditor.');
  } finally {
    if (btn) btn.textContent = 'Rerun audit';
  }
}
