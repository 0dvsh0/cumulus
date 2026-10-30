/*
 * docs.js — renders the live check catalogue into docs.html from /api/v1/meta.
 * The docs page can never drift from the engine: the table is the registry.
 */
import { $, $$, esc, boot } from './common.js';

boot();

const metaFetch = fetch('/api/v1/meta', { headers: { accept: 'application/json' } })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)
  .then(async (m) => {
    if (m) return m;
    try {
      const r = await fetch('data/meta.json');
      if (r.ok) return await r.json();
    } catch {}
    return null;
  });

let meta = null;
metaFetch.then((m) => {
  meta = m;
  if (m) {
    $('#limit-audit').textContent = `${Math.round((m.limits && m.limits.auditMs || 150000) / 1000)} s`;
    renderChecks();
  } else {
    $('#checks-tbody').innerHTML = '<tr><td colspan="5" class="dim">Could not load the registry — start the Cumulus server and reload.</td></tr>';
  }
});

let filter = 'all';

function renderChecks() {
  if (!meta) return;
  const cats = [['all', 'All', meta.checkCount], ...(meta.categories || []).map((c) => [c.id, c.name, meta.checks.filter((k) => k.cat === c.id).length])];
  const tabs = $('#cat-tabs');
  tabs.innerHTML = cats.map(([id, name, n]) => `<button type="button" data-f="${id}" aria-pressed="${filter === id}">${esc(name)} <span class="dim">${n}</span></button>`).join('');
  tabs.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    renderChecks();
  };
  const rows = meta.checks.filter((c) => filter === 'all' || c.cat === filter);
  $('#checks-tbody').innerHTML = rows.map((c) => `
    <tr>
      <td>${esc(c.id)}</td>
      <td>${esc(c.title)}</td>
      <td><span class="sev sev-${esc(c.sev)}">${esc(c.sev)}</span></td>
      <td class="dim">${esc(nameOf(c.cat))}</td>
      <td class="c-impact">${esc(c.why)}</td>
    </tr>`).join('');
}

function nameOf(id) {
  const c = (meta.categories || []).find((x) => x.id === id);
  return c ? c.name : id;
}
