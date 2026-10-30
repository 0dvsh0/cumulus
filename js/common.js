import { initSky, BRAND_SVG } from './visuals.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Escape, then render `inline code` spans (used for check catalogue copy). */
export function md(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}
export function ago(ts) {
  const d = (Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000;
  if (!isFinite(d)) return '';
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + ' min ago';
  if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' d ago';
  return new Date(ts).toLocaleDateString();
}
export function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function boot() {
  const c = $('#sky');
  if (c) initSky(c);
  $$('.brand-mark').forEach(el => { el.innerHTML = BRAND_SVG; });
  const nav = $('.nav');
  if (nav) {
    const on = () => nav.classList.toggle('scrolled', scrollY > 8);
    on(); addEventListener('scroll', on, { passive: true });
  }
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
    es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' }) : null;
  $$('.reveal').forEach(el => io ? io.observe(el) : el.classList.add('in'));
  document.addEventListener('click', e => {
    const b = e.target.closest('.copy');
    if (!b) return;
    const pre = b.closest('.code')?.querySelector('pre');
    if (!pre) return;
    navigator.clipboard?.writeText(pre.innerText).then(() => { const t = b.textContent; b.textContent = 'copied'; setTimeout(() => (b.textContent = t), 1200); });
  });
}

export const ICONS = {
  arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6l4 4 4-4"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v9M4 7l4 4 4-4M3 14h10"/></svg>',
  redo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3v4H9"/><path d="M13 7a5.5 5.5 0 1 0 .6 3.5"/></svg>',
  link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1"/></svg>',
  json: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 2.5c-1.5 0-1.5 1-1.5 2.5S2.5 8 2.5 8s1 0 1 3 0 2.5 1.5 2.5M11 2.5c1.5 0 1.5 1 1.5 2.5s1 3 1 3-1 0-1 3 0 2.5-1.5 2.5"/></svg>'
};
