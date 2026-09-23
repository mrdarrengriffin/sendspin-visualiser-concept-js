/**
 * The Sendspin logo as an animated SVG: a queue of dashes flowing along each solid path, one solid
 * colour per shape, with an optional beat lock. Framework-free; depends only on ./geometry and
 * ../color. See docs/animation and docs/beat-sync for the model this implements.
 */
import {
  BRAND_RED, BY_SIZE, CHAINS, FLOW, GAP, HALF_SHIFT, OVERLAP, REVERSED, SEGMENTS, STROKE, U, BANK_LINES,
  add, reversePath, smoothstep,
  type Half, type SegmentId, type Vec, type ViewMode,
} from './geometry';
import { hexToRgb, mixRgb, rgbToCss, type RGB } from '../color';

export { BRAND_RED, BY_SIZE, FLOW } from './geometry';
export { mixHex } from '../color';

const NS = 'http://www.w3.org/2000/svg';
const WHITE: RGB = [255, 255, 255];
const RAMP_IN = 1.0;   // s, speed ramp when a path starts
const UNLOCK_TAU = 0.5; // s, a path leaving the beat lock eases from its locked speed with this time constant
const DECEL_T = 1.4;   // s, ease-out horizon when a path stops on the logo

export interface LogoOptions {
  speed?: number;
  dash?: number;
  colorA?: string;
  background?: string;
  radius?: number;
  maxFps?: number;
  joinMs?: number;
}

export interface BeatClockInput { period: number; nextBeatAt: number }

export interface PathBeatInfo {
  path: number; div: number; T: number; n: number; v: number;
  errMs: number; snaps: number; nextInMs: number | null; entries: number[];
}

interface Segment {
  id: SegmentId; s: 'sA' | 'sB'; half: Half;
  p: SVGPathElement; len: number; level: number; paints: SVGPathElement[];
}
interface BridgeHalf { p: SVGPathElement; len: number; lead: number }
interface Bridge {
  g: SVGGElement; halves: BridgeHalf[]; len: number;
  E: Vec; S: Vec; A: Vec; B: Vec; N: Vec; halfE: Half; halfS: Half;
}
interface Piece { s0: number; len: number; lead: number; parent: Element; d: string; seg: Segment; cls: string }
interface QueueEl { p: number; len: number; dash: boolean; beat?: boolean; id?: number; color?: string; rgb?: RGB }
interface BeatState {
  n: number; v: number; L: number; err: number; snaps: number;
  lastNext?: QueueEl | null; nextInMs?: number; entries?: number[]; correcting?: boolean;
}
interface Marker { ring: SVGCircleElement; label: SVGTextElement }
interface Chain {
  segs: Segment[]; bridges: Bridge[]; pieces: Piece[]; T: number;
  stream: QueueEl[]; phase: number; running: boolean; stopAt: number | null; decel: number | null; startedAt: number;
  pool: Map<string, SVGPathElement>; beat: BeatState | null; dv: number; div: number | null; markers: Marker[]; bridgesPlaced: boolean;
}
interface ModeState { layer: SVGGElement; chains: Chain[] }

let uid = 0;

