// Sendspin logo: two interleaved single-line S's, each four arc segments, cut by a 45° slash.
// This module mounts the logo as inline SVG and drives it as a queue of dashes flowing along
// each solid path. It exposes hooks for music: energy (flow speed), pulses (beats/onsets),
// per-segment levels (spectrum) and colours.
//
// Geometry facts used throughout (SVG user units, viewBox 0 0 128 128):
//   stroke 8, gap between path ends 8, two radii 15 and 31, four circle centres on two
//   parallel 45° bank lines; the halves are offset 16 along the slash and 8 across it.

const NS = 'http://www.w3.org/2000/svg';
const SW = 8, GAP = 8;
export const BRAND_RED = '#E25C4C';
const SEGMENTS = [
  // id, class, half, sweep, path data as exported from the brand file
  ['A1', 'sA', 'left', 180, 'M49.766 72.7315C43.9523 66.9179 40.6863 59.0329 40.6863 50.8112C40.6863 42.5895 43.9523 34.7045 49.766 28.8909C55.5796 23.0772 63.4646 19.8112 71.6863 19.8112C79.908 19.8112 87.793 23.0772 93.6066 28.8909'],
  ['B1', 'sB', 'left', 180, 'M61.0797 61.4178C58.2666 58.6047 56.6863 54.7894 56.6863 50.8112C56.6863 46.8329 58.2666 43.0176 61.0797 40.2046C63.8927 37.3915 67.708 35.8112 71.6863 35.8112C75.6645 35.8112 79.4798 37.3915 82.2929 40.2046'],
  ['B4', 'sB', 'left', 90, 'M17.2391 105.258C14.3604 102.38 12.077 98.9624 10.5191 95.2013C8.9612 91.4402 8.15936 87.4091 8.15936 83.3381C8.15936 79.2671 8.9612 75.236 10.5191 71.4749C12.077 67.7138 14.3604 64.2964 17.2391 61.4178'],
  ['A4', 'sA', 'left', 90, 'M28.5528 93.9447C27.1599 92.5518 26.055 90.8982 25.3012 89.0783C24.5473 87.2585 24.1594 85.3079 24.1594 83.3381C24.1594 81.3683 24.5473 79.4177 25.3012 77.5978C26.055 75.778 27.1599 74.1244 28.5528 72.7315'],
  ['B3', 'sB', 'right', 180, 'M78.0503 55.7609C83.8639 61.5746 87.1299 69.4595 87.1299 77.6812C87.1299 85.903 83.8639 93.7879 78.0503 99.6016C72.2366 105.415 64.3517 108.681 56.1299 108.681C47.9082 108.681 40.0233 105.415 34.2096 99.6016'],
  ['A3', 'sA', 'right', 180, 'M66.7365 67.0746C69.5496 69.8877 71.1299 73.703 71.1299 77.6812C71.1299 81.6595 69.5496 85.4748 66.7365 88.2878C63.9235 91.1009 60.1082 92.6812 56.1299 92.6812C52.1517 92.6812 48.3364 91.1009 45.5233 88.2878'],
  ['A0', 'sA', 'right', 90, 'M110.577 23.234C113.456 26.1126 115.739 29.5301 117.297 33.2911C118.855 37.0522 119.657 41.0834 119.657 45.1543C119.657 49.2253 118.855 53.2564 117.297 57.0175C115.739 60.7786 113.456 64.196 110.577 67.0746'],
  ['B0', 'sB', 'right', 90, 'M99.2635 34.5477C100.656 35.9406 101.761 37.5942 102.515 39.4141C103.269 41.234 103.657 43.1845 103.657 45.1543C103.657 47.1242 103.269 49.0747 102.515 50.8946C101.761 52.7145 100.656 54.3681 99.2635 55.7609'],
];
// Segments drawn against the flow direction (top-right cap towards bottom-left cap) get reversed.
const REV = { A0: true, A1: true, A3: false, A4: false, B0: true, B1: true, B3: false, B4: false };
// Which faces meet across the slash in each view. Joined: S with S. Offset: the faces that sit
// directly opposite are blue against red; the two caps A0 and B4 face empty slash and stand alone.
const CHAINS = {
  joined: [['A0', 'A1', 'A3', 'A4'], ['B0', 'B1', 'B3', 'B4']],
  offset: [['B0', 'A1'], ['B1', 'A3'], ['B3', 'A4'], ['A0'], ['B4']],
};
const SHIFT = 5.657;  // 8 / sqrt2: each half moves this along the slash to join the S
const ALIGN = { left: [SHIFT, -SHIFT], right: [-SHIFT, SHIFT] };
const NONE = { left: [0, 0], right: [0, 0] };
const U = [Math.SQRT1_2, -Math.SQRT1_2];   // slash direction
const OVERLAP = 0.3;                        // bridges tuck this far under the arcs to hide seams

