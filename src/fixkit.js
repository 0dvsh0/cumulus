/*
 * fixkit.js — the downloadable fix kit.
 * One Markdown file per actionable finding (fail/partial), plus a README
 * with score + fix order and the raw report.json for machine use.
 */
import JSZip from 'jszip';
import { describeFinding } from './findings.js';
import { STATUS_LABEL, CATEGORIES } from './scoring.js';
import { config } from './config.js';

const SLUG_RX = /[^a-z0-9]+/gi;
function slug(s) {
  return String(s || 'finding').toLowerCase().replace(SLUG_RX, '-').replace(/^-+|-+$/g, '').slice(0, 42) || 'finding';
}

function evidenceTable(rows) {
  if (!rows || !rows.length) return '_(no evidence recorded)_\n';
  return rows.map(([k, v]) => `| ${mdEscape(k)} | ${mdEscape(Array.isArray(v) ? String(v[0]) : String(v))} |`).join('\n');
}
function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ⏎ ');
}

function findingMd(idx, f) {
  const d = describeFinding(f.id, { evidence: f.evidence, note: f.summary });
  return `# ${f.id} — ${f.title}

**Status:** ${STATUS_LABEL[f.status] || f.status} · **Severity:** ${f.sev} · **Category:** ${f.catName || f.cat}

## Problem
${d.problem}

## Evidence
${evidenceTable(f.evidence || [])}

## Impact
${d.impact}

## How to fix
${(d.fix || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Acceptance criteria
${(d.ac || []).map((s) => `- [ ] ${s}`).join('\n')}

## Verification
\`\`\`
${d.verify}
\`\`\`

---
_Zero-dependency note: re-run the Cumulus audit after the fix; the acceptance criteria above are what the auditor re-tests._
`;
}

function readmeMd(report) {
  const s = report.score || {};
  const cov = report.coverage || { counts: {}, pct: 0 };
  const byAction = (report.findings || []).slice().sort((a, b) => {
    const rv = { fail: 0, partial: 1 };
    return (WEIGHT_ORD[a.sev] - WEIGHT_ORD[b.sev]) || (rv[a.status] - rv[b.status]);
  });
  const lines = [];
  lines.push(`# ${config.brand.name} fix kit — ${report.meta && report.meta.host}`);
  lines.push('');
  lines.push(`**Audit of ${report.meta && report.meta.url}**`);
  lines.push(`**Score:** ${s.overall ?? 'n/a'}/100 (${s.grade || '—'}) · **Coverage:** ${cov.pct}% of applicable checks tested`);
  lines.push(`**Generated:** ${new Date((report.meta && report.meta.finishedAt) || Date.now()).toISOString()}`);
  lines.push('');
  lines.push('## Result by category');
  lines.push('');
  lines.push('| Category | Score | Status mix |');
  lines.push('|---|---|---|');
  for (const c of report.categories || []) {
    const mix = Object.entries(c.counts || {})
      .filter(([, n]) => n)
      .map(([k, n]) => `${STATUS_LABEL[k] || k} ${n}`).join(' · ') || '—';
    lines.push(`| ${c.name} | ${c.score == null ? 'n/a' : c.score + '/100'} | ${mix} |`);
  }
  lines.push('');
  lines.push(`Check totals: Pass ${cov.counts?.pass ?? 0} · Partial ${cov.counts?.partial ?? 0} · Fail ${cov.counts?.fail ?? 0} · Not established ${cov.counts?.open ?? 0} · N/A ${cov.counts?.['n/a'] ?? 0}`);
  lines.push('');
  if (byAction.length) {
    lines.push('## Fix order (most blocking first)');
    lines.push('');
    lines.push('| # | Check | Severity | Status | File |');
    lines.push('|---|---|---|---|---|');
    byAction.forEach((f, i) => {
      const file = `${String(i + 1).padStart(2, '0')}-${f.id}-${slug(f.title)}.md`;
      lines.push(`| ${i + 1} | ${f.id} ${f.title} | ${f.sev} | ${STATUS_LABEL[f.status] || f.status} | \`${file}\` |`);
    });
    lines.push('');
  } else {
    lines.push('## No failing checks 🎉');
    lines.push('');
    lines.push('This audit found no failing or partial checks — there is nothing to fix. The `report.json` carries the full evidence.');
    lines.push('');
  }
  lines.push('## How to use this kit');
  lines.push('');
  lines.push('1. Work top-down through the fix files (severity order).');
  lines.push('2. Each file ends with acceptance criteria — those are exactly what the auditor re-tests.');
  lines.push('3. Re-run the audit and compare with the previous score. `report.json` in this archive holds the raw result data.');
  lines.push('');
  lines.push(`_Status semantics: Pass full credit · Partial half · Fail zero. Blocked/Inconclusive/Error are reported but never scored as failure; N/A is excluded._`);
  lines.push('');
  return lines.join('\n');
}

const WEIGHT_ORD = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * @param {{report: object}} param
 * @returns {Promise<Buffer>} the zip
 */
export async function buildFixKit(report) {
  const zip = new JSZip();
  const readme = readmeMd(report);
  zip.file('README.md', readme);
  const ordered = (report.findings || []).slice().sort((a, b) => (WEIGHT_ORD[a.sev] - WEIGHT_ORD[b.sev]) || (a.status === 'fail' ? -1 : b.status === 'fail' ? 1 : 0));
  ordered.forEach((f, i) => {
    const name = `${String(i + 1).padStart(2, '0')}-${f.id}-${slug(f.title)}.md`;
    zip.file(name, findingMd(i, f));
  });
  zip.file('report.json', JSON.stringify({ ...report, categories: report.categories }, null, 2));
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return buf;
}

export function fixKitName(report) {
  const host = (report.meta && report.meta.host) || 'site';
  return `${config.brand.name.toLowerCase()}-fixkit-${host.replace(/^www\./, '')}-${new Date((report.meta && report.meta.finishedAt) || Date.now()).toISOString().slice(0, 10)}.zip`;
}
