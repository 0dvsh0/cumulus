import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { resolveTarget, policyCheckUrl, PolicyError } from './netguard.js';

/**
 * safeFetch — the only outbound HTTP client for raw checks.
 *
 * Safety properties:
 *  - URL policy via policyCheckUrl (scheme, port, credentials)
 *  - DNS resolved once by netguard; the connection is PINNED to the validated
 *    address with a custom `lookup`, so a DNS rebinding race cannot redirect us
 *    at connect time. TLS SNI and Host header still use the real hostname.
 *  - Every redirect hop is re-validated (policy + DNS).
 *  - Size, timeout and redirect limits enforced; bodies are truncated at our cap.
 */

function makeLookupPinned(addr, family) {
  return function pinnedLookup(hostIn, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (opts && opts.all) {
      process.nextTick(() => cb(null, [{ address: addr, family }]));
    } else {
      process.nextTick(() => cb(null, addr, family));
    }
  };
}

function decodeBody(buf, encoding) {
  let out = buf;
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') out = zlib.gunzipSync(buf);
    else if (enc === 'deflate') out = zlib.inflateSync(buf);
    else if (enc === 'deflate-raw') out = zlib.inflateRawSync(buf);
    else if (enc === 'br') out = zlib.brotliDecompressSync(buf);
    else if (enc === 'zstd') out = out; // unsupported inflate: keep raw
  } catch (err) {
    return { buf, decodeError: 'inflate_failed' };
  }
  return { buf: out };
}

export function pullText(buf, max = 64) {
  return buf.toString('utf8', 0, Math.min(buf.length, 256_000)).slice(0, max);
}

/**
 * Fetch one URL safely.
 * @returns result object, never throws for network/policy problems:
 *   { ok:true, url, finalUrl, status, headers, bytes, ms, redirects, body }
 *   { ok:false, kind:'blocked'|'policy'|'error'|'tls'|'timeout'|'too_large'|'dns', code, message }
 */
