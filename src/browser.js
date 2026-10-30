/*
 * browser.js — the rendered experience + agent tasks.
 *
 * Goals:
 *  - Run a real headless Chromium against the audited site.
 *  - Contain it: default-deny per-request policy guard (netguard) so the
 *    site cannot make the browser reach internal/private targets.
 *  - Run the five agent tasks by following visible links/buttons only.
 *    Nothing is ever typed, submitted or paid.
 *
 * Task contract (see checks.js):
 *   skin(status, rows, extra) → { status, evidence, evidenceRow(), … }
 */
import { chromium } from 'playwright';
import { config } from './config.js';
import { resolveTarget, policyCheckUrl, PolicyError } from './netguard.js';
import { safeFetch } from './safefetch.js';
import { isAllowed } from './robots.js';
import { domSnapshot } from './parse.js';

const CHALLENGE_MARKERS = [
  'verify you are human', 'are you a human', 'attention required!', 'just a moment…', 'just a moment',
  'captcha', 'bot verification', 'challenge-platform', 'cf-please-wait', 'px-captcha',
  'ddos protection by', 'enable javascript and cookies to continue',
];
export { CHALLENGE_MARKERS };

const NAV_PATTERNS = {
  pricing: /pricing|plans?|prices|tiers?|quot[ae]|subscriptions?|membership/i,
  docs: /\bdocs?\b|documentation|\bhelp\b|help[-_ ]?centre|help[-_ ]?center|knowledge[-_ ]?base|\bsupport\b|guides\b|\bfaq\b|\bwiki\b|manual/i,
  signup: /sign[-_ ]?up|register|create[-_ ]account|get[-_ ]started|start[-_ ]free|try[-_ ]free|join\b|sign[-_ ]in|\blog ?in\b|log[-_ ]?on\b/i,
};
const CTA_RX = /(^|\s)(get started|start(?:[^a-z]{0,3}(free|trial|now))?|try[^a-z]{0,12}free|sign[-_ ]?up|choose[^a-z]{0,14}|select[^a-z]{0,8}|buy[-_ ]?now|upgrade|purchase|subscribe|add[-_ ]to[-_ ]cart|create[-_ ]account|join\b|talk[-_ ]to[-_ ]sales|contact[-_ ]sales|book[-_ ]a[-_ ](?:demo|call))(?=$|[ ,.!])/i;

const CHECKOUT_URL_RX = /(checkout|\/cart|\/basket|\/billing|\/pay\b|\/payment|\/subscribe|\/upgrade\b|\/purchase|\/order\b|\/enroll|\/trial(?:\/|$)|\/register\/|\/start(?:\/|$))/i;
const CHECKOUT_HOST_RX = /(checkout\.stripe|checkout\.shopify|pay\.paypal|www\.paypal\.com|hosted\.paddle|lemonsqueezy|chargebee|fastspring|gocardless|\.myshopify|\/expresscheckout)/i;
const CHECKOUT_TEXT_RX = /(complete purchase|place order|place your order|review your order|confirm your (?:order|subscription|payment)|payment method|card details|billing address|complete your (?:purchase|subscription)|confirm and pay|secure checkout)/i;

const OAUTH_RX = /(sign ?in with (?:google|apple|github|gitlab|microsoft|sso|okta)|continue with (?:google|apple|github|gitlab|microsoft|sso)|log ?in with (?:github|gitlab|google|microsoft|saml|sso)|with (?:google|apple|github) below)/i;

/* --------------------------------------------------------------- */

