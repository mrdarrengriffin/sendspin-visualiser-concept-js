"""Patch sendspin-js with visualizer@v1 + color@v1 role support."""
import re, os, sys

ROOT = os.path.join(os.path.dirname(__file__), "sendspin-js")
os.chdir(ROOT)


def patch(path, pairs):
    s = open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, old[:70], s.count(old))
        s = s.replace(old, new)
    open(path, "w", encoding="utf-8").write(s)


# ---------- types.ts ----------
patch("src/types.ts", [
("""export interface ServerStateController {""",
"""export interface ServerStateColor {
  timestamp?: number;
  background_dark?: number[] | null;
  background_light?: number[] | null;
  primary?: number[] | null;
  accent?: number[] | null;
  on_dark?: number[] | null;
  on_light?: number[] | null;
}

export type VisualizerType = "beat" | "loudness" | "f_peak" | "peak" | "spectrum";

export interface VisualizerSpectrumConfig {
  n_disp_bins: number;
  scale: "mel" | "log" | "lin";
  f_min: number;
  f_max: number;
}

/** What the client asks the server to stream (client/state visualizer object). */
export interface VisualizerRequest {
  types: VisualizerType[];
  rate_max: number;
  spectrum?: VisualizerSpectrumConfig;
}

/** What the server will actually stream (stream/start visualizer object). */
export interface VisualizerStreamConfig extends VisualizerRequest {
  tracks_downbeats?: boolean;
}

/** One decoded visualizer frame. timestampUs is server-clock microseconds. */
export type VisualizerFrame =
  | { type: "loudness"; timestampUs: number; value: number }
  | { type: "beat"; timestampUs: number; downbeat: boolean }
  | { type: "f_peak"; timestampUs: number; freq: number; amp: number }
  | { type: "spectrum"; timestampUs: number; bins: Uint16Array }
  | { type: "peak"; timestampUs: number; strength: number };

export interface ServerStateController {"""),
("""  controller?: ServerStateController;
  player?: ServerStatePlayer;
}""",
"""  controller?: ServerStateController;
  player?: ServerStatePlayer;
  color?: ServerStateColor;
}"""),
("""      min_buffer_ms?: number;
      supported_commands?: string[];
    };
  };
}

export interface ClientGoodbye {""",
"""      min_buffer_ms?: number;
      supported_commands?: string[];
    };
    visualizer?: VisualizerRequest;
  };
}

export interface ClientGoodbye {"""),
("""export interface StreamStart {
  type: MessageType.STREAM_START;
  payload: {
    player: {
      codec: string;
      sample_rate: number;
      channels: number;
      bit_depth?: number;
      codec_header?: string;
    };
  };
}""",
"""export interface StreamStart {
  type: MessageType.STREAM_START;
  payload: {
    player?: {
      codec: string;
      sample_rate: number;
      channels: number;
      bit_depth?: number;
      codec_header?: string;
    };
    visualizer?: VisualizerStreamConfig;
  };
}"""),
])
s = open("src/types.ts", encoding="utf-8").read()
m = re.search(r"export interface SendspinPlayerConfig[^\n]*\{\n", s)
assert m, "SendspinPlayerConfig not found"
ins = """  /**
   * Visualizer role: what analysis data to request from the server. When set,
   * the client advertises visualizer@v1 and frames arrive via onVisualizerFrame.
   */
  visualizer?: VisualizerRequest;
  /** Called for every decoded visualizer frame (loudness, beat, f_peak, spectrum, peak). */
  onVisualizerFrame?: (frame: VisualizerFrame) => void;
  /** Called when the server starts/updates (config) or ends (null) the visualizer stream. */
  onVisualizerStream?: (config: VisualizerStreamConfig | null) => void;
  /** Called when the server clears the visualizer stream (seek / track jump). */
  onVisualizerClear?: () => void;
"""
s = s[: m.end()] + ins + s[m.end():]
open("src/types.ts", "w", encoding="utf-8").write(s)

# ---------- internal-types.ts ----------
patch("src/internal-types.ts", [
("""  handleStreamEnd(): void;
  handleVolumeUpdate(): void;""",
"""  handleStreamEnd(): void;
  handleVisualizerStreamStart(config: VisualizerStreamConfig): void;
  handleVisualizerStreamClear(): void;
  handleVisualizerStreamEnd(): void;
  handleVolumeUpdate(): void;"""),
])
s = open("src/internal-types.ts", encoding="utf-8").read()
if "VisualizerStreamConfig" not in s.split("export interface StreamHandler")[0]:
    s = 'import type { VisualizerStreamConfig } from "./types";\n' + s
