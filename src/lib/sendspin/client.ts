/**
 * Types for the parts of the Sendspin client we use, and a lazy loader for the patched
 * `@sendspin/sendspin-js` bundle in ./vendor (built from tools/, see tools/README.md).
 *
 * The bundle is a prebuilt ESM file with its own lazy Opus-decoder chunks; Vite code-splits it and
 * it is only fetched when the user presses Connect.
 */

export type VisualizerType = 'beat' | 'loudness' | 'f_peak' | 'peak' | 'spectrum';

export interface VisualizerRequest {
  types: VisualizerType[];
  rate_max: number;
  spectrum?: { n_disp_bins: number; scale: 'mel' | 'log' | 'lin'; f_min: number; f_max: number };
}

export interface VisualizerStreamConfig extends VisualizerRequest {
  tracks_downbeats?: boolean;
}

/** One decoded visualizer frame. `timestampUs` is server-clock microseconds: when to show it. */
export type VisualizerFrame =
  | { type: 'loudness'; timestampUs: number; value: number }
  | { type: 'beat'; timestampUs: number; downbeat: boolean }
  | { type: 'f_peak'; timestampUs: number; freq: number; amp: number }
  | { type: 'spectrum'; timestampUs: number; bins: Uint16Array }
  | { type: 'peak'; timestampUs: number; strength: number };

/** One artwork channel; the server scales to fit and pads with black, never crops. */
export interface ArtworkChannel {
  source: 'album' | 'artist' | 'none';
  format?: 'jpeg' | 'png';
  width?: number;
  height?: number;
}

/** Artwork role configuration: 1-4 channels, index = channel number. */
export interface ArtworkRequest {
  channels: ArtworkChannel[];
}

/** One complete artwork transfer. `image` null clears the channel; `timestampUs` is when to show it. */
export interface ArtworkImage {
  channel: number;
  timestampUs: number;
  image: Blob | null;
}

export interface ColorState {
  timestamp?: number;
  background_dark?: number[] | null;
  background_light?: number[] | null;
  primary?: number[] | null;
  accent?: number[] | null;
  on_dark?: number[] | null;
  on_light?: number[] | null;
}

export interface MetadataState {
  timestamp?: number;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  artwork_url?: string | null;
  progress?: { track_progress: number; track_duration: number; playback_speed: number } | null;
}

export interface PlayerState {
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  serverState?: { metadata?: MetadataState; color?: ColorState };
  groupState?: { playback_state?: 'playing' | 'stopped'; group_name?: string };
}

export type ControllerCommand = 'play' | 'pause' | 'stop' | 'next' | 'previous' | 'volume' | 'mute';

export interface SendspinPlayerConfig {
  /** `http://<host>:8927`; the client derives `ws://<host>:8927/sendspin`. Required unless `webSocket` is given. */
  baseUrl?: string;
  /**
   * A pre-opened (or still CONNECTING) WebSocket-shaped transport the client adopts instead of
   * dialling `baseUrl`; the library never auto-reconnects an adopted socket. See ./ma-webrtc.ts.
   */
  webSocket?: WebSocket;
  clientName?: string;
  productName?: string;
  visualizer?: VisualizerRequest;
  onVisualizerFrame?: (frame: VisualizerFrame) => void;
  onVisualizerStream?: (config: VisualizerStreamConfig | null) => void;
  onVisualizerClear?: () => void;
  /** Artwork role: images arrive over the Sendspin connection, so no HTTP fetch is needed. */
  artwork?: ArtworkRequest;
  onArtwork?: (image: ArtworkImage) => void;
  /** The server discarded the channel's pending (scheduled, not yet shown) image. */
  onArtworkCancel?: (channel: number) => void;
  onArtworkStream?: (config: ArtworkRequest | null) => void;
  onStateChange?: (state: PlayerState) => void;
  onPairingPin?: (pin: string) => void;
  reconnect?: { onReconnecting?: (attempt: number) => void; onReconnected?: () => void };
}

export interface SendspinPlayer {
  unlock(): Promise<void>;
  connect(): Promise<void>;
  disconnect(reason?: string): void;
  setVolume(v: number): void;
  sendCommand(command: ControllerCommand, params?: Record<string, unknown>): void;
  /** Current server-clock time in microseconds, via the library's time filter. */
  getCurrentServerTimeUs(): number;
  setVisualizerRequest(req: VisualizerRequest | null): void;
  setArtworkRequest(req: ArtworkRequest | null): void;
}

interface SendspinModule {
  SendspinPlayer: new (config: SendspinPlayerConfig) => SendspinPlayer;
}

let modulePromise: Promise<SendspinModule> | null = null;

/** Load the patched client bundle once (lazy chunk). */
export function loadSendspin(): Promise<SendspinModule> {
  modulePromise ??= import('./vendor/sendspin.js');
  return modulePromise;
}

/** Normalise what a user types into a Sendspin base URL: bare host gets http:// and :8927. */
export function normaliseBaseUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  if (!/^https?:\/\//.test(url)) url = 'http://' + url;
  if (!/:\d+(\/|$)/.test(url.replace(/^https?:\/\//, ''))) url = url.replace(/\/$/, '') + ':8927';
  return url;
}

/** The artwork this app asks for: album art on channel 0, square, enough for a blurred backdrop. */
export const ARTWORK_REQUEST: ArtworkRequest = {
  channels: [{ source: 'album', format: 'jpeg', width: 512, height: 512 }],
};

/** The visualizer data this app asks the server for. */
export const VISUALIZER_REQUEST: VisualizerRequest = {
  types: ['loudness', 'beat', 'peak', 'spectrum'],
  rate_max: 30,
  spectrum: { n_disp_bins: 8, scale: 'mel', f_min: 40, f_max: 16000 },
};