export async function runBrowserPhase(engine, a, ctx) {
  const log = (m, k) => engine.emitStatus(a, 'browser', ctx.browserFrac || 0, m, k);
  const budget = () => Math.max(0, ctx.deadline - Date.now());

  ctx.journey = [];
  ctx.rendered = ctx.rendered || {};
  ctx.tasks = ctx.tasks || {};
  ctx.rendKeyPages = [];
  ctx.blockedRequests = 0;

  /* ---- 1. host allowlist for the chromium resolver ---- */
  const apex = ctx.host.replace(/^www\./, '');
  const allowHosts = new Set([ctx.host, apex]);
  for (const h of thirdPartyHosts(ctx).slice(0, 40)) {
    try { await resolveTarget(h, { cache: ctx.cache }); allowHosts.add(h); } catch { /* excluded */ }
    if (budget() < 25_000) break;
  }

  const allowedBrowserTarget = (u) => {
    const host = u.hostname.toLowerCase();
    return host === ctx.host || host === apex || host.endsWith('.' + apex) ||
      allowHosts.has(host) || allowHosts.has(host.replace(/^www\./, ''));
  };

  /* ---- 2. route guard ---- */
  const guardedRoute = (route) => {
    let settled = false;
    const doAbort = () => { if (!settled) { settled = true; ctx.blockedRequests++; try { route.abort(); } catch { /* stale */ } } };
    const doContinue = () => { if (!settled) { settled = true; try { route.continue(); } catch { /* stale */ } } };
    try {
      const u = policyCheckUrl(route.request().url());
      if (!allowedBrowserTarget(u)) return doAbort();
      // DNS-validate every request target (same gate as raw fetches); only
      // continue when the host resolves into auditable address space.
      resolveTarget(u.hostname, { cache: ctx.cache }).then(doContinue).catch(doAbort);
    } catch { doAbort(); }
  };

  /* ---- 3. launch ---- */
  const resolverRules = `MAP * ~NOTFOUND, ${[...allowHosts.values()].map((h) => `EXCLUDE ${h}`).join(',')}`;
  const browser = await chromium.launch({
    args: ['--host-resolver-rules=' + resolverRules, '--no-first-run', '--disable-background-networking'],
  });
  ctx.browser = { ok: true, requests: 0, blocked: 0 };
  log('Chromium launched (default-deny network policy for the renderer)', 'ok');

  try {
    const context = await browser.newContext({
      userAgent: config.userAgentBrowser,
      viewport: { width: 1366, height: 850 },
      locale: 'en-US',
      timezoneId: 'UTC',
      ignoreHTTPSErrors: false,
    });
    await context.route('**/*', guardedRoute);
    const page = await context.newPage();
    page.setDefaultTimeout(9_000);
    page.setDefaultNavigationTimeout(config.limits.pageLoadTimeoutMs);

    /* ---- render homepage ---- */
    if (budget() < 20_000) { markSkips(ctx, 'audit time budget exhausted before rendering'); return; }
    const home = await renderPage(page, ctx.origin + '/', 25_000, robotsGateFor(ctx));
    if (home.blockedByRobots) { markSkips(ctx, 'robots.txt disallows browser navigation on / for retrieval agents'); return; }
    if (home.error) {
      markSkips(ctx, `homepage render failed (${home.error})`);
      return;
    }
    ctx.rendered.home = home.snapshot;
    ctx.rendered.homeUrl = home.finalUrl;
    ctx.renderedStatus = home.status;
    for (const j of home.journey || []) ctx.journey.push(j);
    log(`rendered ${shortUrl(home.finalUrl)} — DOM text ${home.snapshot.textChars.toLocaleString()} chars, ${home.snapshot.prices.length} price strings`, 'ok');

    if (home.snapshot.challenge) {
      ctx.browserChallenge = home.snapshot.challengeDetail;
      log(`bot challenge on rendered homepage: ${home.snapshot.challengeDetail}`, 'warn');
      markSkips(ctx, 'rendered homepage presents a bot challenge.');
      return;
    }

    /* ---- P1: find pricing ---- */
    ctx.browserFrac = 0.2;
    let b = budget();
    try {
      ctx.tasks.pricing = await taskPricing(ctx, page);
    } catch (err) {
      ctx.tasks.pricing = skin('inconclusive', [['state', `pricing task interrupted: ${err.message}`]]);
    }
    b = budget();

    /* ---- P2: extract plans ---- */
    ctx.browserFrac = 0.36;
    if (ctx.tasks.pricing.status === 'pass' && b > 10_000) {
      try {
        ctx.tasks.plans = await taskPlans(ctx, page, b);
      } catch (err) {
        ctx.tasks.plans = skin('inconclusive', [['state', `plan extraction interrupted: ${err.message}`]]);
      }
    } else if (ctx.tasks.pricing.status === 'pass') {
      ctx.tasks.plans = skin('skipped', [['state', 'plan extraction skipped: audit time budget nearly exhausted']]);
    } else {
      ctx.tasks.plans = skin('na', [['reason', `pricing page not reached (task state: ${ctx.tasks.pricing.status})`]]);
    }
    b = budget();

    /* ---- P5: checkout (run from pricing page while on it) ---- */
    ctx.browserFrac = 0.55;
    if (b > 10_000) {
      try {
        ctx.tasks.checkout = await taskCheckout(ctx, page, b);
      } catch (err) {
        ctx.tasks.checkout = skin('inconclusive', [['state', `checkout task interrupted: ${err.message}`]]);
      }
    } else ctx.tasks.checkout = skin('skipped', [['state', 'checkout task skipped: audit time budget nearly exhausted']]);
    b = budget();

    /* ---- U8: signup ---- */
    ctx.browserFrac = 0.74;
    if (b > 10_000) {
      try {
        ctx.tasks.signup = await taskSignup(ctx, page, b);
      } catch (err) {
        ctx.tasks.signup = skin('inconclusive', [['state', `signup task interrupted: ${err.message}`]]);
      }
    } else ctx.tasks.signup = skin('skipped', [['state', 'signup task skipped: audit time budget nearly exhausted']]);
    b = budget();

    /* ---- U9: docs ---- */
    ctx.browserFrac = 0.88;
    if (b > 9_000) {
      try {
        ctx.tasks.docs = await taskDocs(ctx, page, b);
      } catch (err) {
        ctx.tasks.docs = skin('inconclusive', [['state', `docs task interrupted: ${err.message}`]]);
      }
    } else ctx.tasks.docs = skin('skipped', [['state', 'docs task skipped: audit time budget nearly exhausted']]);

    await finalize(ctx);
    log(`browser tasks finished (${ctx.browser.requests} request(s), ${ctx.blockedRequests} blocked by guard)`, 'ok');
  } finally {
    try { await browser.close(); } catch { /* already dead */ }
  }
}

/* --------------------------------------------------------------- */

function markSkips(ctx, reason) {
  for (const id of ['pricing', 'plans', 'signup', 'checkout', 'docs']) {
    if (!ctx.tasks[id]) ctx.tasks[id] = skin('blocked', [['state', reason]]);
  }
}

function skin(status, rows, extra = {}) {
  return {
    status,
    evidence: rows.map(([k, v]) => [String(k), String(v ?? '')]),
    note: extra.note || null,
    finalUrl: extra.finalUrl || null,
    notApplicableReason: extra.notApplicableReason || null,
    steps: extra.steps || [],
    evidenceRow() { return this.evidence.slice(); },
  };
}

function shortUrl(u, n = 80) { try { const x = new URL(u); return x.hostname + x.pathname + x.search; } catch { return String(u).slice(0, n); } }

function robotsGateFor(ctx) {
  return (url) => {
    const p = ctx.robots && ctx.robots.parsed;
    if (!p || !p.groups.length) return false;
    for (const ua of ['chatgpt-user', 'claudebot', 'claude-user', 'oai-searchbot', 'perplexitybot', 'perplexity-user', 'googlebot']) {
      if (!isAllowed(p, ua, url)) return true;
    }
    return false;
  };
}

/* ---------------- render ---------------- */

async function renderPage(page, url, timeoutMs, gate) {
  if (gate) {
    try {
      const abs = new URL(url, page.url());
      if (gate(abs.href)) return { blockedByRobots: true, url: abs.href, reason: 'robots.txt disallows this path for retrieval agents' };
    } catch { /* url broke */ }
  }
  const journey = [{ detail: `browser navigate → ${shortUrl(url)}`, url }];
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = resp && resp.status();
    try { await page.waitForLoadState('load', { timeout: Math.min(8_000, Math.round(timeoutMs / 2)) }); } catch { /* heavy page */ }
    const snapshot = await domSnapshotBrowser(page);
    const finalUrl = page.url();
    journey.push({ detail: `page loaded${status ? ` (HTTP ${status})` : ''}`, url: finalUrl });
    return { ok: true, status, finalUrl, snapshot, journey };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 160), url, journey };
  }
}

