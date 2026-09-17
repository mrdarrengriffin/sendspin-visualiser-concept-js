/**
 * Music Assistant remote access as a Sendspin transport.
 *
 * Music Assistant 2.7+ can be reached from anywhere over WebRTC: its gateway registers a Remote ID
 * with the Nabu Casa signalling server (wss://signaling.music-assistant.io/ws), a client asks that
 * server for the peer, and the two negotiate an RTCPeerConnection through it. The gateway routes
 * incoming data channels by label; a channel labelled `sendspin` is pumped straight onto the local
 * Sendspin server (ws://<ma>:8927/sendspin), text and binary frames preserved. No Music Assistant
 * login is involved on that channel: the Remote ID (which is the server's DTLS certificate
 * fingerprint, so the answer can be pinned to it) is the only credential, and the Sendspin
 * protocol's own Noise handshake and pairing rules apply on top, exactly as on a LAN socket.
 *
 * This module drives that sequence and exposes the open channel as a WebSocket-shaped object, which
 * sendspin-js adopts through its `webSocket` option. It uses only WebSocket and WebRTC APIs, no DOM.
 *
 * Signalling messages, as the MA frontend (src/plugins/remote/signaling.ts) and the server gateway
 * (controllers/webserver/remote_access/gateway.py) speak them, all JSON text:
 *
 *   client -> signalling   { type: "connect-request", remoteId }
 *   signalling -> client   { type: "connected", remoteId, sessionId, iceServers? }
 *                        | { type: "error", error }
 *   client -> gateway      { type: "offer",         remoteId, sessionId, data: { type, sdp } }
 *   gateway -> client      { type: "answer",        sessionId, data: { type, sdp } }
 *   both ways              { type: "ice-candidate", remoteId, sessionId, data: RTCIceCandidateInit }
 *   signalling -> client   { type: "peer-disconnected" }, { type: "ping" } (answer with "pong")
 *
 * The signalling socket must stay open for the life of the session: the gateway closes the whole
 * peer connection when the signalling server reports the client gone.
 */

export const MA_SIGNALING_URL = 'wss://signaling.music-assistant.io/ws';
export const SENDSPIN_CHANNEL_LABEL = 'sendspin';

/** Used only when the server's `connected` message carries no ICE servers. */
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.home-assistant.io:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export type RemoteStage =
  | 'signalling'      // opening the signalling WebSocket, sending connect-request
  | 'offer'           // peer found; ICE servers received; offer sent
  | 'answer'          // answer received and pinned; ICE in progress
  | 'open'            // data channel open
  | 'closed';

export interface RemoteConnectOptions {
  /** The Remote ID shown in Music Assistant → Settings → Remote access (26 characters). */
  remoteId: string;
  signalingUrl?: string;
  /** Whole connect budget, ms. Default 30000. */
  timeoutMs?: number;
  /** Pin the answer's DTLS fingerprint to the Remote ID. Default true; only disable for debugging. */
  verifyCertificate?: boolean;
  onStage?: (stage: RemoteStage, detail?: string) => void;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface RemoteSendspinSocket {
  /** WebSocket-shaped view of the data channel; CONNECTING until `ready` resolves. */
  socket: WebSocket;
  /** Resolves once the `sendspin` channel is open; rejects with the reason it could not be. */
  ready: Promise<RemoteSessionInfo>;
  /** Tear everything down (channel, peer connection, signalling socket). */
  close(): void;
  /** Fired once when the transport ends for any reason after or before opening. */
  onclose: ((reason: string) => void) | null;
}

export interface RemoteSessionInfo {
  sessionId: string;
  iceServers: RTCIceServer[];
  /** Candidate types of the selected pair, e.g. "srflx→host" or "relay→relay", when known. */
  route: string | null;
}

// ------------------------------------------------------------------ helpers

/** True when a page at this hostname is a LAN page in the browser's eyes (private, loopback, local name). */
export function isLanHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true;
  if (/\.(local|lan|home|internal|home\.arpa)$/.test(h)) return true;
  if (!h.includes('.') && !h.includes(':')) return true; // bare intranet name
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return /^f[cd]/.test(h) || /^fe[89ab]/.test(h); // ULA, link-local
  return false;
}