export function mountLogo(container: HTMLElement, opts: LogoOptions = {}) {
  const id = 'sl' + uid++;
  const JOIN_MS = opts.joinMs ?? 1200;

  // ---------------------------------------------------------------- markup
  const segMarkup = (half: Half) =>
    SEGMENTS.filter((s) => s.half === half).map((s) => `<path class="${s.s}" data-seg="${s.id}" d="${s.d}"/>`).join('');
  container.innerHTML = `
<svg class="sendspin-logo" viewBox="0 0 128 128" fill="none" stroke-width="${STROKE}" xmlns="${NS}">
  <defs>
    <filter id="${id}-round" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
      <feGaussianBlur class="round-blur" stdDeviation="0.8"/>
      <feComponentTransfer><feFuncA type="linear" slope="12" intercept="-5.5"/></feComponentTransfer>
    </filter>
  </defs>
  <g class="pulse"><g class="art" filter="url(#${id}-round)">
    <g class="half half-left">${segMarkup('left')}</g>
    <g class="half half-right">${segMarkup('right')}</g>
  </g></g>
  <g class="overlay"><g class="guides-left"></g><g class="guides-right"></g></g>
</svg>`;
  const svg = container.querySelector('svg') as SVGSVGElement;
  const art = svg.querySelector('.art') as SVGGElement;
  const pulseG = svg.querySelector('.pulse') as SVGGElement;
  const halves: Record<Half, SVGGElement> = {
    left: svg.querySelector('.half-left') as SVGGElement,
    right: svg.querySelector('.half-right') as SVGGElement,
  };
  const overlay: Record<Half, SVGGElement> = {
    left: svg.querySelector('.guides-left') as SVGGElement,
    right: svg.querySelector('.guides-right') as SVGGElement,
  };
  const style = document.createElement('style');
  const J = HALF_SHIFT.joined;
  style.textContent = `
    .sendspin-logo { display: block; }
    .sendspin-logo .half, .sendspin-logo .overlay > g { transition: transform ${JOIN_MS}ms cubic-bezier(.4,0,.2,1); }
    .sendspin-logo.joined .half-left, .sendspin-logo.joined .guides-left  { transform: translate(${J.left[0]}px, ${J.left[1]}px); }
    .sendspin-logo.joined .half-right, .sendspin-logo.joined .guides-right { transform: translate(${J.right[0]}px, ${J.right[1]}px); }
    .sendspin-logo .pulse { transform-origin: 64px 64px; transform-box: view-box; }
    .sendspin-logo .guides { pointer-events: none; display: none; }
    .sendspin-logo.show-guides .guides { display: initial; }
    .sendspin-logo .guides line { stroke: #fff; stroke-width: 0.25; stroke-opacity: 0.8; }
    .sendspin-logo .guides circle { fill: #fff; }
    .sendspin-logo .guides .bank { stroke: #888; stroke-width: 0.3; stroke-dasharray: 1 1; }
    .sendspin-logo .beat-mark { fill: none; stroke: #fff; stroke-width: 0.8; }
    .sendspin-logo .beat-mark.exit { stroke-dasharray: 2 1.5; }
    .sendspin-logo .beat-label { fill: #fff; font: 700 4px system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
    .sendspin-logo .beat-label.exit { fill: #fff9; }`;
  svg.prepend(style);

  // ---------------------------------------------------------------- segments
  const SEG = {} as Record<SegmentId, Segment>;
  for (const def of SEGMENTS) {
    const p = svg.querySelector(`path[data-seg="${def.id}"]`) as SVGPathElement;
    if (REVERSED[def.id]) p.setAttribute('d', reversePath(def.d));
    SEG[def.id] = { id: def.id, s: def.s, half: def.half, p, len: p.getTotalLength(), level: 1, paints: [p] };
  }
  const localEnd = (s: Segment, atEnd: boolean): Vec => {
    const q = s.p.getPointAtLength(atEnd ? s.len : 0);
    return [q.x, q.y];
  };

  // Where each half currently is. Reading the computed transform forces style work, so it is done
  // once per frame and only while the join/offset transition is animating; otherwise it is known.
  let frameNo = 0, shiftFrame = -1, modeChangedAt = -1e9;
  let shiftCache: Record<Half, Vec> = { left: [0, 0], right: [0, 0] };
  function shiftOf(half: Half): Vec {
    if (shiftFrame !== frameNo) {
      shiftFrame = frameNo;
      if (performance.now() - modeChangedAt < JOIN_MS + 150) {
        for (const k of ['left', 'right'] as Half[]) {
          const m = new DOMMatrix(getComputedStyle(halves[k]).transform);
          shiftCache[k] = [m.e, m.f];
        }
      } else shiftCache = svg.classList.contains('joined') ? { ...HALF_SHIFT.joined } : { ...HALF_SHIFT.offset };
    }
    return shiftCache[half];
  }

  // ---------------------------------------------------------------- bridges
  // The 8-unit connector between two faces in a view's own coordinates, split into two colour
  // halves, each drawn OVERLAP longer at both ends and tucked under the arcs to hide seams.
  function makeBridge(prev: Segment, next: Segment, ref: Record<Half, Vec>, layer: SVGGElement): Bridge {
    const E = localEnd(prev, true), S = localEnd(next, false);
    const A = add(E, ref[prev.half]), B = add(S, ref[next.half]);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const N: Vec = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    const M: Vec = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const g = document.createElementNS(NS, 'g') as SVGGElement;
    layer.appendChild(g);
    const ext = (v: Vec): Vec => [v[0] * OVERLAP, v[1] * OVERLAP];
    const halvesEl = ([[A, M, prev], [M, B, next]] as [Vec, Vec, Segment][]).map(([P, Q, owner]) => {
      const P2 = add(P, ext([-N[0], -N[1]])), Q2 = add(Q, ext(N));
      const p = document.createElementNS(NS, 'path') as SVGPathElement;
      p.setAttribute('d', `M${P2[0]} ${P2[1]} L${Q2[0]} ${Q2[1]}`);
      p.setAttribute('class', owner.s);
      g.appendChild(p);
      owner.paints.push(p);
      return { p, len: len / 2, lead: OVERLAP };
    });
    return { g, halves: halvesEl, len, E, S, A, B, N, halfE: prev.half, halfS: next.half };
  }
  // Shear that keeps both ends of a bridge on its (possibly displaced) faces.
  function placeBridge(b: Bridge): void {
    const Ac = add(b.E, shiftOf(b.halfE)), Bc = add(b.S, shiftOf(b.halfS));
    const dA: Vec = [Ac[0] - b.A[0], Ac[1] - b.A[1]], dB: Vec = [Bc[0] - b.B[0], Bc[1] - b.B[1]];
    const m = (dB[0] - dA[0]) * U[0] + (dB[1] - dA[1]) * U[1];
    const k = m / b.len;
    const a = 1 + k * U[0] * b.N[0], c = k * U[0] * b.N[1], bb = k * U[1] * b.N[0], d = 1 + k * U[1] * b.N[1];
    const e = Ac[0] - (a * b.A[0] + c * b.A[1]), f = Ac[1] - (bb * b.A[0] + d * b.A[1]);
    b.g.setAttribute('transform', `matrix(${a} ${bb} ${c} ${d} ${e} ${f})`);
  }

  const MODES = {} as Record<ViewMode, ModeState>;
  for (const name of ['joined', 'offset'] as ViewMode[]) {
    const layer = document.createElementNS(NS, 'g') as SVGGElement;
    layer.setAttribute('class', `bridges-${name}`);
    art.insertBefore(layer, art.firstElementChild);
    const chains = CHAINS[name].map((ids): Chain => {
      const segs = ids.map((i) => SEG[i]);
      const bridges = segs.slice(1).map((s, k) => makeBridge(segs[k], s, HALF_SHIFT[name], layer));
      const T = segs.reduce((a, s) => a + s.len, 0) + bridges.reduce((a, b) => a + b.len, 0);
      // pieces in flow order: arcs and bridge halves with the DOM parent whose transform they inherit
      const pieces: Piece[] = [];
      let s0 = 0;
      segs.forEach((seg, k) => {
        if (k > 0) for (const h of bridges[k - 1].halves) {
          pieces.push({ s0, len: h.len, lead: h.lead, parent: h.p.parentNode as Element, d: h.p.getAttribute('d')!, seg: pieces[pieces.length - 1].seg, cls: h.p.getAttribute('class')! });
          s0 += h.len;
        }
        pieces.push({ s0, len: seg.len, lead: 0, parent: halves[seg.half], d: seg.p.getAttribute('d')!, seg, cls: seg.s });
        s0 += seg.len;
      });
      return { segs, bridges, pieces, T, stream: [], phase: 0, running: false, stopAt: null, decel: null, startedAt: 0, pool: new Map(), beat: null, dv: 0, div: null, markers: [], bridgesPlaced: false };
    });
    MODES[name] = { layer, chains };
  }
  // The original paths are geometry only; visible strokes are the per-dash clones.
  for (const s of Object.values(SEG)) for (const p of s.paints) p.style.stroke = 'none';

  // ---------------------------------------------------------------- state
  const state = {
    animating: false,
    mode: 'offset' as ViewMode,
    speed: opts.speed ?? 40,
    dash: opts.dash ?? 24,
    random: false,
    dashColors: [opts.colorA ?? BRAND_RED],
    bg: opts.background ?? '#111111',
    flash: 0,
    pulse: 0,
    radius: 0.8,
    colorTau: 0.45,
    beat: { period: 0, nextAt: 0, anchor: 0, div: 1, markers: false, on: false, offsetMs: 0 },
  };
  let vCur = 0, lastMode: ViewMode | null = null, dashUid = 0, colorIdx = 0, colorEase = 1;
  let bgRgb = hexToRgb(state.bg);

  // ---------------------------------------------------------------- queue
  const nextColor = () => state.dashColors[colorIdx++ % state.dashColors.length];
  const staticBlock = (chain: Chain): QueueEl[] =>
    chain.segs.flatMap((s) => [{ len: s.len, dash: true, p: 0 }, { len: GAP, dash: false, p: 0 }]);
  function animBlock(chain: Chain): QueueEl[] {
    if (state.random) return [{ len: state.dash * (0.5 + Math.random()), dash: true, p: 0 }, { len: GAP, dash: false, p: 0 }];
    const els: QueueEl[] = [];
    for (const s of chain.segs) {
      const n = Math.max(1, Math.round((s.len + GAP) / (state.dash + GAP)));
      const sub = (s.len - (n - 1) * GAP) / n;
      for (let i = 0; i < n; i++) els.push({ len: sub, dash: true, p: 0 }, { len: GAP, dash: false, p: 0 });
    }
    return els;
  }
  function prepend(chain: Chain, block: QueueEl[]): number {
    let p = chain.stream.length ? chain.stream[0].p : -chain.phase;
    for (let i = block.length - 1; i >= 0; i--) {
      p -= block[i].len;
      const el: QueueEl = { ...block[i], p };
      if (el.dash) { el.id = ++dashUid; el.color = nextColor(); }
      chain.stream.unshift(el);
    }
    return p;
  }
  const clearPool = (chain: Chain) => { for (const el of chain.pool.values()) el.remove(); chain.pool.clear(); };
  function resetChain(chain: Chain): void {
    chain.stream = []; chain.phase = 0; chain.stopAt = null; chain.decel = null;
    clearPool(chain);
    chain.phase = -prepend(chain, staticBlock(chain)); // the block now sits at u in [0, T + GAP]
    chain.running = state.animating; chain.startedAt = performance.now();
  }
  function setAnimating(on: boolean): void {
    if (state.animating === on) return;
    state.animating = on;
    for (const chain of MODES[state.mode].chains) {
      // throw away queued elements that have not entered, so the new kind is next in line
      while (chain.stream.length > 1 && chain.stream[0].p + chain.stream[0].len <= -chain.phase) chain.stream.shift();
      if (!chain.running) chain.startedAt = performance.now();
      chain.running = true; chain.decel = null;
      chain.stopAt = on ? null : -prepend(chain, staticBlock(chain)); // stop exactly when that block is home
    }
  }

  // ---------------------------------------------------------------- beat lock
  // One master grid (period, anchor). A path of length T is traversed in n beats, so an edge that
  // enters on a beat exits on a beat; pitch L = T / (n · div), speed v = T / (n · period).
  const beatOn = () => state.beat.on && state.beat.period > 0;
  const divOf = (chain: Chain) => chain.div ?? state.beat.div;
  function beatSetup(chain: Chain): BeatState {
    const P = state.beat.period, want = Math.max(5, vCur);
    const b = chain.beat ?? (chain.beat = { n: 0, v: 0, L: 0, err: 0, snaps: 0 });
    const div = divOf(chain);
    const step = div < 1 ? Math.max(1, Math.round(1 / div)) : 1; // fractional div: n must be a multiple of 1/div
    const nWant = Math.max(step, Math.round(chain.T / (want * P) / step) * step);
    if (!b.n || b.n % step !== 0 || Math.abs(chain.T / (b.n * P) - want) > 0.4 * want) b.n = nWant; // hysteresis
    b.L = chain.T / b.n / div;
    b.v = chain.T / (b.n * P);
    return b;
  }
  function beatBlock(chain: Chain): QueueEl[] {
    const b = beatSetup(chain), gap = b.L > 2 * GAP ? GAP : b.L / 2;
    return [{ len: b.L - gap, dash: true, beat: true, p: 0 }, { len: gap, dash: false, beat: true, p: 0 }];
  }
  // The not-yet-entered beat dash closest to the entry line.
  function nextBeatEdge(chain: Chain): { d: number; el: QueueEl } | null {
    let best: { d: number; el: QueueEl } | null = null;
    for (const el of chain.stream) {
      if (!el.dash || !el.beat) continue;
      const d = -(el.p + el.len + chain.phase);
      if (d >= 0 && (best === null || d < best.d)) best = { d, el };
    }
    return best;
  }
  // Deterministic placement: compute the phase that puts the next edge on the next grid time and
  // ease onto it. No feedback lag, so paths with different divisions are mutually aligned.
  function beatAlign(chain: Chain, now: number, dt: number): void {
    const b = chain.beat!, Pd = state.beat.period / divOf(chain);
    const next = nextBeatEdge(chain);
    if (!next) return;
    if (b.lastNext && b.lastNext !== next.el) {
      const over = b.lastNext.p + b.lastNext.len + chain.phase; // exact instant the previous edge crossed
      (b.entries ??= []).push(now - (Math.max(0, over) / b.v) * 1000);
      if (b.entries.length > 40) b.entries.shift();
    }
    b.lastNext = next.el; b.nextInMs = (next.d / b.v) * 1000;
    let tau = ((state.beat.anchor + state.beat.offsetMs - now) / 1000) % Pd; if (tau < 0) tau += Pd;
    const q = next.el.p + next.el.len;
    const target = -q - b.v * tau;
    const raw = target - chain.phase;
    const err = raw - b.L * Math.round(raw / b.L); // the grid is periodic in L
    b.err = err / b.v;
    if (Math.abs(err) <= 0.4) { chain.phase += err; b.correcting = false; }
    else {
      if (!b.correcting && Math.abs(err) > b.L / 4) { b.snaps++; b.correcting = true; }
      chain.phase += err * Math.min(1, dt / 1.0); // ease over ~1 s: spacing kept, no holes
    }
  }

  // ---------------------------------------------------------------- render
  function renderDash(chain: Chain, el: QueueEl, used: Set<string>): void {
    const u0 = el.p + chain.phase, u1 = u0 + el.len;
    if (u1 <= 0 || u0 >= chain.T) return;
    const target = hexToRgb(el.color!);
    el.rgb = el.rgb ? mixRgb(el.rgb, target, colorEase) : target; // colours fade, never snap
    chain.pieces.forEach((pc, k) => {
      const lo = Math.max(u0, pc.s0), hi = Math.min(u1, pc.s0 + pc.len);
      if (hi <= lo) return;
      const key = `${el.id}:${k}`;
      let node = chain.pool.get(key);
      if (!node) {
        node = document.createElementNS(NS, 'path') as SVGPathElement;
        node.setAttribute('d', pc.d); node.setAttribute('class', `${pc.cls} dash`);
        pc.parent.appendChild(node); chain.pool.set(key, node);
      }
      used.add(key);
      // local coordinate along the clone = position within the piece + lead; extend into the lead
      // geometry when the dash continues past the face so abutting clones overlap
      const a = u0 < pc.s0 ? 0 : lo - pc.s0 + pc.lead;
      const b = (u1 > pc.s0 + pc.len ? pc.len + 2 * pc.lead : hi - pc.s0 + pc.lead) - a;
      node.style.strokeDasharray = `0 ${a} ${b} 100000`;
      node.style.stroke = rgbToCss(mixRgb(mixRgb(bgRgb, el.rgb!, 0.5 + 0.5 * pc.seg.level), WHITE, state.flash * 0.6));
    });
  }

  // ---------------------------------------------------------------- beat markers (debug)
  for (const name of ['joined', 'offset'] as ViewMode[]) MODES[name].chains.forEach((chain, idx) => {
    const mk = (seg: Segment, atEnd: boolean, cls: 'entry' | 'exit'): Marker => {
      const q = seg.p.getPointAtLength(atEnd ? seg.len : 0);
      const ring = document.createElementNS(NS, 'circle') as SVGCircleElement;
      ring.setAttribute('cx', String(q.x)); ring.setAttribute('cy', String(q.y)); ring.setAttribute('r', '5');
      ring.setAttribute('class', `beat-mark ${cls}`); ring.style.display = 'none';
      const label = document.createElementNS(NS, 'text') as SVGTextElement;
      label.setAttribute('x', String(q.x)); label.setAttribute('y', String(q.y)); label.textContent = String(idx);
      label.setAttribute('class', `beat-label ${cls}`); label.style.display = 'none';
      overlay[seg.half].append(ring, label);
      return { ring, label };
    };
    chain.markers = [mk(chain.segs[0], false, 'entry'), mk(chain.segs[chain.segs.length - 1], true, 'exit')];
  });
  function updateBeatMarkers(now: number): void {
    const show = state.beat.markers && beatOn();
    for (const name of ['joined', 'offset'] as ViewMode[]) for (const chain of MODES[name].chains) {
      const vis = show && name === state.mode;
      for (const m of chain.markers) { m.ring.style.display = vis ? '' : 'none'; m.label.style.display = vis ? '' : 'none'; }
      if (!vis) continue;
      const Pd = state.beat.period / divOf(chain);
      let tau = ((state.beat.anchor + state.beat.offsetMs - now) / 1000) % Pd; if (tau < 0) tau += Pd;
      const k = Math.pow(1 - tau / Pd, 6); // swells into the (sub)beat, snaps back
      for (const m of chain.markers) { m.ring.setAttribute('r', String(5 + 3.5 * k)); m.ring.style.strokeOpacity = String(0.35 + 0.65 * k); }
    }
  }

  // ---------------------------------------------------------------- corner guides (debug)
  const ACROSS: Vec = [Math.SQRT1_2, Math.SQRT1_2], GUIDE = 14;
  function corners(path: SVGPathElement, atStart: boolean): Vec[] {
    const L = path.getTotalLength();
    const a = path.getPointAtLength(atStart ? 0 : L), b = path.getPointAtLength(atStart ? 0.05 : L - 0.05);
    let tx = b.x - a.x, ty = b.y - a.y; const n = Math.hypot(tx, ty); tx /= n; ty /= n;
    return [[a.x - (ty * STROKE) / 2, a.y + (tx * STROKE) / 2], [a.x + (ty * STROKE) / 2, a.y - (tx * STROKE) / 2]];
  }
  for (const side of ['left', 'right'] as Half[]) {
    const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'guides');
    for (const s of Object.values(SEG)) if (s.half === side) for (const atStart of [true, false]) for (const [x, y] of corners(s.p, atStart)) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y)); c.setAttribute('r', '0.7'); g.appendChild(c);
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', String(x - ACROSS[0] * GUIDE)); l.setAttribute('y1', String(y - ACROSS[1] * GUIDE));
      l.setAttribute('x2', String(x + ACROSS[0] * GUIDE)); l.setAttribute('y2', String(y + ACROSS[1] * GUIDE)); g.appendChild(l);
    }
    overlay[side].appendChild(g);
  }
  for (const k of BANK_LINES) {
    const l = document.createElementNS(NS, 'line'); l.setAttribute('class', 'guides bank');
    l.setAttribute('x1', '-10'); l.setAttribute('y1', String(k + 10)); l.setAttribute('x2', String(k + 10)); l.setAttribute('y2', '-10');
    (svg.querySelector('.overlay') as SVGGElement).appendChild(l);
  }

  // ---------------------------------------------------------------- frame loop
  let last = performance.now(), raf = 0;
  const minFrameMs = 1000 / (opts.maxFps ?? 60) - 1.5;
  function frame(now: number): void {
    if (now - last < minFrameMs) { raf = requestAnimationFrame(frame); return; }
    frameNo++;
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    vCur += (state.speed - vCur) * Math.min(1, dt * 4);
    colorEase = 1 - Math.exp(-dt / state.colorTau);
    bgRgb = mixRgb(bgRgb, hexToRgb(state.bg), colorEase);
    if (state.mode !== lastMode) {
      for (const name of ['joined', 'offset'] as ViewMode[]) {
        MODES[name].layer.style.display = name === state.mode ? '' : 'none';
        if (name !== state.mode) for (const c of MODES[name].chains) clearPool(c);
      }
      for (const c of MODES[state.mode].chains) resetChain(c);
      lastMode = state.mode;
    }
    const transitioning = performance.now() - modeChangedAt < JOIN_MS + 300;
    for (const chain of MODES[state.mode].chains) {
      const locked = beatOn() && state.animating && chain.stopAt === null;
      if (chain.running) {
        const ramp = smoothstep((now - chain.startedAt) / 1000 / RAMP_IN);
        if (locked) chain.dv = 0; else chain.dv *= Math.exp(-dt / UNLOCK_TAU);
        let vel = locked ? beatSetup(chain).v * ramp : Math.max(0, vCur + chain.dv) * ramp;
        if (chain.stopAt !== null) {
          const r = chain.stopAt - chain.phase;
          if (chain.decel === null) chain.decel = Math.min(r, (vel * DECEL_T) / 2);
          if (r <= chain.decel) vel = Math.min(vel, vCur) * Math.sqrt(Math.max(r, 0) / Math.max(chain.decel, 1e-6));
          if (r <= 0.02 || vel * dt >= r) { chain.phase = chain.stopAt; chain.stopAt = null; chain.decel = null; chain.running = false; vel = 0; }
        }
        chain.phase += vel * dt;
        if (locked && ramp >= 1) beatAlign(chain, now, dt);
      }
      // keep the queue topped up; while locked, stay a full pitch ahead so a dash is always on approach
      const ahead = locked ? beatSetup(chain).L : 0;
      while (chain.stream[0].p > -chain.phase - ahead + 1e-6) prepend(chain, state.animating ? (beatOn() ? beatBlock(chain) : animBlock(chain)) : staticBlock(chain));
      while (chain.stream.length > 1 && chain.stream[chain.stream.length - 1].p >= chain.T - chain.phase) chain.stream.pop();
      if (transitioning || !chain.bridgesPlaced) { for (const b of chain.bridges) placeBridge(b); chain.bridgesPlaced = true; }
      const used = new Set<string>();
      for (const el of chain.stream) if (el.dash) renderDash(chain, el, used);
      for (const [key, node] of chain.pool) if (!used.has(key)) { node.remove(); chain.pool.delete(key); }
    }
    state.flash *= Math.exp(-dt / 0.12);
    state.pulse *= Math.exp(-dt / 0.22);
    pulseG.style.transform = `scale(${1 + 0.1 * state.pulse})`;
    updateBeatMarkers(now);
    raf = requestAnimationFrame(frame);
  }
  for (const name of ['joined', 'offset'] as ViewMode[]) for (const c of MODES[name].chains) resetChain(c);
  raf = requestAnimationFrame(frame);

  // ---------------------------------------------------------------- API
  const api = {
    svg, state, SEG, FLOW, BY_SIZE,
    setMode(mode: ViewMode) { if (mode !== state.mode) modeChangedAt = performance.now(); state.mode = mode; svg.classList.toggle('joined', mode === 'joined'); },
    toggleMode() { api.setMode(state.mode === 'joined' ? 'offset' : 'joined'); },
    setAnimating,
    setSpeed(v: number) { state.speed = Math.max(0, v); },
    setDash(d: number) { state.dash = Math.max(4, d); },
    setRandom(on: boolean) { state.random = on; },
    /** Corner rounding blur radius; 0 removes the filter entirely. */
    setRadius(r: number) { state.radius = r; svg.querySelector('.round-blur')!.setAttribute('stdDeviation', String(r)); art.setAttribute('filter', r > 0 ? `url(#${id}-round)` : ''); },
    /** Colours handed out round-robin to shapes as they enter; one solid colour per shape. */
    setDashColors(list: string[]) { const l = list.filter(Boolean); if (l.length) state.dashColors = l; },
    setColors(a: string, b: string) { api.setDashColors([a, b]); },
    /** Recolour the shapes already on screen (new colours otherwise apply only to entering shapes). */
    recolor() { for (const name of ['joined', 'offset'] as ViewMode[]) for (const c of MODES[name].chains) for (const el of c.stream) if (el.dash) el.color = nextColor(); },
    setBackground(hex: string) { state.bg = hex; },
    setColorEase(seconds: number) { state.colorTau = Math.max(0.01, seconds); },
    /** Onset flash 0..1: shapes brighten towards white and decay in ~120 ms. */
    flash(strength = 1) { state.flash = Math.min(1, Math.max(state.flash, strength)); },
    /** Beat pulse 0..1: the whole mark scales up briefly. */
    pulse(strength = 1) { state.pulse = Math.min(1, Math.max(state.pulse, strength)); },
    /** Per-arc brightness 0..1, indexed like BY_SIZE (bass first). */
    setLevels(levels: number[]) { BY_SIZE.forEach((sid, i) => { if (levels[i] !== undefined) SEG[sid].level = levels[i]; }); },
    clearLevels() { for (const s of Object.values(SEG)) s.level = 1; },
    showGuides(on: boolean) { svg.classList.toggle('show-guides', on); },
    /**
     * Beat lock input. `period` in seconds, `nextBeatAt` a performance.now() time of a coming beat.
     * The anchor stays on the same beat count as estimates refine, so multi-beat divisions keep parity.
     */
    setBeatClock({ period, nextBeatAt }: BeatClockInput) {
      if (!(period > 0)) return;
      const b = state.beat, Pms = period * 1000;
      if (!b.on || !b.anchor || Math.abs(period - b.period) > 0.05 * b.period) b.anchor = nextBeatAt;
      else b.anchor = nextBeatAt - Math.round((nextBeatAt - b.anchor) / Pms) * Pms;
      b.period = period; b.nextAt = nextBeatAt; b.on = true;
    },
    clearBeatClock() {
      // Each path leaves the lock at the speed it was flowing; the difference to the free flow decays.
      if (beatOn()) for (const c of MODES[state.mode].chains) if (c.beat?.v) c.dv = c.beat.v - vCur;
      state.beat.on = false; for (const name of ['joined', 'offset'] as ViewMode[]) for (const c of MODES[name].chains) c.beat = null; },
    /** Shift the visual grid later (+ms) or earlier to match output latency the browser cannot see. */
    setBeatOffset(ms: number) { state.beat.offsetMs = ms || 0; },
    /** Dashes per beat for every path; fractions allowed (0.5 = one dash spanning two beats). */
    setBeatDiv(d: number) { if (d > 0) state.beat.div = d; },
    /** Per-path dashes per beat, indexed like beatDebug(); null falls back to the global value. */
    setPathBeatDivs(list: (number | null)[]) {
      MODES[state.mode].chains.forEach((c, i) => {
        const d = list[i], nd = d && d > 0 ? d : null;
        if (nd === c.div) return;
        c.div = nd;
        if (c.beat) { c.beat.n = 0; c.beat.lastNext = null; }
        while (c.stream.length > 1 && c.stream[0].p + c.stream[0].len + c.phase <= 0) c.stream.shift(); // re-pitch from the next dash
      });
    },
    showBeatMarkers(on: boolean) { state.beat.markers = on; },
    beatDebug(): PathBeatInfo[] {
      return MODES[state.mode].chains.map((c, i) => ({
        path: i, div: divOf(c), T: +c.T.toFixed(1), n: c.beat?.n ?? 0, v: +(c.beat?.v ?? 0).toFixed(1),
        errMs: Math.round((c.beat?.err ?? 0) * 1000), snaps: c.beat?.snaps ?? 0, nextInMs: c.beat?.nextInMs ?? null, entries: c.beat?.entries ?? [],
      }));
    },
    reset() { for (const c of MODES[state.mode].chains) resetChain(c); },
    destroy() { cancelAnimationFrame(raf); container.innerHTML = ''; },
  };
  api.setRadius(opts.radius ?? 0.8);
  return api;
}

export type Logo = ReturnType<typeof mountLogo>;