async function domSnapshotBrowser(page) {
  const doSnapshot = async () => {
    const ldRaw = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) { if (out.length < 12) out.push(el.textContent || ''); }
      return out;
    });
    const snap = await page.evaluate((markers) => {
      const doc = document;
      const metas = {};
      const getMeta = (name, attr) => {
        const el = doc.querySelector(`meta[${attr}="${name}"]`);
        return el ? (el.getAttribute('content') || '').trim() : '';
      };

      const alternates = [];
      for (const el of doc.querySelectorAll('link[rel="alternate"]')) {
        alternates.push({ type: (el.getAttribute('type') || '').toLowerCase(), href: el.getAttribute('href') || '' });
      }

      const h1s = [];
      const headingSeq = [];
      for (const el of doc.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (tag === 'h1') h1s.push(text);
        if (headingSeq.length < 130) headingSeq.push({ tag, text: text.slice(0, 120) });
      }

      let imgTotal = 0, imgMissingAlt = 0;
      const missingAltSamples = [];
      for (const el of doc.querySelectorAll('img')) {
        imgTotal++;
        const hasAlt = el.hasAttribute('alt');
        const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        if (!hasAlt && !aria) {
          imgMissingAlt++;
          if (missingAltSamples.length < 10) missingAltSamples.push({ src: (el.getAttribute('src') || 'data-uri').slice(0, 70) });
        }
        if (imgTotal >= 500) break;
      }

      let visibleAnchors = 0, anchorsUnnamed = 0;
      const anchorUnnamedSamples = [];
      for (const el of doc.querySelectorAll('a')) {
        if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
        visibleAnchors++;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        if (text.length < 2 && aria.length < 2) {
          anchorsUnnamed++;
          if (anchorUnnamedSamples.length < 8) anchorUnnamedSamples.push((el.getAttribute('href') || '(no href)').slice(0, 70));
        }
        if (visibleAnchors >= 400) break;
      }

      const navEls = [...doc.querySelectorAll('nav, [role="navigation"], header')].slice(0, 6);
      let navRealLinks = 0, navPseudoLinks = 0;
      for (const el of navEls) {
        for (const ax of el.querySelectorAll('a')) {
          const href = (ax.getAttribute('href') || '').trim();
          if (!href || href === '#' || /^javascript:/i.test(href)) navPseudoLinks++;
          else navRealLinks++;
        }
      }

      let buttonsTotal = 0, buttonsUnnamed = 0;
      const unnamedButtonSamples = [];
      for (const el of doc.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')) {
        if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
        buttonsTotal++;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '';
        if (!text && !aria) {
          buttonsUnnamed++;
          if (unnamedButtonSamples.length < 8) unnamedButtonSamples.push((el.getAttribute('class') || '').slice(0, 70));
        }
        if (buttonsTotal >= 400) break;
      }

      const forms = [];
      for (const el of doc.querySelectorAll('form')) {
        if (forms.length >= 12) break;
        const f = { action: el.getAttribute('action') || '', unlabeled: 0, fields: [] };
        for (const inp of el.querySelectorAll('input, select, textarea')) {
          const type = (inp.getAttribute('type') || inp.tagName.toLowerCase()).toLowerCase();
          if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
          let labeled = !!(inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby') || inp.getAttribute('title'));
          const id = inp.id || '';
          if (!labeled && id) { try { labeled = !!el.querySelector(`label[for="${CSS.escape(id)}"]`); } catch { labeled = labeled || !!el.querySelector('label[for="' + id + '"]'); } }
          if (!labeled && inp.closest('label')) labeled = true;
          f.fields.push({ type, label: labeled ? 'labeled' : (inp.getAttribute('placeholder') ? 'placeholder-only' : 'none') });
          if (!labeled) f.unlabeled++;
        }
        if (f.fields.length) forms.push(f);
      }

      const bodyText = ((doc.body && doc.body.innerText) || '').replace(/\s+/g, ' ').trim();
      const PRICE_SRC = String.raw`(?:[$€£¥₹]|USD|EUR|GBP|CAD|AUD|C\$|A\$|R\$)\s*\d(?:\d|[, .]\d{3})*(?:[.,]\d{2})?(?:\s*[/]?[a-z]{0,4})?|\d(?:\d|[, .]\d{3})*(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|CAD|AUD)\b`;
      const priceRx = new RegExp(PRICE_SRC, 'g');
      const prices = [];
      let mm;
      const hay = bodyText.slice(0, 80_000);
      while ((mm = priceRx.exec(hay))) {
        if (prices.length >= 80) break;
        prices.push(mm[0].trim());
      }
      const low = (doc.title || '').toLowerCase() + ' ' + hay.slice(0, 4000).toLowerCase();
      const challengeMarkers = markers.filter((mk) => low.includes(mk));

      return {
        kind: 'rendered',
        url: doc.location.href,
        title: (doc.title || '').trim(), titleLen: (doc.title || '').trim().length,
        metaDesc: getMeta('description', 'name'), metaDescLen: getMeta('description', 'name').length,
        robotsMeta: getMeta('robots', 'name') || getMeta('robots', 'http-equiv'),
        lang: doc.documentElement.getAttribute('lang') || '',
        charset: getMeta('charset', 'attribute') || '',
        viewport: getMeta('viewport', 'name'),
        canonicalHref: (doc.querySelector('link[rel="canonical"]') && doc.querySelector('link[rel="canonical"]').getAttribute('href')) || '',
        og: {
          title: getMeta('og:title', 'property') || getMeta('og:title', 'name'),
          description: getMeta('og:description', 'property'),
          image: getMeta('og:image', 'property'),
          url: getMeta('og:url', 'property'),
        },
        alternates,
        h1Count: h1s.length, h1: h1s.slice(0, 5), headingSeq,
        imgTotal, imgMissingAlt, missingAltSamples,
        anchorCount: visibleAnchors, unnamedAnchors: anchorsUnnamed, anchorUnnamedSamples,
        buttonsTotal, buttonsUnnamed, unnamedBufferSamples: unnamedButtonSamples,
        forms, unlabeledFields: forms.reduce((n, f) => n + f.unlabeled, 0),
        landmarks: {
          main: !!doc.querySelector('main,[role="main"]'),
          nav: navEls.length > 0,
          footer: !!doc.querySelector('footer,[role="contentinfo"]'),
        },
        navRealLinks, navPseudoLinks,
        navLinks: navEls.flatMap((el) => [...el.querySelectorAll('a')].filter((l) => l.offsetWidth > 0).slice(0, 10).map((l) => ({
          href: l.getAttribute('href') || '',
          text: (l.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        }))).slice(0, 40),
        textChars: bodyText.length,
        textSample: bodyText.slice(0, 300),
        prices: [...new Set(prices)],
        paymentSignals: (() => {
          const pmIframes = [...doc.querySelectorAll('iframe')]
            .filter((f) => /(stripe|paypal|squareup|braintree|checkout|paddle|adyen|shopifypay)/i.test(f.src || '')).length;
          const payInputs = [...doc.querySelectorAll('input')]
            .filter((i) => /cc-|card|expir|cvv|csc\b|cvc\b/i.test(`${i.getAttribute('autocomplete') || ''} ${i.getAttribute('name') || ''} ${i.id || ''}`)).length;
          const tm = /complete (?:your )?(?:purchase|order)|place (?:your )?order|review (?:your )?order|confirm (?:your )?(?:order|subscription|payment)|payment method|card (?:details|number)|billing address|complete your (?:purchase|subscription)|confirm and pay|secure checkout/
            .exec(bodyText.toLowerCase());
          return { iframes: pmIframes, inputs: payInputs, text: tm ? tm[0] : null };
        })(),
        challenge: challengeMarkers.length > 0,
        challengeDetail: challengeMarkers.length ? `markers: ${challengeMarkers.slice(0, 3).join(', ')}` : null,
      };
    }, CHALLENGE_MARKERS);
    // JSON-LD parse back in Node
    snap.jsonLd = [];
    for (const raw of ldRaw) {
      try {
        const fixed = raw.replace(/^\s*<!--/, '').replace(/-->\s*$/, '');
        const parsed = JSON.parse(fixed);
        const flat = [];
        const emit = (n) => { if (Array.isArray(n)) return n.forEach(emit); if (n && typeof n === 'object') { if (Array.isArray(n['@graph'])) n['@graph'].forEach(emit); flat.push(n); } };
        emit(parsed);
        const type = flat.map((n) => (n && n['@type']) ? (Array.isArray(n['@type']) ? n['@type'][0] : n['@type']) : null).filter(Boolean).join(', ');
        snap.jsonLd.push({ ok: true, type, data: flat[0] || parsed });
      } catch { snap.jsonLd.push({ ok: false }); }
    }
    return snap;
  };

  try {
    return await doSnapshot();
  } catch (err) {
    if (String(err?.message || '').includes('Execution context was destroyed') || String(err?.message || '').includes('navigation')) {
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 600));
        return await doSnapshot();
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

const PIS_SOURCE = String.raw`(?:[$€£¥₹]|USD|EUR|GBP|CAD|AUD|C\$|A\$|R\$)\s*\d(?:\d|[, .]\d{3})*(?:[.,]\d{2})?(?:\s*[/]?[a-z]{0,4})?|\d(?:\d|[, .]\d{3})*(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|CAD|AUD)\b`;

/* ---------------- anchors / clicking ---------------- */

async function collectAnchors(page) {
  return page.evaluate(() => {
    const mk = (el, src, i) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const img = el.querySelector ? el.querySelector('img[alt]') : null;
      const href = el.getAttribute ? (el.getAttribute('href') || '') : '';
      return { text: (text || aria || (img ? img.getAttribute('alt') : '')).slice(0, 80), href, src, i, real: !!href && href !== '#' && !/^javascript:/i.test(href) };
    };
    const out = { head: [], all: [] };
    const navEls = [...document.querySelectorAll('nav, [role="navigation"], header')].slice(0, 6);
    let hi = 0;
    for (const el of navEls) {
      for (const ax of el.querySelectorAll('a')) {
        if (ax.offsetWidth === 0 || ax.offsetHeight === 0) continue;
        if (out.head.length < 60) out.head.push(mk(ax, 'head', hi++));
      }
    }
    let ai = 0;
    for (const ax of document.querySelectorAll('a')) {
      if (ax.offsetWidth === 0 || ax.offsetHeight === 0) continue;
      if (out.all.length < 240) out.all.push(mk(ax, 'all', ai++));
    }
    return out;
  });
}

