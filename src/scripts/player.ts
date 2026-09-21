/**
 * The Sendspin player page: connects to Music Assistant as a Sendspin client and maps the
 * visualizer, colour and metadata roles onto the logo. See docs/sendspin-integration.
 */
import { mountLogo, type Logo } from '@lib/logo';
import { BeatClock, type TempoLogEntry } from '@lib/beat/tempo';
import { contrast, PALETTE_KEYS, rgbArrayToHex, shapeColoursFor, type Palette } from '@lib/color';
import {
  loadSendspin, normaliseBaseUrl, VISUALIZER_REQUEST,
  type ColorState, type PlayerState, type SendspinPlayer, type SendspinPlayerConfig, type VisualizerFrame, type VisualizerStreamConfig,
} from '@lib/sendspin/client';
import { isLanHostname, normaliseRemoteId, openRemoteSendspinSocket, type RemoteSendspinSocket } from '@lib/sendspin/ma-webrtc';

// ------------------------------------------------------------------ DOM
const control = <T extends HTMLElement = HTMLElement>(name: string) =>
  document.querySelector<T>(`[data-control="${name}"]`)!;
const input = (name: string) => control<HTMLInputElement>(name);
const el = {
  url: input('url'), remoteId: input('remote-id'), route: control<HTMLSelectElement>('route'),
  connect: control<HTMLButtonElement>('connect'), status: control('status'),
  vol: input('vol'), react: input('react'), pulse: input('pulse'), flash: input('flash'), spectrum: input('spectrum'),
  sat: input('sat'), lock: input('lock'), onsets: input('onsets'), divs: input('divs'), offset: input('offset'),
  offsetValue: control('offset-value'), debug: input('debug'), markers: input('markers'),
  mode: control<HTMLButtonElement>('mode'), guides: control<HTMLButtonElement>('guides'),
  more: control<HTMLButtonElement>('more'), settings: control('settings'),
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
  themeColor: document.querySelector<HTMLMetaElement>('meta[data-theme-color]'),
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
// The logo only sees the clock once the lock is established (confidence >= 0.8); until then the
// flow is loudness-driven. Once published it keeps following the lock, relocks included, even if
// confidence dips, until the clock is reset (track change, seek, stream end).
let published = false;
const clock = new BeatClock({
  serverNowUs: () => player?.getCurrentServerTimeUs() ?? 0,
  onsetFallback: el.onsets.checked,
  onClock: (out) => {
    if (clock.established) published = true;
    if (published && el.lock.checked) logo.setBeatClock(out);
  },
  onClear: () => { published = false; logo.clearBeatClock(); },
  log: (e) => blog(e.kind, e),
});
window.clock = clock;

// Loudness -> flow speed, in units/s: 8 at silence, 80 at full scale, with the top flattened
// (exponent 1.4) so loud passages do not race. energy is the smoothed loudness, 0..1.
const speedForEnergy = (energy: number) => 8 + 72 * Math.pow(energy, 1.4);

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
  clock.poll();
  if (streaming && el.react.checked) logo.setSpeed(speedForEnergy(energy.v));

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
    const dissent = clock.dissent ? `  dissent ${clock.dissent}` : '';
    const est = clock.established ? ' est' : '';
    const ev = clock.evidence !== 'none' ? `  ev ${clock.evidence}` : '';
    const state = published ? 'locked' : 'provisional';
    el.beatText.textContent = `${state} ${clock.bpm.toFixed(1)} bpm (${clock.source})  conf ${clock.confidence.toFixed(2)}${est}${ev}${dissent}  relocks ${clock.relocks}/${clock.rephases}  lock ${logo.state.beat.on ? 'on' : 'off'}${coast}   ${paths}`;
  } else {
    el.led.style.opacity = '0.15';
    const types = vizConfig?.types ?? [];
    el.beatText.textContent = !streaming ? '' : types.includes('beat') || el.onsets.checked
      ? `searching  (${clock.beatsSeen} beats, ${peaksSeen} peaks so far${types.includes('beat') ? '' : ', onsets only'})`
      : `server offers: ${types.join(', ') || 'nothing'}  (no beat schedule for this track, onset fallback off)`;
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

// Match the backing store to the CSS box (capped at 2x) so the lane is neither stretched nor
// blurry: on a phone the box is much narrower and relatively taller than the markup's 1040x150.
function sizeLane(): void {
  const w = el.lane.clientWidth, h = el.lane.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (el.lane.width !== W || el.lane.height !== H) { el.lane.width = W; el.lane.height = H; }
}
new ResizeObserver(sizeLane).observe(el.lane);
function drawLane(now: number, alive: boolean): void {
  const W = el.lane.width, H = el.lane.height, x0 = (W * LANE_PAST) / (LANE_PAST + LANE_FUTURE);
  const s = H / 150; // marks scale with the lane, so they read the same on a phone as on a desktop
  const tx = (t: number) => x0 + ((t - now) * W) / (LANE_PAST + LANE_FUTURE);
  lctx.clearRect(0, 0, W, H);
  lctx.fillStyle = '#ffffff10'; lctx.fillRect(x0, 0, W - x0, H);
  lctx.strokeStyle = '#ffffff90'; lctx.lineWidth = 2 * s; lctx.beginPath(); lctx.moveTo(x0, 0); lctx.lineTo(x0, H); lctx.stroke();
  if (!alive) return;
  const Pms = clock.period / 1000;
  lctx.lineWidth = 1 * s; lctx.strokeStyle = '#ffffff55';
  for (let t = clock.nextLocal; t > now - LANE_PAST; t -= Pms) if (t <= now + LANE_FUTURE) { lctx.beginPath(); lctx.moveTo(tx(t), 0); lctx.lineTo(tx(t), H); lctx.stroke(); }
  for (let t = clock.nextLocal + Pms; t <= now + LANE_FUTURE; t += Pms) { lctx.beginPath(); lctx.moveTo(tx(t), 0); lctx.lineTo(tx(t), H); lctx.stroke(); }
  const paths = logo.beatDebug(), rowH = H / (paths.length + 1), cols = logo.state.dashColors;
  paths.forEach((p, i) => {
    const y = rowH * (i + 1), col = cols[i % cols.length];
    lctx.fillStyle = '#ffffff70'; lctx.font = `${16 * s}px monospace`; lctx.fillText(`p${p.path} n${p.n}`, 6 * s, y + 6 * s);
    for (const t of p.entries) if (t > now - LANE_PAST) { lctx.fillStyle = col; lctx.beginPath(); lctx.arc(tx(t), y, 6 * s, 0, 7); lctx.fill(); }
    if (p.nextInMs !== null) { lctx.strokeStyle = col; lctx.lineWidth = 2 * s; lctx.beginPath(); lctx.arc(tx(now + p.nextInMs), y, 6 * s, 0, 7); lctx.stroke(); }
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
  el.themeColor?.setAttribute('content', chosen.background); // mobile browser chrome follows the artwork
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

// ------------------------------------------------------------------ connection route
// Two ways to reach Music Assistant's Sendspin server (docs/sendspin-integration, "Hosting"):
//   ws     a plain ws://<ma>:8927/sendspin socket; only from a page the browser considers local
//          (http:// on a LAN/loopback host), since https pages and public origins are blocked
//   webrtc Music Assistant remote access: signalled through the Nabu Casa signalling server by
//          Remote ID, a `sendspin` data channel bridged to the same server; works from anywhere
// "auto" picks by where this page is served from; ?route=ws|webrtc forces one for a session.
type Route = 'ws' | 'webrtc';
const onLan = isLanHostname(location.hostname);
const routeParam = params.get('route');
const forcedRoute: Route | null = routeParam === 'ws' || routeParam === 'webrtc' ? routeParam : null;
el.route.value = localStorage.getItem('sendspin.route') ?? 'auto';
const effectiveRoute = (): Route =>
  forcedRoute ?? (el.route.value === 'ws' || el.route.value === 'webrtc' ? el.route.value : onLan ? 'ws' : 'webrtc');
function showRoute(): void {
  const r = effectiveRoute();
  el.url.hidden = r !== 'ws';
  el.remoteId.hidden = r !== 'webrtc';
  if (forcedRoute) { el.route.value = forcedRoute; el.route.disabled = true; el.route.title = `forced to ${forcedRoute} by ?route=`; }
}
el.route.addEventListener('change', () => { localStorage.setItem('sendspin.route', el.route.value); showRoute(); });
el.remoteId.addEventListener('change', () => { el.remoteId.value = normaliseRemoteId(el.remoteId.value); });

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
el.url.value = localStorage.getItem('sendspin.url') ?? (isLocal ? 'http://localhost:8927' : '');
el.remoteId.value = localStorage.getItem('sendspin.remoteId') ?? '';
showRoute();
if (location.protocol === 'https:' && !onLan) {
  el.httpsWarning.hidden = false;
  // github.io redirects http:// back to https://, so the link is only offered elsewhere
  if (!location.hostname.endsWith('github.io')) {
    el.httpLink.hidden = false;
    el.httpLink.href = 'http://' + location.host + location.pathname + location.search;
  }
}

// ------------------------------------------------------------------ connect / disconnect
let remote: RemoteSendspinSocket | null = null;
let live = false; // true between a successful connect() and disconnect()

async function connect(): Promise<void> {
  const route = effectiveRoute();
  const transport: Pick<SendspinPlayerConfig, 'baseUrl' | 'webSocket'> = {};
  if (route === 'ws') {
    const baseUrl = normaliseBaseUrl(el.url.value);
    if (!baseUrl) { el.status.textContent = 'enter your Music Assistant address, e.g. 192.168.1.10'; return; }
    el.url.value = baseUrl;
    localStorage.setItem('sendspin.url', baseUrl);
    transport.baseUrl = baseUrl;
  } else {
    const remoteId = normaliseRemoteId(el.remoteId.value);
    if (!remoteId) { el.status.textContent = 'enter the Remote ID from Music Assistant → Settings → Remote access'; return; }
    el.remoteId.value = remoteId;
    localStorage.setItem('sendspin.remoteId', remoteId);
    // the socket is handed over CONNECTING so unlock() can still be the click's first await
    remote = openRemoteSendspinSocket({
      remoteId,
      onStage: (s) => { if (s !== 'closed' && s !== 'open') el.status.textContent = `remote: ${s}…`; },
      log: (kind, data) => blog(kind, data),
    });
    const mine = remote;
    remote.onclose = (reason) => { // a live session ending; a failed connect is reported by connect() itself
      if (remote === mine && player && live) { blog('remote:lost', { reason }); disconnect(); el.status.textContent = `connection lost: ${reason}`; }
    };
    transport.webSocket = remote.socket;
  }
  const { SendspinPlayer } = await loadSendspin();
  player = new SendspinPlayer({
    ...transport,
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
  el.connect.disabled = true;
  try {
    await player.unlock(); // must be the first awaited work in the click handler (audio unlock)
    if (route === 'ws') el.status.textContent = 'connecting…';
    const session = await remote?.ready; // the data channel; rejects with the real reason on failure
    await player.connect();
    player.setVolume(+el.vol.value);
    live = true;
    el.connect.textContent = 'Disconnect';
    el.status.textContent = session ? `connected (remote${session.route ? ', ' + session.route : ''})` : 'connected';
  } catch (e) {
    const hint = route === 'ws' && (location.protocol === 'https:' || !onLan)
      ? ' (this page cannot open a ws:// socket to a LAN server; pick the remote route, or serve the site from a LAN http:// address)' : '';
    el.status.textContent = `failed: ${(e as Error)?.message ?? e}${hint}`;
    console.error(e);
    // stop the client's own reconnect loop; a failed first connect otherwise keeps retrying and
    // its callbacks keep mutating our state after we have let go of it
    player?.disconnect('user_request');
    player = null;
    remote?.close(); remote = null;
  } finally {
    el.connect.disabled = false;
  }
}
function disconnect(): void {
  live = false;
  player?.disconnect('user_request');
  const r = remote; remote = null; r?.close();
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
// The settings groups collapse behind one button under 760px; see ControlBar.astro.
el.more.addEventListener('click', () => {
  const open = el.settings.toggleAttribute('data-open');
  el.more.setAttribute('aria-expanded', String(open));
});

el.markers.addEventListener('change', () => logo.showBeatMarkers(el.markers.checked));
el.debug.addEventListener('change', () => { if (!el.debug.checked) { el.markers.checked = false; logo.showBeatMarkers(false); } });
el.mode.addEventListener('click', () => { logo.toggleMode(); el.mode.textContent = logo.state.mode === 'joined' ? 'offset view' : 'joined view'; });
el.guides.addEventListener('click', () => logo.showGuides(!logo.svg.classList.contains('show-guides')));

// dashes per beat, one value per path (0-4); by default the two long chains (paths 0 and 2) carry
// one dash per two beats and the others one per beat
const DEFAULT_DIVS = '0.5,1,0.5,1,1';
const applyDivs = () => {
  if (!el.divs.value.trim()) el.divs.value = DEFAULT_DIVS;
  logo.setPathBeatDivs(el.divs.value.split(/[,\s]+/).map((v) => +v || null));
};
el.divs.addEventListener('change', applyDivs);
applyDivs();

// manual beat offset, persisted: it mostly reflects the output device's latency
const applyOffset = () => { const ms = +el.offset.value; logo.setBeatOffset(ms); el.offsetValue.textContent = `${ms} ms`; localStorage.setItem('sendspin.beatOffset', String(ms)); };
el.offset.value = localStorage.getItem('sendspin.beatOffset') ?? '0';
el.offset.addEventListener('input', applyOffset);
applyOffset();