/** Normalise a pasted Remote ID: uppercase, no whitespace or dashes. */
export function normaliseRemoteId(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** RFC 4648 base32 (no padding) to bytes. Throws on a bad character. */
function base32Decode(s: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out: number[] = [];
  let bits = 0, acc = 0;
  for (const ch of s) {
    const v = A.indexOf(ch);
    if (v < 0) throw new Error('bad base32 character');
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { out.push((acc >> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** The 16 fingerprint bytes a Remote ID encodes (base32 with 9 in place of 2, 128-bit truncated SHA-256). */
export function remoteIdFingerprint(remoteId: string): Uint8Array {
  let bytes: Uint8Array;
  try { bytes = base32Decode(normaliseRemoteId(remoteId).replace(/9/g, '2')); } catch { throw new Error('Remote ID is not valid (expected 26 letters/digits)'); }
  if (bytes.length !== 16) throw new Error('Remote ID is not valid (expected 26 letters/digits)');
  return bytes;
}

/**
 * Drop every non-SHA-256 fingerprint line from an SDP and require every remaining SHA-256
 * fingerprint to start with the Remote ID's 16 bytes. Mirrors the MA frontend's crypto-utils.ts.
 */
export function pinAnswerSdp(sdp: string, remoteId: string): string {
  const expected = remoteIdFingerprint(remoteId);
  const clean = sdp.replace(/^a=fingerprint:(?!sha-256).*\r?\n?/gim, '');
  const matches = [...clean.matchAll(/a=fingerprint:sha-256\s+([A-Fa-f0-9:]+)/gi)];
  if (!matches.length) throw new Error('answer carries no SHA-256 fingerprint');
  for (const m of matches) {
    const hex = m[1].replace(/:/g, '');
    for (let i = 0; i < 16; i++) {
      if (parseInt(hex.slice(i * 2, i * 2 + 2), 16) !== expected[i]) throw new Error('server certificate does not match the Remote ID');
    }
  }
  return clean;
}

// ------------------------------------------------------------------ WebSocket-shaped channel

/**
 * A WebSocket look-alike over an RTCDataChannel, good enough for sendspin-js's `webSocket` option:
 * readyState with the standard numbers, binaryType, on* handlers, send(string | bytes), close().
 * It starts CONNECTING with no channel; `attach()` binds the channel and `fail()` closes it early.
 */
class ChannelSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readonly url: string;
  readonly protocol = ''; readonly extensions = ''; readonly bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  private channel: RTCDataChannel | null = null;
  private _binaryType: BinaryType = 'arraybuffer';
  private closed = false;
  private closeFired = false;
  /** The owner learns of a close from here, whatever caused it. */
  ondone: ((reason: string) => void) | null = null;
  /** The owner learns of the channel opening from here, before the on* consumer does. */
  onready: (() => void) | null = null;

  constructor(url: string) { this.url = url; }

  get binaryType(): BinaryType { return this._binaryType; }
  set binaryType(v: BinaryType) { this._binaryType = v; if (this.channel) this.channel.binaryType = v; }

  get readyState(): number {
    if (this.closed || this.closeFired) return 3;
    if (!this.channel) return 0;
    return ({ connecting: 0, open: 1, closing: 2, closed: 3 } as const)[this.channel.readyState];
  }

  attach(channel: RTCDataChannel): void {
    if (this.closed) { channel.close(); return; }
    this.channel = channel;
    channel.binaryType = this._binaryType;
    channel.onmessage = (ev) => this.onmessage?.(ev);
    channel.onerror = () => this.onerror?.(new Event('error'));
    channel.onclose = () => this.end('data channel closed');
    const opened = () => { this.onready?.(); this.onopen?.(new Event('open')); };
    if (channel.readyState === 'open') opened();
    else channel.onopen = opened;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') return;
    if (typeof data === 'string') ch.send(data);
    else if (data instanceof Blob) void data.arrayBuffer().then((b) => ch.readyState === 'open' && ch.send(b));
    else if (ArrayBuffer.isView(data)) ch.send(data as ArrayBufferView<ArrayBuffer>);
    else ch.send(data as ArrayBuffer);
  }

  close(): void { this.closed = true; this.channel?.close(); this.end('closed'); }
  /** Close before or after attach, with a reason for the owner. */
  fail(reason: string): void { this.closed = true; this.channel?.close(); this.end(reason); }

  private end(reason: string): void {
    if (this.closeFired) return;
    this.closeFired = true;
    this.onclose?.(new CloseEvent('close', { reason }));
    this.ondone?.(reason);
  }

  addEventListener(type: string, fn: EventListenerOrEventListenerObject | null): void {
    if (typeof fn !== 'function') return;
    if (type === 'open') this.onopen = fn as (ev: Event) => void;
    else if (type === 'message') this.onmessage = fn as (ev: MessageEvent) => void;
    else if (type === 'error') this.onerror = fn as (ev: Event) => void;
    else if (type === 'close') this.onclose = fn as (ev: CloseEvent) => void;
  }
  removeEventListener(): void { /* handlers are single-slot; sendspin-js nulls on* directly */ }
  dispatchEvent(): boolean { return false; }
}

// ------------------------------------------------------------------ the connection

/**
 * Start connecting to a Music Assistant's Sendspin server through its remote access gateway.
 * Returns at once with a CONNECTING socket, so a `SendspinPlayer` can be built (and `unlock()`ed
 * inside the user's click) while signalling and ICE run; `ready` resolves when the channel opens.
 */
export function openRemoteSendspinSocket(opts: RemoteConnectOptions): RemoteSendspinSocket {
  const remoteId = normaliseRemoteId(opts.remoteId);
  const signalingUrl = opts.signalingUrl ?? MA_SIGNALING_URL;
  const log = opts.log ?? (() => {});
  const stage = (s: RemoteStage, d?: string) => { log('remote:' + s, d ? { detail: d } : {}); opts.onStage?.(s, d); };

  const socket = new ChannelSocket(`webrtc://${remoteId}/${SENDSPIN_CHANNEL_LABEL}`);
  let ws: WebSocket | null = null;
  let pc: RTCPeerConnection | null = null;
  let sessionId = '';
  let iceServers: RTCIceServer[] = [];
  let remoteSet = false;
  const pendingIce: RTCIceCandidateInit[] = [];
  let done = false;

  const result: RemoteSendspinSocket = {
    socket: socket as unknown as WebSocket,
    ready: null as unknown as Promise<RemoteSessionInfo>,
    close: () => teardown('closed'),
    onclose: null,
  };

  const teardown = (reason: string) => {
    if (done) return;
    done = true;
    stage('closed', reason);
    socket.fail(reason);
    if (pc) { pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); pc = null; }
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.close(); ws = null; }
    result.onclose?.(reason);
  };
  socket.ondone = (reason) => teardown(reason);

  const sendSignal = (msg: Record<string, unknown>) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  result.ready = new Promise<RemoteSessionInfo>((resolve, reject) => {
    let settled = false;
    const failWith = (reason: string) => { if (!settled) { settled = true; reject(new Error(reason)); } teardown(reason); };
    const timer = setTimeout(() => failWith('timed out connecting through Music Assistant remote access'), opts.timeoutMs ?? 30000);

    try { remoteIdFingerprint(remoteId); } catch (e) { clearTimeout(timer); failWith((e as Error).message); return; }

    stage('signalling');
    try { ws = new WebSocket(signalingUrl); } catch { clearTimeout(timer); failWith('cannot open the signalling server'); return; }
    ws.onopen = () => sendSignal({ type: 'connect-request', remoteId });
    ws.onerror = () => { if (!settled) failWith('signalling server unreachable'); };
    ws.onclose = () => { if (!settled) failWith('signalling connection closed'); else log('remote:signalling-closed'); };
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      switch (msg.type) {
        case 'ping': sendSignal({ type: 'pong' }); break;
        case 'error': failWith(String(msg.error ?? msg.message ?? 'signalling error')); break;
        case 'connected': {
          sessionId = String(msg.sessionId ?? '');
          iceServers = Array.isArray(msg.iceServers) && msg.iceServers.length ? msg.iceServers : FALLBACK_ICE_SERVERS;
          log('remote:ice-servers', { servers: iceServers.map((s) => s.urls), session: sessionId });
          void startPeer().catch((e) => failWith((e as Error).message));
          break;
        }
        case 'answer': void onAnswer(msg.data).catch((e) => failWith((e as Error).message)); break;
        case 'ice-candidate': if (msg.data) void onRemoteIce(msg.data); break;
        case 'peer-disconnected': failWith('Music Assistant closed the connection'); break;
      }
    };

    async function startPeer(): Promise<void> {
      pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
      pc.onicecandidate = (ev) => { if (ev.candidate) sendSignal({ type: 'ice-candidate', remoteId, sessionId, data: ev.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => {
        const s = pc?.connectionState;
        log('remote:pc', { state: s });
        if (s === 'failed') failWith('WebRTC connection failed (no path to the server; TURN may be needed)');
        else if (s === 'closed' || s === 'disconnected') { if (settled) teardown('WebRTC connection ' + s); }
      };
      const channel = pc.createDataChannel(SENDSPIN_CHANNEL_LABEL, { ordered: true });
      socket.onready = () => {
        clearTimeout(timer);
        stage('open');
        if (settled) return;
        settled = true;
        // resolve with the route once stats are in; the socket is already usable
        void selectedRoute(pc).then((route) => { log('remote:open', { route }); resolve({ sessionId, iceServers, route }); });
      };
      socket.attach(channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', remoteId, sessionId, data: { type: offer.type, sdp: offer.sdp } });
      stage('offer');
    }

    async function onAnswer(data: { type: RTCSdpType; sdp?: string }): Promise<void> {
      if (!pc || !data?.sdp) throw new Error('malformed answer');
      const sdp = opts.verifyCertificate === false ? data.sdp : pinAnswerSdp(data.sdp, remoteId);
      await pc.setRemoteDescription({ type: data.type, sdp });
      remoteSet = true;
      stage('answer');
      for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    }

    async function onRemoteIce(c: RTCIceCandidateInit): Promise<void> {
      if (!pc) return;
      if (!remoteSet) { pendingIce.push(c); return; }
      await pc.addIceCandidate(c).catch((e) => log('remote:ice-error', { error: String(e) }));
    }
  });
  // Callers that only await `ready` should not also get an unhandled rejection from this copy.
  result.ready.catch(() => {});
  return result;
}

/** "local→remote" candidate types of the selected ICE pair, when the stats API exposes them. */
async function selectedRoute(pc: RTCPeerConnection | null): Promise<string | null> {
  if (!pc) return null;
  try {
    const stats = await pc.getStats();
    const byId = new Map<string, any>();
    stats.forEach((s: any) => byId.set(s.id, s));
    let pair: any = null;
    stats.forEach((s: any) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach((s: any) => { if (s.type === 'candidate-pair' && (s.selected || s.nominated) && s.state === 'succeeded') pair ??= s; });
    if (!pair) return null;
    const l = byId.get(pair.localCandidateId)?.candidateType, r = byId.get(pair.remoteCandidateId)?.candidateType;
    return l && r ? `${l}→${r}` : null;
  } catch { return null; }
}
