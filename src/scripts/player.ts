/**
 * The Sendspin player page: connects to Music Assistant as a Sendspin client and maps the
 * visualizer, colour and metadata roles onto the logo. See docs/sendspin-integration.
 */
import { mountLogo, type Logo } from '@lib/logo';
import { BeatClock, type TempoLogEntry } from '@lib/beat/tempo';
import { contrast, PALETTE_KEYS, rgbArrayToHex, shapeColoursFor, type Palette } from '@lib/color';
import {
  loadSendspin, normaliseBaseUrl, VISUALIZER_REQUEST,
  type ColorState, type PlayerState, type SendspinPlayer, type VisualizerFrame, type VisualizerStreamConfig,
} from '@lib/sendspin/client';

// ------------------------------------------------------------------ DOM
const control = <T extends HTMLElement = HTMLElement>(name: string) =>
  document.querySelector<T>(`[data-control="${name}"]`)!;
const input = (name: string) => control<HTMLInputElement>(name);
const el = {
  url: input('url'), connect: control<HTMLButtonElement>('connect'), status: control('status'),
  vol: input('vol'), react: input('react'), pulse: input('pulse'), flash: input('flash'), spectrum: input('spectrum'),
  sat: input('sat'), lock: input('lock'), onsets: input('onsets'), divs: input('divs'), offset: input('offset'),
  offsetValue: control('offset-value'), debug: input('debug'), markers: input('markers'),
  mode: control<HTMLButtonElement>('mode'), guides: control<HTMLButtonElement>('guides'),
  title: document.querySelector<HTMLElement>('[data-track="title"]')!,
  artist: document.querySelector<HTMLElement>('[data-track="artist"]')!,
  progress: document.querySelector<HTMLElement>('[data-track="progress"]')!,
  palette: document.querySelector<HTMLElement>('[data-palette]')!,
  led: document.querySelector<HTMLElement>('[data-beat="led"]')!,
  beatText: document.querySelector<HTMLElement>('[data-beat="text"]')!,
  lane: document.querySelector<HTMLCanvasElement>('[data-beat="lane"]')!,
  viz: document.querySelector<HTMLElement>('[data-beat="viz"]')!,
  debugPanels: document.querySelectorAll<HTMLElement>('[data-palette], .beat[data-beat]'),
  httpsWarning: document.querySelector<HTMLElement>('[data-https-warning]')!,
  httpLink: document.querySelector<HTMLAnchorElement>('[data-http-link]')!,
};

// ------------------------------------------------------------------ logo
const params = new URLSearchParams(location.search);
const logo: Logo = mountLogo(document.querySelector<HTMLElement>('[data-logo]')!, {
  speed: 30, maxFps: +(params.get('fps') ?? 60) || 60,
});
logo.showBeatMarkers(el.markers.checked);

// ------------------------------------------------------------------ diagnostics
// Every beat frame, tempo decision and stream event of the session; window.dumpLog() prints it.
const LOG: TempoLogEntry[] = [];
function blog(kind: string, data: Record<string, unknown> = {}): void {
  const e = { t: +(performance.now() / 1000).toFixed(2), kind, ...data };
  LOG.push(e); if (LOG.length > 20000) LOG.shift();
  if (kind !== 'beat') console.log(`[${e.t}s] ${kind}`, JSON.stringify(data));
}
declare global {
  interface Window { logo: Logo; player: SendspinPlayer | null; beatLog: TempoLogEntry[]; dumpLog: () => string; clock: BeatClock }
}
window.logo = logo; window.beatLog = LOG; window.dumpLog = () => LOG.map((e) => JSON.stringify(e)).join('\n');

// ------------------------------------------------------------------ connection state
let player: SendspinPlayer | null = null;
let streaming = false;
let vizConfig: VisualizerStreamConfig | null = null;
let lastState: PlayerState | null = null;
let lastTitle: string | null = null;
let lastColorTs: number | undefined;
let lastPalette: Palette | null = null;

