import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

/**
 * Cumulus treats every submitted URL as untrusted. This module is the single
 * place where a hostname is turned into an address, and the single gate for
 * what is allowed. Everything that talks to the audited site goes through it:
 *   - safeFetch (node http/https, pinned to a validated address)
 *   - the Playwright route handler (per-request host validation)
 */

/* minimal CIDR table for private / reserved ranges we refuse to touch */
const V4_BLOCKED = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],   // CGNAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local (cloud metadata lives here)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],   // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved / broadcast
];

const LOCAL_NAMES = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback|host\.docker\.internal|docker\.internal|.*\.(?:local|internal|lan|home|arpa|test|invalid|example)|bond0|br-lan)$/i;

function v4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function v6Canonical(ipIn) {
  let ip = ipIn.toLowerCase();
  const pct = ip.indexOf('%');
  if (pct !== -1) ip = ip.slice(0, pct);  // strip zone id
  if (ip.startsWith('::ffff:')) {
    const v4part = ip.slice(7);
    const asInt = v4ToInt(v4part);
    return asInt == null ? { v6: ip, v4: null } : { v6: null, v4: v4part };
  }
  // NAT64 well-known prefix
  const nat64 = ip.match(/^(?:64:ff9b::)([0-9a-f:.]+)$/);
  if (nat64) {
    // last 4 hex groups encode the v4 address
    const tail = nat64[1].split(':').filter(Boolean).join(':');
    const segs = ('::' + tail).split(':').filter(Boolean);
    return { v4: null, v6: ip, nat64Hint: segs.length < 4 ? ip : null };
  }
  // IPv4-compatible Teredo / 6to4 endpoints are unusual; conservatively expand+pass through v6 logic
  return { v6: ip, v4: null };
}

function v6InBlocked(ip) {
  if (ip === '::' || ip === '::1') return true;
  // loopback-mapped plain v4 written as ::a.b.c.d (non ::ffff:) — extremely rare; treat with BigInt compare below
  if (ip.startsWith('::ffff:')) return true;
  try {
    const buf = net.isIP(ip) ? ipToBufferV6(ip) : null;
    if (!buf) return true;
    const blocked = [
      ['::', 8],          // unspecified
      ['::1', 128],       // loopback
      ['fc00::', 7],      // unique local
      ['fe80::', 10],     // link local
      ['64:ff9b::', 96],  // NAT64 -> v4-only hosts
      ['::ffff:0:0', 96], // v4-mapped remainder (safety net)
      ['2001:db8::', 32], // documentation
      ['64:ff9b:1::', 48],// local-use NAT64
    ];
    for (const [net7, bits] of blocked) {
      const nbuf = ipToBufferV6(net7);
      if (bitsInCommon(buf, nbuf, bits)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function ipToBufferV6(ip) {
  // Node convoluted but reliable: use IPv6 parse via URL-ish trick
  let ipx = ip;
  if (!ipx.includes(':')) throw new Error('not v6');
  // expand :: 
  let head = ipx, tail = '';
  if (ipx.includes('::')) {
    const [h, t] = ipx.split('::');
    head = h; tail = t;
  }
  let hs = head ? head.split(':') : [];
  let ts = tail ? tail.split(':') : [];
  const missing = 8 - hs.length - ts.length;
  if (ipx.includes('::')) {
    if (missing < 0) throw new Error('bad v6');
    for (let i = 0; i < missing; i++) hs.push('0');
  } else if (hs.length !== 8) throw new Error('bad v6');
  const groups = hs.concat(ts).map((g) => {
    const n = parseInt(g || '0', 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) throw new Error('bad v6');
    return n;
  });
  if (groups.length !== 8) throw new Error('bad v6');
  return Buffer.from(groups.flatMap((n) => [n >> 8, n & 0xff]));
}

function bitsInCommon(a, b, bits) {
  const bytes = Math.floor(bits / 8);
  const rest = bits % 8;
  for (let i = 0; i < bytes; i++) if (a[i] !== b[i]) return false;
  if (rest) return ((a[bytes] ^ b[bytes]) & (0xff << (8 - rest)) & 0xff) === 0;
  return true;
}

export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'blocked_target' | 'bad_target'
  }
}

function checkV4(ip) {
  const n = v4ToInt(ip);
  if (n == null) return true;
  for (const [cidr, bits] of V4_BLOCKED) {
    const base = v4ToInt(cidr);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) === (base & mask)) return true;
  }
  return false;
}