let uid = 0;

export function mountLogo(container, opts = {}) {
  const id = 'sl' + (uid++);
  container.innerHTML = `
<svg class="sendspin-logo" viewBox="0 0 128 128" fill="none" stroke-width="${SW}" xmlns="${NS}">
  <defs>
    <filter id="${id}-round" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
      <feGaussianBlur class="round-blur" stdDeviation="0.8"/>
      <feComponentTransfer><feFuncA type="linear" slope="12" intercept="-5.5"/></feComponentTransfer>
    </filter>
  </defs>
  <g class="pulse"><g class="art" filter="url(#${id}-round)">
    <g class="half half-left">${SEGMENTS.filter(s => s[2] === 'left').map(seg).join('')}</g>
    <g class="half half-right">${SEGMENTS.filter(s => s[2] === 'right').map(seg).join('')}</g>
  </g></g>
  <g class="overlay"><g class="guides-left"></g><g class="guides-right"></g></g>
</svg>`;
  function seg([sid, cls, , , d]) { return `<path class="${cls}" data-seg="${sid}" d="${d}"/>`; }

  const svg = container.querySelector('svg');
  const art = svg.querySelector('.art'), pulseG = svg.querySelector('.pulse');
  const halves = { left: svg.querySelector('.half-left'), right: svg.querySelector('.half-right') };
  const style = document.createElement('style');
  style.textContent = `
    .sendspin-logo { display: block; }
    .sendspin-logo .half, .sendspin-logo .overlay > g { transition: transform ${opts.joinMs ?? 1200}ms cubic-bezier(.4,0,.2,1); }
    .sendspin-logo.joined .half-left, .sendspin-logo.joined .guides-left  { transform: translate(${SHIFT}px, ${-SHIFT}px); }
    .sendspin-logo.joined .half-right, .sendspin-logo.joined .guides-right { transform: translate(${-SHIFT}px, ${SHIFT}px); }
    .sendspin-logo .pulse { transform-origin: 64px 64px; transform-box: view-box; }
    .sendspin-logo .guides { pointer-events: none; display: none; }
    .sendspin-logo.show-guides .guides { display: initial; }
    .sendspin-logo .guides line { stroke: #fff; stroke-width: 0.25; stroke-opacity: 0.8; }
    .sendspin-logo .guides circle { fill: #fff; }
    .sendspin-logo .guides .bank { stroke: #888; stroke-width: 0.3; stroke-dasharray: 1 1; }`;
  svg.prepend(style);

  // ---------- segments ----------
  const SEG = {};
  for (const [sid, cls, half] of SEGMENTS) {
    const p = svg.querySelector(`path[data-seg="${sid}"]`);
    if (REV[sid]) p.setAttribute('d', reversePath(p.getAttribute('d')));
    SEG[sid] = { id: sid, p, len: p.getTotalLength(), half, cls, level: 1, paints: [p] };
  }
  // Reading the computed transform forces style/layout work, so it is done at most once per half per
  // frame, and only while the join/offset transition is actually animating; otherwise the shift is known.
  const JOIN_MS = opts.joinMs ?? 1200;
  let modeChangedAt = -1e9, shiftCache = { left: [0, 0], right: [0, 0] }, shiftFrame = -1;
  function shiftOf(g) {
    const side = g === halves.left ? 'left' : 'right';
    if (shiftFrame !== frameNo) {
      shiftFrame = frameNo;
      if (performance.now() - modeChangedAt < JOIN_MS + 150) {
        for (const k of ['left', 'right']) { const m = new DOMMatrix(getComputedStyle(halves[k]).transform); shiftCache[k] = [m.e, m.f]; }
      } else shiftCache = svg.classList.contains('joined') ? { left: [...ALIGN.left], right: [...ALIGN.right] } : { left: [0, 0], right: [0, 0] };
    }
    return shiftCache[side];
  }
  let frameNo = 0;
  const localEnd = (s, atEnd) => { const q = s.p.getPointAtLength(atEnd ? s.len : 0); return [q.x, q.y]; };
  const add = (p, q) => [p[0] + q[0], p[1] + q[1]];

  // ---------- bridges: the 8-unit connectors across the slash, split in two colour halves ----------
  function makeBridge(prev, next, ref, layer) {
    const E = localEnd(prev, true), S = localEnd(next, false);
    const A = add(E, ref[prev.half]), B = add(S, ref[next.half]);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const N = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const g = document.createElementNS(NS, 'g'); layer.appendChild(g);
    const ext = v => [v[0] * OVERLAP, v[1] * OVERLAP];
    const halvesEl = [[A, M, prev], [M, B, next]].map(([P, Q, owner]) => {
      const P2 = add(P, ext([-N[0], -N[1]])), Q2 = add(Q, ext(N));
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M${P2[0]} ${P2[1]} L${Q2[0]} ${Q2[1]}`); p.setAttribute('class', owner.cls); g.appendChild(p);
      owner.paints.push(p);
      return { p, len: len / 2, lead: OVERLAP };
    });
    return { g, halves: halvesEl, len, E, S, A, B, N, halfE: halves[prev.half], halfS: halves[next.half] };
  }
  function placeBridge(b) {
    const Ac = add(b.E, shiftOf(b.halfE)), Bc = add(b.S, shiftOf(b.halfS));
    const dA = [Ac[0] - b.A[0], Ac[1] - b.A[1]], dB = [Bc[0] - b.B[0], Bc[1] - b.B[1]];
    const m = (dB[0] - dA[0]) * U[0] + (dB[1] - dA[1]) * U[1];
    const k = m / b.len;   // shear that keeps both ends on the (displaced) faces
    const a = 1 + k * U[0] * b.N[0], c = k * U[0] * b.N[1], bb = k * U[1] * b.N[0], d = 1 + k * U[1] * b.N[1];
    const e = Ac[0] - (a * b.A[0] + c * b.A[1]), f = Ac[1] - (bb * b.A[0] + d * b.A[1]);
    b.g.setAttribute('transform', `matrix(${a} ${bb} ${c} ${d} ${e} ${f})`);
  }
  const MODES = {};
  for (const [name, lists] of Object.entries(CHAINS)) {
    const layer = document.createElementNS(NS, 'g'); layer.setAttribute('class', `bridges-${name}`);
    art.insertBefore(layer, art.firstElementChild);
    const ref = name === 'joined' ? ALIGN : NONE;
    MODES[name] = { layer, chains: lists.map(ids => {
      const segs = ids.map(i => SEG[i]);
      const bridges = segs.slice(1).map((s, k) => makeBridge(segs[k], s, ref, layer));
      const T = segs.reduce((a, s) => a + s.len, 0) + bridges.reduce((a, b) => a + b.len, 0);
      return { segs, bridges, T, stream: [], phase: 0, running: false, stopAt: null, decel: null, startedAt: 0 };
    }) };
  }

  // ---------- flow: an explicit queue of dashes on each solid path ----------
  const state = {
    animating: false, mode: 'offset', speed: opts.speed ?? 40, dash: opts.dash ?? 24, random: false,
    dashColors: [opts.colorA ?? BRAND_RED], bg: opts.background ?? '#111',
    flash: 0, pulse: 0, radius: 0.8,
    // beat lock: dashes enter (and therefore exit) each solid path on the beat
    beat: { period: null, nextAt: null, anchor: null, div: 1, markers: false, on: false, offsetMs: 0 },
  };
  let vCur = 0, lastMode = null, dashUid = 0, colorIdx = 0, colorEase = 1, bgRgb = [17, 17, 17];
  // Every dash is one shape with one solid colour, chosen round-robin from dashColors when it
  // enters the queue, and rendered as its own element(s) so a dash spanning two pieces of the
  // path never changes colour.
  const nextColor = () => state.dashColors[(colorIdx++) % state.dashColors.length];
  const staticBlock = chain => chain.segs.flatMap(s => [{ len: s.len, dash: true }, { len: GAP, dash: false }]);
  function animBlock(chain) {
    if (state.random) return [{ len: state.dash * (0.5 + Math.random()), dash: true }, { len: GAP, dash: false }];
    const els = [];
    for (const s of chain.segs) {
      const n = Math.max(1, Math.round((s.len + GAP) / (state.dash + GAP)));
      const sub = (s.len - (n - 1) * GAP) / n;
      for (let i = 0; i < n; i++) els.push({ len: sub, dash: true }, { len: GAP, dash: false });
    }
    return els;
  }
  // ---------- beat lock ----------
  // Each path of length T is traversed in exactly n beats, so a dash edge entering on a beat also
  // exits on a beat. The dash+gap pitch is L = T / n per beat (or per beat subdivision), and the
  // speed is L / period. n is picked so the speed lands near the energy-driven speed.
  const beatOn = () => state.beat.on && state.beat.period > 0;
  const divOf = chain => chain.div ?? state.beat.div;          // per-path subdivision, else global
  function beatSetup(chain) {
    const P = state.beat.period, want = Math.max(5, vCur);
    const b = chain.beat || (chain.beat = { n: 0, v: 0, L: 0, err: 0, snaps: 0 });
    // with a fractional division (e.g. 0.5 = one dash per two beats) the traversal must be a
    // multiple of 1/div beats so the exit still lands on a beat
    const step = divOf(chain) < 1 ? Math.max(1, Math.round(1 / divOf(chain))) : 1;
    const nWant = Math.max(step, Math.round(chain.T / (want * P) / step) * step);
    // hysteresis: only re-pick n when the current speed is far from the wanted speed
    if (!b.n || b.n % step !== 0 || Math.abs(chain.T / (b.n * P) - want) > 0.4 * want) b.n = nWant;
    b.L = chain.T / b.n / divOf(chain);                // pitch per (sub)beat in path units
    b.v = chain.T / (b.n * P);                          // units per second
    return b;
  }
  function beatBlock(chain) {
    const b = beatSetup(chain), gap = b.L > 2 * GAP ? GAP : b.L / 2;
    return [{ len: b.L - gap, dash: true, beat: true }, { len: gap, dash: false, beat: true }];
  }
  // Distance (path units) until the next not-yet-entered beat dash's leading edge reaches u = 0.
  function nextBeatEdge(chain) {
    let best = null;
    for (const el of chain.stream) {
      if (!el.dash || !el.beat) continue;
      const d = -(el.p + el.len + chain.phase);           // > 0 while still outside
      if (d >= 0 && (best === null || d < best.d)) best = { d, el };
    }
    return best;
  }
  // Deterministic placement: the next not-yet-entered beat dash must have its leading edge at the
  // entry line exactly when the next grid time (anchor + k * Pd) arrives. The required phase is
  // computed from the grid, so every path sits on the same master grid with no feedback lag.
  // Un-entered elements are invisible, so a large discrepancy is fixed by sliding them (always
  // outward, never overlapping what has entered); only sub-unit residue is nudged in the phase.
  function beatAlign(chain, now, dt) {
    const b = chain.beat, Pd = state.beat.period / divOf(chain);
    const next = nextBeatEdge(chain);
    if (!next) return;
    if (b.lastNext && b.lastNext !== next.el) {
      // log the exact entry instant of the edge that just crossed: now minus how far past the line it is
      const over = b.lastNext.p + b.lastNext.len + chain.phase;
      (b.entries ||= []).push(now - Math.max(0, over) / b.v * 1000); if (b.entries.length > 40) b.entries.shift();
    }
    b.lastNext = next.el; b.nextInMs = next.d / b.v * 1000;
    let tau = ((state.beat.anchor + state.beat.offsetMs - now) / 1000) % Pd; if (tau < 0) tau += Pd;
    const q = next.el.p + next.el.len;                       // pattern position of the leading edge
    const target = -q - b.v * tau;                           // phase that puts that edge at u=0 at the grid time
    const raw = target - chain.phase;
    const err = raw - b.L * Math.round(raw / b.L);           // grid is periodic in L: wrap to (-L/2, L/2]
    b.err = err / b.v;                                        // seconds, for the debug readout
    // Ease the phase onto the grid over ~1 s instead of sliding dashes: the flow keeps its spacing
    // (no holes), it just speeds up or slows down a little while it settles. Small residue snaps.
    if (Math.abs(err) <= 0.4) chain.phase += err;
    else { if (!b.correcting && Math.abs(err) > b.L / 4) { b.snaps++; b.correcting = true; } chain.phase += err * Math.min(1, dt / 1.0); }
    if (Math.abs(err) <= 0.4) b.correcting = false;
  }

  function prepend(chain, block) {
    let p = chain.stream.length ? chain.stream[0].p : -chain.phase;
    for (let i = block.length - 1; i >= 0; i--) {
      p -= block[i].len;
      const el = { ...block[i], p };
      if (el.dash) { el.id = ++dashUid; el.color = nextColor(); }
      chain.stream.unshift(el);
    }
    return p;
  }
  function clearPool(chain) { for (const el of chain.pool.values()) el.remove(); chain.pool.clear(); }
  function resetChain(chain) {
    chain.stream = []; chain.phase = 0; chain.stopAt = null; chain.decel = null;
    if (chain.pool) clearPool(chain); else chain.pool = new Map();
    chain.phase = -prepend(chain, staticBlock(chain));
    chain.running = state.animating; chain.startedAt = performance.now();
  }
  function setAnimating(on) {
    if (state.animating === on) return;
    state.animating = on;
    for (const chain of MODES[state.mode].chains) {
      while (chain.stream.length > 1 && chain.stream[0].p + chain.stream[0].len <= -chain.phase) chain.stream.shift();
      if (!chain.running) chain.startedAt = performance.now();
      chain.running = true; chain.decel = null;
      chain.stopAt = on ? null : -prepend(chain, staticBlock(chain));
    }
  }
  const RAMP_IN = 1.0, DECEL_T = 1.4;
  const smoothstep = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

  // The pieces of each solid path in flow order: segments and bridge halves, with the DOM parent
  // whose transform they inherit, their path data, and the extra `lead` geometry before the face.
  for (const m of Object.values(MODES)) for (const chain of m.chains) {
    const pieces = []; let s0 = 0;
    chain.segs.forEach((seg, k) => {
      if (k > 0) for (const h of chain.bridges[k - 1].halves) {
        pieces.push({ s0, len: h.len, lead: h.lead, parent: h.p.parentNode, d: h.p.getAttribute('d'), seg: pieces[pieces.length - 1].seg, cls: h.p.getAttribute('class') });
        s0 += h.len;
      }
      pieces.push({ s0, len: seg.len, lead: 0, parent: halves[seg.half], d: seg.p.getAttribute('d'), seg, cls: seg.cls });
      s0 += seg.len;
    });
    chain.pieces = pieces;
  }
  // The original paths are geometry only; the visible strokes are the per-dash elements.
  for (const s of Object.values(SEG)) for (const p of s.paints) p.style.stroke = 'none';

  // ---------- colour ----------
  const hex2rgb = h => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const toCss = c => `rgb(${c.map(Math.round).join(',')})`;
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const WHITE = [255, 255, 255];

  // Draw one dash: for every piece it overlaps, a clone of that piece's path showing just the
  // overlapped range, all in the dash's own colour. Clones are pooled by dash id + piece index.
  function renderDash(chain, el, used) {
    const u0 = el.p + chain.phase, u1 = u0 + el.len;
    if (u1 <= 0 || u0 >= chain.T) return;
    // ease the shape's displayed colour towards its target so recolours fade instead of snapping
    const target = hex2rgb(el.color);
    el.rgb = el.rgb ? mix(el.rgb, target, colorEase) : target;
    const bg = bgRgb, base = el.rgb;
    chain.pieces.forEach((pc, k) => {
      const lo = Math.max(u0, pc.s0), hi = Math.min(u1, pc.s0 + pc.len);
      if (hi <= lo) return;
      const key = el.id + ':' + k;
      let node = chain.pool.get(key);
      if (!node) {
        node = document.createElementNS(NS, 'path');
        node.setAttribute('d', pc.d); node.setAttribute('class', pc.cls + ' dash');
        pc.parent.appendChild(node); chain.pool.set(key, node);
      }
      used.add(key);
      // local coordinate along the clone = position within the piece + lead. Extend into the lead
      // geometry when the dash continues past the face so abutting clones overlap and hide seams.
      const a = u0 < pc.s0 ? 0 : (lo - pc.s0) + pc.lead;
      const b = (u1 > pc.s0 + pc.len ? pc.len + 2 * pc.lead : (hi - pc.s0) + pc.lead) - a;
      node.style.strokeDasharray = `0 ${a} ${b} 100000`;
      const c = mix(mix(bg, base, 0.5 + 0.5 * pc.seg.level), WHITE, state.flash * 0.6);
      node.style.stroke = toCss(c);
    });
  }

  // ---------- frame loop ----------
  let last = performance.now(), raf = 0;
  const minFrameMs = 1000 / (opts.maxFps ?? 60) - 1.5;   // cap work at ~60 fps even on 120/165 Hz displays
  function frame(now) {
    if (now - last < minFrameMs) { raf = requestAnimationFrame(frame); return; }
    frameNo++;
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    vCur += (state.speed - vCur) * Math.min(1, dt * 4);
    colorEase = 1 - Math.exp(-dt / (state.colorTau ?? 0.45));   // colour time constant, default 0.45 s
    bgRgb = mix(bgRgb, hex2rgb(state.bg), colorEase);            // background reference eases too
    if (state.mode !== lastMode) {
      for (const [name, m] of Object.entries(MODES)) { m.layer.style.display = name === state.mode ? '' : 'none'; if (name !== state.mode) for (const c of m.chains) if (c.pool) clearPool(c); }
      for (const c of MODES[state.mode].chains) resetChain(c);
      lastMode = state.mode;
    }
    for (const chain of MODES[state.mode].chains) {
      if (chain.running) {
        const ramp = smoothstep((now - chain.startedAt) / 1000 / RAMP_IN);
        const locked = beatOn() && state.animating && chain.stopAt === null;
        let vel = locked ? beatSetup(chain).v * ramp : vCur * ramp;
        if (chain.stopAt !== null) {
          const r = chain.stopAt - chain.phase;
          if (chain.decel === null) chain.decel = Math.min(r, vel * DECEL_T / 2);
          if (r <= chain.decel) vel = Math.min(vel, vCur) * Math.sqrt(Math.max(r, 0) / Math.max(chain.decel, 1e-6));
          if (r <= 0.02 || vel * dt >= r) { chain.phase = chain.stopAt; chain.stopAt = null; chain.decel = null; chain.running = false; vel = 0; }
        }
        chain.phase += vel * dt;
        if (locked && ramp >= 1) beatAlign(chain, now, dt);
      }
      // keep the queue topped up; while beat-locked, stay a full pitch ahead of the entry line so a
      // not-yet-entered dash is always available to steer onto the beat
      const ahead = beatOn() && state.animating && chain.stopAt === null ? beatSetup(chain).L : 0;
      while (chain.stream[0].p > -chain.phase - ahead + 1e-6) prepend(chain, state.animating ? (beatOn() ? beatBlock(chain) : animBlock(chain)) : staticBlock(chain));
      while (chain.stream.length > 1 && chain.stream[chain.stream.length - 1].p >= chain.T - chain.phase) chain.stream.pop();
      if (performance.now() - modeChangedAt < JOIN_MS + 300 || !chain.bridgesPlaced) { for (const b of chain.bridges) placeBridge(b); chain.bridgesPlaced = true; }
      const used = new Set();
      for (const el of chain.stream) if (el.dash) renderDash(chain, el, used);
      for (const [key, node] of chain.pool) if (!used.has(key)) { node.remove(); chain.pool.delete(key); }
    }
    state.flash *= Math.exp(-dt / 0.12);
    state.pulse *= Math.exp(-dt / 0.22);
    pulseG.style.transform = `scale(${1 + 0.1 * state.pulse})`;
    updateBeatMarkers(now);
    raf = requestAnimationFrame(frame);
  }
  for (const m of Object.values(MODES)) for (const c of m.chains) resetChain(c);
  raf = requestAnimationFrame(frame);

  // ---------- beat markers (debug): entry and exit point of every active path ----------
  const markerLayer = { left: svg.querySelector('.guides-left'), right: svg.querySelector('.guides-right') };
  for (const m of Object.values(MODES)) m.chains.forEach((chain, idx) => {
    const first = chain.segs[0], lastSeg = chain.segs[chain.segs.length - 1];
    const mk = (seg, atEnd, cls) => {
      const q = seg.p.getPointAtLength(atEnd ? seg.len : 0);
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', q.x); c.setAttribute('cy', q.y); c.setAttribute('r', 5);
      c.setAttribute('class', `beat-mark ${cls}`); c.style.display = 'none';
      markerLayer[seg.half].appendChild(c);
      // path number inside the ring, so entries and exits can be referred to by index
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', q.x); t.setAttribute('y', q.y); t.textContent = String(idx);
      t.setAttribute('class', `beat-label ${cls}`); t.style.display = 'none';
      markerLayer[seg.half].appendChild(t);
      c.label = t;
      return c;
    };
    chain.markers = [mk(first, false, 'entry'), mk(lastSeg, true, 'exit')];
  });
  style.textContent += `
    .sendspin-logo .beat-mark { fill: none; stroke: #fff; stroke-width: 0.8; }
    .sendspin-logo .beat-mark.exit { stroke-dasharray: 2 1.5; }
    .sendspin-logo .beat-label { fill: #fff; font: 700 4px system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
    .sendspin-logo .beat-label.exit { fill: #fff9; }`;
  function updateBeatMarkers(now) {
    const show = state.beat.markers && beatOn();
    for (const [name, m] of Object.entries(MODES)) for (const chain of m.chains) {
      const vis = show && name === state.mode;
      for (const c of chain.markers) { c.style.display = vis ? '' : 'none'; c.label.style.display = vis ? '' : 'none'; }
      if (!vis) continue;
      const Pd = state.beat.period / divOf(chain);
      let tau = ((state.beat.anchor + state.beat.offsetMs - now) / 1000) % Pd; if (tau < 0) tau += Pd;
      const k = Math.pow(1 - tau / Pd, 6);                  // swells into the (sub)beat, snaps back
      for (const c of chain.markers) { c.setAttribute('r', 5 + 3.5 * k); c.style.strokeOpacity = 0.35 + 0.65 * k; }
    }
  }

  // ---------- guides (debug) ----------
  const ACROSS = [Math.SQRT1_2, Math.SQRT1_2], GUIDE = 14;
  function corners(path, atStart) {
    const L = path.getTotalLength();
    const a = path.getPointAtLength(atStart ? 0 : L), b = path.getPointAtLength(atStart ? 0.05 : L - 0.05);
    let tx = b.x - a.x, ty = b.y - a.y; const n = Math.hypot(tx, ty); tx /= n; ty /= n;
    return [[a.x - ty * SW / 2, a.y + tx * SW / 2], [a.x + ty * SW / 2, a.y - tx * SW / 2]];
  }
  for (const side of ['left', 'right']) {
    const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'guides');
    for (const path of halves[side].querySelectorAll('path')) for (const atStart of [true, false]) for (const [x, y] of corners(path, atStart)) {
      const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 0.7); g.appendChild(c);
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', x - ACROSS[0] * GUIDE); l.setAttribute('y1', y - ACROSS[1] * GUIDE);
      l.setAttribute('x2', x + ACROSS[0] * GUIDE); l.setAttribute('y2', y + ACROSS[1] * GUIDE); g.appendChild(l);
    }
    svg.querySelector(`.guides-${side}`).appendChild(g);
  }
  for (const k of [122.497, 133.811]) {
    const l = document.createElementNS(NS, 'line'); l.setAttribute('class', 'guides bank');
    l.setAttribute('x1', -10); l.setAttribute('y1', k + 10); l.setAttribute('x2', k + 10); l.setAttribute('y2', -10);
    svg.querySelector('.overlay').appendChild(l);
  }

  // ---------- public API ----------
  // Segment order for spectrum mapping: biggest arcs first (bass), smallest caps last (treble).
  const BY_SIZE = ['A1', 'B3', 'A0', 'B4', 'A3', 'B1', 'A4', 'B0'];
  const api = {
    svg, state, SEG,
    setMode(mode) { if (mode !== state.mode) modeChangedAt = performance.now(); state.mode = mode; svg.classList.toggle('joined', mode === 'joined'); },
    toggleMode() { api.setMode(state.mode === 'joined' ? 'offset' : 'joined'); },
    setAnimating,
    setSpeed(v) { state.speed = Math.max(0, v); },
    setDash(d) { state.dash = Math.max(4, d); },
    setRandom(on) { state.random = !!on; },
    setRadius(r) { state.radius = r; svg.querySelector('.round-blur').setAttribute('stdDeviation', r); art.setAttribute('filter', r > 0 ? `url(#${id}-round)` : ''); },
    /** Colours handed out round-robin to dashes as they enter the queue; one solid colour per shape. */
    setDashColors(list) { const l = (Array.isArray(list) ? list : [list]).filter(Boolean); if (l.length) state.dashColors = l; },
    /** Convenience: one or two colours (alternating shapes). */
    setColors(a, b) { api.setDashColors([a, b]); },
    /** Recolour the shapes currently on screen too (otherwise new colours apply only to entering shapes). */
    recolor() { for (const m of Object.values(MODES)) for (const c of m.chains) for (const el of c.stream) if (el.dash) el.color = nextColor(); },
    /** Segment ids of each S in flow order (top-right cap first). */
    FLOW: { sA: ['A0', 'A1', 'A3', 'A4'], sB: ['B0', 'B1', 'B3', 'B4'] },
    setBackground(hex) { state.bg = hex; },
    /**
     * Beat lock. period in seconds, nextBeatAt a performance.now() timestamp (ms) of a coming beat.
     * Call on every beat (or whenever the estimate changes); clearBeatClock() returns to free flow.
     */
    setBeatClock({ period, nextBeatAt }) {
      if (!(period > 0)) return;
      const b = state.beat, Pms = period * 1000;
      // The grid anchor is a beat time that stays on the same beat count as estimates refine, so
      // multi-beat divisions (0.5 = every other beat) keep a stable parity instead of flipping.
      if (!b.on || !b.anchor || Math.abs(period - b.period) > 0.05 * b.period) b.anchor = nextBeatAt;
      else b.anchor = nextBeatAt - Math.round((nextBeatAt - b.anchor) / Pms) * Pms;
      b.period = period; b.nextAt = nextBeatAt; b.on = true;
    },
    clearBeatClock() { state.beat.on = false; for (const m of Object.values(MODES)) for (const c of m.chains) c.beat = null; },
    /** Shift the visual beat grid by ms (+ later) to compensate output latency the browser cannot see. */
    setBeatOffset(ms) { state.beat.offsetMs = +ms || 0; },
    /** Dashes per beat for every path (1 = every beat, 2 = eighths). */
    setBeatDiv(d) { if (d > 0) state.beat.div = d; },
    /** Per-path dashes per beat, indexed like beatDebug(); null entries fall back to the global value. */
    setPathBeatDivs(list) {
      MODES[state.mode].chains.forEach((c, i) => {
        const d = list[i], nd = d > 0 ? d : null;
        if (nd === c.div) return;
        c.div = nd; if (c.beat) { c.beat.n = 0; c.beat.lastNext = null; }
        // drop queued elements that have not entered so the new pitch starts with the next dash
        while (c.stream.length > 1 && c.stream[0].p + c.stream[0].len + c.phase <= 0) c.stream.shift();
      });
    },
    showBeatMarkers(on) { state.beat.markers = !!on; },
    /** Per-path lock telemetry for a debug UI. */
    beatDebug() {
      return MODES[state.mode].chains.map((c, i) => ({ path: i, div: divOf(c), T: +c.T.toFixed(1), n: c.beat?.n ?? 0, v: +(c.beat?.v ?? 0).toFixed(1), errMs: Math.round((c.beat?.err ?? 0) * 1000), snaps: c.beat?.snaps ?? 0, nextInMs: c.beat?.nextInMs ?? null, entries: c.beat?.entries ?? [] }));
    },
    /** Colour transition time constant in seconds (default 0.45). */
    setColorEase(seconds) { state.colorTau = Math.max(0.01, seconds); },
    showGuides(on) { svg.classList.toggle('show-guides', !!on); },
    reset() { for (const c of MODES[state.mode].chains) resetChain(c); },
    /** Onset flash, strength 0..1: brightens towards white and decays in ~120ms. */
    flash(strength = 1) { state.flash = Math.min(1, Math.max(state.flash, strength)); },
    /** Beat pulse, strength 0..1: scales the whole logo up briefly. */
    pulse(strength = 1) { state.pulse = Math.min(1, Math.max(state.pulse, strength)); },
    /** Per-segment brightness levels 0..1, one per entry of BY_SIZE (8 values, bass first). */
    setLevels(levels) { BY_SIZE.forEach((sid, i) => { if (levels[i] !== undefined) SEG[sid].level = levels[i]; }); },
    clearLevels() { for (const s of Object.values(SEG)) s.level = 1; },
    destroy() { cancelAnimationFrame(raf); container.innerHTML = ''; },
    BY_SIZE,
  };
  api.setRadius(opts.radius ?? 0.8);
  return api;
}

/** Linear mix of two hex colours, t in 0..1. */
export function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = sh => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
  return '#' + [16, 8, 0].map(sh => ch(sh).toString(16).padStart(2, '0')).join('');
}

function reversePath(d) {
  const n = d.match(/-?\d*\.?\d+/g).map(Number);
  const pts = []; for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
  pts.reverse();
  let out = `M${pts[0]}`;
  for (let i = 1; i < pts.length; i += 3) out += ` C${pts[i]} ${pts[i + 1]} ${pts[i + 2]}`;
  return out.replace(/,/g, ' ');
}