// ------------------------------------------------------------------ beat clock
const clock = new BeatClock({
  serverNowUs: () => player?.getCurrentServerTimeUs() ?? 0,
  onsetFallback: el.onsets.checked,
  onClock: (out) => { if (el.lock.checked) logo.setBeatClock(out); },
  onClear: () => logo.clearBeatClock(),
  log: (e) => blog(e.kind, e),
});
window.clock = clock;

// ------------------------------------------------------------------ frame queue
// Frames carry a server-clock "display at" timestamp; hold them until the player's time filter says
// that moment has arrived, and drop anything already stale.
let queue: VisualizerFrame[] = [];
const energy = { v: 0 };
const bins = { v: new Float32Array(8), peak: new Float32Array(8).fill(0.5), floor: new Float32Array(8).fill(0.2) };
let lastLoud = 0, peaksSeen = 0;

function onFrame(frame: VisualizerFrame): void {
  queue.push(frame);
  if (queue.length > 3000) { queue.sort((a, b) => a.timestampUs - b.timestampUs); queue.length = 3000; } // drop the furthest-future
}
function release(): void {
  if (!player) return;
  const now = player.getCurrentServerTimeUs();
  queue.sort((a, b) => a.timestampUs - b.timestampUs);
  let i = 0;
  while (i < queue.length && queue[i].timestampUs <= now) {
    const f = queue[i++];
    if (now - f.timestampUs > 2_000_000) continue;
    apply(f);
  }
  queue.splice(0, i);
}
function apply(f: VisualizerFrame): void {
  if (f.type === 'beat') clock.trackBeat(f.timestampUs, f.downbeat);
  if (f.type === 'peak') { peaksSeen++; clock.trackOnset(f.timestampUs, f.strength); }
  if (!el.react.checked) return;
  switch (f.type) {
    case 'loudness': { // 0..65535 is -60..0 dB(A), already perceptual
      const L = f.value / 65535; lastLoud = L;
      energy.v += (L - energy.v) * (L > energy.v ? 0.45 : 0.08);
      break;
    }
    case 'spectrum': { // one bin per arc, bass on the biggest arcs, per-band auto-gain
      if (!el.spectrum.checked) break;
      const n = Math.min(8, f.bins.length);
      for (let k = 0; k < n; k++) {
        const v = f.bins[k] / 65535;
        bins.peak[k] = Math.max(v, bins.peak[k] - 0.001);
        bins.floor[k] = Math.min(v, bins.floor[k] + 0.0007);
        const span = Math.max(0.08, bins.peak[k] - bins.floor[k]);
        const lvl = Math.min(1, Math.max(0, (v - bins.floor[k]) / span));
        bins.v[k] += (lvl - bins.v[k]) * (lvl > bins.v[k] ? 0.6 : 0.2);
      }
      logo.setLevels(Array.from(bins.v));
      break;
    }
    case 'beat': if (el.pulse.checked) logo.pulse(f.downbeat ? 1 : 0.55); break;
    case 'peak': if (el.flash.checked) logo.flash(f.strength / 255); break;
  }
}

