import * as cheerio from 'cheerio';

/* ------------------------------------------------------------------ */
/* Note parser                                                         */
/* ------------------------------------------------------------------ */

export function parseJsonLdBlocks(html) {
  if (!html) return [];
  const out = [];
  try {
    const $ = cheerio.load(html);
    $('script[type="application/ld+json"]').each((i, el) => {
      const txt = $(el).contents().text();
      try {
        const parsed = JSON.parse(txt.replace(/^\s+/u, ''));
        emit(parsed, out);
      } catch {
        // sometimes a JSON array is wrapped in comments; try stripping HTML comments
        try {
          const fixed = JSON.parse(txt.replace(/^\s*<!--/, '').replace(/-->\s*$/u, ''));
          emit(fixed, out);
        } catch { out.push({ ok: false, raw: txt.slice(0, 400) }); }
      }
    });
  } catch { /* not-whole html fallback */ }
  return out;
}

function emit(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => emit(n, out)); return; }
  if (node && typeof node === 'object') {
    if ('@graph' in node && Array.isArray(node['@graph'])) node['@graph'].forEach((n) => emit(n, out));
    out.push({ ok: true, type: node['@type'] || '', data: node, ...node });
  }
}

/* ------------------------------------------------------------------ */
/* DOM snapshot (used for both raw HTML via cheerio and rendered DOM)   */
/* ------------------------------------------------------------------ */

const PRICE_RX = /(?:[$€£¥₹]|USD|EUR|GBP|CAD|AUD|R[$]|R\$)\s?\d{1,7}(?:[.,]\d{2})?|\d{1,7}(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|CAD|AUD)/g;

export function collectPrices(text) {
  const found = new Set();
  const rx = new RegExp(PRICE_RX.source, 'g');
  let m;
  while ((m = rx.exec(text || ''))) { found.add(m[0].trim()); if (found.size > 60) break; }
  return [...found];
}

/**
 * DOM snapshot. Accepts HTML (cheerio) — the browser path (browser.js) produces
 * an equivalent object with page.evaluate.
 */