export function safeFetch(rawUrl, {
  method = 'GET',
  headers = {},
  ua = config.userAgentAudit,
  timeoutMs = config.limits.fetchTimeoutMs,
  maxRedirects = config.limits.redirects,
  maxBytes = config.limits.maxResponseBytes,
  maxDecodeBytes = config.limits.maxDecodeBytes,
  headersOnly = false,           // destroy socket after response headers
  accept = '*/*',
  cache = null,                  // optional Map for DNS memoization
  followRedirects = true,
  signal = null,                 // external AbortSignal
} = {}) {
  return new Promise((resolve) => {
    let hops = [];
    let settled = false;
    let settledEarly = false;

    // overall timeout, incl. redirects
    const deadline = setTimeout(() => { finish({ ok: false, kind: 'timeout', code: 'ETIMEDOUT', message: 'Total fetch time exceeded.' }); }, timeoutMs);

    function cleanup() { clearTimeout(deadline); }
    function finish(r) {
      if (settledEarly) return;
      if (settled) return;
      settled = settledEarly = true; cleanup();
      resolve(r);
    }

    function hop(currentUrl, redirectsLeft) {
      let u;
      try { u = policyCheckUrl(currentUrl); }
      catch (err) {
        return finish({ ok: false, kind: err instanceof PolicyError ? 'blocked' : 'policy', code: err.code || 'E_POLICY', message: err.message });
      }

      resolveTarget(u.hostname, { cache })
        .then((addr) => {
          const isHttps = u.protocol === 'https:';
          const mod = isHttps ? https : http;
          const hostnameIsIpLiteral = /^[0-9.]+$/.test(u.hostname) || u.hostname.includes(':');
          const finalServername = isHttps && !hostnameIsIpLiteral ? u.hostname : undefined;

          const reqHeaders = {
            'user-agent': ua,
            accept,
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en',
            connection: 'close',
            ...headers,
          };

          const opts = {
            hostname: u.hostname.replace(/^\[(.+)\]$/, '$1'), // net wants bare IPv6 literals
            port: u.port || (isHttps ? 443 : 80),
            path: u.pathname + u.search,
            method,
            headers: reqHeaders,
            lookup: makeLookupPinned(addr.address, addr.family),
            servername: finalServername,
            // TLS hardening
            rejectUnauthorized: true,
            setNoDelay: true,
            timeout: Math.max(4_000, Math.round(timeoutMs * 0.8)),
          };

          const req = mod.request(opts, onResponse);
          req.end(); // flush the request head — without this the socket idles and the host never receives the request
          req.setTimeout(Math.max(4_000, Math.round(timeoutMs * 0.8)), () => {
            req.destroy(new Error('ETIMEDOUT'));
          });

          const onAbort = () => { try { req.destroy(new Error('E_CANCELED')); } catch {} };
          if (signal) {
            if (signal.aborted) { try { req.destroy(); } catch {} return finish({ ok: false, kind: 'error', code: 'E_CANCELED', message: 'Cancelled.' }); }
            signal.addEventListener('abort', onAbort, { once: true });
          }

          req.on('error', (err) => {
            if (signal) signal.removeEventListener('abort', onAbort);
            const code = err && err.code ? err.code : String(err.message || 'ECONERR');
            if (code === 'E_CANCELED') return finish({ ok: false, kind: 'error', code: 'E_CANCELED', message: 'Fetch cancelled.' });
            if (/timeout/i.test(String(err.message)) || code === 'ETIMEDOUT') {
              return finish({ ok: false, kind: 'timeout', code: 'ETIMEDOUT', message: 'Host did not respond in time.' });
            }
            if (code === 'ECONNREFUSED') return finish({ ok: false, kind: 'error', code, message: 'Connection refused.' });
            if (code === 'ECONNRESET' || code === 'EPIPE') return finish({ ok: false, kind: 'error', code, message: 'Connection reset by host.' });
            if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENOLOOKUP') {
              return finish({ ok: false, kind: 'error', code, message: 'Host not found.' });
            }
            if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'CERT_HAS_EXPIRED' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'EPROTO' || /cert|tls|ssl/i.test(code)) {
              return finish({ ok: false, kind: 'tls', code: code, message: 'TLS certificate could not be verified.' });
            }
            finish({ ok: false, kind: 'error', code: code, message: 'Connection to host failed.' });
          });

          function onResponse(res) {
            if (signal) signal.removeEventListener('abort', onAbort);
            const status = res.statusCode || 0;
            const hdrs = res.headers || {};
            const headersOut = {};
            for (const [k, v] of Object.entries(hdrs)) headersOut[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);

            // redirect?
            if (followRedirects && status >= 300 && status < 400 && hdrs.location) {
              res.resume();
              if (redirectsLeft <= 0) return finish({ ok: false, kind: 'policy', code: 'E_TOOMANYREDIRECTS', message: 'Too many redirects.' });
              let next;
              try { next = new URL(hdrs.location, u); } catch {
                return finish({ ok: false, kind: 'policy', code: 'E_REDIRECT', message: 'Redirect target was not a valid URL.' });
              }
              hops.push({ status, from: u.href, to: next.href });
              // drop auth-ish headers when changing host
              if (next.hostname.toLowerCase() !== u.hostname.toLowerCase()) {
                for (const h of Object.keys(reqHeaders)) if (h === 'authorization' || h === 'cookie') delete reqHeaders[h];
              }
              return hop(next.href, redirectsLeft - 1);
            }

            const t0 = performance.now();
            function elapsed() { return Math.round(performance.now() - t0); }

            // headers-only: we don't intend to keep the body
            if (headersOnly) {
              res.resume();
              res.on('close', () => finish({
                ok: true, url: rawUrl, finalUrl: u.href, status, headers: headersOut,
                bytes: 0, readBytes: 0, ms: elapsed(), redirects: hops.slice(), body: Buffer.alloc(0),
              }));
              return;
            }

            const chunks = [];
            let total = 0;
            let tooLarge = false;


            res.on('data', (c) => {
              total += c.length;
              if (total > maxBytes) { tooLarge = true; res.destroy(); return; }
              chunks.push(c);
            });
            res.on('error', () => { /* treated by close */ });
            res.on('close', () => {
              if (settledEarly) return;
              if (tooLarge) return finish({ ok: false, kind: 'too_large', code: 'E_RESPSIZE', message: `Response body exceeded ${maxBytes} bytes.` });
              const rawBody = Buffer.concat(chunks);
              const { buf, decodeError } = decodeBody(rawBody, hdrs['content-encoding']);
              if (buf.length > maxDecodeBytes) {
                return finish({ ok: false, kind: 'too_large', code: 'E_RESPSIZE', message: `Uncompressed body exceeded ${maxDecodeBytes} bytes.` });
              }
              finish({
                ok: true, url: rawUrl, finalUrl: u.href, status, headers: headersOut,
                rawBytes: rawBody.length, bytes: buf.length, ms: elapsed(), decodeError,
                redirects: hops.slice(), encoding: String(hdrs['content-encoding'] || ''),
                body: buf,
              });
            });
          }
        })
        .catch((err) => finish({ ok: false, kind: err instanceof PolicyError ? 'blocked' : 'error', code: err.code || 'EDNS', message: err.message }));
    }

    hop(String(rawUrl), maxRedirects);
  });
}

/** Fetch and keep only headers (used for cheap liveness of many links). */
export function safeProbe(url, opts = {}) {
  return safeFetch(url, { ...opts, headersOnly: true, maxRedirects: opts.maxRedirects ?? config.limits.redirects });
}

/**
 * Decimal/octal-encoded IP hostnames and weird variants are covered because
 * we dns-lookup the hostname and validate the resulting address; getaddrinfo
 * resolves them, and the resolved address must be public or the fetch aborts.
 */
export function normalizeHostUrl(u) {
  const out = new URL(u);
  out.hash = '';
  return out.href;
}