// ------------------------------------------------------------------ per-frame
function tick(): void {
  release();
  if (streaming && el.react.checked) logo.setSpeed(8 + 120 * Math.pow(energy.v, 1.6));

  const meta = lastState?.serverState?.metadata;
  if (meta?.progress && player) {
    const nowUs = player.getCurrentServerTimeUs(), p = meta.progress;
    const ms = p.track_progress + ((nowUs - (meta.timestamp ?? nowUs)) / 1000) * (p.playback_speed / 1000);
    const frac = p.track_duration ? Math.min(1, Math.max(0, ms / p.track_duration)) : 0;
    el.progress.style.width = `${frac * 100}%`;
  }

  const alive = clock.alive && streaming;
  if (!alive && logo.state.beat.on) logo.clearBeatClock();

  const debug = el.debug.checked;
  for (const p of el.debugPanels) p.hidden = !debug;
  if (!debug) { requestAnimationFrame(tick); return; }

  const now = performance.now();
  if (alive) {
    const Pms = clock.period / 1000;
    const tau = (((clock.nextLocal - now) % Pms) + Pms) % Pms;
    el.led.style.opacity = String(0.15 + 0.85 * Math.pow(1 - tau / Pms, 5));
    const paths = logo.beatDebug().map((p) => `p${p.path}/${p.div} n=${p.n} v=${p.v} err=${p.errMs >= 0 ? '+' : ''}${p.errMs}ms`).join('  ');
    const coast = clock.coastingMs > 3000 ? `  coasting ${Math.round(clock.coastingMs / 1000)}s` : '';
    el.beatText.textContent = `${clock.bpm.toFixed(1)} bpm (${clock.source})  downbeats ${clock.downbeats}  lock ${logo.state.beat.on ? 'on' : 'off'}${coast}   ${paths}`;
  } else {
    el.led.style.opacity = '0.15';
    const types = vizConfig?.types ?? [];
    el.beatText.textContent = !streaming ? '' : types.includes('beat')
      ? `server offers beats (${clock.beatsSeen} so far), waiting for a steady tempo`
      : `server offers: ${types.join(', ') || 'nothing'}  (no beat schedule for this track)`;
  }
  drawLane(now, alive);
  el.viz.textContent = streaming
    ? `loud ${lastLoud.toFixed(2)}  energy ${energy.v.toFixed(2)}  beats ${clock.beatsSeen}  peaks ${peaksSeen}  bins ${Array.from(bins.v, (x) => x.toFixed(1)).join(' ')}`
    : vizConfig === null ? '' : 'visualizer stream idle';
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ------------------------------------------------------------------ beat lane
// Time scrolls left; beat ticks are lines, dash entries are dots per path. Locked = dots on lines.
const lctx = el.lane.getContext('2d')!;
const LANE_PAST = 2400, LANE_FUTURE = 800;
function drawLane(now: number, alive: boolean): void {
  const W = el.lane.width, H = el.lane.height, x0 = (W * LANE_PAST) / (LANE_PAST + LANE_FUTURE);
  const tx = (t: number) => x0 + ((t - now) * W) / (LANE_PAST + LANE_FUTURE);
  lctx.clearRect(0, 0, W, H);
  lctx.fillStyle = '#ffffff10'; lctx.fillRect(x0, 0, W - x0, H);
  lctx.strokeStyle = '#ffffff90'; lctx.lineWidth = 2; lctx.beginPath(); lctx.moveTo(x0, 0); lctx.lineTo(x0, H); lctx.stroke();
  if (!alive) return;
  const Pms = clock.period / 1000;
  lctx.lineWidth = 1; lctx.strokeStyle = '#ffffff55';
  for (let t = clock.nextLocal; t > now - LANE_PAST; t -= Pms) if (t <= now + LANE_FUTURE) { lctx.beginPath(); lctx.moveTo(tx(t), 0); lctx.lineTo(tx(t), H); lctx.stroke(); }
  for (let t = clock.nextLocal + Pms; t <= now + LANE_FUTURE; t += Pms) { lctx.beginPath(); lctx.moveTo(tx(t), 0); lctx.lineTo(tx(t), H); lctx.stroke(); }
  const paths = logo.beatDebug(), rowH = H / (paths.length + 1), cols = logo.state.dashColors;
  paths.forEach((p, i) => {
    const y = rowH * (i + 1), col = cols[i % cols.length];
    lctx.fillStyle = '#ffffff70'; lctx.font = '16px monospace'; lctx.fillText(`p${p.path} n${p.n}`, 6, y + 6);
    for (const t of p.entries) if (t > now - LANE_PAST) { lctx.fillStyle = col; lctx.beginPath(); lctx.arc(tx(t), y, 6, 0, 7); lctx.fill(); }
    if (p.nextInMs !== null) { lctx.strokeStyle = col; lctx.lineWidth = 2; lctx.beginPath(); lctx.arc(tx(now + p.nextInMs), y, 6, 0, 7); lctx.stroke(); }
  });
}

// ------------------------------------------------------------------ palette
function applyPalette(c: ColorState): void {
  const p: Palette = {
    background_dark: rgbArrayToHex(c.background_dark), background_light: rgbArrayToHex(c.background_light),
    primary: rgbArrayToHex(c.primary), accent: rgbArrayToHex(c.accent), on_dark: rgbArrayToHex(c.on_dark), on_light: rgbArrayToHex(c.on_light),
  };
  lastPalette = p;
  const chosen = shapeColoursFor(p, { saturation: +el.sat.value });
  logo.setDashColors(chosen.shapes); logo.recolor();
  document.documentElement.style.setProperty('--bg', chosen.background); logo.setBackground(chosen.background);
  document.documentElement.style.setProperty('--fg', chosen.foreground);
  const art = lastState?.serverState?.metadata?.artwork_url;
  el.palette.innerHTML = (art ? `<img src="${art}" alt="">` : '') + PALETTE_KEYS.map((key) => {
    const col = p[key];
    const ratio = col ? contrast(col, chosen.background).toFixed(1) : '';
    return `<div class="sw ${chosen.used.includes(key) ? 'used' : ''}"><i style="background:${col ?? 'transparent'}"></i>${key.replace('background', 'bg')}<br>${col ?? '–'}<br>${ratio}:1</div>`;
  }).join('') + `<div class="sw"><i style="background:linear-gradient(90deg,${chosen.shapes.join(',')})"></i>shapes<br>${chosen.shapes.length} colours</div>`;
  blog('palette', { ...p, shapes: chosen.shapes });
}
el.sat.addEventListener('input', () => { if (lastPalette) applyPalette(paletteToState(lastPalette)); });
const paletteToState = (p: Palette): ColorState => Object.fromEntries(PALETTE_KEYS.map((k) => [k, p[k] ? hexToArr(p[k]!) : null]));
const hexToArr = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ------------------------------------------------------------------ server state
function onState(state: PlayerState): void {
  lastState = state;
  const playing = state.isPlaying || state.groupState?.playback_state === 'playing';
  if (!playing) { logo.setAnimating(false); logo.clearLevels(); energy.v = 0; }
  else if (streaming) logo.setAnimating(true);

  const m = state.serverState?.metadata;
  if (m?.title && m.title !== lastTitle) {
    lastTitle = m.title; blog('track', { title: m.title, artist: m.artist });
    clock.reset('track change'); // a new track's tempo is unknown; never coast into it
  }
  el.title.textContent = m?.title || (player ? 'Nothing playing' : ' ');
  el.artist.textContent = [m?.artist, m?.album].filter(Boolean).join(' · ') || ' ';

  const c = state.serverState?.color;
  if (c && c.timestamp !== lastColorTs) {
    lastColorTs = c.timestamp;
    const wait = player && c.timestamp ? (c.timestamp - player.getCurrentServerTimeUs()) / 1000 : 0; // scheduled palettes
    if (wait > 50 && wait < 30000) setTimeout(() => applyPalette(c), wait); else applyPalette(c);
  }
  el.status.textContent = `${state.isPlaying ? 'playing' : 'idle'}${state.groupState?.group_name ? ' · ' + state.groupState.group_name : ''}`;
}

// ------------------------------------------------------------------ connect / disconnect
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
el.url.value = localStorage.getItem('sendspin.url') ?? (isLocal ? 'http://localhost:8927' : '');
if (location.protocol === 'https:') {
  el.httpsWarning.hidden = false;
  el.httpLink.href = 'http://' + location.host + location.pathname + location.search;
}

async function connect(): Promise<void> {
  const baseUrl = normaliseBaseUrl(el.url.value);
  if (!baseUrl) { el.status.textContent = 'enter your Music Assistant address, e.g. 192.168.1.10'; return; }
  el.url.value = baseUrl;
  localStorage.setItem('sendspin.url', baseUrl);
  const { SendspinPlayer } = await loadSendspin();
  player = new SendspinPlayer({
    baseUrl,
    clientName: 'Sendspin Logo',
    productName: 'Sendspin logo visualiser',
    visualizer: VISUALIZER_REQUEST,
    onVisualizerFrame: onFrame,
    onVisualizerStream: (cfg) => {
      vizConfig = cfg; streaming = cfg !== null; queue = [];
      clock.serverOffersBeats = cfg?.types.includes('beat') ?? false;
      blog('stream', { types: cfg?.types ?? null, tracksDownbeats: cfg?.tracks_downbeats ?? null });
      if (!streaming) { clock.reset('stream end'); logo.setAnimating(false); logo.clearLevels(); }
      else logo.setAnimating(true);
    },
    onVisualizerClear: () => { queue = []; clock.reset('stream clear'); },
    onStateChange: onState,
    onPairingPin: (pin) => { el.status.textContent = `pairing PIN: ${pin}`; },
    reconnect: { onReconnecting: (n) => { el.status.textContent = `reconnecting (${n})`; }, onReconnected: () => { el.status.textContent = 'connected'; } },
  });
  window.player = player;
  try {
    await player.unlock(); // must be the first awaited work in the click handler (audio unlock)
    el.status.textContent = 'connecting…';
    await player.connect();
    player.setVolume(+el.vol.value);
    el.connect.textContent = 'Disconnect';
    el.status.textContent = 'connected';
  } catch (e) {
    const blocked = location.protocol === 'https:' ? ' (an HTTPS page cannot reach a ws:// server; use the http:// page)' : '';
    el.status.textContent = `failed: ${(e as Error)?.message ?? e}${blocked}`;
    console.error(e);
    player = null;
  }
}
function disconnect(): void {
  player?.disconnect('user_request');
  player = null; streaming = false;
  el.connect.textContent = 'Connect'; el.status.textContent = 'disconnected';
  logo.setAnimating(false); clock.reset('disconnect');
}
el.connect.addEventListener('click', () => (player ? disconnect() : connect()));

// ------------------------------------------------------------------ controls
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cmd]')) {
  b.addEventListener('click', () => player?.sendCommand(b.dataset.cmd as 'play'));
}
el.vol.addEventListener('input', () => player?.setVolume(+el.vol.value));
el.spectrum.addEventListener('change', () => { if (!el.spectrum.checked) logo.clearLevels(); });
el.lock.addEventListener('change', () => { if (!el.lock.checked) logo.clearBeatClock(); });
el.onsets.addEventListener('change', () => { clock.onsetFallback = el.onsets.checked; });
el.markers.addEventListener('change', () => logo.showBeatMarkers(el.markers.checked));
el.debug.addEventListener('change', () => { if (!el.debug.checked) { el.markers.checked = false; logo.showBeatMarkers(false); } });
el.mode.addEventListener('click', () => { logo.toggleMode(); el.mode.textContent = logo.state.mode === 'joined' ? 'offset view' : 'joined view'; });
el.guides.addEventListener('click', () => logo.showGuides(!logo.svg.classList.contains('show-guides')));

// dashes per beat, one value per path (0-4); paths 0 and 2 run on half-beats by default
const applyDivs = () => logo.setPathBeatDivs(el.divs.value.split(/[,\s]+/).map((v) => +v || null));
el.divs.addEventListener('change', applyDivs);
applyDivs();

// manual beat offset, persisted: it mostly reflects the output device's latency
const applyOffset = () => { const ms = +el.offset.value; logo.setBeatOffset(ms); el.offsetValue.textContent = `${ms} ms`; localStorage.setItem('sendspin.beatOffset', String(ms)); };
el.offset.value = localStorage.getItem('sendspin.beatOffset') ?? '0';
el.offset.addEventListener('input', applyOffset);
applyOffset();