async function clickAnchor(page, slot) {
  return page.evaluate(({ src, idx }) => {
    let list;
    if (src === 'head') {
      list = [...document.querySelectorAll('nav, [role="navigation"], header')].slice(0, 6)
        .flatMap((el) => [...el.querySelectorAll('a')]).filter((ax) => ax.offsetWidth > 0 && ax.offsetHeight > 0);
      if (!list[idx]) {
        // fall back to the nth visible anchor of the page (indices won't match perfectly but this keeps the click honest)
        list = [...document.querySelectorAll('a')].filter((ax) => ax.offsetWidth > 0 && ax.offsetHeight > 0);
      }
    } else {
      list = [...document.querySelectorAll('a')].filter((ax) => ax.offsetWidth > 0 && ax.offsetHeight > 0);
    }
    const el = list[idx] || null;
    if (!el) return { ok: false, reason: 'element gone' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, href: el.getAttribute('href') || '', text: (el.textContent || '').trim().slice(0, 60) };
  }, slot);
}

async function waitForNav(page, ms = 9_000) {
  try { await page.waitForLoadState('domcontentloaded', { timeout: ms }); } catch { /* never settled */ }
  await page.waitForTimeout(650);
}

/* ---------------- task: find pricing (P1) ---------------- */

async function taskPricing(ctx, page) {
  const rows = [];
  const steps = [];
  const gate = robotsGateFor(ctx);

  // 1) rendered candidates (nav first, then body)
  const cand = await collectAnchors(page);
  const matches = [];
  for (const [src, list] of [['head', cand.head], ['all', cand.all]]) {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (NAV_PATTERNS.pricing.test(`${l.text} ${l.href} `) && (l.real || src === 'head')) { matches.push(l); break; }
    }
    if (matches.length) break;
  }

  if (matches.length) {
    const m = matches[0];
    const abs = m.href ? new URL(m.href, ctx.origin).href : null;
    if (abs && gate(abs)) {
      return skin('blocked', [['state', 'robots.txt disallows the discovered pricing URL for retrieval agents'], ['candidate link', `${m.text} → ${m.href}`]]);
    }
    steps.push({ detail: `click “${m.text.slice(0, 40)}”`, url: page.url() });
    let landed = false;
    try {
      const click = await clickAnchor(page, { src: m.src, idx: m.i });
      if (click.ok) {
        await waitForNav(page);
        landed = true;
      }
    } catch { /* fallthrough */ }
    if (!landed && abs) {
      const r = await renderPage(page, abs, 20_000, gate);
      if (r.blockedByRobots) return skin('blocked', [['state', 'robots.txt disallows the pricing URL for retrieval agents']]);
      landed = !!r.finalUrl;
    }
    await waitForNav(page, 6_000);
    const finalUrl = page.url();
    steps.push({ detail: `landed on ${shortUrl(finalUrl)}`, url: finalUrl, ok: true });
    const snap = await domSnapshotBrowser(page);
    const looksPricing = /pricing|plans?|\bprice|tiers?|quot[ae]|offers/i.test(finalUrl) || (snap.prices && snap.prices.length >= 2) || (snap.headingSeq && snap.headingSeq.some((h) => /pricing|\bprice\b|plans/i.test(h.text)));
    rows.push(['clicked', `${m.text || '(untitled)'} → ${m.href || '(no href in anchor)'}`]);
    rows.push(['final url', finalUrl]);
    if (looksPricing) {
      ctx.pricingUrl = finalUrl;
      ctx.rendKeyPages.push({ label: 'pricing', url: finalUrl, snapshot: snap });
      const ctas = await gatherPricingCtas(page);
      ctx.pricingCtas = ctas;
      rows.push(['pricing evidence', `${snap.prices.length} price string(s) on the page`]);
      return skin('pass', [...rows, ['claim', 'a link-following agent reached a pricing page by following links']], { finalUrl, steps });
    }
    if (snap.challenge) {
      rows.push(['challenge', snap.challengeDetail]);
      return skin('blocked', rows, { finalUrl, steps });
    }
    rows.push(['price strings on page', String(snap.prices ? snap.prices.length : 0)]);
    return skin('inconclusive', [...rows, ['result', 'the label matched but the page it opened shows no pricing URL pattern or price strings']], { finalUrl, steps });
  }

  // 2) raw-HTML fallback (anchor exists in server HTML but not visible in nav area)
  const rawHit = ctx.navHits && ctx.navHits.pricing;
  if (rawHit && rawHit.href) {
    const abs = new URL(rawHit.href, ctx.origin).href;
    if (gate(abs)) return skin('blocked', [['state', 'robots.txt disallows the raw-HTML pricing URL'], ['candidate link', `${rawHit.text} → ${rawHit.href}`]]);
    steps.push({ detail: 'no rendered pricing anchor; navigating to pricing URL found in initial HTML', url: page.url() });
    const r = await renderPage(page, abs, 20_000, gate);
    if (r.error) return skin('inconclusive', [['state', `pricing URL did not load in browser (${r.error})`], ['url', abs]]);
    const finalUrl = r.finalUrl;
    rows.push(['initial-html link', `${rawHit.text} → ${rawHit.href}`]);
    rows.push(['final url', finalUrl]);
    const snap = r.snapshot;
    const looksPricing = looksPricingLike(finalUrl, snap);
    if (looksPricing) {
      ctx.pricingUrl = finalUrl;
      ctx.rendKeyPages.push({ label: 'pricing', url: finalUrl, snapshot: snap });
      ctx.pricingCtas = snap ? await gatherPricingCtas(page) : null;
      return skin('pass', [...rows, ['claim', 'pricing page reached through the link declared in the HTML source']], { finalUrl, steps });
    }
    if (snap.challenge) return skin('blocked', [...rows, ['challenge', snap.challengeDetail]], { finalUrl });
    return skin('inconclusive', [...rows, ['result', 'the pricing link from initial HTML did not open a page with pricing signals']], { finalUrl, steps });
  }

  // 3) no candidates at all
  const isNonComm = nonCommercial(ctx);
  return skin('fail', [
    ['result', 'no pricing link was found in rendered nav, rendered body anchors, or initial HTML'],
    ['anchors scanned', `${cand.head.length} in header/nav, ${cand.all.length} on the rendered homepage`],
    ['sample labels', (cand.all.slice(0, 12).map((l) => l.text || '(image link)').join(' · ') || 'none').slice(0, 300)],
    ['initial-HTML nav', (ctx.navHits || {}).pricing ? '' : 'no pricing-classified link found either'],
    ['sitemap pricing urls', String((ctx.sitemap && ctx.sitemap.urlMatches && ctx.sitemap.urlMatches.pricing?.length) || 0)],
  ], { steps, notApplicableReason: isNonComm });
}

