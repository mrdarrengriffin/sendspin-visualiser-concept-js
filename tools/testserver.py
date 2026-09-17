"""Local Sendspin test server: streams a synthetic groove with beats, colours and metadata.

Lets the browser visualizer be exercised end to end without Music Assistant.
Run:  venv/Scripts/python testserver.py [port]
Then connect the player page to http://127.0.0.1:<port>
"""
from __future__ import annotations

import asyncio
import logging
import math
import sys
from pathlib import Path

import numpy as np
from aiohttp import web
from aiosendspin.models.visualizer import BeatTiming
from aiosendspin.noise.keys import Identity, b64url_decode
from aiosendspin.noise.trust_store import FileServerPairingStore
from aiosendspin.server import (
    AudioFormat,
    ClientConnectedEvent,
    ClientDisconnectedEvent,
    SendspinEvent,
    SendspinServer,
)
from aiosendspin.server.roles.color.state import Color
from aiosendspin.server.roles.metadata.state import Metadata

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("testserver")

SR, CH = 48000, 2
BPM = 120.0
BEAT = 60.0 / BPM
CHUNK_MS = 100
STATE_DIR = Path(__file__).with_name("testserver-state")
FMT = AudioFormat(sample_rate=SR, bit_depth=16, channels=CH, sample_type="int")

# simple 4-bar bass line (Hz) and a pad chord
BASS = [55.0, 55.0, 65.41, 73.42]  # A, A, C, D
PAD = [220.0, 261.63, 329.63]


def synth_chunk(t0: float) -> bytes:
    """Render CHUNK_MS of the groove starting at song time t0 (seconds)."""
    n = SR * CHUNK_MS // 1000
    t = t0 + np.arange(n) / SR
    beat_pos = t / BEAT                       # beats elapsed (float)
    beat_idx = np.floor(beat_pos).astype(int)
    tb = (beat_pos - beat_idx) * BEAT         # seconds since the last beat
    bar = beat_idx // 4
    in_bar = beat_idx % 4

    # kick on every beat: pitch sweep 130 -> 45 Hz, fast decay
    f_kick = 45 + 85 * np.exp(-tb * 18)
    kick = np.sin(2 * math.pi * np.cumsum(f_kick) / SR) * np.exp(-tb * 9) * 0.9
    # snare-ish noise on beats 2 and 4
    rng = np.random.default_rng(int(t0 * 1000))
    noise = rng.standard_normal(n)
    snare = noise * np.exp(-tb * 22) * 0.35 * ((in_bar == 1) | (in_bar == 3))
    # hats on the off-eighths
    te = (beat_pos * 2 - np.floor(beat_pos * 2)) * BEAT / 2
    off = (np.floor(beat_pos * 2).astype(int) % 2) == 1
    hats = noise * np.exp(-te * 60) * 0.18 * off
    # bass: note per bar, saw-ish, gated per beat
    fb = np.array(BASS)[bar % 4]
    ph = 2 * math.pi * np.cumsum(fb) / SR
    bass = (np.sin(ph) + 0.5 * np.sin(2 * ph) + 0.25 * np.sin(3 * ph)) * np.exp(-tb * 3) * 0.35
    # pad chord with slow tremolo, plus a sparkle every 2 bars
    pad = sum(np.sin(2 * math.pi * f * t) for f in PAD) * (0.05 + 0.03 * np.sin(2 * math.pi * 0.25 * t))
    sparkle = np.sin(2 * math.pi * 2200 * t) * np.exp(-((t % (8 * BEAT)) * 6)) * 0.12

    mono = kick + snare + hats + bass + pad + sparkle
    mono = np.tanh(mono * 1.2) * 0.8
    stereo = np.stack([mono * (0.9 + 0.1 * np.sin(2 * math.pi * 0.1 * t)), mono], axis=1)
    return (stereo * 32767).astype("<i2").tobytes()


def beats_between(t0: float, t1: float) -> list[tuple[float, bool]]:
    """Song-time beats in [t0, t1): (time, is_downbeat)."""
    out = []
    k = math.ceil(t0 / BEAT - 1e-9)
    while k * BEAT < t1:
        out.append((k * BEAT, k % 4 == 0))
        k += 1
    return out


