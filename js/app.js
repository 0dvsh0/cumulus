(() => {
  /*
   * Cumulus Landing Page & Visuals Bundle
   * Zero-dependency WebGL starfield, hand-inked SVG clouds, constellations,
   * score dial, check catalogue, interactive sample report & validation.
   */

  /* ---------------- seeded RNG ---------------- */
  function rng(seed = 1) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
  }

  /* ---------------- Starfield (WebGL) ---------------- */
  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FRAG = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif
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

  function initSky(canvas) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let gl;
    try {
      gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
    } catch (e) {}
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
    if (!ctx) return;
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
  function cloudSVG({ w = 1600, h = 600, seed = 3, rows, className = '', bottomFill = true } = {}) {
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
      const fillers = puffs.slice(0, -1).map((p, i) => {
        const q = puffs[i + 1];
        const r = Math.min(p.r, q.r) * (.55 + R() * .2);
        return { x: (p.x + q.x) / 2, y: Math.max(p.y, q.y) + r * .5, r };
      });
      const all = [...puffs, ...fillers];
      const baseY = Math.max(...puffs.map(p => p.y)) + rMax * .2;
      const circ = (p, dr = 0, dx = 0, dy = 0) => `<circle cx="${(p.x + dx).toFixed(1)}" cy="${(p.y + dy).toFixed(1)}" r="${Math.max(0, p.r + dr).toFixed(1)}"/>`;
      let g = `<g class="cloud-row" data-depth="${depth}">`;
      g += `<g fill="#050507">${all.map(p => circ(p, stroke)).join('')}${bottomFill ? `<rect x="-50" y="${baseY.toFixed(1)}" width="${w + 100}" height="${h}"/>` : ''}</g>`;
      g += `<g fill="${rim}">${all.map(p => circ(p)).join('')}</g>`;
      g += `<g fill="${body}">${all.map(p => circ(p, -p.r * .07, p.r * .06, p.r * .13)).join('')}${bottomFill ? `<rect x="-50" y="${(baseY + 4).toFixed(1)}" width="${w + 100}" height="${h}"/>` : ''}</g>`;
      if (bottomFill) g += `<rect x="-50" y="${(baseY + rMax * .9).toFixed(1)}" width="${w + 100}" height="${h}" fill="${deep}" opacity=".55"/>`;
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
        if (R() < .55 * detail) {
          const cx = p.x + (R() - .3) * p.r * .6, cy = p.y + p.r * (.15 + R() * .3), s = 5 + R() * 5;
          arcs += `M${(cx - s).toFixed(1)} ${cy.toFixed(1)}Q${cx.toFixed(1)} ${(cy + s * .55).toFixed(1)} ${(cx + s).toFixed(1)} ${cy.toFixed(1)}`;
        }
      }
      g += `<path d="${arcs}" fill="none" stroke="#050507" stroke-width="${(stroke * .62).toFixed(2)}" stroke-linecap="round" opacity=".85"/>`;
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

  function heroClouds(seed = 11) {
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

  function bandClouds(seed = 5, { w = 1800, h = 320, rows = 2 } = {}) {
    const wave = (base, amp, f, ph) => (x) => base + amp * Math.sin(x * Math.PI * f + ph);
    const list = [
      { shape: wave(.3, .07, 3, 1), rMin: 30, rMax: 64, body: '#63646c', rim: '#aaacbc', stroke: 2.8, detail: .9 },
      { shape: wave(.5, .06, 4, 2.5), rMin: 34, rMax: 72, body: '#5a5b63', rim: '#a0a2b2', stroke: 3, detail: 1 },
      { shape: wave(.66, .05, 5, .4), rMin: 36, rMax: 76, body: '#55565d', rim: '#9a9cac', stroke: 3.2, detail: 1 }
    ];
    return cloudSVG({ w, h, seed, rows: list.slice(0, rows + 1) });
  }

  /* ---------------- Brand mark ---------------- */
  const BRAND_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><g stroke="#050507" stroke-width="1.6"><path d="M6 25.5h20.5a4.5 4.5 0 0 0 .4-9 6.5 6.5 0 0 0-12.3-2.2A5.2 5.2 0 0 0 6.2 18 3.8 3.8 0 0 0 6 25.5Z" fill="#a4a6b6"/><path d="M8 25.5h18.2a3.6 3.6 0 0 0 .5-7.2 5.6 5.6 0 0 0-10.6-1.9 4.4 4.4 0 0 0-7.4 3.2A2.9 2.9 0 0 0 8 25.5Z" fill="#5f6068" stroke="none"/></g><circle cx="24.5" cy="6" r="1.5" fill="#fff"/><circle cx="19" cy="3.6" r=".7" fill="#fff" opacity=".7"/><circle cx="28.4" cy="10.2" r=".6" fill="#fff" opacity=".6"/></svg>`;

  /* ---------------- Score orb ---------------- */
  function scoreOrbSVG(score, coverage = 1) {
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
        <radialGradient id="orbfill" cx="40%" cy="30%" r="75%"><stop offset="0" stop-color="#16161d"/></radialGradient>
      </defs>
      <circle cx="150" cy="150" r="108" fill="url(#orbfill)" stroke="rgba(164,166,182,.16)"/>
      ${ticks}
      <circle cx="150" cy="150" r="${cr}" fill="none" stroke="rgba(164,166,182,.1)" stroke-width="1"/>
      <circle class="cov" cx="150" cy="150" r="${cr}" fill="none" stroke="#a4a6b6" stroke-width="1.5" stroke-dasharray="${covLen.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 150 150)" stroke-linecap="round"/>
    </svg>`;
  }

  function animateOrb(root) {
    const ticks = [...root.querySelectorAll('.tick')];
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    ticks.forEach((t, i) => {
      if (reduce) { t.style.opacity = 1; return; }
      t.style.transition = 'opacity .4s ease';
      setTimeout(() => { t.style.opacity = 1; }, 200 + i * 12);
    });
  }

  function miniOrbSVG(score) {
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
  function constellationSVG(key) {
    const c = CONST[key];
    const lines = c.lines.map(([a, b]) => `<line x1="${c.pts[a][0]}" y1="${c.pts[a][1]}" x2="${c.pts[b][0]}" y2="${c.pts[b][1]}"/>`).join('');
    const stars = c.pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="${c.big.includes(i) ? 3.2 : 1.9}"${c.big.includes(i) ? ' filter="url(#cg)"' : ''}/>`).join('');
    return `<svg class="constellation" viewBox="0 0 270 130" aria-hidden="true"><defs><filter id="cg"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${lines}${stars}</svg>`;
  }

  function sparkSVG(values, w = 296, h = 42) {
    const v = values.filter(x => x != null);
    if (v.length < 2) return '';
    const step = w / (values.length - 1);
    const y = s => h - 4 - (s / 100) * (h - 8);
    const pts = values.map((s, i) => s == null ? null : [i * step, y(s)]).filter(Boolean);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="rgba(195,197,212,.6)" stroke-width="1.5"/>${pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === pts.length - 1 ? 3 : 2}" fill="#fff"/>`).join('')}</svg>`;
  }

  /* ---------------- Common helpers ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function md(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function ago(ts) {
    const d = (Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000;
    if (!isFinite(d)) return '';
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + ' min ago';
    if (d < 86400) return Math.floor(d / 3600) + ' h ago';
    if (d < 86400 * 30) return Math.floor(d / 86400) + ' d ago';
    return new Date(ts).toLocaleDateString();
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function boot() {
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

  const ICONS = {
    arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6l4 4 4-4"/></svg>',
    down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v9M4 7l4 4 4-4M3 14h10"/></svg>',
    redo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3v4H9"/><path d="M13 7a5.5 5.5 0 1 0 .6 3.5"/></svg>',
    link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1"/></svg>',
    json: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 2.5c-1.5 0-1.5 1-1.5 2.5S2.5 8 2.5 8s1 0 1 3 0 2.5 1.5 2.5M11 2.5c1.5 0 1.5 1 1.5 2.5s1 3 1 3-1 0-1 3 0 2.5-1.5 2.5"/></svg>'
  };

  boot();

  /* ---------------- Clouds ---------------- */
  const heroCloudsEl = $('#hero-clouds');
  if (heroCloudsEl) heroCloudsEl.innerHTML = heroClouds(11);
  const finaleCloudsEl = $('#finale-clouds');
  if (finaleCloudsEl) finaleCloudsEl.innerHTML = bandClouds(23, { rows: 2 });

  const rows = $$('#hero-clouds .cloud-row');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let ticking = false;
    addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = Math.min(scrollY, innerHeight);
        rows.forEach((r, i) => { r.style.transform = `translateY(${(-y * (0.04 + i * 0.05)).toFixed(1)}px)`; });
        ticking = false;
      });
    }, { passive: true });
  }

  /* ---------------- Categories ---------------- */
  const CATS = [
    { id: 'discovery', name: 'Discovery', q: 'Can agents find your important pages, docs, products and pricing?', items: ['robots.txt & AI agent policy', 'sitemap coverage', 'llms.txt', 'metadata & JSON-LD'] },
    { id: 'access', name: 'Access', q: 'Can agents actually retrieve the information?', items: ['reachability over HTTPS', 'content in initial HTML', 'bot challenges', 'noindex directives'] },
    { id: 'usability', name: 'Usability', q: 'Can agents understand pages and navigate key workflows?', items: ['heading outline & landmarks', 'named links & buttons', 'labelled forms', 'task: locate signup'] },
    { id: 'payments', name: 'Payments', q: 'Can agents find pricing, understand plans and reach checkout?', items: ['task: find pricing', 'task: extract plans', 'offer structured data', 'task: reach checkout'] }
  ];

  const quadEl = $('#quad');
  if (quadEl) {
    quadEl.innerHTML = CATS.map((c, i) => `
      <article>
        <span class="idx">0${i + 1} / ${c.id}</span>
        ${constellationSVG(c.id)}
        <h3>${c.name}</h3>
        <p>${c.q}</p>
        <ul>${c.items.map(x => `<li>${x}</li>`).join('')}</ul>
      </article>`).join('');
  }

  /* ---------------- Check catalogue ---------------- */
  const CHECKS = [
    ['D1', 'discovery', 'medium', 'robots.txt is published and readable', 'The first file agents read: policy plus a pointer to your sitemap.'],
    ['D2', 'discovery', 'critical', 'AI retrieval agents are allowed', 'ChatGPT-User, Claude-User, Perplexity-User and AI search crawlers obey robots.txt.'],
    ['D3', 'discovery', 'high', 'XML sitemap is discoverable', 'Lets agents enumerate pages that are not prominently linked.'],
    ['D4', 'discovery', 'medium', 'Sitemap includes key pages', 'Pricing, docs and signup must be listed to be found that way.'],
    ['D5', 'discovery', 'medium', 'llms.txt is published', 'An emerging, curated Markdown map for language models.'],
    ['D6', 'discovery', 'high', 'Title and meta description in HTML', 'The summary agents use to decide relevance.'],
    ['D7', 'discovery', 'low', 'Canonical URL is declared', 'Tells agents which URL is authoritative.'],
    ['D8', 'discovery', 'medium', 'Valid JSON-LD structured data', 'Unambiguous facts about the organisation and product.'],
    ['D9', 'discovery', 'high', 'Navigation exposes key destinations', 'Pricing, docs and signup linked with literal labels.'],
    ['D10', 'discovery', 'low', 'Open Graph metadata', 'Consistent title, description and image for previews.'],
    ['A1', 'access', 'critical', 'Homepage reachable over HTTPS', 'If this fails, nothing else is reachable.'],
    ['A2', 'access', 'critical', 'Core content is in the initial HTML', 'Raw-HTML text compared with rendered DOM text.'],
    ['A3', 'access', 'critical', 'No bot challenge on public pages', 'CAPTCHAs and interstitials stop agents at the door.'],
    ['A4', 'access', 'high', 'Pages are not marked noindex', 'noindex tells retrieval systems not to use the page.'],
    ['A5', 'access', 'medium', 'HTML is a reasonable size', 'Oversized pages get truncated in agent context windows.'],
    ['A6', 'access', 'low', 'Document language is declared', 'Helps agents choose language handling.'],
    ['A7', 'access', 'low', 'Machine-readable alternate advertised', 'Markdown or feed versions avoid layout parsing.'],
    ['A8', 'access', 'high', 'Key pages return successful responses', 'Discovered pricing, docs and signup pages must load.'],
    ['U1', 'usability', 'medium', 'Heading structure is clear', 'One h1 and an ordered outline to segment the page.'],
    ['U2', 'usability', 'medium', 'Semantic landmarks are used', 'main and nav separate content from chrome.'],
    ['U3', 'usability', 'low', 'Images have alt text', 'Agents cannot see screenshots or diagrams.'],
    ['U4', 'usability', 'medium', 'Links have descriptive names', 'Agents choose links by their text.'],
    ['U5', 'usability', 'medium', 'Buttons have accessible names', 'Icon-only buttons cannot be reasoned about.'],
    ['U6', 'usability', 'medium', 'Form fields are labelled', 'Placeholder-only fields are ambiguous.'],
    ['U7', 'usability', 'high', 'Navigation uses real links', 'href="#" and clickable divs need scripted clicks.'],
    ['U8', 'usability', 'high', 'Agent task: locate signup', 'Follow links to a signup form — never submitted.'],
    ['U9', 'usability', 'medium', 'Agent task: locate docs or help', 'Agents answer “how do I…” from your docs.'],
    ['P1', 'payments', 'critical', 'Agent task: find pricing', 'The most commonly delegated commercial question.'],
    ['P2', 'payments', 'high', 'Agent task: extract plan details', 'Price, currency, period and plan names as text.'],
    ['P3', 'payments', 'high', 'Prices present in the initial HTML', 'JavaScript-injected prices are missed by fetchers.'],
    ['P4', 'payments', 'medium', 'Offers described with structured data', 'schema.org Offer gives exact price and currency.'],
    ['P5', 'payments', 'critical', 'Agent task: reach the checkout interface', 'Follow a plan CTA to checkout, then stop.'],
    ['P6', 'payments', 'high', 'Plan CTAs are real links', 'Script-only buy buttons cannot be followed.']
  ];

  const checkCountEl = $('#check-count');
  if (checkCountEl) checkCountEl.textContent = CHECKS.length;
  const eyebrowCountEl = $('#eyebrow-count');
  if (eyebrowCountEl) eyebrowCountEl.textContent = CHECKS.length;

  const tabs = $('#cat-tabs');
  const tbody = $('#checks-table tbody');
  let filter = 'all';
  function renderChecks() {
    if (tabs) {
      tabs.innerHTML = [['all', 'All', CHECKS.length], ...CATS.map(c => [c.id, c.name, CHECKS.filter(k => k[1] === c.id).length])]
        .map(([id, n, k]) => `<button type="button" data-f="${id}" aria-pressed="${filter === id}">${n} <span class="dim">${k}</span></button>`).join('');
    }
    if (tbody) {
      tbody.innerHTML = CHECKS.filter(c => filter === 'all' || c[1] === filter).map(c => `
        <tr><td>${c[0]}</td><td>${esc(c[3])}</td><td><span class="sev sev-${c[2]}">${c[2]}</span></td><td class="c-impact">${esc(c[4])}</td></tr>`).join('');
    }
  }
  if (tabs) {
    tabs.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; filter = b.dataset.f; renderChecks(); });
  }
  renderChecks();

  /* ---------------- Illustrative sample report ---------------- */
  const SAMPLE_SCORE = 62;
  const SAMPLE_CATS = { discovery: [71, '7 pass · 2 partial · 1 fail'], access: [78, '6 pass · 1 fail · 1 blocked'], usability: [64, '4 pass · 1 partial · 2 fail · 2 n/a'], payments: [35, '1 pass · 1 partial · 2 fail · 2 inconclusive'] };
  const SAMPLE_FINDINGS = [
    { id: 'P3', sev: 'high', st: 'fail', t: 'Prices present in the initial HTML', s: 'Prices only appear after JavaScript runs; raw HTML has none.',
      ev: [['Rendered prices', '$0, $24, $49'], ['Raw HTML prices', 'none'], ['URL', 'https://acme-cloud.example/pricing']],
      fix: ['Server-render plan prices.', 'Use client code only to toggle between already-present monthly/annual values.'],
      ac: ['`curl` of /pricing contains every plan price.', 'Re-audit reports P3 as Pass.'] },
    { id: 'P6', sev: 'high', st: 'fail', t: 'Plan CTAs are real links', s: 'All three “Upgrade” buttons work only through JavaScript click handlers.',
      ev: [['CTA links', 'none'], ['Script-only buttons', '"Upgrade", "Upgrade", "Talk to sales"']],
      fix: ['Render each CTA as `<a href="/checkout?plan=pro">`.', 'Keep the plan in the URL so it survives a plain GET.'],
      ac: ['Every plan CTA is an anchor with a real href.'] },
    { id: 'D2', sev: 'critical', st: 'warn', t: 'AI retrieval agents are allowed', s: 'Retrieval agents are allowed, but Claude-SearchBot is disallowed on /pricing.',
      ev: [['robots.txt', 'User-agent: Claude-SearchBot\nDisallow: /pricing']],
      fix: ['Remove the /pricing disallow for search and retrieval agents.', 'Opt out of training crawlers separately if desired.'],
      ac: ['robots.txt allows /pricing for all retrieval and search agents.'] }
  ];

  const orbEl = $('#orb');
  if (orbEl) orbEl.insertAdjacentHTML('afterbegin', scoreOrbSVG(SAMPLE_SCORE, 0.91));

  const sampleCatsEl = $('#sample-cats');
  if (sampleCatsEl) {
    sampleCatsEl.innerHTML = CATS.map(c => {
      const [s, counts] = SAMPLE_CATS[c.id];
      return `<div class="cat-card"><div class="row"><h3>${c.name}</h3><span class="s">${s}<small>/100</small></span></div>
        <div class="meter"><i style="width:0" data-w="${s}"></i></div><div class="counts">${counts}</div></div>`;
    }).join('');
  }

  const sampleFindingsEl = $('#sample-findings');
  if (sampleFindingsEl) {
    sampleFindingsEl.innerHTML = SAMPLE_FINDINGS.map((f, i) => `
      <div class="finding${i === 0 ? ' open' : ''}">
        <button type="button" aria-expanded="${i === 0}">
          <span class="fid">${f.id}</span>
          <span><span class="ft">${esc(f.t)}</span><span class="fs" style="display:block">${esc(f.s)}</span></span>
          <span class="pill st-${f.st}">${f.st === 'warn' ? 'Partial' : 'Fail'} · ${f.st === 'warn' ? 'high' : f.sev}</span>
          ${ICONS.chev}
        </button>
        <div class="detail">
          <h4>Evidence</h4>
          <div class="evidence">${f.ev.map(([k, v]) => `<div class="er"><span>${esc(k)}</span><div>${esc(v)}</div></div>`).join('')}</div>
          <h4>How to fix</h4><ol>${f.fix.map(x => `<li>${md(x)}</li>`).join('')}</ol>
          <h4>Acceptance criteria</h4><ul class="checklist">${f.ac.map(x => `<li>${md(x)}</li>`).join('')}</ul>
        </div>
      </div>`).join('');

    sampleFindingsEl.addEventListener('click', e => {
      const b = e.target.closest('.finding > button'); if (!b) return;
      const f = b.parentElement; const open = f.classList.toggle('open');
      b.setAttribute('aria-expanded', open);
    });
  }

  const sample = $('.sample');
  const playSample = () => {
    if (orbEl) animateOrb(orbEl);
    const n = $('#orb-num');
    if (n) {
      const t0 = performance.now();
      const step = now => {
        const p = Math.min(1, (now - t0) / 1400);
        n.textContent = Math.round(SAMPLE_SCORE * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    $$('#sample-cats .meter i').forEach(i => { i.style.width = i.dataset.w + '%'; });
  };
  if (sample) {
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { playSample(); io.disconnect(); } }, { threshold: .1 });
      io.observe(sample);
    } else playSample();
  }

  /* ---------------- Audit form (landing only) ---------------- */
  const PRIVATE = /^(localhost|.*\\.(local|internal|lan|localhost|test|invalid))$/i;
  function validate(raw) {
    raw = raw.trim();
    if (!raw) return 'Enter a website address.';
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    let u; try { u = new URL(raw); } catch { return 'That does not look like a valid URL.'; }
    if (!/^https?:$/.test(u.protocol)) return 'Only http and https websites can be audited.';
    const h = u.hostname;
    if (/^\d+(\.\d+){3}$/.test(h) || h.includes(':') || h.startsWith('[')) return 'IP addresses are not scanned. Submit a public domain name.';
    if (!h.includes('.') || PRIVATE.test(h)) return 'Internal and local hostnames are not scanned.';
    return { url: u.href };
  }
  const auditForm = $('#audit-form');
  if (auditForm) {
    auditForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#form-msg');
      if (!msg) return;
      const urlInput = $('#url');
      const submitBtn = auditForm.querySelector('button[type="submit"]');
      const raw = urlInput ? urlInput.value : '';
      const r = validate(raw);
      if (typeof r === 'string') { msg.className = 'form-msg err'; msg.textContent = r; return; }

      msg.className = 'form-msg';
      msg.innerHTML = `Connecting to auditor for <code>${esc(r.url)}</code>…`;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.setAttribute('data-orig-text', submitBtn.innerHTML);
        submitBtn.innerHTML = 'Auditing…';
      }

      try {
        const res = await fetch('/api/v1/audits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: r.url }),
        });
        const data = await res.json().catch(() => null);
        if (res.status === 202 && data && data.id) {
          msg.innerHTML = `Audit started! Redirecting to live progress…`;
          window.location.href = `/report/${data.id}`;
          return;
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = submitBtn.getAttribute('data-orig-text') || 'Audit <span aria-hidden="true">→</span>';
        }
        msg.className = 'form-msg err';
        if (res.status === 429) {
          msg.textContent = (data && data.error && data.error.message) || 'Cooldown active for this site. Please wait a few seconds before re-auditing.';
        } else if (res.status === 503) {
          msg.textContent = (data && data.error && data.error.message) || 'Auditor is at capacity. Retrying shortly.';
        } else {
          msg.textContent = (data && data.error && data.error.message) || 'Could not start audit. Please check the URL and try again.';
        }
      } catch {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = submitBtn.getAttribute('data-orig-text') || 'Audit <span aria-hidden="true">→</span>';
        }
        msg.className = 'form-msg err';
        msg.textContent = 'Network error contacting audit engine. Ensure the server is running.';
      }
    });
  }
})();