function looksPricingLike(url, snap) {
  if (url && /pricing|plans?|\bprice|tiers?|quot[ae]|offers/i.test(url)) return true;
  if (snap) {
    if (snap.prices && snap.prices.length >= 2) return true;
    if (snap.headingSeq && snap.headingSeq.some((h) => /pricing|\bprice\b|\bplans?\b/i.test(h.text))) return true;
  }
  return false;
}

async function gatherPricingCtas(page) {
  return page.evaluate(() => {
    const CTA = /(^|\s)(get started|start(?:[^a-z]{0,3}(?:free|trial|now))?|try[^a-z]{0,12}free|sign[-_ ]?up|choose[^a-z]{0,14}|select[^a-z]{0,8}|buy[-_ ]?now|upgrade|purchase|subscribe|add[-_ ]to[-_ ]cart|create[-_ ]account|join\b|talk[-_ ]to[-_ ]sales|contact[-_ ]sales|book[-_ ]a[-_ ](?:demo|call))(?=$|[ ,.!])/i;
    let anchors = 0, scriptOnly = 0;
    const samples = [];
    for (const el of document.querySelectorAll('a, button, [role="button"], input[type="submit"]')) {
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 34 || rect.height < 16) continue;
      const text = (el.textContent || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim();
      if (!text || !CTA.test(text)) continue;
      const isAnchor = el.tagName.toLowerCase() === 'a';
      const href = isAnchor ? (el.getAttribute('href') || '') : '';
      const real = href && href !== '#' && !/^javascript:/i.test(href);
      if (real) anchors++; else scriptOnly++;
      if (samples.length < 10) samples.push(`${text.slice(0, 30)} → ${real ? href.slice(0, 60) : 'button without href'}`);
    }
    return { anchors, scripts: scriptOnly, samples };
  });
}

/* ---------------- task: extract plans (P2) ---------------- */

