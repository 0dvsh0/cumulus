/*
 * test/fixture.js — a small deterministic website used by the e2e suite.
 * Target: http://127.0.0.1:FIXTURE_PORT (allowed only because the test runs
 * the server with CUMULUS_ALLOW_PRIVATE=1).
 *
 * Serves: homepage (rich content, JSON-LD, OG, sitemap+llms links, nav to
 * pricing/docs/signup), /pricing (server-rendered plans + CTA anchors to
 * checkout), /docs, /signup (form with labels), /checkout (payment-looking
 * step), robots.txt (allow all), sitemap.xml, llms.txt.
 */
import express from 'express';

const CSS = 'body{font-family:sans-serif}>';
const PAGE = (title, body, extraHead = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title} — Fixture Cloud</title>
<meta name="description" content="Fixture Cloud is a demo cloud product used for tests with readable content.">
<link rel="canonical" href="https://fixture.test${title === 'Home' ? '/' : '/' + title.toLowerCase()}/">
<meta property="og:title" content="${title} — Fixture Cloud"><meta property="og:image" content="/og.png">
${extraHead}</head><body>
<header><nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/signup">Sign up</a><a href="/blog">Blog</a></nav></header>
<main>${body}</main>
<footer><footer-content>© Fixture Cloud</footer-content></footer>
</body></html>`;

export function createFixture({ port = 4701 } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /private\nSitemap: http://127.0.0.1:' + port + '/sitemap.xml\n');
  });

  app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://127.0.0.1:${port}/</loc></url>
  <url><loc>http://127.0.0.1:${port}/pricing</loc></url>
  <url><loc>http://127.0.0.1:${port}/docs</loc></url>
  <url><loc>http://127.0.0.1:${port}/signup</loc></url>
  <url><loc>http://127.0.0.1:${port}/blog</loc></url>
</urlset>`);
  });

  app.get('/llms.txt', (req, res) => {
    res.type('text/markdown').send('# Fixture Cloud\n\n> Demo SaaS for the Cumulus test suite.\n\n## Pages\n- [Pricing](http://127.0.0.1:' + port + '/pricing): plans and prices\n- [Docs](http://127.0.0.1:' + port + '/docs): how to integrate\n- [Signup](http://127.0.0.1:' + port + '/signup): create an account\n');
  });

  app.get('/', (req, res) => {
    res.type('html').send(PAGE('Home', `
      <h1>Fixture Cloud</h1>
      <h2>Reliable demo hosting for your tests</h2>
      <p>${'Fixture Cloud serves deterministic pages to the Cumulus auditor. '.repeat(12)}</p>
      <p>We publish open <a href="/docs">documentation</a>, a public <a href="/pricing">pricing page</a>
      and a fast <a href="/signup">signup</a>. Read the <a href="/blog">changelog</a> for updates.
      Everything is server-rendered plain text: $9 Starter, $24 Pro, $99 scale.</p>
      <img src="/hero.png" alt="Dashboard screenshot">
      <img src="/arrow.png">
      <form method="get" action="/search"><input type="email" name="mail" aria-label="Email address" placeholder="you@corp.example"><button type="submit">Subscribe</button></form>
    `, '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture Cloud","url":"https://fixture.test"}</script>'));
  });

  app.get('/pricing', (req, res) => {
    res.type('html').send(PAGE('Pricing', `
      <h1>Pricing</h1>
      <div class="plans" style="display:flex;gap:16px">
        <div class="plan" style="min-width:200px"><h3>Starter</h3><p>$9 / month</p><a href="/checkout?plan=starter">Get started</a></div>
        <div class="plan" style="min-width:200px"><h3>Pro</h3><p>$24 / month</p><a href="/checkout?plan=pro">Get started</a></div>
        <div class="plan" style="min-width:200px"><h3>Scale</h3><p>$99 / month</p><a href="/checkout?plan=scale">Get started</a></div>
      </div>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Fixture Pro","offers":{"@type":"Offer","price":"24.00","priceCurrency":"USD"}}</script>
      <img src="/diagram.png" alt="Plan comparison diagram">
    `));
  });

  app.get('/docs', (req, res) => {
    res.type('html').send(PAGE('Docs', `
      <h1>Documentation</h1>
      <h2>Getting started</h2>
      <p>${'Fixture Cloud documentation explains how to integrate the demo API into your test harness. '.repeat(10)}</p>
      <h3>Authentication</h3><p>Pass the fixture token header.</p>
      <h3>Webhooks</h3><p>Fixture webhooks fire on test events.</p>
    `));
  });

  app.get('/signup', (req, res) => {
    res.type('html').send(PAGE('Signup', `
      <h1>Create your account</h1>
      <form method="post" action="/signup">
        <label for="email">Work email</label><input id="email" name="email" type="email" required autocomplete="email">
        <label for="pw">Password</label><input id="pw" name="pw" type="password" required autocomplete="new-password">
        <button type="submit" disabled>Create account (form never actually works)</button>
      </form>
      <p>Or continue with <a href="/oauth/google">Google</a></p>
    `));
  });

  app.get('/checkout', (req, res) => {
    const plan = String(req.query.plan || 'starter');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checkout — Fixture Cloud</title></head><body>
      <main><h1>Complete your purchase — ${plan}</h1>
      <p>This page simulates a payment step. The auditor stops here.</p>
      <input autocomplete="cc-number" name="cc" aria-label="Card number">
      <p>Payment method: card · Billing address · Secure checkout</p></main></body></html>`);
  });

  app.get('/blog', (req, res) => {
    res.type('html').send(PAGE('Blog', '<h1>Changelog</h1><p>' + 'Fixture blog entry. '.repeat(20) + '</p><a href="/blog/post-1">Entry one</a>'));
  });
  app.get('/blog/post-1', (req, res) => {
    res.type('html').send(PAGE('Blog Post', '<h1>Entry one</h1><p>' + 'Fixture blog post text. '.repeat(30) + '</p>'));
  });

  // deliberately broken link target
  app.get('/broken', (req, res) => res.status(404).send('gone'));

  return app.listen(port);
}

// run standalone: node test/fixture.js
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] && process.argv[1].endsWith('fixture.js')) {
  const port = Number(process.env.FIXTURE_PORT || 4701);
  createFixture({ port });
  console.log(`fixture site on http://127.0.0.1:${port}`);
}