open("src/internal-types.ts", "w", encoding="utf-8").write(s)

# ---------- protocol-handler.ts ----------
patch("src/core/protocol-handler.ts", [
("""        supported_roles: ["player@v1", "controller@v1", "metadata@v1"],""",
"""        supported_roles: [
          "player@v1",
          "controller@v1",
          "metadata@v1",
          ...(this.visualizerRequest ? ["visualizer@v1"] : []),
          "color@v1",
        ],"""),
("""          supported_commands: ["volume", "mute"],
        },
      },
    };""",
"""          supported_commands: ["volume", "mute"],
        },
        ...(this.visualizerRequest
          ? {
              "visualizer@v1_support": {
                buffer_capacity: VISUALIZER_BUFFER_CAPACITY,
              },
            }
          : {}),
      },
    };"""),
("""    const message: ClientState = {
      type: "client/state" as MessageType.CLIENT_STATE,
      payload,
    };
    this.sender.sendControl(message);
  }""",
"""    if (
      this.visualizerRequest &&
      (this.activeRoles === null || this.activeRoles.has("visualizer@v1"))
    ) {
      payload.visualizer = this.visualizerRequest;
    }

    const message: ClientState = {
      type: "client/state" as MessageType.CLIENT_STATE,
      payload,
    };
    this.sender.sendControl(message);
  }

  /** Set (or clear with null) the visualizer request; re-sent on the next client/state. */
  setVisualizerRequest(request: VisualizerRequest | null): void {
    this.visualizerRequest = request;
    if (this.activated) this.sendStateUpdate();
  }"""),
("""  private handleStreamStart(message: StreamStart): void {
    const isFormatUpdate = this.stateManager.currentStreamFormat !== null;

    this.stateManager.currentStreamFormat = message.payload.player;""",
"""  private handleStreamStart(message: StreamStart): void {
    if (message.payload.visualizer) {
      this.streamHandler.handleVisualizerStreamStart(message.payload.visualizer);
    }
    const player = message.payload.player;
    if (!player) return;
    const isFormatUpdate = this.stateManager.currentStreamFormat !== null;

    this.stateManager.currentStreamFormat = player;"""),
("""  private handleStreamClear(message: StreamClear): void {
    const roles = message.payload.roles;
    if (!roles || roles.includes("player")) {""",
"""  private handleStreamClear(message: StreamClear): void {
    const roles = message.payload.roles;
    if (!roles || roles.includes("visualizer")) {
      this.streamHandler.handleVisualizerStreamClear();
    }
    if (!roles || roles.includes("player")) {"""),
("""  private handleStreamEnd(message: StreamEnd): void {
    const roles = message.payload?.roles;
    if (!roles || roles.includes("player")) {""",
"""  private handleStreamEnd(message: StreamEnd): void {
    const roles = message.payload?.roles;
    if (!roles || roles.includes("visualizer")) {
      this.streamHandler.handleVisualizerStreamEnd();
    }
    if (!roles || roles.includes("player")) {"""),
("""  constructor(
    private sender: MessageSender,""",
"""  private visualizerRequest: VisualizerRequest | null = null;

  constructor(
    private sender: MessageSender,"""),
('import { clampSyncDelayMs } from "../sync-delay";',
 'import { clampSyncDelayMs } from "../sync-delay";\n'
 'import type { VisualizerRequest } from "../types";\n\n'
 '// Max bytes of not-yet-due visualizer frames the server may have in flight to us.\n'
 'const VISUALIZER_BUFFER_CAPACITY = 256 * 1024;'),
])