async function taskPlans(ctx, page, budget) {
  const currentUrl = page.url();
  const snap = await domSnapshotBrowser(page);
  const plans = await page.evaluate(() => {
    const PRICE = new RegExp(String.raw`(?:[$€£¥₹]|USD|EUR|GBP|CAD|AUD|C\$|A\$|R\$)\s*\d(?:\d|[, .]\d{3})*(?:[.,]\d{2})?|\b\d(?:\d|[, .]\d{3})*(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|CAD|AUD)\b`, 'g');
    const out = [];
    const seen = new Set();
    const els = document.querySelectorAll('div, li, article, section, dd, td');
    for (const el of els) {
      if (out.length >= 10) break;
      const rect = el.getBoundingClientRect();
      if (!rect.width || rect.width < 170 || rect.height < 80 || rect.height > 2800) continue;
      if (el.querySelectorAll('div, article, section').length > 0) continue;
      const own = (el.innerText || el.textContent || '').trim();
      if (own.length > 800) continue;
      PRICE.lastIndex = 0;
      const m = own.match(PRICE);
      if (!m || !m.length) continue;
      const nameEl = el.querySelector('h2, h3, h4, strong, b, [class*="plan" i], [class*="tier" i], [class*="name" i]');
      let name = nameEl ? (nameEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
      if (!name) {
        const firstLine = own.split('\n').map((x) => x.trim()).find(Boolean) || '';
        if (firstLine && firstLine.length <= 40 && !/[$€£¥/]|\d/.test(firstLine)) name = firstLine.slice(0, 40);
      }
      if (!name || /pricing|\bprice\b|\bplans?\b|\bfor\b/i.test(name)) continue;
      const priceStr = m[0].trim();
      const key = `${name.toLowerCase()}|${priceStr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, price: priceStr, snippet: own.replace(/\s+/g, ' ').slice(0, 100) });
    }
    return out;
  });

  if (!plans.length) {
    const prices = (snap.prices || []).slice(0, 6);
    if (prices.length >= 2) {
      return skin('partial', [
        ['result', 'price strings present on the rendered pricing page, but plan names were not extractable as readable text'],
        ['price strings', prices.join('\n')],
        ['page text length', `${snap.textChars.toLocaleString()} chars`],
      ], { finalUrl: currentUrl });
    }
    return skin('fail', [
      ['result', 'no plan names with readable prices could be extracted from the rendered pricing page'],
      ['price strings on page', prices.join(' · ') || 'none'],
      ['page text length', `${snap.textChars.toLocaleString()} chars`],
      ['url', currentUrl],
    ]);
  }
  const rows = plans.map((p) => [`plan: ${p.name}`, `${p.name} — ${p.price}`]);
  const coveredFree = /\bfree\b/i.test(snap.textSample || '');
  const status = plans.length >= 2 || (plans.length === 1 && coveredFree) ? 'pass' : 'partial';
  const t = skin(status, [...rows, ['claim', 'plans and prices extracted from the rendered DOM (this is the information an agent would read)']], { finalUrl: currentUrl });
  t.plans = plans.map((p) => ({ name: p.name, price: p.price }));
  return t;
}

/* ---------------- task: signup (U8) ---------------- */

async function taskSignup(ctx, page, budget) {
  const rows = [];
  const steps = [];
  const gate = robotsGateFor(ctx);
  if (budget < 9_000) return skin('skipped', [['state', 'time budget']]);

  if (page.url() !== ctx.origin + '/' && page.url() !== ctx.origin) {
    try {
      await page.goto(ctx.origin + '/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await waitForNav(page, 4_000);
    } catch { /* fallthrough */ }
  }

  const cand = await collectAnchors(page);
  const matches = [];
  for (const [src, list] of [['head', cand.head], ['all', cand.all]]) {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (NAV_PATTERNS.signup.test(`${l.text} ${l.href} `) && (l.real || src === 'head')) { matches.push(l); if (matches.length >= 8) break; }
    }
  }

  const startUrl = page.url();
  let finalUrl = null;
  if (matches.length) {
    const m = matches[0];
    const abs = m.href ? new URL(m.href, ctx.origin).href : null;
    if (abs && gate(abs)) return skin('blocked', [['state', 'robots.txt disallows the signup URL for retrieval agents'], ['candidate link', `${m.text} → ${m.href}`]]);
    steps.push({ detail: `click “${m.text.slice(0, 40)}”`, url: startUrl });
    let landed = false;
    try {
      const click = await clickAnchor(page, { src: m.src, idx: m.i });
      if (click.ok) { await waitForNav(page); landed = true; }
    } catch { /* */ }
    if (!landed && abs) {
      const r = await renderPage(page, abs, 20_000, gate);
      if (r.blockedByRobots) return skin('blocked', [['state', 'robots.txt disallows the signup URL for retrieval agents']]);
      landed = !!r.finalUrl;
    }
    await waitForNav(page, 6_000);
    finalUrl = page.url();
    steps.push({ detail: `landed on ${shortUrl(finalUrl)}`, url: finalUrl, ok: true });
    rows.push(['clicked', `${m.text || '(untitled)'} → ${m.href || '(no href)'}`]);
    rows.push(['final url', finalUrl]);
  } else {
    rows.push(['result', 'no signup/register/get-started link or button was found']);
    rows.push(['anchors scanned', `${cand.head.length} in header/nav, ${cand.all.length} on the page`]);
    rows.push(['sample labels', (cand.all.slice(0, 12).map((l) => l.text || '(image link)').join(' · ') || 'none').slice(0, 280)]);
  }

  let affordances = null;
  if (finalUrl) {
    if (!sameHost(finalUrl, ctx.origin)) {
      rows.push(['note', `signup navigation led off-site (${shortUrl(finalUrl)}) — no account form was opened here`]);
    } else {
      const snap = await domSnapshotBrowser(page).catch(() => null);
      if (snap) {
        if (snap.challenge) return skin('blocked', [...rows, ['challenge', snap.challengeDetail]], { finalUrl, steps });
        ctx.rendKeyPages.push({ label: 'signup', url: finalUrl, snapshot: snap });
        affordances = await page.evaluate(() => {
          const seen = [];
          let pw = 0, em = 0;
          for (const inp of document.querySelectorAll('input')) {
            if (inp.offsetWidth === 0) continue;
            const t = (inp.getAttribute('type') || '').toLowerCase();
            if (t === 'password') pw++;
            else if (t === 'email') em++;
          }
          const bodyTxt = (document.body && document.body.innerText) || '';
          const m = bodyTxt.match(/(sign ?in with|continue with|log ?in with) [A-Za-z ]{2,16}/g);
          return { pw, em, oauth: [...new Set(m || [])].slice(0, 4).map((s) => s.trim().slice(0, 60)) };
        });
        rows.push(['account affordances', `password fields: ${affordances.pw}, email fields: ${affordances.em}, OAuth/sign-in texts: ${affordances.oauth.length ? affordances.oauth.join(' / ') : 'none'}`]);
      }
    }
  }

  const signupishUrl = /sign[-_]?up|regist(er|ration)|create[-_]?account|join\b|getting[-_]?started|start[-_]?here|log[-_]?in|\/login|sign[-_]?in/i.test(finalUrl || '');
  const formish = affordances && (affordances.pw > 0 || affordances.em >= 1 || affordances.oauth.length > 0);
  if (finalUrl && formish && (signupishUrl || affordances.pw > 0)) {
    rows.push(['claim', 'reached a page where an account can be created (verified from navigation affordances; nothing was submitted)']);
    return skin('pass', rows, { finalUrl, steps });
  }
  if (formish) {
    rows.push(['note', 'element-level signup affordances were reached through a matching link, but the endpoint itself is not clearly an account-creation page']);
    return skin('partial', rows, { finalUrl, steps });
  }
  if (matches.length && !finalUrl) return skin('inconclusive', [...rows, ['result', 'the open navigation never completed']], { steps });
  if (matches.length && finalUrl) return skin('fail', [...rows, ['claim', 'no account-creation affordance on the page the signup link opens']], { finalUrl, steps });
  return skin('fail', [...rows, ['claim', 'no signup affordance reachable from the rendered homepage']], { steps });
}

/* ---------------- task: checkout (P5) ---------------- */

async function taskCheckout(ctx, page, budget) {
  const rows = [];
  const steps = [];
  const gate = robotsGateFor(ctx);
  if (budget < 9_000) return skin('skipped', [['state', 'time budget']]);

  if (ctx.pricingUrl && page.url() !== ctx.pricingUrl) {
    try {
      await page.goto(ctx.pricingUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await waitForNav(page, 4_000);
    } catch { /* fallthrough */ }
  }

  const cand = await collectAnchors(page);
  const matches = [];
  for (const [src, list] of [['all', cand.all], ['head', cand.head]]) {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (CTA_RX.test(` ${l.text} `) && l.real) { matches.push(l); if (matches.length >= 10) break; }
    }
  }
  matches.sort((a, b) => {
    const aCheck = CHECKOUT_URL_RX.test(a.href) || CHECKOUT_HOST_RX.test(a.href);
    const bCheck = CHECKOUT_URL_RX.test(b.href) || CHECKOUT_HOST_RX.test(b.href);
    if (aCheck && !bCheck) return -1;
    if (!aCheck && bCheck) return 1;
    return 0;
  });

  const startUrl = page.url();
  let finalUrl = null;
  let reached = null;
  let followed = null;

  for (const m of matches.slice(0, 3)) {
    const abs = new URL(m.href, ctx.origin).href;
    if (gate(abs)) { reached = skin('blocked', [['state', `robots.txt disallows ${shortUrl(abs)} — cannot follow this CTA`], ['cta', `${m.text} → ${m.href}`]]); break; }
    steps.push({ detail: `follow CTA “${m.text.slice(0, 36)}”`, url: startUrl });
    let ok = false;
    try {
      const click = await clickAnchor(page, { src: m.src, idx: m.i });
      if (click.ok) { await waitForNav(page, 8_000); ok = true; }
    } catch { /* */ }
    if (!ok) {
      const r = await renderPage(page, abs, 18_000, gate);
      if (r.blockedByRobots) continue;
      ok = !!r.finalUrl;
      if (ok && r.snapshot && r.snapshot.challenge) {
        reached = skin('blocked', [['challenge', r.snapshot.challengeDetail]], { steps });
        break;
      }
    }
    finalUrl = page.url();
    if (!ok) { steps.push({ detail: 'navigation did not complete', url: startUrl }); continue; }
    followed = m;
    steps.push({ detail: `landed on ${shortUrl(finalUrl)}`, url: finalUrl, ok: true });
    const snap = await domSnapshotBrowser(page).catch(() => null);
    const sig = checkoutSignals(finalUrl, snap, abs);
    if (sig.reached) {
      reached = skin('pass', ['fill'].length ? [
        ['cta followed', `${m.text || '(aria)'} → ${m.href}`],
        ['final url', finalUrl],
        ['checkout signals', sig.detail],
        ['claim', 'payment interface reached; auditor stopped here — nothing was entered, nothing was paid'],
      ] : [], { finalUrl, steps });
      break;
    }
    // second hop from the page we landed on
    const cand2 = await collectAnchors(page);
    const more = [];
    for (const [src, list] of [['head', cand2.head], ['all', cand2.all]]) {
      for (let i = 0; i < list.length; i++) {
        const l = list[i];
        if (CTA_RX.test(` ${l.text} `) && l.real && !/login|logout|sign[-_ ]?out|\/docs|blog|about|twitter|facebook|linkedin|github/i.test(l.href || '')) more.push(l);
        if (more.length >= 6) break;
      }
    }
    for (const m2 of more.slice(0, 2)) {
      const abs2 = new URL(m2.href, ctx.origin).href;
      if (gate(abs2)) continue;
      steps.push({ detail: `follow CTA “${m2.text.slice(0, 36)}”`, url: finalUrl });
      let ok2 = false;
      try {
        const click = await clickAnchor(page, { src: m2.src, idx: m2.i });
        if (click.ok) { await waitForNav(page, 8_000); ok2 = true; }
      } catch { /* */ }
      if (!ok2) {
        const r = await renderPage(page, abs2, 18_000, gate);
        if (r.blockedByRobots) continue;
        ok2 = !!r.finalUrl;
      }
      finalUrl = page.url();
      if (!ok2) continue;
      steps.push({ detail: `landed on ${shortUrl(finalUrl)}`, url: finalUrl });
      const snap2 = await domSnapshotBrowser(page).catch(() => null);
      const s2 = checkoutSignals(finalUrl, snap2, abs2);
      if (s2.reached) {
        reached = skin('pass', [
          ['cta chain', `${m.text.slice(0, 30)} → ${shortUrl(finalUrl)} → ${m2.text.slice(0, 30)} → ${shortUrl(finalUrl)}`],
          ['final url', finalUrl],
          ['checkout signals', s2.detail],
          ['claim', 'payment interface reached through a two-step CTA chain; stopped before payment'],
        ], { finalUrl, steps });
        break;
      }
    }
    if (reached) break;
    // try the next CTA
  }

  if (reached) { ctx.checkoutReached = true; return reached; }
  void followed;

  const contactOnly = contactSales(ctx);
  rows.push(['CTAs considered', matches.length ? matches.slice(0, 8).map((m) => `${m.text.slice(0, 34)} → ${String(m.href).slice(0, 70)}`).join('\n') : 'none found']);
  if (finalUrl) rows.push(['final url', finalUrl]);
  rows.push(['note', 'no checkout or payment interface was reached following plan CTAs within the allowed hop budget']);

  if (!matches.length && contactOnly) {
    return skin('na', rows, {
      notApplicableReason: 'the pricing surface offers contact-sales/conversation-only purchasing — there is no self-serve checkout to reach',
      steps,
    });
  }
  if (ctx.tasks.pricing && ctx.tasks.pricing.status === 'fail' && ctx.tasks.pricing.notApplicableReason) {
    return skin('na', rows, { notApplicableReason: ctx.tasks.pricing.notApplicableReason, steps });
  }
  return skin('fail', rows, { steps });
}

function checkoutSignals(url, snap, ctaHref) {
  const found = [];
  try {
    const u = new URL(url);
    if (CHECKOUT_URL_RX.test(u.pathname) || CHECKOUT_HOST_RX.test(u.host + u.pathname)) found.push('URL matches a checkout/payment step');
  } catch { /* */ }
  if (ctaHref && CHECKOUT_HOST_RX.test(ctaHref)) found.push('CTA href points to a payment provider');
  if (snap) {
    if (snap.paymentSignals && snap.paymentSignals.inputs) found.push(`payment-related input fields found (${snap.paymentSignals.inputs})`);
    if (snap.paymentSignals && snap.paymentSignals.iframes) found.push('payment provider iframe detected');
    if (snap.paymentSignals && snap.paymentSignals.text) found.push(`payment step text (“${snap.paymentSignals.text}”)`);
  }
  if (!snap) {
    // url-only signal
  }
  return { reached: found.length > 0, detail: found.join('; ') || 'none' };
}

function contactSales(ctx) {
  const a = (ctx.rendKeyPages || []).find((p) => p.label === 'pricing');
  const raw = (ctx.rawKeyPages || []).find((p) => p.label === 'pricing');
  const hay = `${raw && raw.snapshot ? raw.snapshot.textSample : ''} ${a && a.snapshot ? a.snapshot.textSample : ''}`;
  return /contact sales|talk to sales|book a (?:demo|call)|contact us for (?:pricing|a quote|custom)|request a (?:demo|quote)/i.test(hay);
}

/* ---------------- task: docs (U9) ---------------- */

async function taskDocs(ctx, page, budget) {
  const rows = [];
  const steps = [];
  const gate = robotsGateFor(ctx);
  if (budget < 8_000) return skin('skipped', [['state', 'time budget']]);

  if (page.url() !== ctx.origin + '/' && page.url() !== ctx.origin) {
    try {
      await page.goto(ctx.origin + '/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await waitForNav(page, 4_000);
    } catch { /* fallthrough */ }
  }

  const cand = await collectAnchors(page);
  const matches = [];
  for (const [src, list] of [['head', cand.head], ['all', cand.all]]) {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (NAV_PATTERNS.docs.test(`${l.text} ${l.href} `) && l.real) { matches.push(l); if (matches.length >= 8) break; }
    }
  }

  if (matches.length) {
    const m = matches[0];
    const abs = new URL(m.href, ctx.origin).href;
    if (gate(abs)) return skin('blocked', [['state', 'robots.txt disallows the docs URL for retrieval agents'], ['candidate link', `${m.text} → ${m.href}`]]);
    steps.push({ detail: `click “${m.text.slice(0, 40)}”`, url: page.url() });
    let ok = false;
    try {
      const click = await clickAnchor(page, { src: m.src, idx: m.i });
      if (click.ok) { await waitForNav(page); ok = true; }
    } catch { /* */ }
    if (!ok) {
      const r = await renderPage(page, abs, 18_000, gate);
      if (r.blockedByRobots) return skin('blocked', [['state', 'robots.txt disallows the docs URL for retrieval agents']]);
      ok = !!r.finalUrl;
    }
    await waitForNav(page, 6_000);
    const finalUrl = page.url();
    steps.push({ detail: `landed on ${shortUrl(finalUrl)}`, url: finalUrl, ok: true });
    rows.push(['docs link used', `${m.text || '(untitled)'} → ${m.href}`]);
    rows.push(['final url', finalUrl]);
    const snap = await domSnapshotBrowser(page).catch(() => null);
    const docsLike = looksDocsLike(finalUrl, snap);
    if (snap) {
      ctx.rendKeyPages.push({ label: 'docs', url: finalUrl, snapshot: snap });
      if (snap.challenge) return skin('blocked', [...rows, ['challenge', snap.challengeDetail]], { finalUrl, steps });
    }
    if (docsLike) return skin('pass', rows, { finalUrl, steps });
    rows.push(['result', 'clicking the docs label did not open documentation-like content']);
    return skin('fail', rows, { finalUrl, steps });
  }

  return skin('fail', [
    ['result', 'no docs/documentation/help/support link follows from the pages visited'],
    ['anchors scanned', `${cand.head.length} in header/nav, ${cand.all.length} on the rendered homepage`],
    ['sample labels', (cand.all.slice(0, 12).map((l) => l.text || '(image link)').join(' · ') || 'none').slice(0, 280)],
  ]);
}

function looksDocsLike(url, snap) {
  if (url && /\/(docs?|documentation|help(-|\/)?center|kb|knowledge|guides|faq|wiki)/i.test(new URL(url, 'https://x.com').pathname)) return true;
  if (snap && (snap.headingSeq || []).length >= 5 && snap.textChars >= 900) return true;
  return false;
}

/* ---------------- final adjustments ---------------- */

function nonCommercial(ctx) {
  const doms = [];
  if (ctx.homeDom) doms.push(ctx.homeDom);
  for (const pg of (ctx.crawl && ctx.crawl.pages) || []) if (pg.dom) doms.push(pg.dom);
  if (ctx.rendered && ctx.rendered.home) doms.push(ctx.rendered.home);
  const commerce = doms.some((d) => ((d.prices || []).length > 0 || (d.jsonLd || []).some((b) => /offer|product\b|price/i.test(b.type || ''))));
  const navPricing = ctx.navHits && (ctx.navHits.pricing || ctx.navHits.signup);
  const sitemapPricing = ctx.sitemap && ctx.sitemap.urlMatches && (((ctx.sitemap.urlMatches.pricing?.length || 0) + (ctx.sitemap.urlMatches.signup?.length || 0)) > 0);
  if (!commerce && !navPricing && !sitemapPricing) {
    return 'no pricing links, no price strings and no commerce structured data across all fetched pages — the surface looks non-commercial, so payments checks are N/A';
  }
  return null;
}

async function finalize(ctx) {
  // non-commercial → payments subchecks N/A
  const nc = nonCommercial(ctx);
  if (nc) {
    ctx.nonCommercial = true;
    for (const id of ['plans', 'checkout']) {
      if (ctx.tasks[id] && ['fail'].includes(ctx.tasks[id].status)) ctx.tasks[id].notApplicableReason = nc;
    }
    if (ctx.tasks.pricing && ctx.tasks.pricing.status === 'fail' && !ctx.tasks.pricing.notApplicableReason) ctx.tasks.pricing.notApplicableReason = nc;
  }
  // raw pricing page for P3/P4 comparisons (if the browser reached one)
  const pricingUrl = ctx.pricingUrl || (ctx.tasks.pricing && ctx.tasks.pricing.finalUrl);
  if (pricingUrl && sameHost(pricingUrl, ctx.origin) && !(ctx.rawKeyPages || []).some((p) => p.label === 'pricing' && p.ok)) {
    const already = (ctx.rawKeyPages || []).find((p) => p.label === 'pricing');
    const sameUrl = already && already.url === pricingUrl;
    if (!already || !sameUrl) {
      const p = ctx.robots && ctx.robots.parsed;
      if (!p || p.groups.length === 0 || isAllowed(p, 'cumulusbot', pricingUrl)) {
        try {
          const res = await safeFetch(pricingUrl, { cache: ctx.cache, accept: 'text/html', timeoutMs: 12_000 });
          ctx.rawKeyPages = ctx.rawKeyPages.filter((p2) => p2.label !== 'pricing');
          ctx.rawKeyPages.push({
            label: 'pricing', url: pricingUrl,
            status: res.ok ? res.status : null,
            ok: res.ok && res.status === 200,
            bytes: res.ok ? res.bytes : 0,
            snapshot: res.ok ? domSnapshot(res.body.toString('utf8'), { url: pricingUrl }) : null,
            blocked: false,
          });
        } catch { /* best effort */ }
      }
    }
  }
}

function sameHost(x, origin) {
  try {
    return new URL(x).hostname.replace(/^www\./, '') === new URL(origin).hostname.replace(/^www\./, '');
  } catch { return false; }
}

/* third-party resource hosts harvested from fetched raw HTML for the chromium allowlist */
function thirdPartyHosts(ctx) {
  const hosts = new Set();
  const push = (h) => {
    h = String(h || '').toLowerCase();
    if (!h || h.length > 80 || /^[0-9.]+$/.test(h) || h.includes(':') || !h.includes('.')) return;
    if (/(^|\.)localhost$|\.local$|\.internal$|\.lan$|\.home$|\.arpa$/.test(h)) return;
    hosts.add(h);
  };
  const raw = ctx.homeFetch && ctx.homeFetch.ok ? ctx.homeFetch.body.toString('utf8') : '';
  const rx = /(?:https?:)?\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;
  let m;
  while ((m = rx.exec(raw))) push(m[1]);
  return [...hosts];
}
