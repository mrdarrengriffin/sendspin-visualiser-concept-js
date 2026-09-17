"""Local Sendspin test server: streams a synthetic groove with beats, colours and metadata.

Lets the browser visualizer be exercised end to end without Music Assistant.
Run:  venv/Scripts/python testserver.py [port] [options]
Then connect the player page to http://127.0.0.1:<port>

Scenarios for the beat clock (all off by default except the fill):
  --no-fill                 steady beats throughout (default: two off-grid bars in every sixteen)
  --bpm2 100 --switch-at 40 change tempo after N seconds (a genuine tempo relock)
  --shift-ms 200 --shift-at 30
                            from N seconds on, every beat is pushed by this much at the same tempo
                            (a re-pushed, phase-shifted beat list: a phase relock)
  --sparse 10               only every other beat for the first N seconds (a sparse intro)
  --half 30 45              only every other beat between the two times (a breakdown at half rate;
                            the clock must keep the full tempo)
  --gap 30 45               no beats at all between the two times, then the same grid again
  --rit-at 50 --rit-rate 0.03 --rit-beats 12
                            from N seconds each beat gap grows by this fraction for this many beats,
                            then the beats stop for good (an end-of-track ritardando and fade; the
                            audio keeps its tempo, only the schedule slows)
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import math
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
# Scenario options, set from the command line in main().
OPTS = argparse.Namespace(
    fill=True, bpm2=None, switch_at=40.0, shift_ms=0.0, shift_at=30.0, sparse=0.0,
    half=None, gap=None, rit_at=None, rit_rate=0.03, rit_beats=12,
)
STATE_DIR = Path(__file__).with_name("testserver-state")
FMT = AudioFormat(sample_rate=SR, bit_depth=16, channels=CH, sample_type="int")

# simple 4-bar bass line (Hz) and a pad chord
BASS = [55.0, 55.0, 65.41, 73.42]  # A, A, C, D
PAD = [220.0, 261.63, 329.63]


def synth_chunk(t0: float) -> bytes:
    """Render CHUNK_MS of the groove starting at song time t0 (seconds)."""
    n = SR * CHUNK_MS // 1000
    t = t0 + np.arange(n) / SR
    beat_pos = beats_at(t)                    # beats elapsed (float)
    beat_idx = np.floor(beat_pos).astype(int)
    tb = (beat_pos - beat_idx) * BEAT         # seconds since the last beat (envelope time; fine at any tempo)
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


# Every 16 bars, bars 8-9 are a "fill": the beat schedule there is deliberately wrong (beats
# pushed off the grid, one dropped), to check that a locked client rides through it.
FILL_BARS = range(8, 10)
FILL_EVERY = 16


def switch_beat() -> int:
    """Index of the first beat at the second tempo (or a huge number when there is none)."""
    return math.ceil(OPTS.switch_at / BEAT) if OPTS.bpm2 else 1 << 30


def beat_time(k: int) -> float:
    """Song time of grid beat k, honouring the tempo change."""
    k0 = switch_beat()
    if k < k0:
        return k * BEAT
    return k0 * BEAT + (k - k0) * 60.0 / OPTS.bpm2


def beats_at(t):
    """Fractional beats elapsed at song time(s) t (numpy-friendly inverse of beat_time)."""
    k0 = switch_beat()
    t0 = k0 * BEAT
    if not OPTS.bpm2:
        return t / BEAT
    return np.where(t < t0, t / BEAT, k0 + (t - t0) * OPTS.bpm2 / 60.0)


def rit_beat() -> int:
    """Index of the first slowed beat of the ritardando (or a huge number when there is none)."""
    return math.ceil(OPTS.rit_at / BEAT) + 1 if OPTS.rit_at is not None else 1 << 30


def rit_extra(k: int) -> float | None:
    """How much later than the grid beat k falls in the ritardando; None once the beats have stopped."""
    k0 = rit_beat()
    if k < k0:
        return 0.0
    n = k - k0 + 1
    if n > OPTS.rit_beats:
        return None
    return sum(BEAT * ((1 + OPTS.rit_rate) ** i - 1) for i in range(1, n + 1))


def beats_between(t0: float, t1: float) -> list[tuple[float, bool]]:
    """Song-time beats in [t0, t1): (time, is_downbeat), with the scenario applied."""
    out = []
    # widen the search: scenario beats move by up to shift + 0.2 s, plus the whole ritardando
    slack = 0.2 + OPTS.shift_ms / 1000
    if OPTS.rit_at is not None:
        slack += rit_extra(rit_beat() + OPTS.rit_beats - 1) or 0.0
    k = max(0, math.floor(float(beats_at(np.float64(t0 - slack)))) - 1)
    while beat_time(k) - slack < t1:
        t, bar, in_bar = beat_time(k), k // 4, k % 4
        if OPTS.sparse and t < OPTS.sparse and k % 2:
            k += 1
            continue                           # sparse intro: every other beat only
        if OPTS.half and OPTS.half[0] <= t < OPTS.half[1] and k % 2:
            k += 1
            continue                           # half-rate section: every other slot, same grid
        if OPTS.gap and OPTS.gap[0] <= t < OPTS.gap[1]:
            k += 1
            continue                           # no beats at all, then the same grid
        extra = rit_extra(k)
        if extra is None:
            k += 1
            continue                           # the beat list ended before the audio
        t += extra                             # ritardando: each gap a little longer
        if OPTS.fill and bar % FILL_EVERY in FILL_BARS:
            if in_bar == 2:
                k += 1
                continue                       # dropped beat
            t += 0.18 if in_bar % 2 else -0.12  # pushed off the grid
        if OPTS.shift_ms and t >= OPTS.shift_at:
            t += OPTS.shift_ms / 1000          # re-pushed list: same tempo, new phase
        if t0 <= t < t1:
            out.append((t, in_bar == 0))
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
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", nargs="?", type=int, default=8928)
    ap.add_argument("--no-fill", dest="fill", action="store_false")
    ap.add_argument("--bpm2", type=float, default=None)
    ap.add_argument("--switch-at", type=float, default=40.0)
    ap.add_argument("--shift-ms", type=float, default=0.0)
    ap.add_argument("--shift-at", type=float, default=30.0)
    ap.add_argument("--sparse", type=float, default=0.0)
    ap.add_argument("--half", type=float, nargs=2, metavar=("FROM", "UNTIL"), default=None)
    ap.add_argument("--gap", type=float, nargs=2, metavar=("FROM", "UNTIL"), default=None)
    ap.add_argument("--rit-at", type=float, default=None)
    ap.add_argument("--rit-rate", type=float, default=0.03)
    ap.add_argument("--rit-beats", type=int, default=12)
    ap.parse_args(namespace=OPTS)
    log.info("scenario: %s", vars(OPTS))
    ts = TestServer(OPTS.port)
    await ts.start()
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
