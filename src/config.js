import os from 'node:os';

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',

  /** Optional bearer token for REST API + MCP. When unset, same-origin UI and open API are allowed. */
  apiKey: process.env.CUMULUS_API_KEY || '',

  /** Test-only escape hatch to audit private/local targets (used by the e2e fixture). */
  allowPrivate: /^(1|true|yes)$/i.test(process.env.CUMULUS_ALLOW_PRIVATE || ''),

  dataDir: process.env.CUMULUS_DATA_DIR || 'data',

  limits: {
    /** Total wall-clock budget for one audit. */
    auditMs: 150_000,
    /** Max redirects followed per page fetch. */
    redirects: 5,
    /** Max bytes of a single response body (compressed, before inflate). */
    maxResponseBytes: 3_000_000,
    /** Max decompressed bytes we will inflate to. */
    maxDecodeBytes: 6_000_000,
    /** Default fetch timeout. */
    fetchTimeoutMs: 15_000,
    /** Crawl: max pages fetched. */
    crawlMaxPages: 14,
    /** Crawl: max links scanned per page. */
    crawlMaxLinksPerPage: 250,
    /** Crawl politeness delay between same-host fetches. */
    crawlDelayMs: 300,
    /** Browser: page-load timeout. */
    pageLoadTimeoutMs: 25_000,
    /** Browser: per-task timeout. */
    taskTimeoutMs: 18_000,
    /** Max concurrent audits. */
    concurrentAudits: 3,
    /** Cool-down per origin between new audits (ms). */
    perOriginCooldownMs: 20_000,
  },

  userAgentAudit: 'CumulusBot/1.0 (website AI-readiness audit; respects robots.txt)',
  userAgentBrowser:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',

  brand: { name: 'Cumulus', version: '1.0.0' },
  productName: 'Cumulus',
};

export function localBaseUrl() {
  return `http://localhost:${config.port}`;
}

export function isPrivateRun() {
  return config.allowPrivate;
}