class TestServer:
    def __init__(self, port: int) -> None:
        self.port = port
        self.server: SendspinServer | None = None
        self.stream_tasks: dict[str, asyncio.Task] = {}

    def _identity(self) -> Identity:
        STATE_DIR.mkdir(exist_ok=True)
        key = STATE_DIR / "identity.key"
        if key.exists():
            return Identity.from_private_bytes(b64url_decode(key.read_text().strip()))
        ident = Identity.generate()
        key.write_text(ident.private_b64u)
        return ident

    async def start(self) -> None:
        store = await FileServerPairingStore.open(STATE_DIR / "pairing-store.json")
        self.server = SendspinServer(
            loop=asyncio.get_running_loop(),
            identity=self._identity(),
            server_name="Sendspin logo test server",
            pairing_store=store,
            allow_noncompliant_clients=True,
        )
        self.server.add_event_listener(self._on_event)
        app = web.Application()
        app.router.add_get(SendspinServer.API_PATH, self.server.on_client_connect)
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", self.port).start()
        log.info("listening on ws://0.0.0.0:%d%s", self.port, SendspinServer.API_PATH)

    def _on_event(self, server: SendspinServer, event: SendspinEvent) -> None:
        if isinstance(event, ClientConnectedEvent):
            asyncio.create_task(self._client_connected(event.client_id))
        elif isinstance(event, ClientDisconnectedEvent):
            log.info("client disconnected %s", event.client_id)

    async def _client_connected(self, client_id: str) -> None:
        assert self.server is not None
        # Unpaired (Sentinel-PSK) browsers are fine here: approve them so their roles activate.
        await self.server.trust_unpaired(client_id)
        await asyncio.sleep(0.3)
        client = self.server.get_client(client_id)
        if client is None or not client.is_connected:
            return
        log.info("client %s roles=%s", client_id, [r.role_id for r in client.active_roles])
        gid = client.group.group_id
        if gid not in self.stream_tasks or self.stream_tasks[gid].done():
            self.stream_tasks[gid] = asyncio.create_task(self._stream(client.group))

    async def _stream(self, group) -> None:
        ps = group.start_stream()
        now = ps.now_us()
        meta_role = group.group_role("metadata")
        if meta_role:
            meta_role.set_metadata(Metadata(
                title="Test Groove", artist="Sendspin test server", album="Local synth",
                track_progress=0, track_duration=0, playback_speed=1000, timestamp_us=now,
            ))
        color_role = group.group_role("color")
        if color_role:
            color_role.set_color(Color(
                primary=(226, 92, 76), accent=(76, 201, 240),
                background_dark=(18, 14, 22), on_dark=(240, 236, 232),
            ))
        viz = group.group_role("visualizer")
        log.info("stream started for group %s (viz role: %s)", group.group_id, viz is not None)
        t = 0.0
        play_start_us: int | None = None
        try:
            while group.clients and any(c.is_connected for c in group.clients):
                pcm = synth_chunk(t)
                ps.prepare_audio(pcm, FMT)
                # Beats must reach the visualizer role BEFORE the audio they belong to is committed:
                # the role drops any beat at or behind the timestamp of the last frame it already sent.
                # Chunks are contiguous, so this chunk starts one chunk after the previous play start.
                predicted_us = None
                if viz is not None and play_start_us is not None:
                    predicted_us = play_start_us + CHUNK_MS * 1000
                    beats = [
                        BeatTiming(timestamp_us=int(predicted_us + (bt - t) * 1_000_000), is_downbeat=down)
                        for bt, down in beats_between(t, t + CHUNK_MS / 1000)
                    ]
                    if beats:
                        try:
                            viz.append_beat_schedule(beats)
                        except ValueError as err:
                            log.warning("beat schedule rejected: %s", err)
                play_start_us = await ps.commit_audio()
                if predicted_us is not None and abs(play_start_us - predicted_us) > 2000:
                    log.warning("chunk timing jumped: predicted %d, actual %d", predicted_us, play_start_us)
                t += CHUNK_MS / 1000
                await ps.sleep_to_limit_buffer(1_500_000)
        except Exception:
            log.exception("stream loop failed")
        finally:
            log.info("stream ended for group %s", group.group_id)
            group.stop_stream()


async def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8928
    ts = TestServer(port)
    await ts.start()
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