export function domSnapshot(html, { url = '' } = {}) {
  const $ = cheerio.load(html || '', { decodeEntities: true });
  const base = url;

  const title = ($('title').first().text() || '').trim();
  const metaDesc = ($('meta[name="description"]').attr('content') || '').trim();
  const robotsMeta = ($('meta[name="robots"]').attr('content') || $('meta[name="googlebot"]').attr('content') || '').trim();
  const lang = ($('html').attr('lang') || '').trim();
  const charset =
    ($('meta[charset]').attr('charset') || '').trim() ||
    ((($('meta[http-equiv="Content-Type"]').attr('content') || '').match(/charset=([\w-]+)/i) || [])[1] || '').trim();
  const viewport = ($('meta[name="viewport"]').attr('content') || '').trim();

  const canonicalHref = $('link[rel="canonical"]').attr('href') || '';
  const og = {
    title: ($('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content') || '').trim(),
    description: ($('meta[property="og:description"]').attr('content') || '').trim(),
    image: ($('meta[property="og:image"]').attr('content') || '').trim(),
    url: ($('meta[property="og:url"]').attr('content') || '').trim(),
  };

  const alternates = [];
  $('link[rel="alternate"]').each((i, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    const href = ($(el).attr('href') || '').toLowerCase();
    alternates.push({ type, href, hreflang: ($(el).attr('hreflang') || '').toLowerCase() });
  });

  // headings
  const h1s = [];
  const headingSeq = [];
  $('h1, h2, h3, h4, h5, h6').each((i, el) => {
    const tag = el.tagName.toLowerCase();
    const text = ($(el).text() || '').trim();
    if (tag === 'h1') h1s.push(text);
    headingSeq.push({ tag, text: text.slice(0, 120) });
    if (headingSeq.length > 120) return false;
  });

  // images
  let imgTotal = 0;
  let imgMissingAlt = 0;
  const missingAltSamples = [];
  $('img').each((i, el) => {
    imgTotal += 1;
    const hasAlt = typeof $(el).attr('alt') === 'string';
    const aria = $(el).attr('aria-label') || $(el).attr('title') || '';
    if (!hasAlt && !aria) {
      imgMissingAlt += 1;
      if (missingAltSamples.length < 10) {
        missingAltSamples.push({ src: ($(el).attr('src') || '').slice(0, 160) });
      }
    }
    if (imgTotal >= 400) return false;
  });

  // anchors
  const anchors = [];
  let namedAnchors = 0;
  $('a').each((i, el) => {
    const href = ($(el).attr('href') || '').trim();
    const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    const aria = ($(el).attr('aria-label') || $(el).attr('title') || '').trim();
    const named = text.length >= 2 || aria.length >= 2;
    if (named) namedAnchors += 1;
    if (anchors.length < 250) {
      anchors.push({
        href,
        text: text.slice(0, 80),
        aria: aria.slice(0, 80),
        imageAlts: ($(el).find('img[alt]').map((j, im) => $(im).attr('alt')).get().join(' ') || '').slice(0, 80),
      });
    }
  });
  let unnamedAnchors = Math.max(0, anchors.length - namedAnchors); // approx over cap
  
  // buttons
  let buttonsTotal = 0;
  let buttonsUnnamed = 0;
  const unnamedBufferSamples = [];
  $('button, [role="button"], input[type="submit"], input[type="button"]').each((i, el) => {
    buttonsTotal += 1;
    const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    const aria = ($(el).attr('aria-label') || $(el).attr('title') || ($(el).attr('value') || '')).trim();
    if (!text && !aria) {
      buttonsUnnamed += 1;
      if (unnamedBufferSamples.length < 8) unnamedBufferSamples.push(($(el).attr('class') || '').slice(0, 80));
    }
    if (buttonsTotal >= 300) return false;
  });

  // forms + labelled fields
  const forms = [];
  $('form').each((i, el) => {
    const f = { action: ($(el).attr('action') || '').trim(), method: ($(el).attr('method') || 'get').toLowerCase(), fields: [], unlabeled: 0 };
    $(el).find('input, select, textarea').each((j, inp) => {
      const type = ($(inp).attr('type') || inp.tagName.toLowerCase()).toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return;
      const id = $(inp).attr('id') || '';
      let labeled = false;
      if ($(inp).attr('aria-label') || $(inp).attr('aria-labelledby')) labeled = true;
      else if (id && $(el).find(`label[for="${id.replace(/"/g, '\\"')}"]`).length) labeled = true;
      else if ($(inp).parents('label').length) labeled = true;
      else if ($(inp).attr('title')) labeled = true;
      const leg = $(inp).attr('placeholder') || '';
      f.fields.push({ type, label: labeled ? 'labeled' : (leg ? `placeholder-only` : 'none'), name: $(inp).attr('name') || '' });
      if (!labeled) f.unlabeled += 1;
    });
    if (f.fields.length && forms.length < 12) forms.push(f);
  });
  const unlabeledFields = forms.reduce((n, f) => n + f.unlabeled, 0);

  // landmarks
  const $body = $('body');
  const hasMain = $body.find('main,[role="main"]').length > 0 || $('main').length > 0;
  const navCandidates = $('nav, [role="navigation"], header').toArray();
  let navRealLinks = 0;
  let navPseudoLinks = 0;
  navCandidates.slice(0, 6).forEach((el) => {
    $(el).find('a').each((j, a) => {
      const href = ($(a).attr('href') || '').trim();
      if (!href || href === '#' || href.toLowerCase().startsWith('javascript:')) navPseudoLinks += 1;
      else navRealLinks += 1;
    });
  });
  const hasFooter = $body.find('footer,[role="contentinfo"]').length > 0 || $('footer').length > 0;
  const hasNav = navCandidates.length > 0 || $('header').length > 0;

  // anchors without href that look interactive (clickable divs/buttons acting on nav) - rough heuristic
  const $scriptTags = $('script');
  const inlineScripts = $scriptTags.filter((i, el) => !$(el).attr('src')).length;

  // visible-ish text (script/style stripped) — use a fresh parse to avoid clone quirks
  let text = '';
  try {
    const $2 = cheerio.load(html || '', { decodeEntities: true });
    $2('script, style, noscript, template, svg[aria-hidden="true"]').remove();
    text = ($2.text() || '').replace(/\s+/g, ' ').trim();
  } catch { /* fall through with empty text */ }
  const textChars = text.length;
  const textSample = text.slice(0, 400);

  const prices = [...new Set(collectPrices(text))];
  const jsonLd = parseJsonLdBlocks(html);

  // top nav link list for discovery checks
  const navLinks = [];
  navCandidates.slice(0, 4).forEach((el) => {
    $(el).find('a').each((j, a) => {
      const href = ($(a).attr('href') || '').trim();
      const t = ($(a).text() || '').replace(/\s+/g, ' ').trim();
      if (href && navLinks.length < 40) navLinks.push({ href, text: t });
    });
  });

  return {
    kind: 'static',
    url: base,
    title, titleLen: title.length,
    metaDesc, metaDescLen: metaDesc.length,
    robotsMeta, lang, charset, viewport,
    canonicalHref, og, alternates,
    h1Count: h1s.length, h1: h1s.slice(0, 5), headingSeq,
    imgTotal, imgMissingAlt, missingAltSamples,
    anchors, anchorCount: anchors.length, unnamedAnchors,
    buttonsTotal, buttonsUnnamed, unnamedBufferSamples,
    forms, unlabeledFields,
    landmarks: { main: hasMain, nav: hasNav, footer: hasFooter },
    navRealLinks, navPseudoLinks, navLinks,
    textChars, textSample, prices,
    jsonLd, inlineScripts,
  };
}