# ---------- core.ts ----------
patch("src/core/core.ts", [
("""  handleBinaryMessage(data: ArrayBuffer): void {
    const format = this.stateManager.currentStreamFormat;""",
"""  /** Visualizer role callbacks (set by SendspinPlayer). */
  onVisualizerFrame: ((frame: VisualizerFrame) => void) | null = null;
  onVisualizerStream: ((config: VisualizerStreamConfig | null) => void) | null =
    null;
  onVisualizerClear: (() => void) | null = null;

  setVisualizerRequest(request: VisualizerRequest | null): void {
    this.protocolHandler.setVisualizerRequest(request);
  }

  handleVisualizerStreamStart(config: VisualizerStreamConfig): void {
    console.log("Sendspin: Visualizer stream started", config);
    this.onVisualizerStream?.(config);
  }
  handleVisualizerStreamClear(): void {
    this.onVisualizerClear?.();
  }
  handleVisualizerStreamEnd(): void {
    console.log("Sendspin: Visualizer stream ended");
    this.onVisualizerStream?.(null);
  }

  // Binary visualizer frame: [type:1][timestamp:8 BE int64][data]
  // See spec roles/visualizer/v1.md. All uint16 fields are big-endian.
  private handleVisualizerBinary(type: number, data: ArrayBuffer): void {
    if (!this.onVisualizerFrame || data.byteLength < 9) return;
    const view = new DataView(data);
    const timestampUs = Number(view.getBigInt64(1));
    switch (type) {
      case 16:
        this.onVisualizerFrame({
          type: "loudness",
          timestampUs,
          value: view.getUint16(9),
        });
        break;
      case 17:
        this.onVisualizerFrame({
          type: "beat",
          timestampUs,
          downbeat: (view.getUint8(9) & 1) === 1,
        });
        break;
      case 18:
        this.onVisualizerFrame({
          type: "f_peak",
          timestampUs,
          freq: view.getUint16(9),
          amp: view.getUint16(11),
        });
        break;
      case 19: {
        const n = (data.byteLength - 9) >> 1;
        const bins = new Uint16Array(n);
        for (let i = 0; i < n; i++) bins[i] = view.getUint16(9 + 2 * i);
        this.onVisualizerFrame({ type: "spectrum", timestampUs, bins });
        break;
      }
      case 20:
        this.onVisualizerFrame({
          type: "peak",
          timestampUs,
          strength: view.getUint8(9),
        });
        break;
    }
  }

  handleBinaryMessage(data: ArrayBuffer): void {
    const messageType = new Uint8Array(data, 0, 1)[0];
    if (messageType >= 16 && messageType <= 23) {
      this.handleVisualizerBinary(messageType, data);
      return;
    }
    const format = this.stateManager.currentStreamFormat;"""),
])
s = open("src/core/core.ts", encoding="utf-8").read()
m = re.search(r'import type \{([^}]*)\} from "\.\./types";', s)
if m:
    s = (s[: m.start()] + "import type {" + m.group(1).rstrip()
         + ",\n  VisualizerFrame,\n  VisualizerRequest,\n  VisualizerStreamConfig,\n} from \"../types\";"
         + s[m.end():])
else:
    s = ('import type { VisualizerFrame, VisualizerRequest, VisualizerStreamConfig } from "../types";\n' + s)
open("src/core/core.ts", "w", encoding="utf-8").write(s)

# ---------- index.ts ----------
patch("src/index.ts", [
("""    // Wire core events to scheduler
    this.core.onAudioData = (chunk) => {
      this.scheduler.handleDecodedChunk(chunk);
    };""",
"""    // Wire core events to scheduler
    this.core.onAudioData = (chunk) => {
      this.scheduler.handleDecodedChunk(chunk);
    };

    // Visualizer + colour roles
    this.core.onVisualizerFrame = config.onVisualizerFrame ?? null;
    this.core.onVisualizerStream = config.onVisualizerStream ?? null;
    this.core.onVisualizerClear = config.onVisualizerClear ?? null;
    if (config.visualizer) this.core.setVisualizerRequest(config.visualizer);"""),
("""  getCurrentServerTimeUs(): number {""",
"""  /** Change what visualizer data is requested; takes effect on the next client/state. */
  setVisualizerRequest(request: VisualizerRequest | null): void {
    this.core.setVisualizerRequest(request);
  }

  getCurrentServerTimeUs(): number {"""),
])
s = open("src/index.ts", encoding="utf-8").read()
m = re.search(r'import type \{([^}]*)\} from "\./types";', s)
assert m, "no type import from ./types in index.ts"
if "VisualizerRequest" not in m.group(1):
    s = (s[: m.start()] + "import type {" + m.group(1).rstrip()
         + ",\n  VisualizerRequest,\n} from \"./types\";" + s[m.end():])
open("src/index.ts", "w", encoding="utf-8").write(s)
print("patched OK")
