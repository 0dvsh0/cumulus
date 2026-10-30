/*
 * Visual system: GLSL starfield, procedural hand-inked cumulus (SVG),
 * brand mark, score orb, constellations. No dependencies.
 */

/* ---------------- seeded RNG ---------------- */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

/* ---------------- Starfield (WebGL) ---------------- */
const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const FRAG = `
precision highp float;
uniform vec2 r; uniform float t; uniform vec2 m; uniform float sc;
float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float layer(vec2 uv,float scale,float keep,float bright,float rmin,float rmax){
  vec2 g=uv*scale; vec2 id=floor(g); vec2 f=fract(g)-.5;
  float n=h(id); if(n>keep) return 0.;
  vec2 o=(vec2(h(id+3.1),h(id+7.7))-.5)*.8;
  float cell=r.y/scale;
  float d=length(f-o)*cell;
  float big=pow(h(id+11.3),5.);
  float rad=mix(rmin,rmax,big);
  float tw=.65+.35*sin(t*(.6+h(id+5.)*2.2)+n*60.);
  float s=smoothstep(rad,rad*.15,d)*bright*tw;
  s+=big*.9*bright*tw*exp(-d*d/(rad*rad*9.));
  return s;
}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*r)/r.y;
  vec2 par=m*.012;
  float y=sc*.00012;
  float c=0.;
  c+=layer(uv+par*1.0+vec2(0.,y*1.),14.,.42,1.,1.,2.6);
  c+=layer(uv+par*.6+vec2(4.,y*.6),30.,.32,.75,.55,1.5);
  c+=layer(uv+par*.3+vec2(9.,y*.3),62.,.22,.5,.4,.9);
  vec2 q=gl_FragCoord.xy/r;
  float dust=h(floor(gl_FragCoord.xy*.5)+floor(t*.5))*.012;
  vec3 col=vec3(c)*vec3(.96,.97,1.)+dust;
  col+=vec3(.035,.035,.05)*smoothstep(.55,0.,q.y);
  gl_FragColor=vec4(col,1.);
}`;

