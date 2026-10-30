/*
 * findings.js — remediation content per check id.
 *
 * Every finding presented to a user (report UI, REST /findings, fix-kit
 * Markdown) gets: problem · evidence · impact · fix steps · acceptance
 * criteria · a verification command. Unwritten ids fall back to a generic
 * entry built from the check definition, so a finding is never empty.
 */

const LIMIT_NOTE = 'The auditor never fills or submits forms, never creates an account and never carries out a payment.';

const F = {
  /* ---------------- Discovery ---------------- */
  D1: {
    problem: 'Every compliant agent starts at /robots.txt, both to respect your policy and to learn where your sitemap is. If it is missing (or not served with HTTP 200), agents can only guess.',
    impact: 'Without a robots.txt, your policy is implicit (mostly "allow"), and agents lose the standard pointer to your sitemap. In the worse case, a gateway error on that path makes fetchers back off.',
    fix: [
      'Publish a plain-text robots.txt at the site root, served with HTTP 200 and `content-type: text/plain`.',
      'Start from the default-allow case; carry over only real exclusions (e.g. `Disallow: /cart`).',
      'Add a `Sitemap: <absolute URL>` line pointing at your XML sitemap.',
    ],
    ac: ['GET /robots.txt returns HTTP 200 with text/plain.', 'The file parses without errors and includes at least one `Sitemap:` directive when a sitemap exists.'],
    verify: 'curl -fsS https://YOUR-SITE/robots.txt',
  },
  D2: {
    problem: 'One or more AI retrieval agents (the assistants that fetch pages on behalf of users, and AI search crawlers) are disallowed by robots.txt rules aimed at them specifically.',
    impact: 'Agents that obey robots.txt will never read the disallowed paths — your product facts stop being visible to exactly the users who delegate questions to AI assistants. Traffic from those agents disappears without any error being logged on your side.',
    fix: [
      'Review the User-agent groups aimed at ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User and OAI-SearchBot.',
      'Decide deliberately: retrieval access for assistants is generally safe (a single render, not model training). If you must block some paths, block them narrowly.',
      'If the goal is an opt-out from training, target training crawlers (GPTBot, CCBot, Google-Extended…) in their own groups — not retrieval agents.',
    ],
    ac: ['robots.txt allows `/` (and pricing/docs paths) for every tested retrieval agent.', 'Re-audit reports D2 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/robots.txt | grep -iA3 "user-agent: chatgpt-user"',
  },
  D3: {
    problem: 'No XML sitemap was found — neither via the `Sitemap:` directive in robots.txt nor at the standard locations (/sitemap.xml, /sitemap_index.xml, /sitemap-index.xml, /wp-sitemap.xml).',
    impact: 'Agents that map a site from its sitemap see nothing: pages that are not prominently linked do not exist for them. Human visitors find those pages through on-page flows; agents often never do.',
    fix: [
      'Generate an XML sitemap covering your public pages (most frameworks/plugins can emit one).',
      'Reference it from robots.txt with an absolute URL.',
      'Keep it under ~50,000 URLs / 50 MB per file and use sitemap indexes for larger sites.',
    ],
    ac: ['A `Sitemap:` line in robots.txt (or /sitemap.xml) serves valid XML with a `<urlset>`.', 'Re-audit reports D3 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/sitemap.xml | head -5',
  },
  D4: {
    problem: 'A sitemap exists, but pricing, docs or signup pages are absent from it.',
    impact: 'The pages you most want agents to reach are invisible to the agents that enumerate from the sitemap — the sitemap tells them everything else matters more.',
    fix: [
      'Add your canonical pricing, docs and signup URLs to the sitemap.',
      'Keep entries 200-OK only, and drop redirects or soft-404s.',
    ],
    ac: ['The sitemap lists the canonical URLs of pricing, docs and signup.', 'Re-audit reports D4 as Partial or Pass (≥2 of 3 present).'],
    verify: 'curl -fsS https://YOUR-SITE/sitemap.xml | grep -Ei "pricing|docs|signup"',
  },
  D5: {
    problem: 'No /llms.txt is published. This is an emerging convention: a curated Markdown map of the site at a stable URL, written for language-model consumption.',
    impact: 'Without it, agents must parse layout and navigation to work out what your site contains, which is more fragile and slower than reading one curated file.',
    fix: [
      'Create a Markdown file listing name, one-line description and URL of your key content areas.',
      'Publish it at /llms.txt served with HTTP 200 and `text/plain` or `text/markdown`.',
      'Link key detail pages with one line each; keep it maintained alongside docs releases.',
    ],
    ac: ['GET /llms.txt returns HTTP 200 with a non-empty Markdown body.', 'Re-audit reports D5 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/llms.txt',
  },
  D6: {
    problem: 'The homepage title and/or meta description are missing, empty or an unusable length for summarisation.',
    impact: 'Title and meta description are the summary an agent reads before deciding to spend context on a page. Weak or missing ones make the agent guess about your site, or skip it.',
    fix: [
      'Give the homepage a `<title>` of roughly 10–90 characters containing the brand and what it does.',
      'Add `<meta name="description">` of roughly 20–300 characters answering "what is this?" in plain language.',
      'Check the representative subpages (pricing, docs) inherit sensible titles.',
    ],
    ac: ['The page has a non-empty `<title>` (4–90 chars) and a meta description (20–300 chars).', 'Re-audit reports D6 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -Eo "<title[^>]*>[^<]*</title>|name=\"description\"[^>]*>"',
  },
  D7: {
    problem: 'The page declares no canonical URL — and has no og:url fallback either.',
    impact: 'Agents meeting http/https, www/apex or query-string variants treat them as different documents. Machine summarisation and caches end up split, and the "wrong" variant can outrun the one you meant.',
    fix: [
      'Add `<link rel="canonical" href="…">` to each template, with one chosen host form and no parameters.',
      'If your generators cannot emit it, at minimum publish `og:url`.',
    ],
    ac: ['Every public template emits a canonical link with an absolute URL.', 'Re-audit reports D7 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -i "rel=.*canonical"',
  },
  D8: {
    problem: 'The site has no valid JSON-LD structured data, or the blocks it does carry fail to parse.',
    impact: 'JSON-LD states facts explicitly — organisation, products, prices, articles — so agents do not need to walk the DOM. Without it they infer everything from copy, and inference is where they get it wrong.',
    fix: [
      'Add a `<script type="application/ld+json">` block with at least `@type: Organization|WebSite` on the homepage.',
      'Validate each block with a JSON parser — a single trailing comma invalidates the block (this is the usual cause of "unparseable block").',
      'On pricing pages add Product/Offer; on docs add TechArticle where sensible.',
    ],
    ac: ['At least one valid ld+json block parses and declares `@type`.', 'Re-audit reports D8 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -c "application/ld+json"',
  },
  D9: {
    problem: 'The homepage navigation does not link (with literal, named anchors) to pricing, docs or signup.',
    impact: 'Agents pick destinations by visible labels in link graphs. An unlinked page is invisible to any agent that navigates from the homepage — and also to crawlers that prize nav depth.',
    fix: [
      'Expose Pricing, Docs and Signup as real `<a href>` items in the header/footer navigation.',
      'Use stable human labels ("Pricing", "Docs") — agents match on text and href, not icons or JS state.',
    ],
    ac: ['The rendered nav contains followable links whose text/href match pricing, docs and signup.', 'Re-audit reports D9 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -Eio "href=\"[^\"]*(pricing|docs|signup)[^\"]*\""',
  },
  D10: {
    problem: 'The homepage sets no Open Graph metadata (og:title/og:image), or only one of the pair.',
    impact: 'Link previews in chat tools and agent summaries fall back to a bare URL or an arbitrary h1/card. Sharing your product loses its name, description and image in the places agent users actually paste links.',
    fix: [
      'Add `og:title`, `og:description`, `og:type` and `og:image` (absolute image URL ≥ 1200×630 preferred).',
      'Add `og:url` echoing the canonical URL.',
    ],
    ac: ['og:title and og:image are present on public templates.', 'Re-audit reports D10 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -i "og:title\\|og:image"',
  },

  /* ---------------- Access ---------------- */
  A1: {
    problem: 'The homepage could not be fetched by a plain HTTP(S) client, or is not served over HTTPS, or did not respond with HTML.',
    impact: 'This is ground zero: nothing else can be tested, and no agent — fetch-style or browser — can read the site at all.',
    fix: [
      'Resolve the serving error the auditor reported in the evidence block (timeout, connection refused, non-200, wrong content-type).',
      'Serve your site (and all key pages) over HTTPS with a valid certificate.',
      'Test without cookies, JavaScript or a country whitelist: a plain GET must return HTML.',
    ],
    ac: ['A plain GET of the homepage returns 200 with text/html over HTTPS.', 'Re-audit reports A1 as Pass.'],
    verify: 'curl -fsSI https://YOUR-SITE/',
  },
  A2: {
    problem: 'The rendered DOM carries far more text than the initial HTML — the primary content is assembled by JavaScript after page load.',
    impact: 'Fetching agents read the bytes your server sends. Where the key content exists only after JS, those agents see a shell: empty pricing, empty docs, nothing to quote.',
    fix: [
      'Server-render (or prerender) homepage, pricing and docs content so text exists in the initial HTML.',
      'Keep client-side scripts for interactivity only; never rely on them to insert the product facts.',
      'If your stack cannot server-render, pre-render at build time for the key routes.',
    ],
    ac: ['Raw-HTML text reaches ≥55% of the rendered text (ideally near 100%) on the homepage and pricing page.', 'Re-audit reports A2 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | wc -c',
  },
  A3: {
    problem: 'Requests shaped like an autonomous agent (no browser, plain UA) are challenged (CAPTCHA/interstitial) or dropped (401/403/429) instead of receiving the page.',
    impact: 'Bot-walls aimed at datacentre traffic take out legitimate assistants too. Fetching agents stop at the door: they cannot see any page, however well it is built. Human traffic looks fine, which is why the problem is easy to miss.',
    fix: [
      'Update WAF/bot rules so known AI-assistant UAs (ChatGPT-User, Claude-User, Perplexity-User…) are not challenged on public pages.',
      'Avoid serving CAPTCHA interstitials to requests that merely GET a public page.',
      'If you rate-limit, return 429 with a Retry-After rather than a challenge page (and keep public pages far from the limit).',
    ],
    ac: ['A plain-HTTP request with a non-browser UA gets the actual page (200), not a challenge.', 'Re-audit reports A3 as Pass or Inconclusive (recoverable state).'],
    verify: 'curl -fsS -A "AIAssistant/1.0" https://YOUR-SITE/ -o - | head -20',
  },
  A4: {
    problem: 'A public page carries `meta name="robots" content="… noindex …"` (or Googlebot equivalent).',
    impact: 'noindex is a standing instruction for retrieval systems to forget the page. Applied by accident to catalogues or docs (common with previews and staging configs leaking to prod), the page disappears from agent search results.',
    fix: [
      'Audit the `<meta name="robots">` and `X-Robots-Tag` headers across public templates.',
      'Remove noindex from pages agents should read; keep it only on genuinely private/utility pages.',
      'Verify the prod build does not inherit noindex from staging defaults.',
    ],
    ac: ['No public page returns a noindex directive.', 'Re-audit reports A4 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -i "name=\"robots\""',
  },
  A5: {
    problem: 'The homepage HTML is very large (well over the ~300 KB many fetchers safely ingest).',
    impact: 'Fetchers with capped context windows truncate or drop oversized documents, often losing the useful part (which sits after inline data, styles or scripts).',
    fix: [
      'Move inlined data blobs out of HTML and behind endpoints/',
      'Strip block-listed scripts/styles; check for accidental base64 payloads.',
      'As a rule of thumb keep the initial HTML under ~300 KB (uncompressed) on core pages.',
    ],
    ac: ['Homepage and key pages are ≤ 300 KB HTML (or at minimum ≤ 1 MB).', 'Re-audit reports A5 as Partial or Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | wc -c',
  },
  A6: {
    problem: 'The page has no `lang` attribute on `<html>`, or an invalid primary tag.',
    impact: 'Agents use it to choose language handling, translation and locale-sensitive answers; a missing or broken lang risks skewed extraction and wrong-language replies.',
    fix: [
      'Set `<html lang="…">` (BCP-47 primary tag, e.g. `en`, `de`, `pt-BR`) on every template.',
    ],
    ac: ['The homepage `<html>` carries a valid BCP-47 lang attribute.', 'Re-audit reports A6 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -io "<html[^>]*lang[^>]*>"',
  },
  A7: {
    problem: 'No machine-readable alternate (RSS, Atom, Markdown) is advertised through `<link rel="alternate">`.',
    impact: 'Alternates let agents consume your content without page-layout parsing. Their absence leaves every agent scraping DOM shapes that change under them.',
    fix: [
      'Advertise a feed: `<link rel="alternate" type="application/rss+xml" …>` (blog/changelog).',
      'For docs, consider publishing Markdown sources and linking them as alternates: `type="text/markdown"`.',
    ],
    ac: ['At least one non-hreflang machine-readable alternate is advertised (or genuinely no feed-worthy content exists — then file as N/A).', 'Re-audit reports A7 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -i "rel=.*alternate"',
  },
  A8: {
    problem: 'A discovered key page (pricing/docs/signup) failed to load with a plain agent-shaped request.',
    impact: 'The agent did the hard part (finding the URL) and then hit a wall: 4xx/5xx, non-HTML, or robots. The answer a user delegated ("what does Pro cost?") never arrives.',
    fix: [
      'Fix the failures listed in the evidence (status codes, content types).',
      'Re-check redirects: chains that end off-site or in dead paths count as failures.',
    ],
    ac: ['Every discovered key page returns 200 HTML to a plain GET (robots allowed).', 'Re-audit reports A8 as Pass.'],
    verify: 'curl -fsSI https://YOUR-SITE/pricing',
  },

  /* ---------------- Usability ---------------- */
  U1: {
    problem: 'The page has zero, several, or structurally broken headings (level skips), so its outline does not segment cleanly.',
    impact: 'Agents skim through headings to build an internal map of the page. A broken outline (empty h1, multiple h1s, h2 after h4) miscarries that map and loses detail.',
    fix: [
      'Exactly one `<h1>` per page, stating the page topic.',
      'Use h2/h3 in strict order under it; avoid level skips.',
    ],
    ac: ['Rendered page has one h1 and an outline with no level skips.', 'Re-audit reports U1 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -Eio "<h1[^>]*>[^<]*</h1>"',
  },
  U2: {
    problem: 'The page is missing semantic landmarks (`main`, `nav`, `footer` or their roles).',
    impact: 'Landmarks separate content from chrome. Without them, agents can spend context on legalese and cookie banners — or quote the wrong part of the page.',
    fix: [
      'Wrap page content in `<main>`, put site links in `<nav>`, footer in `<footer>`.',
      'Add `role="main"` / `role="navigation"` where the tags cannot be used.',
    ],
    ac: ['Rendered page exposes `<main>`, `<nav>` and `<footer>`. ', 'Re-audit reports U2 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -Eio "<(main|nav|footer)[ >]"',
  },
  U3: {
    problem: 'A sizeable share of `<img>` elements have no alt/aria-label text.',
    impact: 'Agents cannot see images at all. Charts, logos and diagrams without text equivalents are gaps in their understanding; alt text may also double as anchor text for image links.',
    fix: [
      'Give every content image a meaningful `alt`.',
      'Use empty `alt=""` only for decorative images.',
      'For icon-only links add `aria-label`.',
    ],
    ac: ['≤5% of images lack alt/aria-label text (0% is Pass).', 'Re-audit reports U3 as Pass or Partial (≤30%).'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -io "<img[^>]*>" | grep -vc "alt="',
  },
  U4: {
    problem: 'Many anchors are unnamed — no visible text or aria-label an agent can act on.',
    impact: 'In the link graph these are dead ends: an agent cannot decide "follow this" for a link it cannot describe, so content behind them disappears.',
    fix: [
      'Name links with visible text wherever possible.',
      'For icon-only anchors use `aria-label`.',
      'Avoid duplicated "click here"-type labels that give no hint of the destination.',
    ],
    ac: ['≤5% of anchors lack both text and aria-label (0% is Pass).', 'Re-audit reports U4 as Pass.'],
    verify: 'grep -Eio "<a [^>]*>" page.html | grep -viE "aria-label|>/><" - | wc -l  (manual review)',
  },
  U5: {
    problem: 'Buttons on the page expose no accessible name (no text, no aria-label, no value).',
    impact: 'Icon-only buttons — hamburger menus, close gadgets, arrow CIPs — are unexplainable to text-only agents. If a key action (e.g. mobile nav that opens pricing) hides behind one, the agent never finds it.',
    fix: [
      'Give buttons text labels; for icon-only ones add `aria-label` (or `title`).',
      'If the name lives in a wrapped SVG/text span, it still counts — verify in the DOM, not the design file.',
    ],
    ac: ['0 unnamed buttons in the rendered DOM.', 'Re-audit reports U5 as Pass.'],
    verify: 'document.querySelectorAll("button").forEach(b => { const n = (b.textContent||"").trim(); if (!n && !b.getAttribute("aria-label")) console.log(b.outerHTML.slice(0, 80)); });',
  },
  U6: {
    problem: 'Form fields lack proper labels (aria-label, `<label for>`, wrapping label) — placeholders alone are ambiguous.',
    impact: 'Assistants offering legitimate help with forms rely on labelled fields; placeholder-only names are guesses. Unlabelled fields are also an accessibility failure for human users.',
    fix: [
      'Attach a `<label for="id">` (or wrapping label) to every visible input.',
      'Add `aria-label` where visual labels are suppressed.',
      'Pay special attention to email/newsletter and search forms.',
    ],
    ac: ['0 unlabelled fields across homepage forms.', 'Re-audit reports U6 as Pass or Partial (≤20%).'],
    verify: 'document.querySelectorAll("form input:not([type=hidden]), form select, form textarea").forEach(i => { /* assert labelled */ });',
  },
  U7: {
    problem: 'Navigation entries are pseudo-links: `href="#"`, `javascript:` URLs or click-handler-only "links".',
    impact: 'Fetch-only agents can execute no JavaScript. What humans reach by clicking is unreachable to plain fetching — nav effectively hides your content tree from a whole agent class.',
    fix: [
      'Render real `<a href>` for destinations, and let JS enhance progressively.',
      'For widgets that require interaction (menus, selves), expose the underlying URLs somewhere crawlable.',
    ],
    ac: ['≥3 real hrefs in nav areas and 0 pseudo-links.', 'Re-audit reports U7 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/ | grep -Eio "href=\"(#|javascript:[^\"]*)\"" | wc -l',
  },
  U8: {
    problem: 'An agent following links from your homepage cannot reach an account-creation affordance (or what it finds there is not clearly a signup).',
    impact: 'A delegated "help me get started" task dead-ends. Signup is the front door for users who arrive through the agent, so what is uncrawlable there is also uncaptured.',
    fix: [
      'Expose signup/register/create-account as a link with a human label.',
      'Point it at a page that visibly offers sign-up (email/password fields, OAuth providers).',
    ],
    ac: ['Following nav labels from `/` reaches a page with clear account-creation affordances.', 'Re-audit reports U8 as Pass.'],
    verify: `Agent task, manually: open the homepage, click "Sign up". ${LIMIT_NOTE}`,
  },
  U9: {
    problem: 'The docs/help/knowledge-base link is missing, broken, or the destination is not documentation-like content.',
    impact: 'Agents answer "how do I…" questions from your docs. If they cannot reach them, they answer from guesses — which is worse than a refusal.',
    fix: [
      'Link docs/help/support/knowledge-base prominently and keep a dedicated surface.',
      'Ensure GET of the docs URL (with a plain UA) returns real content.',
    ],
    ac: ['A docs link is followed to a docs-like page with real content.', 'Re-audit reports U9 as Pass.'],
    verify: 'Agent task, manually: open the homepage, click "Docs"/"Help". ',
  },

  /* ---------------- Payments ---------------- */
  P1: {
    problem: 'An agent following links from your homepage cannot reach a pricing page (no pricing link, or landed content is not pricing-like).',
    impact: 'The most common delegated commercial question is "what does it cost?" If a link-following agent cannot reach pricing, that question goes unanswered or fabricates an answer.',
    fix: [
      'Add a Pricing link (real `<a href>`), visible in the header/footer nav.',
      'Make the destination genuinely pricing-like: plan names, prices, and comparable copy.',
    ],
    ac: ['A pricing URL is reachable by following links and contains pricing signals (plan/price text).', 'Re-audit reports P1 as Pass.'],
    verify: 'Agent task, manually: open the homepage, click "Pricing". ',
  },
  P2: {
    problem: 'The rendered pricing page does not expose readable plan names and prices as text.',
    impact: 'This is how agents answer plan questions: extract plan name + price as text. If the facts are not readable — images, canvas, nested canvas, or unlabeled price chips — the agent cannot relay them.',
    fix: [
      'Present each plan as text (name h2/h3 + price with symbol/period).',
      'Keep them in the DOM — not only in images or canvas.',
    ],
    ac: ['At least one (ideally ≥2) named plan with a readable price is extractable from DOM text.', 'Re-audit reports P2 as Pass or Partial.'],
    verify: 'Agent task, manually: on the pricing page, verify text like "Pro — $24 / month".',
  },
  P3: {
    problem: 'Plan prices appear in the rendered page only after JavaScript runs — the server HTML carries none of them.',
    impact: 'Every fetch-only agent misses JavaScript-injected prices: your pricing exists for browser agents only, half the agent population reads zero plans.',
    fix: [
      'Server-render plan prices into the initial HTML of the pricing route.',
      'If the values genuinely need client code (e.g. currency switching), render a default value server-side and hydrate on top.',
    ],
    ac: ['`curl` of the pricing URL contains every plan price string (or the page is truelly JS-only with a text fallback).', 'Re-audit reports P3 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/pricing | grep -Eo "\\$[0-9]+([.,][0-9]{2})?"',
  },
  P4: {
    problem: 'The pricing page has no valid JSON-LD offer/product markup with machine-readable price fields.',
    impact: 'schema.org Product/Offer states price, currency and availability unambiguously. Without it, agents parse visual layout, error-prone and fragile to design changes.',
    fix: [
      'Add a JSON-LD block per plan (Product with an Offer: `price`, `priceCurrency`).',
      'For subscriptions model priceSpecification price or reference OfferCatalog.',
      'Keep values in sync with the rendered prices.',
    ],
    ac: ['Valid ld+json on the pricing page carries Product/Offer types with price fields.', 'Re-audit reports P4 as Pass or Partial.'],
    verify: 'curl -fsS https://YOUR-SITE/pricing | grep -i "application/ld+json"',
  },
  P5: {
    problem: 'Following plan CTAs from the pricing page never reaches a checkout/payment interface.',
    impact: 'The end of the purchase journey is uncrawlable: the agent can find plans but cannot complete what the user asked. Friction here is usually invisible in web analytics because agents leave silently.',
    fix: [
      'Make plan CTAs real links pointing at a checkout/payment step.',
      'If checkout is behind account creation, surface that link chain clearly (plan → signup/login → checkout).',
      'For browser-only checkout, keep the entry links real — otherwise the journey dies early.',
    ],
    ac: ['Following a plan CTA lands on a checkout/payment step within two hops. ' + LIMIT_NOTE, 'Re-audit reports P5 as Pass.'],
    verify: 'Agent task, manually: on pricing, follow "Get started"/"Upgrade". ' + LIMIT_NOTE,
  },
  P6: {
    problem: 'Plan CTAs are script-only buttons with no href — they cannot be followed by a fetcher and never appear in the link graph.',
    impact: 'The agent can see that "Upgrade" exists but has no URL to follow: for fetch-only agents, the plan ends there.',
    fix: [
      'Render each plan CTA as `<a href="…">` (points at checkout or signup), styled as a button.',
      'Keep the plan id in the URL so a single GET resolves the intent (`/checkout?plan=pro`).',
    ],
    ac: ['Every plan CTA is an anchor with a real href.', 'Re-audit reports P6 as Pass.'],
    verify: 'curl -fsS https://YOUR-SITE/pricing | grep -Eo "<a [^>]*href=\"[^\"]*\"[^>]*>[^<]*(get started|choose|upgrade|buy)" -i',
  },
};

const GENERIC = {
  problem: 'The check observed a state that hurts agent legibility; see the evidence block for what exactly was observed.',
  impact: 'This degrades how reliably AI agents can discover, read or act on your site for the affected paths.',
  fix: ['Review the evidence above against the check description.', 'Fix the underlying page/policy and re-run the audit to confirm.'],
  ac: ['The check\'s evidence no longer shows the failing state.', 'Re-audit reports this check as Pass (or N/A where the precondition does not hold).'],
  verify: 'Re-run: cumulus audit https://YOUR-SITE (or the equivalent REST call).',
};

/**
 * Build public finding copy for one check result.
 * @returns {summary, problem, impact, fix[], ac[], verify}
 */
export function describeFinding(id, ctxHint = {}) {
  const base = F[id] || GENERIC;
  return { ...base, summary: summarize(id, base, ctxHint) };
}

function summarize(id, base, { evidence = [], note = null } = {}) {
  const leading = evidence.slice(0, 3).filter(([k]) => !['note', 'claim'].includes(k));
  if (note) return note;
  if (leading.length) {
    const tail = leading.map(([k, v]) => `${k}: ${Array.isArray(v) ? v[0] : String(v).slice(0, 90)}`).join(' — ');
    return tail.slice(0, 240);
  }
  return base.problem.split(/(?<=\.)\s/)[0];
}

export const FINDINGS_LIBRARY = F;