/** Throws PolicyError when the hostname/ip cannot be audited. Returns selected address on success. */
export async function resolveTarget(hostname, { cache = null } = {}) {
  let host = String(hostname || '').toLowerCase().replace(/\.$/, '');

  if (LOCAL_NAMES.test(host)) {
    throw new PolicyError('blocked_target', `${host} is an internal or reserved hostname.`);
  }
  // URL hostname keeps IPv6 literals bracketed; the checks below expect the bare address
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // IP literal?
  const asInt = v4ToInt(host);
  if (asInt != null) {
    if (!config.allowPrivate && checkV4(host)) throw new PolicyError('blocked_target', 'IP literals in private or reserved ranges are not audited.');
    if (config.allowPrivate) return { address: host, family: 4 };
    return { address: host, family: 4 };
  }
  if (net.isIPv6(host)) {
    const c = v6Canonical(host);
    if (c.v4 && !config.allowPrivate && checkV4(c.v4)) throw new PolicyError('blocked_target', 'IPv4-mapped addresses are not audited.');
    if (!config.allowPrivate && c.v6 && v6InBlocked(c.v6)) throw new PolicyError('blocked_target', 'IPv6 loopback, link-local and private addresses are not audited.');
    return { address: host, family: 6 };
  }

  if (cache) {
    const hit = cache.get('dns:' + host);
    if (hit) return hit;
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: false });
  } catch (err) {
    throw new PolicyError('bad_target', `DNS lookup failed for ${host} (${err.code || 'ENOLOOKUP'}).`);
  }
  if (!addrs || addrs.length === 0) {
    throw new PolicyError('bad_target', `No addresses resolve for ${host}.`);
  }

  let chosen = null;
  for (const a of addrs) {
    const addr = String(a.address || '').toLowerCase();
    if (a.family === 4) {
      if (checkV4(addr)) continue;
      chosen = { address: addr, family: 4 };
      break;
    }
    if (a.family === 6) {
      const c = v6Canonical(addr);
      if (c.v4) {
        if (checkV4(c.v4)) continue;
        chosen = { address: addr, family: 6 };
        break;
      }
      if (c.v6 && !v6InBlocked(c.v6)) {
        chosen = { address: addr, family: 6 };
        break;
      }
      continue;
    }
  }
  if (!chosen) {
    throw new PolicyError('blocked_target', `${host} resolves only into private, loopback or reserved address space.`);
  }
  if (cache) cache.set('dns:' + host, chosen);
  return chosen;
}

/** URL-level policy: schemes, ports, credentials. Returns normalized http(s) URL. */
export function policyCheckUrl(raw) {
  let u;
  let s = String(raw || '').trim();
  if (!s) throw new PolicyError('bad_target', 'Empty URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    u = new URL(s);
  } catch {
    throw new PolicyError('bad_target', 'That does not look like a valid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new PolicyError('blocked_target', 'Only http and https URLs can be audited.');
  }
  if (u.username || u.password) {
    throw new PolicyError('blocked_target', 'URLs with embedded credentials are not audited.');
  }
  const port = u.port;
  if (port && port !== '80' && port !== '443' && !config.allowPrivate) {
    throw new PolicyError('blocked_target', 'Only standard web ports (80, 443) are audited.');
  }
  let host = u.hostname.toLowerCase();
  if (LOCAL_NAMES.test(host)) {
    throw new PolicyError('blocked_target', `${host} is an internal or reserved hostname.`);
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const asInt = v4ToInt(host);
  if (asInt != null) {
    if (!config.allowPrivate && checkV4(host)) throw new PolicyError('blocked_target', 'IP literals in private or reserved ranges are not audited.');
  } else if (net.isIPv6(host)) {
    const c = v6Canonical(host);
    if (!config.allowPrivate) {
      if (c.v4 && checkV4(c.v4)) throw new PolicyError('blocked_target', 'IPv4-mapped addresses are not audited.');
      if (c.v6 && v6InBlocked(c.v6)) throw new PolicyError('blocked_target', 'IPv6 loopback, link-local and private addresses are not audited.');
    }
  }
  const pub = !config.allowPrivate;
  if (pub && !host.includes('.')) {
    // single-label hostnames that are not IP literals: only reachable inside a LAN
    throw new PolicyError('blocked_target', 'Single-label hostnames are not audited. Submit a public domain name.');
  }
  return u;
}

/** Full pre-flight used by every fetch/browser navigation: URL policy + DNS gate. */
export async function gateTarget(rawUrl, ctx = {}) {
  const u = policyCheckUrl(rawUrl);
  await resolveTarget(u.hostname, ctx);
  return u;
}