export function initSky(canvas) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) return fallbackSky(canvas);
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return fallbackSky(canvas);
  gl.useProgram(pr);
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = { r: gl.getUniformLocation(pr, 'r'), t: gl.getUniformLocation(pr, 't'), m: gl.getUniformLocation(pr, 'm'), sc: gl.getUniformLocation(pr, 'sc') };
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener('pointermove', e => { mouse.tx = (e.clientX / innerWidth - .5) * 2; mouse.ty = (e.clientY / innerHeight - .5) * -2; }, { passive: true });
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize(); addEventListener('resize', resize);
  let visible = true;
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (visible) requestAnimationFrame(frame); });
  const t0 = performance.now();
  function frame(now) {
    mouse.x += (mouse.tx - mouse.x) * .04; mouse.y += (mouse.ty - mouse.y) * .04;
    gl.uniform2f(U.r, canvas.width, canvas.height);
    gl.uniform1f(U.t, reduce ? 0 : (now - t0) / 1000);
    gl.uniform2f(U.m, mouse.x, mouse.y);
    gl.uniform1f(U.sc, scrollY * (devicePixelRatio || 1));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (visible && !reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function fallbackSky(canvas) {
  const ctx = canvas.getContext('2d');
  const draw = () => {
    canvas.width = innerWidth; canvas.height = innerHeight;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const R = rng(7);
    for (let i = 0; i < 420; i++) {
      const s = R() < .06 ? 1.6 : R() * .9 + .3;
      ctx.fillStyle = `rgba(255,255,255,${.35 + R() * .65})`;
      ctx.beginPath(); ctx.arc(R() * canvas.width, R() * canvas.height, s, 0, 7); ctx.fill();
    }
  };
  draw(); addEventListener('resize', draw);
}

/* ---------------- Hand-inked cumulus ---------------- */
/*
 * rows: back → front. Each row is a band of overlapping puffs whose top edge
 * follows `shape(x)` (0..1 of height). Drawing order per row mirrors how the
 * reference was inked: outline mass → lavender rim → graphite body → contour
 * scallops → stipple dots. Later rows overlap earlier ones.
 */
export function cloudSVG({ w = 1600, h = 600, seed = 3, rows, className = '', bottomFill = true } = {}) {
  const R = rng(seed);
  const out = [];
  rows.forEach((row, ri) => {
    const { shape, rMin, rMax, body = '#5f6068', rim = '#a4a6b6', deep = '#4a4b52', stroke = 3, detail = 1, depth = ri } = row;
    const puffs = [];
    let x = -rMax;
    while (x < w + rMax) {
      const r = rMin + (rMax - rMin) * Math.pow(R(), 1.3);
      const top = shape(x / w) * h;
      puffs.push({ x, y: top + r * (.55 + R() * .25), r });
      x += r * (0.95 + R() * 0.5);
    }
    // second tier of small puffs filling seams lower down
    const fillers = puffs.slice(0, -1).map((p, i) => {
      const q = puffs[i + 1];
      const r = Math.min(p.r, q.r) * (.55 + R() * .2);
      return { x: (p.x + q.x) / 2, y: Math.max(p.y, q.y) + r * .5, r };
    });
    const all = [...puffs, ...fillers];
    const baseY = Math.max(...puffs.map(p => p.y)) + rMax * .2;
    const circ = (p, dr = 0, dx = 0, dy = 0) => `<circle cx="${(p.x + dx).toFixed(1)}" cy="${(p.y + dy).toFixed(1)}" r="${Math.max(0, p.r + dr).toFixed(1)}"/>`;
    let g = `<g class="cloud-row" data-depth="${depth}">`;
    // outline mass
    g += `<g fill="#050507">${all.map(p => circ(p, stroke)).join('')}${bottomFill ? `<rect x="-50" y="${baseY.toFixed(1)}" width="${w + 100}" height="${h}"/>` : ''}</g>`;
    // rim light
    g += `<g fill="${rim}">${all.map(p => circ(p)).join('')}</g>`;
    // body (offset down-right so rim reads as top light)
    g += `<g fill="${body}">${all.map(p => circ(p, -p.r * .07, p.r * .06, p.r * .13)).join('')}${bottomFill ? `<rect x="-50" y="${(baseY + 4).toFixed(1)}" width="${w + 100}" height="${h}"/>` : ''}</g>`;
    // shadowed belly toward the base
    if (bottomFill) g += `<rect x="-50" y="${(baseY + rMax * .9).toFixed(1)}" width="${w + 100}" height="${h}" fill="${deep}" opacity=".55"/>`;
    // contour scallops: short arcs describing sub-puffs inside the mass
    let arcs = '';
    for (const p of puffs) {
      const n = Math.round((1 + R() * 2) * detail);
      for (let k = 0; k < n; k++) {
        const sr = p.r * (.28 + R() * .22);
        const cx = p.x + (R() - .5) * p.r * 1.1;
        const cy = p.y + p.r * (.35 + R() * .55);
        const a0 = Math.PI * (1.08 + R() * .12), a1 = Math.PI * (1.72 + R() * .18);
        const x0 = cx + Math.cos(a0) * sr, y0 = cy + Math.sin(a0) * sr;
        const x1 = cx + Math.cos(a1) * sr, y1 = cy + Math.sin(a1) * sr;
        arcs += `M${x0.toFixed(1)} ${y0.toFixed(1)}A${sr.toFixed(1)} ${sr.toFixed(1)} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
      }
      // tiny hatch ticks ("︶" marks in the reference)
      if (R() < .55 * detail) {
        const cx = p.x + (R() - .3) * p.r * .6, cy = p.y + p.r * (.15 + R() * .3), s = 5 + R() * 5;
        arcs += `M${(cx - s).toFixed(1)} ${cy.toFixed(1)}Q${cx.toFixed(1)} ${(cy + s * .55).toFixed(1)} ${(cx + s).toFixed(1)} ${cy.toFixed(1)}`;
      }
    }
    g += `<path d="${arcs}" fill="none" stroke="#050507" stroke-width="${(stroke * .62).toFixed(2)}" stroke-linecap="round" opacity=".85"/>`;
    // stipple dots on the lit side
    let dots = '';
    for (const p of puffs) {
      if (R() > .5 * detail) continue;
      const k = 1 + Math.floor(R() * 3);
      for (let j = 0; j < k; j++) {
        const a = Math.PI * (1.15 + R() * .5);
        const rr = p.r * (.72 + R() * .12);
        dots += `<circle cx="${(p.x + Math.cos(a) * rr).toFixed(1)}" cy="${(p.y + Math.sin(a) * rr + p.r * .1).toFixed(1)}" r="${(1 + R() * .9).toFixed(1)}"/>`;
      }
    }
    g += `<g fill="#050507" opacity=".8">${dots}</g></g>`;
    out.push(g);
  });
  return `<svg class="${className}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">${out.join('')}</svg>`;
}

/* The hero composition from the reference: towering banks at both edges,
   a valley of lower cumulus in the middle opening onto the sky. */
export function heroClouds(seed = 11) {
  const valley = (amp, base, pow = 1.7, skew = 0) => (x) => {
    const d = Math.abs(x - .5 - skew) / .5;
    return base - amp * Math.pow(Math.min(1, d), pow);
  };
  return cloudSVG({
    w: 1800, h: 760, seed,
    rows: [
      { shape: valley(.46, .62, 2.2, .02), rMin: 34, rMax: 70, body: '#6a6b74', rim: '#b2b4c4', stroke: 2.6, detail: .8 },
      { shape: valley(.34, .66, 1.8, -.03), rMin: 38, rMax: 82, body: '#63646c', rim: '#aaacbc', stroke: 3, detail: 1 },
      { shape: valley(.22, .74, 1.5, .04), rMin: 44, rMax: 92, body: '#5d5e66', rim: '#a4a6b6', stroke: 3.2, detail: 1 },
      { shape: valley(.1, .84, 1.4, 0), rMin: 50, rMax: 104, body: '#57585f', rim: '#9c9eae', stroke: 3.4, detail: 1.1 }
    ]
  });
}

export function bandClouds(seed = 5, { w = 1800, h = 320, rows = 2 } = {}) {
  const wave = (base, amp, f, ph) => (x) => base + amp * Math.sin(x * Math.PI * f + ph);
  const list = [
    { shape: wave(.3, .07, 3, 1), rMin: 30, rMax: 64, body: '#63646c', rim: '#aaacbc', stroke: 2.8, detail: .9 },
    { shape: wave(.5, .06, 4, 2.5), rMin: 34, rMax: 72, body: '#5a5b63', rim: '#a0a2b2', stroke: 3, detail: 1 },
    { shape: wave(.66, .05, 5, .4), rMin: 36, rMax: 76, body: '#55565d', rim: '#9a9cac', stroke: 3.2, detail: 1 }
  ];
  return cloudSVG({ w, h, seed, rows: list.slice(0, rows + 1) });
}

/* ---------------- Brand mark ---------------- */
export const BRAND_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><g stroke="#050507" stroke-width="1.6"><path d="M6 25.5h20.5a4.5 4.5 0 0 0 .4-9 6.5 6.5 0 0 0-12.3-2.2A5.2 5.2 0 0 0 6.2 18 3.8 3.8 0 0 0 6 25.5Z" fill="#a4a6b6"/><path d="M8 25.5h18.2a3.6 3.6 0 0 0 .5-7.2 5.6 5.6 0 0 0-10.6-1.9 4.4 4.4 0 0 0-7.4 3.2A2.9 2.9 0 0 0 8 25.5Z" fill="#5f6068" stroke="none"/></g><circle cx="24.5" cy="6" r="1.5" fill="#fff"/><circle cx="19" cy="3.6" r=".7" fill="#fff" opacity=".7"/><circle cx="28.4" cy="10.2" r=".6" fill="#fff" opacity=".6"/></svg>`;

/* ---------------- Score orb ---------------- */
export function scoreOrbSVG(score, coverage = 1) {
  const N = 100, c = 150;
  const lit = score == null ? 0 : Math.round(score);
  let ticks = '';
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    const major = i % 10 === 0;
    const r0 = major ? 118 : 124, r1 = 136;
    const on = i < lit;
    ticks += `<line class="tick${on ? ' on' : ''}" data-i="${i}" x1="${(c + Math.cos(a) * r0).toFixed(2)}" y1="${(c + Math.sin(a) * r0).toFixed(2)}" x2="${(c + Math.cos(a) * r1).toFixed(2)}" y2="${(c + Math.sin(a) * r1).toFixed(2)}" stroke="${on ? '#ffffff' : 'rgba(164,166,182,.18)'}" stroke-width="${major ? 2 : 1.4}" stroke-linecap="round"${on ? ' filter="url(#glow)"' : ''} style="opacity:0"/>`;
  }
  const cr = 146, circ = 2 * Math.PI * cr;
  const covLen = circ * Math.max(0, Math.min(1, coverage));
  return `<svg viewBox="0 0 300 300" role="img" aria-label="Score ${score ?? 'not established'} out of 100, coverage ${Math.round(coverage * 100)}%">
    <defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <radialGradient id="orbfill" cx="40%" cy="30%" r="75%"><stop offset="0" stop-color="#16161d"/><stop offset="1" stop-color="#050507"/></radialGradient>
    </defs>
    <circle cx="150" cy="150" r="108" fill="url(#orbfill)" stroke="rgba(164,166,182,.16)"/>
    ${ticks}
    <circle cx="150" cy="150" r="${cr}" fill="none" stroke="rgba(164,166,182,.1)" stroke-width="1"/>
    <circle class="cov" cx="150" cy="150" r="${cr}" fill="none" stroke="#a4a6b6" stroke-width="1.5" stroke-dasharray="${covLen.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 150 150)" stroke-linecap="round"/>
  </svg>`;
}

export function animateOrb(root) {
  const ticks = [...root.querySelectorAll('.tick')];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  ticks.forEach((t, i) => {
    if (reduce) { t.style.opacity = 1; return; }
    t.style.transition = 'opacity .4s ease';
    setTimeout(() => { t.style.opacity = 1; }, 200 + i * 12);
  });
}

export function miniOrbSVG(score) {
  const r = 20, C = 2 * Math.PI * r, v = score == null ? 0 : score / 100;
  return `<svg class="mini-score" viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="${r}" fill="none" stroke="rgba(164,166,182,.16)" stroke-width="2.5"/><circle cx="23" cy="23" r="${r}" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(C * v).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 23 23)"/><text x="23" y="27.5" text-anchor="middle" font-family="Geist Mono, monospace" font-size="12.5" font-weight="600" fill="#ededf2">${score ?? '–'}</text></svg>`;
}

/* ---------------- Constellations (one per category) ---------------- */
const CONST = {
  discovery: { pts: [[20, 92], [62, 60], [96, 78], [134, 34], [170, 54], [214, 22], [250, 66]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]], big: [3, 5] },
  access: { pts: [[60, 110], [60, 30], [160, 30], [160, 110], [200, 70], [240, 70], [228, 86]], lines: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6]], big: [4] },
  usability: { pts: [[20, 110], [70, 96], [100, 60], [150, 74], [180, 40], [226, 50], [256, 18]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]], big: [0, 6] },
  payments: { pts: [[40, 34], [70, 34], [96, 96], [208, 96], [232, 52], [86, 52], [120, 120], [190, 120]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]], big: [6, 7] }
};
export function constellationSVG(key) {
  const c = CONST[key];
  const lines = c.lines.map(([a, b]) => `<line x1="${c.pts[a][0]}" y1="${c.pts[a][1]}" x2="${c.pts[b][0]}" y2="${c.pts[b][1]}"/>`).join('');
  const stars = c.pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="${c.big.includes(i) ? 3.2 : 1.9}"${c.big.includes(i) ? ' filter="url(#cg)"' : ''}/>`).join('');
  return `<svg class="constellation" viewBox="0 0 270 130" aria-hidden="true"><defs><filter id="cg"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${lines}${stars}</svg>`;
}

/* ---------------- Sparkline ---------------- */
export function sparkSVG(values, w = 296, h = 42) {
  const v = values.filter(x => x != null);
  if (v.length < 2) return '';
  const step = w / (values.length - 1);
  const y = s => h - 4 - (s / 100) * (h - 8);
  const pts = values.map((s, i) => s == null ? null : [i * step, y(s)]).filter(Boolean);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="rgba(195,197,212,.6)" stroke-width="1.5"/>${pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === pts.length - 1 ? 3 : 2}" fill="#fff"/>`).join('')}</svg>`;
}
