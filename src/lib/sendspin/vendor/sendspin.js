/**
 * Audio decoder pipeline for Sendspin protocol.
 *
 * Decodes compressed audio (PCM, Opus, FLAC) into raw Float32Array PCM samples.
 * This module has no Web Audio playback concerns — it only produces decoded data.
 */
class SendspinDecoder {
    constructor(onDecodedChunk, currentGeneration) {
        // Native Opus decoder (WebCodecs API)
        this.webCodecsDecoder = null;
        this.webCodecsDecoderReady = null;
        this.webCodecsFormat = null;
        this.useNativeOpus = true;
        this.nativeDecoderQueue = [];
        // Fallback Opus decoder (opus-encdec library)
        this.opusDecoder = null;
        this.opusDecoderModule = null;
        this.opusDecoderReady = null;
        // FLAC decoding context (OfflineAudioContext, no playback needed)
        this.flacDecodingContext = null;
        this.flacDecodingContextSampleRate = 0;
        this.flacDecodingContextChannels = 0;
        this.onDecodedChunk = onDecodedChunk;
        this.currentGeneration = currentGeneration;
    }
    /**
     * Handle a binary audio message from the WebSocket.
     * Parses the message, decodes the audio, and emits a DecodedAudioChunk.
     */
    async handleBinaryMessage(data, format, generation) {
        // First byte contains role type and message slot
        const firstByte = new Uint8Array(data)[0];
        // Type 4 is audio chunk (Player role, slot 0)
        if (firstByte === 4) {
            // Next 8 bytes are server timestamp in microseconds (big-endian int64)
            const timestampView = new DataView(data, 1, 8);
            const serverTimeUs = Number(timestampView.getBigInt64(0, false));
            // Rest is audio data
            const audioData = data.slice(9);
            // For Opus: use native decoder (non-blocking async path)
            if (format.codec === "opus" && this.useNativeOpus) {
                await this.initWebCodecsDecoder(format);
                if (this.useNativeOpus && this.webCodecsDecoder) {
                    if (this.queueToNativeOpusDecoder(audioData, serverTimeUs, generation)) {
                        return; // Async path - callback handles output
                    }
                    // Fall through to fallback on error
                }
            }
            // Fallback decode path (PCM, FLAC, or Opus via opus-encdec)
            try {
                const decoded = await this.decode(audioData, format);
                if (decoded && generation === this.currentGeneration()) {
                    this.onDecodedChunk({
                        samples: decoded.samples,
                        sampleRate: decoded.sampleRate,
                        serverTimeUs,
                        generation,
                    });
                }
            }
            catch (error) {
                console.error("Sendspin: Failed to decode audio buffer:", error);
            }
        }
    }
    async decode(audioData, format) {
        if (format.codec === "opus") {
            return this.decodeOpusWithEncdec(audioData, format);
        }
        else if (format.codec === "flac") {
            return this.decodeFLAC(audioData, format);
        }
        else if (format.codec === "pcm") {
            return this.decodePCM(audioData, format);
        }
        return null;
    }
    // ========================================
    // PCM Decoder
    // ========================================
    decodePCM(audioData, format) {
        const bitDepth = format.bit_depth ?? 16;
        if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
            console.warn(`Sendspin: unsupported PCM bit_depth ${bitDepth}`);
            return null;
        }
        const bytesPerSample = bitDepth / 8;
        const dataView = new DataView(audioData);
        const numSamples = audioData.byteLength / (bytesPerSample * format.channels);
        const samples = [];
        for (let ch = 0; ch < format.channels; ch++) {
            samples.push(new Float32Array(numSamples));
        }
        // Decode PCM data (interleaved format)
        for (let channel = 0; channel < format.channels; channel++) {
            const channelData = samples[channel];
            for (let i = 0; i < numSamples; i++) {
                const offset = (i * format.channels + channel) * bytesPerSample;
                let sample = 0;
                if (bitDepth === 16) {
                    sample = dataView.getInt16(offset, true) / 32768.0;
                }
                else if (bitDepth === 24) {
                    const byte1 = dataView.getUint8(offset);
                    const byte2 = dataView.getUint8(offset + 1);
                    const byte3 = dataView.getUint8(offset + 2);
                    let int24 = (byte3 << 16) | (byte2 << 8) | byte1;
                    if (int24 & 0x800000) {
                        int24 |= 0xff000000;
                    }
                    sample = int24 / 8388608.0;
                }
                else if (bitDepth === 32) {
                    sample = dataView.getInt32(offset, true) / 2147483648.0;
                }
                channelData[i] = sample;
            }
        }
        return { samples, sampleRate: format.sample_rate };
    }
    // ========================================
    // FLAC Decoder (uses OfflineAudioContext)
    // ========================================
    getFlacDecodingContext(sampleRate, channels) {
        if (!this.flacDecodingContext ||
            this.flacDecodingContextSampleRate !== sampleRate ||
            this.flacDecodingContextChannels !== channels) {
            this.flacDecodingContext = new OfflineAudioContext(channels, 1, sampleRate);
            this.flacDecodingContextSampleRate = sampleRate;
            this.flacDecodingContextChannels = channels;
        }
        return this.flacDecodingContext;
    }
    async decodeFLAC(audioData, format) {
        try {
            let dataToEncode = audioData;
            if (format.codec_header) {
                // Decode Base64 codec header and prepend to audio data
                const headerBytes = Uint8Array.from(atob(format.codec_header), (c) => c.charCodeAt(0));
                const combined = new Uint8Array(headerBytes.length + audioData.byteLength);
                combined.set(headerBytes, 0);
                combined.set(new Uint8Array(audioData), headerBytes.length);
                dataToEncode = combined.buffer;
            }
            const ctx = this.getFlacDecodingContext(format.sample_rate, format.channels);
            const audioBuffer = await ctx.decodeAudioData(dataToEncode);
            // Extract Float32Array per channel from AudioBuffer
            const samples = [];
            for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
                samples.push(new Float32Array(audioBuffer.getChannelData(ch)));
            }
            return { samples, sampleRate: audioBuffer.sampleRate };
        }
        catch (error) {
            console.error("Error decoding FLAC data:", error);
            return null;
        }
    }
    // ========================================
    // Opus - Native WebCodecs Decoder
    // ========================================
    async initWebCodecsDecoder(format) {
        const tryConfigureExistingDecoder = () => {
            if (!this.webCodecsDecoder)
                return false;
            const matchesFormat = !!this.webCodecsFormat &&
                this.webCodecsFormat.sample_rate === format.sample_rate &&
                this.webCodecsFormat.channels === format.channels;
            if (this.webCodecsDecoder.state === "configured" && matchesFormat) {
                return true;
            }
            if (this.webCodecsDecoder.state === "closed") {
                return false;
            }
            try {
                this.webCodecsDecoder.configure({
                    codec: "opus",
                    sampleRate: format.sample_rate,
                    numberOfChannels: format.channels,
                });
                this.webCodecsFormat = format;
                return true;
            }
            catch {
                return false;
            }
        };
        if (tryConfigureExistingDecoder()) {
            return;
        }
        if (this.webCodecsDecoderReady) {
            await this.webCodecsDecoderReady;
            if (tryConfigureExistingDecoder()) {
                return;
            }
            try {
                this.webCodecsDecoder?.close();
            }
            catch {
                // Ignore close errors; we'll recreate below.
            }
            this.webCodecsDecoder = null;
            this.webCodecsDecoderReady = null;
            this.webCodecsFormat = null;
        }
        if (this.webCodecsDecoderReady) {
            await this.webCodecsDecoderReady;
            return;
        }
        this.webCodecsDecoderReady = this.createWebCodecsDecoder(format);
        await this.webCodecsDecoderReady;
    }
    async createWebCodecsDecoder(format) {
        if (typeof AudioDecoder === "undefined") {
            this.useNativeOpus = false;
            return;
        }
        try {
            const support = await AudioDecoder.isConfigSupported({
                codec: "opus",
                sampleRate: format.sample_rate,
                numberOfChannels: format.channels,
            });
            if (!support.supported) {
                console.log("[NativeOpus] WebCodecs Opus not supported, will use fallback");
                this.useNativeOpus = false;
                return;
            }
            this.webCodecsDecoder = new AudioDecoder({
                output: (audioData) => this.handleAudioData(audioData),
                error: (error) => {
                    console.error("[NativeOpus] WebCodecs decoder error:", error);
                },
            });
            this.webCodecsDecoder.configure({
                codec: "opus",
                sampleRate: format.sample_rate,
                numberOfChannels: format.channels,
            });
            this.webCodecsFormat = format;
            console.log(`[NativeOpus] Using WebCodecs AudioDecoder: ${format.sample_rate}Hz, ${format.channels}ch`);
        }
        catch (error) {
            console.warn("[NativeOpus] WebCodecs init failed, will use fallback:", error);
            this.useNativeOpus = false;
        }
    }
    // Handle decoded audio data from native Opus decoder
    handleAudioData(audioData) {
        try {
            const outputTimestampUs = Number(audioData.timestamp);
            const metadata = this.nativeDecoderQueue.shift();
            if (!metadata) {
                console.warn(`[NativeOpus] Dropping frame with empty decode queue (out ts=${outputTimestampUs})`);
                audioData.close();
                return;
            }
            const { serverTimeUs, generation } = metadata;
            const format = this.webCodecsFormat;
            if (!format) {
                audioData.close();
                return;
            }
            if (generation !== this.currentGeneration()) {
                console.warn(`[NativeOpus] Dropping old-stream frame (ts=${serverTimeUs}, gen=${generation} != current=${this.currentGeneration()})`);
                audioData.close();
                return;
            }
            const channels = audioData.numberOfChannels;
            const frames = audioData.numberOfFrames;
            const fmt = audioData.format;
            const samples = [];
            for (let ch = 0; ch < channels; ch++) {
                samples.push(new Float32Array(frames));
            }
            if (fmt === "f32-planar") {
                for (let ch = 0; ch < channels; ch++) {
                    audioData.copyTo(samples[ch], { planeIndex: ch });
                }
            }
            else if (fmt === "s16-planar") {
                const plane = new Int16Array(frames);
                for (let ch = 0; ch < channels; ch++) {
                    audioData.copyTo(plane, { planeIndex: ch });
                    const out = samples[ch];
                    for (let i = 0; i < frames; i++)
                        out[i] = plane[i] / 32768.0;
                }
            }
            else if (fmt === "f32") {
                const interleaved = new Float32Array(frames * channels);
                audioData.copyTo(interleaved, { planeIndex: 0 });
                for (let ch = 0; ch < channels; ch++) {
                    const out = samples[ch];
                    for (let i = 0; i < frames; i++)
                        out[i] = interleaved[i * channels + ch];
                }
            }
            else if (fmt === "s16") {
                const interleaved = new Int16Array(frames * channels);
                audioData.copyTo(interleaved, { planeIndex: 0 });
                for (let ch = 0; ch < channels; ch++) {
                    const out = samples[ch];
                    for (let i = 0; i < frames; i++)
                        out[i] = interleaved[i * channels + ch] / 32768.0;
                }
            }
            else {
                console.warn(`[NativeOpus] Unsupported AudioData format: ${fmt}`);
                audioData.close();
                return;
            }
            audioData.close();
            this.onDecodedChunk({
                samples,
                sampleRate: format.sample_rate,
                serverTimeUs,
                generation,
            });
        }
        catch (e) {
            console.error("[NativeOpus] Error in output callback:", e);
            audioData.close();
        }
    }
    queueToNativeOpusDecoder(audioData, serverTimeUs, generation) {
        if (!this.webCodecsDecoder ||
            this.webCodecsDecoder.state !== "configured") {
            return false;
        }
        try {
            this.nativeDecoderQueue.push({
                serverTimeUs,
                generation,
            });
            const chunk = new EncodedAudioChunk({
                type: "key",
                timestamp: serverTimeUs,
                data: audioData,
            });
            this.webCodecsDecoder.decode(chunk);
            return true;
        }
        catch (error) {
            if (this.nativeDecoderQueue.length > 0) {
                this.nativeDecoderQueue.pop();
            }
            console.error("[NativeOpus] WebCodecs queue error:", error);
            return false;
        }
    }
    // ========================================
    // Opus - Fallback (opus-encdec library)
    // ========================================
    resolveOpusDecoderModule(moduleExport) {
        const maybeDefault = moduleExport?.default;
        const maybeCommonJs = moduleExport?.["module.exports"];
        const resolved = maybeDefault ?? maybeCommonJs ?? moduleExport;
        if (!resolved || typeof resolved !== "object") {
            throw new Error("[Opus] Invalid libopus decoder module export");
        }
        return resolved;
    }
    resolveOggOpusDecoderClass(wrapperExport) {
        const maybeDefault = wrapperExport?.default;
        const maybeCommonJs = wrapperExport?.["module.exports"];
        const wrapper = maybeDefault ?? maybeCommonJs ?? wrapperExport;
        const resolved = wrapper?.OggOpusDecoder ?? wrapper;
        if (typeof resolved !== "function") {
            throw new Error("[Opus] OggOpusDecoder class export not found");
        }
        return resolved;
    }
    async waitForOpusReady(target) {
        if (target.isReady)
            return;
        if (Object.isExtensible(target)) {
            await new Promise((resolve) => {
                target.onready = () => resolve();
            });
            return;
        }
        while (!target.isReady) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    async initOpusEncdecDecoder(format) {
        if (this.opusDecoderReady) {
            await this.opusDecoderReady;
            return;
        }
        this.opusDecoderReady = (async () => {
            console.log("[Opus] Initializing decoder (opus-encdec)...");
            const [DecoderModuleExport, DecoderWrapperExport] = await Promise.all([
                import('./chunk-libopus-decoder-CSpihSS0.js').then(function (n) { return n.l; }),
                import('./chunk-oggOpusDecoder-D-pindbL.js').then(function (n) { return n.o; }),
            ]);
            this.opusDecoderModule =
                this.resolveOpusDecoderModule(DecoderModuleExport);
            const OggOpusDecoderClass = this.resolveOggOpusDecoderClass(DecoderWrapperExport);
            await this.waitForOpusReady(this.opusDecoderModule);
            this.opusDecoder = new OggOpusDecoderClass({
                rawOpus: true,
                decoderSampleRate: format.sample_rate,
                outputBufferSampleRate: format.sample_rate,
                numberOfChannels: format.channels,
            }, this.opusDecoderModule);
            await this.waitForOpusReady(this.opusDecoder);
            console.log("[Opus] Decoder ready");
        })();
        await this.opusDecoderReady;
    }
    async decodeOpusWithEncdec(audioData, format) {
        try {
            await this.initOpusEncdecDecoder(format);
            const uint8Array = new Uint8Array(audioData);
            const decodedSamples = [];
            this.opusDecoder.decodeRaw(uint8Array, (samples) => {
                decodedSamples.push(new Float32Array(samples));
            });
            if (decodedSamples.length === 0) {
                console.warn("[Opus] Fallback decoder produced no samples");
                return null;
            }
            // Convert interleaved samples to per-channel arrays
            const interleavedSamples = decodedSamples[0];
            const numFrames = interleavedSamples.length / format.channels;
            const samples = [];
            for (let ch = 0; ch < format.channels; ch++) {
                const channelData = new Float32Array(numFrames);
                for (let i = 0; i < numFrames; i++) {
                    channelData[i] = interleavedSamples[i * format.channels + ch];
                }
                samples.push(channelData);
            }
            return { samples, sampleRate: format.sample_rate };
        }
        catch (error) {
            console.error("[Opus] Decode error:", error);
            return null;
        }
    }
    // ========================================
    // Lifecycle
    // ========================================
    /** Clear decoder state (on stream change/clear). Drops in-flight async decodes. */
    clearState() {
        this.nativeDecoderQueue = [];
        try {
            this.webCodecsDecoder?.close();
        }
        catch {
            // Ignore close errors
        }
        this.webCodecsDecoder = null;
        this.webCodecsDecoderReady = null;
        this.webCodecsFormat = null;
    }
    /** Full cleanup (on disconnect). Releases all decoder resources. */
    close() {
        this.clearState();
        if (this.opusDecoder) {
            this.opusDecoder = null;
            this.opusDecoderModule = null;
            this.opusDecoderReady = null;
        }
        // Reset native Opus flag for next session
        this.useNativeOpus = true;
        this.flacDecodingContext = null;
        this.flacDecodingContextSampleRate = 0;
        this.flacDecodingContextChannels = 0;
    }
}

const TIME_SYNC_BURST_SIZE = 8;
const TIME_SYNC_BURST_INTERVAL_MS = 10000;
const TIME_SYNC_REQUEST_TIMEOUT_MS = 2000;
const TIME_SYNC_ROBUST_SELECTION_COUNT = 3;
class TimeSyncManager {
    constructor(sender, stateManager, timeFilter) {
        this.sender = sender;
        this.stateManager = stateManager;
        this.timeFilter = timeFilter;
        this.timeSyncBurstActive = false;
        this.timeSyncBurstSentCount = 0;
        this.timeSyncInFlightClientTransmitted = null;
        this.timeSyncInFlightTimeout = null;
        this.timeSyncBurstSamples = [];
    }
    // Start an initial burst and schedule recurring bursts.
    startAndSchedule() {
        this.stop();
        this.startTimeSyncBurstIfIdle();
        this.scheduleNextTimeSyncBurstTick();
    }
    // Schedule the next fixed 10s burst tick.
    scheduleNextTimeSyncBurstTick() {
        const timeSyncTimeout = globalThis.setTimeout(() => {
            this.startTimeSyncBurstIfIdle();
            this.scheduleNextTimeSyncBurstTick();
        }, TIME_SYNC_BURST_INTERVAL_MS);
        this.stateManager.setTimeSyncInterval(timeSyncTimeout);
    }
    startTimeSyncBurstIfIdle() {
        if (this.timeSyncBurstActive) {
            return;
        }
        this.timeSyncBurstActive = true;
        this.timeSyncBurstSentCount = 0;
        this.timeSyncBurstSamples = [];
        this.timeSyncInFlightClientTransmitted = null;
        this.sendNextTimeSyncBurstProbe();
    }
    sendNextTimeSyncBurstProbe() {
        if (!this.timeSyncBurstActive ||
            this.timeSyncInFlightClientTransmitted !== null) {
            return;
        }
        if (this.timeSyncBurstSentCount >= TIME_SYNC_BURST_SIZE) {
            this.finalizeTimeSyncBurst();
            return;
        }
        const clientTransmitted = this.sendTimeSync();
        this.timeSyncBurstSentCount += 1;
        this.timeSyncInFlightClientTransmitted = clientTransmitted;
        this.armTimeSyncProbeTimeout(clientTransmitted);
    }
    armTimeSyncProbeTimeout(expectedClientTransmitted) {
        this.clearTimeSyncProbeTimeout();
        this.timeSyncInFlightTimeout = globalThis.setTimeout(() => {
            this.handleTimeSyncProbeTimeout(expectedClientTransmitted);
        }, TIME_SYNC_REQUEST_TIMEOUT_MS);
    }
    clearTimeSyncProbeTimeout() {
        if (this.timeSyncInFlightTimeout !== null) {
            clearTimeout(this.timeSyncInFlightTimeout);
            this.timeSyncInFlightTimeout = null;
        }
    }
    handleTimeSyncProbeTimeout(expectedClientTransmitted) {
        if (!this.timeSyncBurstActive ||
            this.timeSyncInFlightClientTransmitted !== expectedClientTransmitted) {
            return;
        }
        console.warn("Sendspin: Time sync probe timed out, aborting current burst");
        this.abortTimeSyncBurst();
    }
    finalizeTimeSyncBurst() {
        this.clearTimeSyncProbeTimeout();
        const candidate = this.selectTimeSyncBurstCandidate();
        if (candidate) {
            this.timeFilter.update(candidate.measurement, candidate.maxError, candidate.t4);
        }
        this.timeSyncBurstActive = false;
        this.timeSyncBurstSentCount = 0;
        this.timeSyncInFlightClientTransmitted = null;
        this.timeSyncBurstSamples = [];
    }
    selectTimeSyncBurstCandidate() {
        if (this.timeSyncBurstSamples.length === 0) {
            return null;
        }
        const topRttSamples = [...this.timeSyncBurstSamples]
            .sort((a, b) => a.rttTerm - b.rttTerm)
            .slice(0, Math.min(TIME_SYNC_ROBUST_SELECTION_COUNT, this.timeSyncBurstSamples.length));
        const sortedByMeasurement = [...topRttSamples].sort((a, b) => a.measurement - b.measurement);
        return sortedByMeasurement[Math.floor(sortedByMeasurement.length / 2)];
    }
    abortTimeSyncBurst() {
        this.clearTimeSyncProbeTimeout();
        this.timeSyncBurstActive = false;
        this.timeSyncBurstSentCount = 0;
        this.timeSyncInFlightClientTransmitted = null;
        this.timeSyncBurstSamples = [];
    }
    // Stop all time sync activity (interval + in-flight burst).
    stop() {
        this.stateManager.clearTimeSyncInterval();
        this.abortTimeSyncBurst();
    }
    // Handle server/time response
    handleServerTime(message) {
        if (!this.timeSyncBurstActive ||
            this.timeSyncInFlightClientTransmitted === null) {
            return;
        }
        // Per spec: client_transmitted (T1), server_received (T2), server_transmitted (T3)
        const T1 = message.payload.client_transmitted;
        if (T1 !== this.timeSyncInFlightClientTransmitted) {
            console.warn("Sendspin: Ignoring out-of-order time response", T1, this.timeSyncInFlightClientTransmitted);
            return;
        }
        const T4 = Math.floor(performance.now() * 1000); // client received time
        const T2 = message.payload.server_received;
        const T3 = message.payload.server_transmitted;
        // NTP offset calculation: measurement = ((T2 - T1) + (T3 - T4)) / 2
        const measurement = (T2 - T1 + (T3 - T4)) / 2;
        // Max error (half of round-trip time): max_error = ((T4 - T1) - (T3 - T2)) / 2
        const rttTerm = Math.max(0, T4 - T1 - (T3 - T2));
        const maxError = Math.max(1000, rttTerm / 2);
        this.timeSyncBurstSamples.push({
            measurement,
            maxError,
            t4: T4,
            rttTerm,
        });
        this.clearTimeSyncProbeTimeout();
        this.timeSyncInFlightClientTransmitted = null;
        if (this.timeSyncBurstSentCount >= TIME_SYNC_BURST_SIZE) {
            this.finalizeTimeSyncBurst();
            return;
        }
        this.sendNextTimeSyncBurstProbe();
    }
    // Send time synchronization message
    sendTimeSync(clientTimeUs = Math.floor(performance.now() * 1000)) {
        const message = {
            type: "client/time",
            payload: {
                client_transmitted: clientTimeUs,
            },
        };
        this.sender.sendControl(message);
        return clientTimeUs;
    }
}

// Depth of buffered audio the server streams ahead, in seconds. Servers gate
// the send queue on both bytes (buffer_capacity) and duration; aiosendspin's
// duration horizon is 30s. Sizing the advertised byte capacity below that depth
// makes bytes the binding limit and starves the buffer on high-rate codecs.
const BUFFER_DEPTH_SECONDS = 30;
// FLAC falls back to verbatim frames on incompressible audio, where the frame
// headers put the stream slightly above raw PCM. Measured at 195.4 kB/s for
// 48kHz/16-bit stereo (192.0 kB/s raw) with full-scale decorrelated noise.
const FLAC_WORST_CASE_EXPANSION = 1.02;
// libopus tops out at 512 kbps for stereo. Servers pick their own bitrate
// (aiosendspin uses the libopus default, ~96 kbps), so assume the ceiling
// rather than tying the capacity to any one server's encoder settings.
const OPUS_MAX_BYTES_PER_SECOND = 64000;
/** Detect which audio codecs the current browser supports. */
function getBrowserSupportedCodecs() {
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
    const isFirefox = /firefox/i.test(userAgent);
    // Check if native Opus decoder is available (requires secure context)
    const hasNativeOpus = typeof AudioDecoder !== "undefined";
    if (!hasNativeOpus) {
        if (typeof window !== "undefined" && !window.isSecureContext) {
            console.warn("[Opus] Running in insecure context, falling back to FLAC/PCM");
        }
        else {
            console.warn("[Opus] Native decoder not available, falling back to FLAC/PCM");
        }
    }
    if (isSafari) {
        // Safari: No FLAC support
        return new Set(["pcm", "opus"]);
    }
    if (isFirefox) {
        // Firefox: Opus has audio glitches with both native and opus-encdec decoders
        return new Set(["pcm", "flac"]);
    }
    if (hasNativeOpus) {
        // Native Opus available (Chrome, Edge)
        return new Set(["pcm", "opus", "flac"]);
    }
    // No WebCodecs AudioDecoder (insecure context or unsupported browser)
    return new Set(["pcm", "flac"]);
}
/** Build supported format list from requested codecs, filtering by browser support. */
function getSupportedFormats(codecs) {
    const browserSupported = getBrowserSupportedCodecs();
    const formats = [];
    for (const codec of codecs) {
        if (!browserSupported.has(codec)) {
            continue;
        }
        if (codec === "opus") {
            // Opus requires 48kHz
            formats.push({
                codec: "opus",
                sample_rate: 48000,
                channels: 2,
                bit_depth: 16,
            });
        }
        else {
            // PCM and FLAC support both sample rates
            formats.push({ codec, sample_rate: 48000, channels: 2, bit_depth: 16 });
            formats.push({ codec, sample_rate: 44100, channels: 2, bit_depth: 16 });
        }
    }
    if (formats.length === 0) {
        throw new Error(`No supported codecs: requested [${codecs.join(", ")}], ` +
            `browser supports [${[...browserSupported].join(", ")}]`);
    }
    return formats;
}
/** Worst-case wire byte rate for a single advertised format. */
function getWireByteRate(format) {
    const pcmByteRate = format.sample_rate * format.channels * Math.ceil(format.bit_depth / 8);
    switch (format.codec) {
        case "opus":
            return OPUS_MAX_BYTES_PER_SECOND;
        case "flac":
            return pcmByteRate * FLAC_WORST_CASE_EXPANSION;
        default:
            return pcmByteRate;
    }
}
/**
 * Buffer capacity to advertise for a set of supported formats, in bytes.
 *
 * The server picks one of the advertised formats, so the capacity is sized for
 * the highest byte rate among them: enough for the full stream-ahead depth even
 * on incompressible FLAC without making bytes the binding limit before the
 * server's duration horizon.
 *
 * @param formats - Formats advertised in `client/hello`, as returned by `getSupportedFormats`
 */
function getDefaultBufferCapacity(formats) {
    const worstByteRate = Math.max(...formats.map(getWireByteRate));
    return Math.ceil(worstByteRate * BUFFER_DEPTH_SECONDS);
}

const SYNC_DELAY_MAX_MS = 5000;
function clampSyncDelayMs(delayMs) {
    if (!isFinite(delayMs))
        return 0;
    return Math.max(0, Math.min(SYNC_DELAY_MAX_MS, Math.round(delayMs)));
}

// Max bytes of not-yet-due visualizer frames the server may have in flight to us.
const VISUALIZER_BUFFER_CAPACITY = 256 * 1024;
// Constants
const STATE_UPDATE_INTERVAL = 5000; // 5 seconds
const DEFAULT_REQUIRED_LEAD_TIME_MS = 250;
const DEFAULT_MIN_BUFFER_MS = 250;
function assertBufferMs(value, name) {
    if (!isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative finite number`);
    }
}
class ProtocolHandler {
    constructor(sender, helloContext, streamHandler, stateManager, timeFilter, config = {}) {
        this.sender = sender;
        this.helloContext = helloContext;
        this.streamHandler = streamHandler;
        this.stateManager = stateManager;
        this.timeFilter = timeFilter;
        this.activated = false;
        this.activeRoles = null;
        this.pairingSuspended = false;
        // Last player payload sent to the current server connection, or null when no
        // full state has been sent yet. Cleared on (re)connect so the first send is
        // full again.
        this.lastSentPlayer = null;
        this.visualizerRequest = null;
        this.artworkRequest = null;
        this.clientName = config.clientName ?? "Sendspin Player";
        this.productName = config.productName;
        this.codecs = config.codecs ?? ["opus", "flac", "pcm"];
        // Left undefined so the capacity is derived from the formats actually
        // advertised in client/hello (see sendClientHello).
        this.bufferCapacity = config.bufferCapacity;
        this.requiredLeadTimeMs =
            config.requiredLeadTimeMs ?? DEFAULT_REQUIRED_LEAD_TIME_MS;
        assertBufferMs(this.requiredLeadTimeMs, "requiredLeadTimeMs");
        this.minBufferMs = config.minBufferMs ?? DEFAULT_MIN_BUFFER_MS;
        assertBufferMs(this.minBufferMs, "minBufferMs");
        this.useHardwareVolume = config.useHardwareVolume ?? false;
        this.onVolumeCommand = config.onVolumeCommand;
        this.onDelayCommand = config.onDelayCommand;
        this.getExternalVolume = config.getExternalVolume;
        this.timeSyncManager = new TimeSyncManager(sender, stateManager, timeFilter);
    }
    // Handle server messages
    handleServerMessage(message) {
        switch (message.type) {
            case "server/hello":
                this.handleServerHello();
                break;
            case "server/activate":
                this.handleServerActivate(message);
                break;
            case "server/time":
                this.timeSyncManager.handleServerTime(message);
                break;
            case "stream/start":
                this.handleStreamStart(message);
                break;
            case "stream/clear":
                this.handleStreamClear(message);
                break;
            case "stream/end":
                this.handleStreamEnd(message);
                break;
            case "server/command":
                this.handleServerCommand(message);
                break;
            case "server/state":
                this.stateManager.updateServerState(message.payload);
                break;
            case "group/update":
                this.stateManager.updateGroupState(message.payload);
                break;
        }
    }
    // Handle server hello: reply with client/hello. client/state and time-sync
    // are deferred to server/activate.
    handleServerHello() {
        console.log("Sendspin: Connected to server");
        this.sendClientHello();
    }
    // Handle server/activate: start the initial client/state, time-sync, and
    // periodic state updates. Guarded so a repeat activate is a no-op.
    handleServerActivate(message) {
        this.pairingSuspended = false;
        let rolesChanged = false;
        if (message.payload.active_roles !== undefined) {
            const nextRoles = new Set(message.payload.active_roles);
            rolesChanged =
                this.activeRoles === null ||
                    nextRoles.size !== this.activeRoles.size ||
                    [...nextRoles].some((role) => !this.activeRoles.has(role));
            this.activeRoles = nextRoles;
        }
        if (this.activated) {
            if (rolesChanged)
                this.sendStateUpdate();
            return;
        }
        this.activated = true;
        this.sendStateUpdate();
        this.timeSyncManager.startAndSchedule();
        const stateInterval = globalThis.setInterval(() => this.sendStateUpdate(), STATE_UPDATE_INTERVAL);
        this.stateManager.setStateUpdateInterval(stateInterval);
    }
    // Restart the periodic state update interval.
    // Called after volume commands to prevent a pending periodic update
    // from sending stale hardware volume shortly after the command response.
    restartStateUpdateInterval() {
        const newInterval = globalThis.setInterval(() => this.sendStateUpdate(), STATE_UPDATE_INTERVAL);
        this.stateManager.setStateUpdateInterval(newInterval);
    }
    stopTimeSync() {
        this.timeSyncManager.stop();
    }
    suspendForPairing() {
        this.pairingSuspended = true;
        this.activated = false;
        this.activeRoles = new Set();
        this.timeSyncManager.stop();
        this.stateManager.clearStateUpdateInterval();
    }
    /**
     * Clear the activate guard so the next server/activate (e.g. after a reconnect on a
     * reused handler) restarts time-sync and state updates.
     * @internal called by SendspinCore on transport close, not part of the public API.
     */
    resetActivation(preserveActiveRoles = false) {
        this.pairingSuspended = false;
        this.activated = false;
        if (!preserveActiveRoles)
            this.activeRoles = null;
        this.timeSyncManager.stop();
        this.stateManager.clearStateUpdateInterval();
    }
    handleStreamStart(message) {
        if (message.payload.visualizer) {
            this.streamHandler.handleVisualizerStreamStart(message.payload.visualizer);
        }
        if (message.payload.artwork) {
            this.streamHandler.handleArtworkStreamStart(message.payload.artwork);
        }
        const player = message.payload.player;
        if (!player)
            return;
        const isFormatUpdate = this.stateManager.currentStreamFormat !== null;
        this.stateManager.currentStreamFormat = player;
        console.log(isFormatUpdate
            ? "Sendspin: Stream format updated"
            : "Sendspin: Stream started", this.stateManager.currentStreamFormat);
        console.log(`Sendspin: Codec=${this.stateManager.currentStreamFormat.codec.toUpperCase()}, ` +
            `SampleRate=${this.stateManager.currentStreamFormat.sample_rate}Hz, ` +
            `Channels=${this.stateManager.currentStreamFormat.channels}, ` +
            `BitDepth=${this.stateManager.currentStreamFormat.bit_depth}bit`);
        this.streamHandler.handleStreamStart(this.stateManager.currentStreamFormat, isFormatUpdate);
        this.stateManager.isPlaying = true;
        // Explicitly set playbackState for Android (if mediaSession available)
        if (typeof navigator !== "undefined" && navigator.mediaSession) {
            navigator.mediaSession.playbackState = "playing";
        }
    }
    handleStreamClear(message) {
        const roles = message.payload.roles;
        if (!roles || roles.includes("visualizer")) {
            this.streamHandler.handleVisualizerStreamClear();
        }
        if (!roles || roles.includes("player")) {
            console.log("Sendspin: Stream clear (seek)");
            this.streamHandler.handleStreamClear();
        }
    }
    handleStreamEnd(message) {
        const roles = message.payload?.roles;
        if (!roles || roles.includes("visualizer")) {
            this.streamHandler.handleVisualizerStreamEnd();
        }
        if (!roles || roles.includes("artwork")) {
            this.streamHandler.handleArtworkStreamEnd();
        }
        if (!roles || roles.includes("player")) {
            console.log("Sendspin: Stream ended");
            this.streamHandler.handleStreamEnd();
            this.stateManager.currentStreamFormat = null;
            this.stateManager.isPlaying = false;
            if (typeof navigator !== "undefined" && navigator.mediaSession) {
                navigator.mediaSession.playbackState = "paused";
            }
            this.sendStateUpdate();
        }
    }
    // Handle server commands
    handleServerCommand(message) {
        const playerCommand = message.payload.player;
        if (!playerCommand)
            return;
        switch (playerCommand.command) {
            case "volume":
                // Set volume command
                if (playerCommand.volume !== undefined) {
                    this.stateManager.volume = playerCommand.volume;
                    this.streamHandler.handleVolumeUpdate();
                    // Notify external handler for hardware volume
                    if (this.useHardwareVolume && this.onVolumeCommand) {
                        this.onVolumeCommand(playerCommand.volume, this.stateManager.muted);
                    }
                }
                break;
            case "mute":
                // Mute/unmute command - uses boolean mute field
                if (playerCommand.mute !== undefined) {
                    this.stateManager.muted = playerCommand.mute;
                    this.streamHandler.handleVolumeUpdate();
                    // Notify external handler for hardware volume
                    if (this.useHardwareVolume && this.onVolumeCommand) {
                        this.onVolumeCommand(this.stateManager.volume, playerCommand.mute);
                    }
                }
                break;
            case "set_static_delay": {
                const delay = playerCommand.static_delay_ms;
                if (typeof delay === "number" && isFinite(delay)) {
                    const clamped = clampSyncDelayMs(delay);
                    this.streamHandler.handleSyncDelayChange(clamped);
                    this.onDelayCommand?.(clamped);
                }
                break;
            }
        }
        // Reset periodic timer first, then send state with commanded values.
        // Skip hardware read to avoid race where hardware hasn't applied the volume yet.
        this.restartStateUpdateInterval();
        this.sendStateUpdate(true);
    }
    // client_id and version live in client/init, not the hello.
    sendClientHello() {
        const supportedFormats = getSupportedFormats(this.codecs);
        const hello = {
            type: "client/hello",
            payload: {
                name: this.clientName,
                supported_roles: [
                    "player@v1",
                    "controller@v1",
                    "metadata@v1",
                    ...(this.visualizerRequest ? ["visualizer@v1"] : []),
                    ...(this.artworkRequest ? ["artwork@v1"] : []),
                    "color@v1",
                ],
                trust_level: this.helloContext.trustLevel(),
                supported_pair_methods: this.helloContext.pairMethods(),
                unpaired_access: { enabled: this.helloContext.unpairedAccess },
                device_info: {
                    product_name: this.productName,
                    manufacturer: (typeof navigator !== "undefined" && navigator.vendor) || "Unknown",
                    software_version: (typeof navigator !== "undefined" && navigator.userAgent) ||
                        "Unknown",
                },
                "player@v1_support": {
                    supported_formats: supportedFormats,
                    buffer_capacity: this.bufferCapacity ?? getDefaultBufferCapacity(supportedFormats),
                    supported_commands: ["volume", "mute"],
                },
                ...(this.visualizerRequest
                    ? {
                        // buffer_capacity is the spec field; the stream configuration is repeated here
                        // for servers (aiosendspin <= 9.1.x) that still read it from the hello.
                        "visualizer@v1_support": {
                            buffer_capacity: VISUALIZER_BUFFER_CAPACITY,
                            ...this.visualizerRequest,
                        },
                    }
                    : {}),
                ...(this.artworkRequest
                    ? {
                        // Not in the current spec (the channels moved to client/state), but servers on
                        // aiosendspin <= 9.1.x require it whenever artwork@v1 is listed, under these names.
                        "artwork@v1_support": {
                            channels: this.artworkRequest.channels.map((c) => ({
                                source: c.source,
                                format: c.format ?? "jpeg",
                                media_width: c.width ?? 1,
                                media_height: c.height ?? 1,
                            })),
                        },
                    }
                    : {}),
            },
        };
        // Reset so the first client/state after connect is a full snapshot.
        this.lastSentPlayer = null;
        this.sender.sendControl(hello);
    }
    setRequiredLeadTimeMs(leadTimeMs) {
        assertBufferMs(leadTimeMs, "requiredLeadTimeMs");
        this.requiredLeadTimeMs = leadTimeMs;
        this.sendStateUpdate();
    }
    setMinBufferMs(minBufferMs) {
        assertBufferMs(minBufferMs, "minBufferMs");
        this.minBufferMs = minBufferMs;
        this.sendStateUpdate();
    }
    // Send state update. The first send after a (re)connect is a full snapshot;
    // later sends are deltas carrying only changed fields, which the server merges.
    // When skipHardwareRead is true, use stateManager values instead of reading from hardware.
    // This avoids race conditions when responding to volume commands.
    sendStateUpdate(skipHardwareRead = false) {
        if (this.pairingSuspended)
            return;
        let volume = this.stateManager.volume;
        let muted = this.stateManager.muted;
        if (!skipHardwareRead && this.useHardwareVolume && this.getExternalVolume) {
            const externalVol = this.getExternalVolume();
            volume = externalVol.volume;
            muted = externalVol.muted;
        }
        const syncDelayMs = this.streamHandler.getSyncDelayMs();
        const staticDelayMs = clampSyncDelayMs(syncDelayMs);
        const payload = {
            available: true,
        };
        if (this.activeRoles === null || this.activeRoles.has("player@v1")) {
            const current = {
                volume,
                muted,
                static_delay_ms: staticDelayMs,
                required_lead_time_ms: this.requiredLeadTimeMs,
                min_buffer_ms: this.minBufferMs,
            };
            const last = this.lastSentPlayer;
            if (last === null) {
                // Full state: every field plus the static supported_commands.
                payload.player = {
                    ...current,
                    supported_commands: ["set_static_delay"],
                };
            }
            else {
                // Delta: only changed fields.
                const player = {};
                if (current.static_delay_ms !== last.static_delay_ms)
                    player.static_delay_ms = current.static_delay_ms;
                if (current.volume !== last.volume)
                    player.volume = current.volume;
                if (current.muted !== last.muted)
                    player.muted = current.muted;
                if (current.required_lead_time_ms !== last.required_lead_time_ms)
                    player.required_lead_time_ms = current.required_lead_time_ms;
                if (current.min_buffer_ms !== last.min_buffer_ms)
                    player.min_buffer_ms = current.min_buffer_ms;
                payload.player = player;
            }
            this.lastSentPlayer = current;
        }
        if (this.visualizerRequest &&
            (this.activeRoles === null || this.activeRoles.has("visualizer@v1"))) {
            payload.visualizer = this.visualizerRequest;
        }
        if (this.artworkRequest &&
            (this.activeRoles === null || this.activeRoles.has("artwork@v1"))) {
            payload.artwork = this.artworkRequest;
        }
        const message = {
            type: "client/state",
            payload,
        };
        this.sender.sendControl(message);
    }
    /** Set (or clear with null) the artwork request: advertised in client/hello, re-sent on the next client/state. */
    setArtworkRequest(request) {
        this.artworkRequest = request;
        if (this.activated)
            this.sendStateUpdate();
    }
    /** Set (or clear with null) the visualizer request; re-sent on the next client/state. */
    setVisualizerRequest(request) {
        this.visualizerRequest = request;
        if (this.activated)
            this.sendStateUpdate();
    }
    // Send goodbye message before disconnecting
    sendGoodbye(reason) {
        this.sender.sendControl({
            type: "client/goodbye",
            payload: {
                reason,
            },
        });
    }
    // Send controller command to server
    sendCommand(command, params) {
        if (this.pairingSuspended || !this.activeRoles?.has("controller@v1"))
            return;
        this.sender.sendControl({
            type: "client/command",
            payload: {
                controller: {
                    command,
                    ...params,
                },
            },
        });
    }
}

/**
 * Apply a diff to an object, returning a new copy.
 * - Fields from diff are merged into the copy
 * - null values delete the key from the result
 * - Nested objects are merged recursively (one level deep)
 */
function applyDiff(existing, diff) {
    const result = { ...existing };
    for (const key of Object.keys(diff)) {
        const value = diff[key];
        if (value === null) {
            delete result[key];
        }
        else if (value !== undefined) {
            // If both existing and new value are plain objects, merge recursively
            const existingValue = result[key];
            if (typeof value === "object" &&
                !Array.isArray(value) &&
                typeof existingValue === "object" &&
                existingValue !== null &&
                !Array.isArray(existingValue)) {
                result[key] = applyDiff(existingValue, value);
            }
            else {
                result[key] = value;
            }
        }
    }
    return result;
}
class StateManager {
    constructor(onStateChange) {
        this._volume = 100;
        this._muted = false;
        this._playerState = "synchronized";
        this._isPlaying = false;
        this._currentStreamFormat = null;
        this._streamStartServerTime = 0;
        this._streamStartAudioTime = 0;
        this._streamGeneration = 0;
        // Cached server state (from server/state messages)
        this._serverState = {};
        // Cached group state (from group/update messages)
        this._groupState = {};
        // Interval references for cleanup
        this.timeSyncInterval = null;
        this.stateUpdateInterval = null;
        this.onStateChangeCallback = onStateChange;
    }
    // Volume & Mute
    get volume() {
        return this._volume;
    }
    set volume(value) {
        this._volume = Math.max(0, Math.min(100, value));
        this.notifyStateChange();
    }
    get muted() {
        return this._muted;
    }
    set muted(value) {
        this._muted = value;
        this.notifyStateChange();
    }
    // Player State
    get playerState() {
        return this._playerState;
    }
    set playerState(value) {
        this._playerState = value;
        this.notifyStateChange();
    }
    // Playing State
    get isPlaying() {
        return this._isPlaying;
    }
    set isPlaying(value) {
        this._isPlaying = value;
        this.notifyStateChange();
    }
    // Stream Format
    get currentStreamFormat() {
        return this._currentStreamFormat;
    }
    set currentStreamFormat(value) {
        this._currentStreamFormat = value;
    }
    // Stream Anchoring (for timestamp-based scheduling)
    get streamStartServerTime() {
        return this._streamStartServerTime;
    }
    set streamStartServerTime(value) {
        this._streamStartServerTime = value;
    }
    get streamStartAudioTime() {
        return this._streamStartAudioTime;
    }
    set streamStartAudioTime(value) {
        this._streamStartAudioTime = value;
    }
    // Reset stream anchors (called on stream start)
    resetStreamAnchors() {
        this._streamStartServerTime = 0;
        this._streamStartAudioTime = 0;
        this._streamGeneration++;
    }
    // Get current stream generation
    get streamGeneration() {
        return this._streamGeneration;
    }
    // Interval management
    setTimeSyncInterval(interval) {
        this.clearTimeSyncInterval();
        this.timeSyncInterval = interval;
    }
    clearTimeSyncInterval() {
        if (this.timeSyncInterval !== null) {
            clearTimeout(this.timeSyncInterval);
            this.timeSyncInterval = null;
        }
    }
    setStateUpdateInterval(interval) {
        this.clearStateUpdateInterval();
        this.stateUpdateInterval = interval;
    }
    clearStateUpdateInterval() {
        if (this.stateUpdateInterval !== null) {
            clearInterval(this.stateUpdateInterval);
            this.stateUpdateInterval = null;
        }
    }
    clearAllIntervals() {
        this.clearTimeSyncInterval();
        this.clearStateUpdateInterval();
    }
    // Reset all state (called on disconnect)
    reset() {
        this._volume = 100;
        this._muted = false;
        this._playerState = "synchronized";
        this._isPlaying = false;
        this._currentStreamFormat = null;
        this._streamStartServerTime = 0;
        this._streamStartAudioTime = 0;
        this._serverState = {};
        this._groupState = {};
        this.clearAllIntervals();
    }
    // Notify callback of state changes
    notifyStateChange() {
        if (this.onStateChangeCallback) {
            this.onStateChangeCallback({
                isPlaying: this._isPlaying,
                volume: this._volume,
                muted: this._muted,
                playerState: this._playerState,
                serverState: this._serverState,
                groupState: this._groupState,
            });
        }
    }
    // Update server state (merges delta, null clears fields)
    updateServerState(update) {
        this._serverState = applyDiff(this._serverState, update);
        this.notifyStateChange();
    }
    // Update group state (merges delta, null clears fields)
    updateGroupState(update) {
        this._groupState = applyDiff(this._groupState, update);
        this.notifyStateChange();
    }
    // Getters for cached state
    get serverState() {
        return this._serverState;
    }
    get groupState() {
        return this._groupState;
    }
}

class WebSocketManager {
    constructor(config) {
        this.ws = null;
        this.reconnectTimeout = null;
        this.shouldReconnect = false;
        this.isReconnecting = false;
        this.reconnectAttempt = 0;
        this.baseDelayMs = Math.max(0, config?.baseDelayMs ?? 1000);
        this.maxDelayMs = Math.max(this.baseDelayMs, config?.maxDelayMs ?? 15000);
        this.maxAttempts =
            config?.maxAttempts === undefined
                ? Infinity
                : Math.max(0, config.maxAttempts);
        this.onReconnecting = config?.onReconnecting;
        this.onReconnected = config?.onReconnected;
        this.onExhausted = config?.onExhausted;
    }
    /**
     * Adopt an existing WebSocket connection.
     * The caller is responsible for having already opened the socket.
     * Reconnection is disabled for adopted sockets.
     *
     * Returns a Promise that resolves once the adopted socket is open. Throws
     * synchronously if the socket is already CLOSING or CLOSED.
     */
    adopt(ws, onOpen, onMessage, onError, onClose) {
        if (ws.readyState !== WebSocket.OPEN &&
            ws.readyState !== WebSocket.CONNECTING) {
            throw new Error(`Sendspin: Cannot adopt WebSocket in readyState ${ws.readyState} (must be OPEN or CONNECTING)`);
        }
        // Store handlers
        this.onOpenHandler = onOpen;
        this.onMessageHandler = onMessage;
        this.onErrorHandler = onError;
        this.onCloseHandler = onClose;
        // Detach handlers from any existing socket so its async close event
        // cannot fire into the newly-adopted session.
        if (this.ws) {
            const old = this.ws;
            old.onopen = null;
            old.onmessage = null;
            old.onerror = null;
            old.onclose = null;
            old.close();
            this.ws = null;
        }
        this.ws = ws;
        this.ws.binaryType = "arraybuffer";
        // No auto-reconnect for externally-managed sockets
        this.shouldReconnect = false;
        this.clearReconnectState();
        this.ws.onmessage = (event) => {
            if (this.onMessageHandler) {
                this.onMessageHandler(event);
            }
        };
        this.ws.onerror = (error) => {
            console.error("Sendspin: WebSocket error", error);
            if (this.onErrorHandler) {
                this.onErrorHandler(error);
            }
        };
        this.ws.onclose = () => {
            console.log("Sendspin: WebSocket disconnected");
            if (this.onCloseHandler) {
                this.onCloseHandler();
            }
        };
        return new Promise((resolve, reject) => {
            const fireOpen = () => {
                if (this.onOpenHandler) {
                    this.onOpenHandler();
                }
                resolve();
            };
            if (ws.readyState === WebSocket.OPEN) {
                console.log("Sendspin: Adopted open WebSocket");
                fireOpen();
                return;
            }
            // CONNECTING: wait for open or early close.
            const prevOnClose = this.ws.onclose;
            this.ws.onopen = () => {
                console.log("Sendspin: Adopted WebSocket connected");
                fireOpen();
            };
            this.ws.onclose = (event) => {
                if (prevOnClose) {
                    prevOnClose.call(this.ws, event);
                }
                reject(new Error("Sendspin: Adopted WebSocket closed before opening"));
            };
        });
    }
    // Connect to WebSocket server
    async connect(url, onOpen, onMessage, onError, onClose) {
        // Store handlers
        this.onOpenHandler = onOpen;
        this.onMessageHandler = onMessage;
        this.onErrorHandler = onError;
        this.onCloseHandler = onClose;
        // Detach the old socket before replacing it: its async onclose would
        // otherwise re-enter scheduleReconnect once openSocket re-arms retry.
        this.shouldReconnect = false;
        this.clearReconnectState();
        if (this.ws) {
            const old = this.ws;
            old.onopen = null;
            old.onmessage = null;
            old.onerror = null;
            old.onclose = null;
            old.close();
            this.ws = null;
        }
        return this.openSocket(url);
    }
    openSocket(url) {
        return new Promise((resolve, reject) => {
            try {
                console.log("Sendspin: Connecting to", url);
                this.ws = new WebSocket(url);
                this.ws.binaryType = "arraybuffer";
                this.shouldReconnect = true;
                // Browsers fire close even for attempts that never opened.
                let opened = false;
                this.ws.onopen = () => {
                    console.log("Sendspin: WebSocket connected");
                    opened = true;
                    const wasReconnecting = this.isReconnecting;
                    this.isReconnecting = false;
                    this.reconnectAttempt = 0;
                    if (this.onOpenHandler) {
                        this.onOpenHandler();
                    }
                    if (wasReconnecting) {
                        this.onReconnected?.();
                    }
                    resolve();
                };
                this.ws.onmessage = (event) => {
                    if (this.onMessageHandler) {
                        this.onMessageHandler(event);
                    }
                };
                this.ws.onerror = (error) => {
                    console.error("Sendspin: WebSocket error", error);
                    if (this.onErrorHandler) {
                        this.onErrorHandler(error);
                    }
                    reject(error);
                };
                this.ws.onclose = () => {
                    console.log("Sendspin: WebSocket disconnected");
                    if (opened && this.onCloseHandler) {
                        this.onCloseHandler();
                    }
                    // Try to reconnect after a delay if we should reconnect
                    if (this.shouldReconnect) {
                        this.scheduleReconnect(url);
                    }
                };
            }
            catch (error) {
                console.error("Sendspin: Failed to connect", error);
                reject(error);
            }
        });
    }
    getReconnectDelayMs(attempt) {
        const exponential = this.baseDelayMs * 2 ** (attempt - 1);
        return Math.min(exponential, this.maxDelayMs);
    }
    // Schedule reconnection attempt
    scheduleReconnect(url) {
        if (this.reconnectTimeout !== null) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        const attempt = this.reconnectAttempt + 1;
        if (attempt > this.maxAttempts) {
            console.warn(`Sendspin: Reconnect exhausted after ${this.maxAttempts} attempt(s)`);
            this.shouldReconnect = false;
            this.isReconnecting = false;
            this.reconnectAttempt = 0;
            this.onExhausted?.();
            return;
        }
        this.reconnectAttempt = attempt;
        this.isReconnecting = true;
        const delayMs = this.getReconnectDelayMs(attempt);
        this.reconnectTimeout = globalThis.setTimeout(() => {
            this.reconnectTimeout = null;
            if (!this.shouldReconnect) {
                return;
            }
            this.onReconnecting?.(attempt);
            console.log(`Sendspin: Attempting to reconnect (attempt ${attempt}${this.maxAttempts === Infinity ? "" : `/${this.maxAttempts}`})...`);
            this.openSocket(url).catch((error) => {
                console.error("Sendspin: Reconnection failed", error);
            });
        }, delayMs);
    }
    clearReconnectState() {
        if (this.reconnectTimeout !== null) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.isReconnecting = false;
        this.reconnectAttempt = 0;
    }
    // Disconnect from WebSocket server
    disconnect() {
        this.shouldReconnect = false;
        this.clearReconnectState();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    // Send a cleartext text frame (handshake only).
    sendText(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data);
        }
        else {
            console.warn("Sendspin: Cannot send text, WebSocket not connected");
        }
    }
    // Send a binary frame (Noise transport ciphertext).
    sendBinary(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // TS types Uint8Array as ArrayBufferLike, DOM lib wants ArrayBuffer.
            this.ws.send(data);
        }
        else {
            console.warn("Sendspin: Cannot send binary, WebSocket not connected");
        }
    }
    // Check if WebSocket is connected
    isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
    // Get current ready state
    getReadyState() {
        return this.ws ? this.ws.readyState : WebSocket.CLOSED;
    }
}

/**
 * Two-dimensional Kalman filter for NTP-style time synchronization.
 *
 * This class implements a time synchronization filter that tracks both the timestamp
 * offset and clock drift rate between a client and server. It processes measurements
 * obtained with NTP-style time messages that contain round-trip timing information to
 * optimally estimate the time relationship while accounting for network latency
 * uncertainty.
 *
 * The filter maintains a 2D state vector [offset, drift] with associated covariance
 * matrix to track estimation uncertainty. An adaptive forgetting factor helps the
 * filter recover quickly from network disruptions or server clock adjustments.
 *
 * Direct port of the Python implementation from aiosendspin.
 */
// Residual threshold as fraction of max_error for triggering adaptive forgetting.
// When residual > CUTOFF * max_error, the filter applies forgetting to recover from outliers.
const ADAPTIVE_FORGETTING_CUTOFF = 2.0;
class SendspinTimeFilter {
    constructor(offset_process_std_dev = 0.01, forget_factor = 1.1, drift_significance_threshold = 2.0, drift_process_std_dev = 0.0) {
        this._last_update = 0;
        // Maturity gate for the state machine and adaptive forgetting, caps at 100.
        this._count = 0;
        this._measurements_processed = 0;
        this._offset = 0.0;
        this._drift = 0.0;
        this._offset_covariance = Infinity;
        this._offset_drift_covariance = 0.0;
        this._drift_covariance = 0.0;
        this._use_drift = false;
        this._offset_process_variance =
            offset_process_std_dev * offset_process_std_dev;
        this._drift_process_variance =
            drift_process_std_dev * drift_process_std_dev;
        this._forget_variance_factor = forget_factor * forget_factor;
        this._drift_significance_threshold_squared =
            drift_significance_threshold * drift_significance_threshold;
        this._current_time_element = this._createDefaultTimeElement();
    }
    /**
     * Create a default TimeElement with zero values.
     * Single source of truth for default initialization.
     */
    _createDefaultTimeElement() {
        return {
            last_update: 0,
            offset: 0.0,
            drift: 0.0,
        };
    }
    /**
     * Process a new time synchronization measurement through the Kalman filter.
     *
     * Updates the filter's offset and drift estimates using a two-stage Kalman filter
     * algorithm: predict based on the drift model then correct using the new
     * measurement. The measurement uncertainty is derived from the network round-trip
     * delay.
     *
     * @param measurement - Computed offset from NTP-style exchange: ((T2-T1)+(T3-T4))/2 in microseconds
     * @param max_error - Half the round-trip delay: ((T4-T1)-(T3-T2))/2, representing maximum measurement uncertainty in microseconds
     * @param time_added - Client timestamp when this measurement was taken in microseconds
     */
    update(measurement, max_error, time_added) {
        if (time_added <= this._last_update) {
            // Skip non-monotonic timestamps. dt == 0 divides by zero in the drift
            // calc, dt < 0 corrupts the predict step.
            return;
        }
        const dt = time_added - this._last_update;
        this._last_update = time_added;
        this._measurements_processed += 1;
        const update_std_dev = max_error;
        const measurement_variance = update_std_dev * update_std_dev;
        // Filter initialization: First measurement establishes offset baseline
        if (this._count <= 0) {
            this._count += 1;
            this._offset = measurement;
            this._offset_covariance = measurement_variance;
            this._drift = 0.0; // No drift information available yet
            this._current_time_element = {
                last_update: this._last_update,
                offset: this._offset,
                drift: this._drift,
            };
            this._use_drift = false;
            return;
        }
        // Second measurement: Initial drift estimation from finite differences
        if (this._count === 1) {
            this._count += 1;
            this._drift = (measurement - this._offset) / dt;
            this._offset = measurement;
            // Drift variance estimated from propagation of offset uncertainties
            this._drift_covariance =
                (this._offset_covariance + measurement_variance) / (dt * dt);
            this._offset_covariance = measurement_variance;
            this._current_time_element = {
                last_update: this._last_update,
                offset: this._offset,
                drift: this._drift,
            };
            this._use_drift = false;
            return;
        }
        /// Kalman Prediction Step ///
        // State prediction: x_k|k-1 = F * x_k-1|k-1
        const offset = this._offset + this._drift * dt;
        // Covariance prediction: P_k|k-1 = F * P_k-1|k-1 * F^T + Q
        // State transition matrix F = [1, dt; 0, 1]
        const dt_squared = dt * dt;
        // Process noise models uncertainty growth in both offset and drift random walks.
        const drift_process_variance = dt * this._drift_process_variance;
        let new_drift_covariance = this._drift_covariance + drift_process_variance;
        const offset_drift_process_variance = 0.0;
        let new_offset_drift_covariance = this._offset_drift_covariance +
            this._drift_covariance * dt +
            offset_drift_process_variance;
        const offset_process_variance = dt * this._offset_process_variance;
        let new_offset_covariance = this._offset_covariance +
            2 * this._offset_drift_covariance * dt +
            this._drift_covariance * dt_squared +
            offset_process_variance;
        /// Innovation and Adaptive Forgetting ///
        const residual = measurement - offset; // Innovation: y_k = z_k - H * x_k|k-1
        const max_residual_cutoff = max_error * ADAPTIVE_FORGETTING_CUTOFF;
        if (this._count < 100) {
            // Build sufficient history before enabling adaptive forgetting
            this._count += 1;
        }
        else if (Math.abs(residual) > max_residual_cutoff) {
            // Large prediction error detected - likely network disruption or clock adjustment
            // Apply forgetting factor to increase Kalman gain and accelerate convergence
            new_drift_covariance *= this._forget_variance_factor;
            new_offset_drift_covariance *= this._forget_variance_factor;
            new_offset_covariance *= this._forget_variance_factor;
        }
        /// Kalman Update Step ///
        // Innovation covariance: S = H * P * H^T + R, where H = [1, 0]
        const uncertainty = 1.0 / (new_offset_covariance + measurement_variance);
        // Kalman gain: K = P * H^T * S^(-1)
        const offset_gain = new_offset_covariance * uncertainty;
        const drift_gain = new_offset_drift_covariance * uncertainty;
        // State update: x_k|k = x_k|k-1 + K * y_k
        this._offset = offset + offset_gain * residual;
        this._drift += drift_gain * residual;
        // Covariance update: P_k|k = (I - K*H) * P_k|k-1
        // Using simplified form to ensure numerical stability
        this._drift_covariance =
            new_drift_covariance - drift_gain * new_offset_drift_covariance;
        this._offset_drift_covariance =
            new_offset_drift_covariance - drift_gain * new_offset_covariance;
        this._offset_covariance =
            new_offset_covariance - offset_gain * new_offset_covariance;
        // Drift compensation is enabled only when the estimate is statistically significant.
        const drift_squared = this._drift * this._drift;
        this._use_drift =
            drift_squared >
                this._drift_significance_threshold_squared * this._drift_covariance;
        this._current_time_element = {
            last_update: this._last_update,
            offset: this._offset,
            drift: this._drift,
        };
    }
    /**
     * Convert a client timestamp to the equivalent server timestamp.
     *
     * Applies the current offset and drift compensation to transform from client time
     * domain to server time domain. The transformation accounts for both static offset
     * and dynamic drift accumulated since the last filter update.
     *
     * @param client_time - Client timestamp in microseconds
     * @returns Equivalent server timestamp in microseconds
     */
    computeServerTime(client_time) {
        // Transform: T_server = T_client + offset + drift * (T_client - T_last_update)
        // Compute instantaneous offset accounting for linear drift:
        // offset(t) = offset_base + drift * (t - t_last_update)
        const dt = client_time - this._current_time_element.last_update;
        const effective_drift = this._use_drift
            ? this._current_time_element.drift
            : 0.0;
        const offset = Math.round(this._current_time_element.offset + effective_drift * dt);
        return client_time + offset;
    }
    /**
     * Convert a server timestamp to the equivalent client timestamp.
     *
     * Inverts the time transformation to convert from server time domain to client
     * time domain. Accounts for both offset and drift effects in the inverse
     * transformation.
     *
     * @param server_time - Server timestamp in microseconds
     * @returns Equivalent client timestamp in microseconds
     */
    computeClientTime(server_time) {
        // Inverse transform solving for T_client:
        // T_server = T_client + offset + drift * (T_client - T_last_update)
        // T_server = (1 + drift) * T_client + offset - drift * T_last_update
        // T_client = (T_server - offset + drift * T_last_update) / (1 + drift)
        const effective_drift = this._use_drift
            ? this._current_time_element.drift
            : 0.0;
        return Math.round((server_time -
            this._current_time_element.offset +
            effective_drift * this._current_time_element.last_update) /
            (1.0 + effective_drift));
    }
    /**
     * Reset the filter state.
     */
    reset() {
        this._count = 0;
        this._measurements_processed = 0;
        this._last_update = 0;
        this._offset = 0.0;
        this._drift = 0.0;
        this._offset_covariance = Infinity;
        this._offset_drift_covariance = 0.0;
        this._drift_covariance = 0.0;
        this._use_drift = false;
        this._current_time_element = this._createDefaultTimeElement();
    }
    /**
     * Get the number of time sync measurements processed.
     */
    get count() {
        return this._measurements_processed;
    }
    /**
     * Check if time synchronization is ready for use.
     *
     * Time sync is considered ready when at least 1 measurement has been
     * collected and the offset covariance is finite (not infinite).
     */
    get is_synchronized() {
        return this._count >= 1 && isFinite(this._offset_covariance);
    }
    /**
     * Get the standard deviation estimate in microseconds.
     */
    get error() {
        return Math.round(Math.sqrt(this._offset_covariance));
    }
    /**
     * Get the covariance (variance) estimate for the offset.
     */
    get covariance() {
        return Math.round(this._offset_covariance);
    }
    /**
     * Get the current filtered offset estimate in microseconds.
     */
    get offset() {
        return this._offset;
    }
    /**
     * Get the current clock drift rate estimate.
     * Returns the drift as a ratio (e.g., 0.04 means server clock is 4% faster).
     */
    get drift() {
        return this._drift;
    }
}

/**
 * Persists the server-commanded static delay so it survives reboots and
 * reconnections, as the spec requires.
 */
// Ignore delays saved before fixed scheduling headroom was removed (#159).
const STATIC_DELAY_STORAGE_KEY = "sendspin-static-delay-ms-v2";
class StaticDelayStore {
    constructor(storage) {
        this.storage = storage;
    }
    load() {
        if (!this.storage)
            return null;
        try {
            const stored = this.storage.getItem(STATIC_DELAY_STORAGE_KEY);
            if (stored === null)
                return null;
            const value = parseFloat(stored);
            if (isNaN(value))
                return null;
            return clampSyncDelayMs(value);
        }
        catch {
            return null;
        }
    }
    save(delayMs) {
        if (!this.storage)
            return;
        try {
            this.storage.setItem(STATIC_DELAY_STORAGE_KEY, delayMs.toString());
        }
        catch {
            // ignore
        }
    }
}

const crypto$1 = typeof globalThis === 'object' && 'crypto' in globalThis ? globalThis.crypto : undefined;

/**
 * Utilities for hex, bytes, CSPRNG.
 * @module
 */
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// We use WebCrypto aka globalThis.crypto, which exists in browsers and node.js 16+.
// node.js versions earlier than v19 don't declare it in global scope.
// For node.js, package.json#exports field mapping rewrites import
// from `crypto` to `cryptoNode`, which imports native module.
// Makes the utils un-importable in browsers without a bundler.
// Once node.js 18 is deprecated (2025-04-30), we can just drop the import.
/** Checks if something is Uint8Array. Be careful: nodejs Buffer will return true. */
function isBytes$1(a) {
    return a instanceof Uint8Array || (ArrayBuffer.isView(a) && a.constructor.name === 'Uint8Array');
}
/** Asserts something is positive integer. */
function anumber$1(n) {
    if (!Number.isSafeInteger(n) || n < 0)
        throw new Error('positive integer expected, got ' + n);
}
/** Asserts something is Uint8Array. */
function abytes$1(b, ...lengths) {
    if (!isBytes$1(b))
        throw new Error('Uint8Array expected');
    if (lengths.length > 0 && !lengths.includes(b.length))
        throw new Error('Uint8Array expected of length ' + lengths + ', got length=' + b.length);
}
/** Asserts something is hash */
function ahash(h) {
    if (typeof h !== 'function' || typeof h.create !== 'function')
        throw new Error('Hash should be wrapped by utils.createHasher');
    anumber$1(h.outputLen);
    anumber$1(h.blockLen);
}
/** Asserts a hash instance has not been destroyed / finished */
function aexists$1(instance, checkFinished = true) {
    if (instance.destroyed)
        throw new Error('Hash instance has been destroyed');
    if (checkFinished && instance.finished)
        throw new Error('Hash#digest() has already been called');
}
/** Asserts output is properly-sized byte array */
function aoutput$1(out, instance) {
    abytes$1(out);
    const min = instance.outputLen;
    if (out.length < min) {
        throw new Error('digestInto() expects output buffer of length at least ' + min);
    }
}
/** Zeroize a byte array. Warning: JS provides no guarantees. */
function clean$1(...arrays) {
    for (let i = 0; i < arrays.length; i++) {
        arrays[i].fill(0);
    }
}
/** Create DataView of an array for easy byte-level manipulation. */
function createView$1(arr) {
    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
/** The rotate right (circular right shift) operation for uint32 */
function rotr(word, shift) {
    return (word << (32 - shift)) | (word >>> shift);
}
// Built-in hex conversion https://caniuse.com/mdn-javascript_builtins_uint8array_fromhex
const hasHexBuiltin = /* @__PURE__ */ (() => 
// @ts-ignore
typeof Uint8Array.from([]).toHex === 'function' && typeof Uint8Array.fromHex === 'function')();
// Array where index 0xf0 (240) is mapped to string 'f0'
const hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
/**
 * Convert byte array to hex string. Uses built-in function, when available.
 * @example bytesToHex(Uint8Array.from([0xca, 0xfe, 0x01, 0x23])) // 'cafe0123'
 */
function bytesToHex(bytes) {
    abytes$1(bytes);
    // @ts-ignore
    if (hasHexBuiltin)
        return bytes.toHex();
    // pre-caching improves the speed 6x
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += hexes[bytes[i]];
    }
    return hex;
}
// We use optimized technique to convert hex string to byte array
const asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
    if (ch >= asciis._0 && ch <= asciis._9)
        return ch - asciis._0; // '2' => 50-48
    if (ch >= asciis.A && ch <= asciis.F)
        return ch - (asciis.A - 10); // 'B' => 66-(65-10)
    if (ch >= asciis.a && ch <= asciis.f)
        return ch - (asciis.a - 10); // 'b' => 98-(97-10)
    return;
}
/**
 * Convert hex string to byte array. Uses built-in function, when available.
 * @example hexToBytes('cafe0123') // Uint8Array.from([0xca, 0xfe, 0x01, 0x23])
 */
function hexToBytes(hex) {
    if (typeof hex !== 'string')
        throw new Error('hex string expected, got ' + typeof hex);
    // @ts-ignore
    if (hasHexBuiltin)
        return Uint8Array.fromHex(hex);
    const hl = hex.length;
    const al = hl / 2;
    if (hl % 2)
        throw new Error('hex string expected, got unpadded hex of length ' + hl);
    const array = new Uint8Array(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
        const n1 = asciiToBase16(hex.charCodeAt(hi));
        const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
        if (n1 === undefined || n2 === undefined) {
            const char = hex[hi] + hex[hi + 1];
            throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
        }
        array[ai] = n1 * 16 + n2; // multiply first octet, e.g. 'a3' => 10*16+3 => 160 + 3 => 163
    }
    return array;
}
/**
 * Converts string to bytes using UTF8 encoding.
 * @example utf8ToBytes('abc') // Uint8Array.from([97, 98, 99])
 */
function utf8ToBytes$1(str) {
    if (typeof str !== 'string')
        throw new Error('string expected');
    return new Uint8Array(new TextEncoder().encode(str)); // https://bugzil.la/1681809
}
/**
 * Normalizes (non-hex) string or Uint8Array to Uint8Array.
 * Warning: when Uint8Array is passed, it would NOT get copied.
 * Keep in mind for future mutable operations.
 */
function toBytes$1(data) {
    if (typeof data === 'string')
        data = utf8ToBytes$1(data);
    abytes$1(data);
    return data;
}
/** For runtime check if class implements interface */
class Hash {
}
/** Wraps hash function, creating an interface on top of it */
function createHasher(hashCons) {
    const hashC = (msg) => hashCons().update(toBytes$1(msg)).digest();
    const tmp = hashCons();
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = () => hashCons();
    return hashC;
}
/** Cryptographically secure PRNG. Uses internal OS-level `crypto.getRandomValues`. */
function randomBytes(bytesLength = 32) {
    if (crypto$1 && typeof crypto$1.getRandomValues === 'function') {
        return crypto$1.getRandomValues(new Uint8Array(bytesLength));
    }
    // Legacy Node.js compatibility
    if (crypto$1 && typeof crypto$1.randomBytes === 'function') {
        return Uint8Array.from(crypto$1.randomBytes(bytesLength));
    }
    throw new Error('crypto.getRandomValues must be defined');
}

/**
 * Internal Merkle-Damgard hash utils.
 * @module
 */
/** Polyfill for Safari 14. https://caniuse.com/mdn-javascript_builtins_dataview_setbiguint64 */
function setBigUint64$1(view, byteOffset, value, isLE) {
    if (typeof view.setBigUint64 === 'function')
        return view.setBigUint64(byteOffset, value, isLE);
    const _32n = BigInt(32);
    const _u32_max = BigInt(0xffffffff);
    const wh = Number((value >> _32n) & _u32_max);
    const wl = Number(value & _u32_max);
    const h = isLE ? 4 : 0;
    const l = isLE ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE);
    view.setUint32(byteOffset + l, wl, isLE);
}
/** Choice: a ? b : c */
function Chi(a, b, c) {
    return (a & b) ^ (~a & c);
}
/** Majority function, true if any two inputs is true. */
function Maj(a, b, c) {
    return (a & b) ^ (a & c) ^ (b & c);
}
/**
 * Merkle-Damgard hash construction base class.
 * Could be used to create MD5, RIPEMD, SHA1, SHA2.
 */
class HashMD extends Hash {
    constructor(blockLen, outputLen, padOffset, isLE) {
        super();
        this.finished = false;
        this.length = 0;
        this.pos = 0;
        this.destroyed = false;
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE;
        this.buffer = new Uint8Array(blockLen);
        this.view = createView$1(this.buffer);
    }
    update(data) {
        aexists$1(this);
        data = toBytes$1(data);
        abytes$1(data);
        const { view, buffer, blockLen } = this;
        const len = data.length;
        for (let pos = 0; pos < len;) {
            const take = Math.min(blockLen - this.pos, len - pos);
            // Fast path: we have at least one block in input, cast it to view and process
            if (take === blockLen) {
                const dataView = createView$1(data);
                for (; blockLen <= len - pos; pos += blockLen)
                    this.process(dataView, pos);
                continue;
            }
            buffer.set(data.subarray(pos, pos + take), this.pos);
            this.pos += take;
            pos += take;
            if (this.pos === blockLen) {
                this.process(view, 0);
                this.pos = 0;
            }
        }
        this.length += data.length;
        this.roundClean();
        return this;
    }
    digestInto(out) {
        aexists$1(this);
        aoutput$1(out, this);
        this.finished = true;
        // Padding
        // We can avoid allocation of buffer for padding completely if it
        // was previously not allocated here. But it won't change performance.
        const { buffer, view, blockLen, isLE } = this;
        let { pos } = this;
        // append the bit '1' to the message
        buffer[pos++] = 0b10000000;
        clean$1(this.buffer.subarray(pos));
        // we have less than padOffset left in buffer, so we cannot put length in
        // current block, need process it and pad again
        if (this.padOffset > blockLen - pos) {
            this.process(view, 0);
            pos = 0;
        }
        // Pad until full block byte with zeros
        for (let i = pos; i < blockLen; i++)
            buffer[i] = 0;
        // Note: sha512 requires length to be 128bit integer, but length in JS will overflow before that
        // You need to write around 2 exabytes (u64_max / 8 / (1024**6)) for this to happen.
        // So we just write lowest 64 bits of that value.
        setBigUint64$1(view, blockLen - 8, BigInt(this.length * 8), isLE);
        this.process(view, 0);
        const oview = createView$1(out);
        const len = this.outputLen;
        // NOTE: we do division by 4 later, which should be fused in single op with modulo by JIT
        if (len % 4)
            throw new Error('_sha2: outputLen should be aligned to 32bit');
        const outLen = len / 4;
        const state = this.get();
        if (outLen > state.length)
            throw new Error('_sha2: outputLen bigger than state');
        for (let i = 0; i < outLen; i++)
            oview.setUint32(4 * i, state[i], isLE);
    }
    digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
    }
    _cloneInto(to) {
        to || (to = new this.constructor());
        to.set(...this.get());
        const { blockLen, buffer, length, finished, destroyed, pos } = this;
        to.destroyed = destroyed;
        to.finished = finished;
        to.length = length;
        to.pos = pos;
        if (length % blockLen)
            to.buffer.set(buffer);
        return to;
    }
    clone() {
        return this._cloneInto();
    }
}
/**
 * Initial SHA-2 state: fractional parts of square roots of first 16 primes 2..53.
 * Check out `test/misc/sha2-gen-iv.js` for recomputation guide.
 */
/** Initial SHA256 state. Bits 0..32 of frac part of sqrt of primes 2..19 */
const SHA256_IV = /* @__PURE__ */ Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
/** Initial SHA512 state. Bits 0..64 of frac part of sqrt of primes 2..19 */
const SHA512_IV = /* @__PURE__ */ Uint32Array.from([
    0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
    0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
]);

/**
 * Internal helpers for u64. BigUint64Array is too slow as per 2025, so we implement it using Uint32Array.
 * @todo re-check https://issues.chromium.org/issues/42212588
 * @module
 */
const U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
const _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
    if (le)
        return { h: Number(n & U32_MASK64), l: Number((n >> _32n) & U32_MASK64) };
    return { h: Number((n >> _32n) & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
    const len = lst.length;
    let Ah = new Uint32Array(len);
    let Al = new Uint32Array(len);
    for (let i = 0; i < len; i++) {
        const { h, l } = fromBig(lst[i], le);
        [Ah[i], Al[i]] = [h, l];
    }
    return [Ah, Al];
}
// for Shift in [0, 32)
const shrSH = (h, _l, s) => h >>> s;
const shrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);
// Right rotate for Shift in [1, 32)
const rotrSH = (h, l, s) => (h >>> s) | (l << (32 - s));
const rotrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);
// Right rotate for Shift in (32, 64), NOTE: 32 is special case.
const rotrBH = (h, l, s) => (h << (64 - s)) | (l >>> (s - 32));
const rotrBL = (h, l, s) => (h >>> (s - 32)) | (l << (64 - s));
// JS uses 32-bit signed integers for bitwise operations which means we cannot
// simple take carry out of low bit sum by shift, we need to use division.
function add(Ah, Al, Bh, Bl) {
    const l = (Al >>> 0) + (Bl >>> 0);
    return { h: (Ah + Bh + ((l / 2 ** 32) | 0)) | 0, l: l | 0 };
}
// Addition with more than 2 elements
const add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
const add3H = (low, Ah, Bh, Ch) => (Ah + Bh + Ch + ((low / 2 ** 32) | 0)) | 0;
const add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
const add4H = (low, Ah, Bh, Ch, Dh) => (Ah + Bh + Ch + Dh + ((low / 2 ** 32) | 0)) | 0;
const add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
const add5H = (low, Ah, Bh, Ch, Dh, Eh) => (Ah + Bh + Ch + Dh + Eh + ((low / 2 ** 32) | 0)) | 0;

/**
 * SHA2 hash function. A.k.a. sha256, sha384, sha512, sha512_224, sha512_256.
 * SHA256 is the fastest hash implementable in JS, even faster than Blake3.
 * Check out [RFC 4634](https://datatracker.ietf.org/doc/html/rfc4634) and
 * [FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf).
 * @module
 */
/**
 * Round constants:
 * First 32 bits of fractional parts of the cube roots of the first 64 primes 2..311)
 */
// prettier-ignore
const SHA256_K = /* @__PURE__ */ Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
/** Reusable temporary buffer. "W" comes straight from spec. */
const SHA256_W = /* @__PURE__ */ new Uint32Array(64);
class SHA256 extends HashMD {
    constructor(outputLen = 32) {
        super(64, outputLen, 8, false);
        // We cannot use array here since array allows indexing by variable
        // which means optimizer/compiler cannot use registers.
        this.A = SHA256_IV[0] | 0;
        this.B = SHA256_IV[1] | 0;
        this.C = SHA256_IV[2] | 0;
        this.D = SHA256_IV[3] | 0;
        this.E = SHA256_IV[4] | 0;
        this.F = SHA256_IV[5] | 0;
        this.G = SHA256_IV[6] | 0;
        this.H = SHA256_IV[7] | 0;
    }
    get() {
        const { A, B, C, D, E, F, G, H } = this;
        return [A, B, C, D, E, F, G, H];
    }
    // prettier-ignore
    set(A, B, C, D, E, F, G, H) {
        this.A = A | 0;
        this.B = B | 0;
        this.C = C | 0;
        this.D = D | 0;
        this.E = E | 0;
        this.F = F | 0;
        this.G = G | 0;
        this.H = H | 0;
    }
    process(view, offset) {
        // Extend the first 16 words into the remaining 48 words w[16..63] of the message schedule array
        for (let i = 0; i < 16; i++, offset += 4)
            SHA256_W[i] = view.getUint32(offset, false);
        for (let i = 16; i < 64; i++) {
            const W15 = SHA256_W[i - 15];
            const W2 = SHA256_W[i - 2];
            const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ (W15 >>> 3);
            const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ (W2 >>> 10);
            SHA256_W[i] = (s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16]) | 0;
        }
        // Compression function main loop, 64 rounds
        let { A, B, C, D, E, F, G, H } = this;
        for (let i = 0; i < 64; i++) {
            const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
            const T1 = (H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
            const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
            const T2 = (sigma0 + Maj(A, B, C)) | 0;
            H = G;
            G = F;
            F = E;
            E = (D + T1) | 0;
            D = C;
            C = B;
            B = A;
            A = (T1 + T2) | 0;
        }
        // Add the compressed chunk to the current hash value
        A = (A + this.A) | 0;
        B = (B + this.B) | 0;
        C = (C + this.C) | 0;
        D = (D + this.D) | 0;
        E = (E + this.E) | 0;
        F = (F + this.F) | 0;
        G = (G + this.G) | 0;
        H = (H + this.H) | 0;
        this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
        clean$1(SHA256_W);
    }
    destroy() {
        this.set(0, 0, 0, 0, 0, 0, 0, 0);
        clean$1(this.buffer);
    }
}
// SHA2-512 is slower than sha256 in js because u64 operations are slow.
// Round contants
// First 32 bits of the fractional parts of the cube roots of the first 80 primes 2..409
// prettier-ignore
const K512 = /* @__PURE__ */ (() => split([
    '0x428a2f98d728ae22', '0x7137449123ef65cd', '0xb5c0fbcfec4d3b2f', '0xe9b5dba58189dbbc',
    '0x3956c25bf348b538', '0x59f111f1b605d019', '0x923f82a4af194f9b', '0xab1c5ed5da6d8118',
    '0xd807aa98a3030242', '0x12835b0145706fbe', '0x243185be4ee4b28c', '0x550c7dc3d5ffb4e2',
    '0x72be5d74f27b896f', '0x80deb1fe3b1696b1', '0x9bdc06a725c71235', '0xc19bf174cf692694',
    '0xe49b69c19ef14ad2', '0xefbe4786384f25e3', '0x0fc19dc68b8cd5b5', '0x240ca1cc77ac9c65',
    '0x2de92c6f592b0275', '0x4a7484aa6ea6e483', '0x5cb0a9dcbd41fbd4', '0x76f988da831153b5',
    '0x983e5152ee66dfab', '0xa831c66d2db43210', '0xb00327c898fb213f', '0xbf597fc7beef0ee4',
    '0xc6e00bf33da88fc2', '0xd5a79147930aa725', '0x06ca6351e003826f', '0x142929670a0e6e70',
    '0x27b70a8546d22ffc', '0x2e1b21385c26c926', '0x4d2c6dfc5ac42aed', '0x53380d139d95b3df',
    '0x650a73548baf63de', '0x766a0abb3c77b2a8', '0x81c2c92e47edaee6', '0x92722c851482353b',
    '0xa2bfe8a14cf10364', '0xa81a664bbc423001', '0xc24b8b70d0f89791', '0xc76c51a30654be30',
    '0xd192e819d6ef5218', '0xd69906245565a910', '0xf40e35855771202a', '0x106aa07032bbd1b8',
    '0x19a4c116b8d2d0c8', '0x1e376c085141ab53', '0x2748774cdf8eeb99', '0x34b0bcb5e19b48a8',
    '0x391c0cb3c5c95a63', '0x4ed8aa4ae3418acb', '0x5b9cca4f7763e373', '0x682e6ff3d6b2b8a3',
    '0x748f82ee5defb2fc', '0x78a5636f43172f60', '0x84c87814a1f0ab72', '0x8cc702081a6439ec',
    '0x90befffa23631e28', '0xa4506cebde82bde9', '0xbef9a3f7b2c67915', '0xc67178f2e372532b',
    '0xca273eceea26619c', '0xd186b8c721c0c207', '0xeada7dd6cde0eb1e', '0xf57d4f7fee6ed178',
    '0x06f067aa72176fba', '0x0a637dc5a2c898a6', '0x113f9804bef90dae', '0x1b710b35131c471b',
    '0x28db77f523047d84', '0x32caab7b40c72493', '0x3c9ebe0a15c9bebc', '0x431d67c49c100d4c',
    '0x4cc5d4becb3e42b6', '0x597f299cfc657e2a', '0x5fcb6fab3ad6faec', '0x6c44198c4a475817'
].map(n => BigInt(n))))();
const SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
const SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
// Reusable temporary buffers
const SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
const SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
class SHA512 extends HashMD {
    constructor(outputLen = 64) {
        super(128, outputLen, 16, false);
        // We cannot use array here since array allows indexing by variable
        // which means optimizer/compiler cannot use registers.
        // h -- high 32 bits, l -- low 32 bits
        this.Ah = SHA512_IV[0] | 0;
        this.Al = SHA512_IV[1] | 0;
        this.Bh = SHA512_IV[2] | 0;
        this.Bl = SHA512_IV[3] | 0;
        this.Ch = SHA512_IV[4] | 0;
        this.Cl = SHA512_IV[5] | 0;
        this.Dh = SHA512_IV[6] | 0;
        this.Dl = SHA512_IV[7] | 0;
        this.Eh = SHA512_IV[8] | 0;
        this.El = SHA512_IV[9] | 0;
        this.Fh = SHA512_IV[10] | 0;
        this.Fl = SHA512_IV[11] | 0;
        this.Gh = SHA512_IV[12] | 0;
        this.Gl = SHA512_IV[13] | 0;
        this.Hh = SHA512_IV[14] | 0;
        this.Hl = SHA512_IV[15] | 0;
    }
    // prettier-ignore
    get() {
        const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
    }
    // prettier-ignore
    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
        this.Ah = Ah | 0;
        this.Al = Al | 0;
        this.Bh = Bh | 0;
        this.Bl = Bl | 0;
        this.Ch = Ch | 0;
        this.Cl = Cl | 0;
        this.Dh = Dh | 0;
        this.Dl = Dl | 0;
        this.Eh = Eh | 0;
        this.El = El | 0;
        this.Fh = Fh | 0;
        this.Fl = Fl | 0;
        this.Gh = Gh | 0;
        this.Gl = Gl | 0;
        this.Hh = Hh | 0;
        this.Hl = Hl | 0;
    }
    process(view, offset) {
        // Extend the first 16 words into the remaining 64 words w[16..79] of the message schedule array
        for (let i = 0; i < 16; i++, offset += 4) {
            SHA512_W_H[i] = view.getUint32(offset);
            SHA512_W_L[i] = view.getUint32((offset += 4));
        }
        for (let i = 16; i < 80; i++) {
            // s0 := (w[i-15] rightrotate 1) xor (w[i-15] rightrotate 8) xor (w[i-15] rightshift 7)
            const W15h = SHA512_W_H[i - 15] | 0;
            const W15l = SHA512_W_L[i - 15] | 0;
            const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
            const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
            // s1 := (w[i-2] rightrotate 19) xor (w[i-2] rightrotate 61) xor (w[i-2] rightshift 6)
            const W2h = SHA512_W_H[i - 2] | 0;
            const W2l = SHA512_W_L[i - 2] | 0;
            const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
            const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
            // SHA256_W[i] = s0 + s1 + SHA256_W[i - 7] + SHA256_W[i - 16];
            const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
            const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
            SHA512_W_H[i] = SUMh | 0;
            SHA512_W_L[i] = SUMl | 0;
        }
        let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        // Compression function main loop, 80 rounds
        for (let i = 0; i < 80; i++) {
            // S1 := (e rightrotate 14) xor (e rightrotate 18) xor (e rightrotate 41)
            const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
            const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
            //const T1 = (H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
            const CHIh = (Eh & Fh) ^ (~Eh & Gh);
            const CHIl = (El & Fl) ^ (~El & Gl);
            // T1 = H + sigma1 + Chi(E, F, G) + SHA512_K[i] + SHA512_W[i]
            // prettier-ignore
            const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
            const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
            const T1l = T1ll | 0;
            // S0 := (a rightrotate 28) xor (a rightrotate 34) xor (a rightrotate 39)
            const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
            const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
            const MAJh = (Ah & Bh) ^ (Ah & Ch) ^ (Bh & Ch);
            const MAJl = (Al & Bl) ^ (Al & Cl) ^ (Bl & Cl);
            Hh = Gh | 0;
            Hl = Gl | 0;
            Gh = Fh | 0;
            Gl = Fl | 0;
            Fh = Eh | 0;
            Fl = El | 0;
            ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
            Dh = Ch | 0;
            Dl = Cl | 0;
            Ch = Bh | 0;
            Cl = Bl | 0;
            Bh = Ah | 0;
            Bl = Al | 0;
            const All = add3L(T1l, sigma0l, MAJl);
            Ah = add3H(All, T1h, sigma0h, MAJh);
            Al = All | 0;
        }
        // Add the compressed chunk to the current hash value
        ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
        ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
        ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
        ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
        ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
        ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
        ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
        ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
        this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
    }
    roundClean() {
        clean$1(SHA512_W_H, SHA512_W_L);
    }
    destroy() {
        clean$1(this.buffer);
        this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
}
/**
 * SHA2-256 hash function from RFC 4634.
 *
 * It is the fastest JS hash, even faster than Blake3.
 * To break sha256 using birthday attack, attackers need to try 2^128 hashes.
 * BTC network is doing 2^70 hashes/sec (2^95 hashes/year) as per 2025.
 */
const sha256 = /* @__PURE__ */ createHasher(() => new SHA256());
/** SHA2-512 hash function from RFC 4634. */
const sha512 = /* @__PURE__ */ createHasher(() => new SHA512());

/**
 * Hex, bytes and number utilities.
 * @module
 */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const _0n$2 = /* @__PURE__ */ BigInt(0);
const _1n$3 = /* @__PURE__ */ BigInt(1);
function hexToNumber(hex) {
    if (typeof hex !== 'string')
        throw new Error('hex string expected, got ' + typeof hex);
    return hex === '' ? _0n$2 : BigInt('0x' + hex); // Big Endian
}
// BE: Big Endian, LE: Little Endian
function bytesToNumberBE(bytes) {
    return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
    abytes$1(bytes);
    return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));
}
function numberToBytesBE(n, len) {
    return hexToBytes(n.toString(16).padStart(len * 2, '0'));
}
function numberToBytesLE(n, len) {
    return numberToBytesBE(n, len).reverse();
}
/**
 * Takes hex string or Uint8Array, converts to Uint8Array.
 * Validates output length.
 * Will throw error for other types.
 * @param title descriptive title for an error e.g. 'secret key'
 * @param hex hex string or Uint8Array
 * @param expectedLength optional, will compare to result array's length
 * @returns
 */
function ensureBytes(title, hex, expectedLength) {
    let res;
    if (typeof hex === 'string') {
        try {
            res = hexToBytes(hex);
        }
        catch (e) {
            throw new Error(title + ' must be hex string or Uint8Array, cause: ' + e);
        }
    }
    else if (isBytes$1(hex)) {
        // Uint8Array.from() instead of hash.slice() because node.js Buffer
        // is instance of Uint8Array, and its slice() creates **mutable** copy
        res = Uint8Array.from(hex);
    }
    else {
        throw new Error(title + ' must be hex string or Uint8Array');
    }
    const len = res.length;
    if (typeof expectedLength === 'number' && len !== expectedLength)
        throw new Error(title + ' of length ' + expectedLength + ' expected, got ' + len);
    return res;
}
/**
 * @example utf8ToBytes('abc') // new Uint8Array([97, 98, 99])
 */
// export const utf8ToBytes: typeof utf8ToBytes_ = utf8ToBytes_;
/**
 * Converts bytes to string using UTF8 encoding.
 * @example bytesToUtf8(Uint8Array.from([97, 98, 99])) // 'abc'
 */
// export const bytesToUtf8: typeof bytesToUtf8_ = bytesToUtf8_;
// Is positive bigint
const isPosBig = (n) => typeof n === 'bigint' && _0n$2 <= n;
function inRange(n, min, max) {
    return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
/**
 * Asserts min <= n < max. NOTE: It's < max and not <= max.
 * @example
 * aInRange('x', x, 1n, 256n); // would assume x is in (1n..255n)
 */
function aInRange(title, n, min, max) {
    // Why min <= n < max and not a (min < n < max) OR b (min <= n <= max)?
    // consider P=256n, min=0n, max=P
    // - a for min=0 would require -1:          `inRange('x', x, -1n, P)`
    // - b would commonly require subtraction:  `inRange('x', x, 0n, P - 1n)`
    // - our way is the cleanest:               `inRange('x', x, 0n, P)
    if (!inRange(n, min, max))
        throw new Error('expected valid ' + title + ': ' + min + ' <= n < ' + max + ', got ' + n);
}
/**
 * Calculate mask for N bits. Not using ** operator with bigints because of old engines.
 * Same as BigInt(`0b${Array(i).fill('1').join('')}`)
 */
const bitMask = (n) => (_1n$3 << BigInt(n)) - _1n$3;
function _validateObject(object, fields, optFields = {}) {
    if (!object || typeof object !== 'object')
        throw new Error('expected valid options object');
    function checkField(fieldName, expectedType, isOpt) {
        const val = object[fieldName];
        if (isOpt && val === undefined)
            return;
        const current = typeof val;
        if (current !== expectedType || val === null)
            throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
    }
    Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));
    Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));
}

/**
 * Utils for modular division and fields.
 * Field over 11 is a finite (Galois) field is integer number operations `mod 11`.
 * There is no division: it is replaced by modular multiplicative inverse.
 * @module
 */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// prettier-ignore
const _0n$1 = BigInt(0), _1n$2 = BigInt(1), _2n$2 = /* @__PURE__ */ BigInt(2), _3n$1 = /* @__PURE__ */ BigInt(3);
// prettier-ignore
const _4n = /* @__PURE__ */ BigInt(4), _5n$1 = /* @__PURE__ */ BigInt(5), _7n = /* @__PURE__ */ BigInt(7);
// prettier-ignore
const _8n$1 = /* @__PURE__ */ BigInt(8), _9n = /* @__PURE__ */ BigInt(9), _16n = /* @__PURE__ */ BigInt(16);
// Calculates a modulo b
function mod$1(a, b) {
    const result = a % b;
    return result >= _0n$1 ? result : b + result;
}
/** Does `x^(2^power)` mod p. `pow2(30, 4)` == `30^(2^4)` */
function pow2(x, power, modulo) {
    let res = x;
    while (power-- > _0n$1) {
        res *= res;
        res %= modulo;
    }
    return res;
}
/**
 * Inverses number over modulo.
 * Implemented using [Euclidean GCD](https://brilliant.org/wiki/extended-euclidean-algorithm/).
 */
function invert(number, modulo) {
    if (number === _0n$1)
        throw new Error('invert: expected non-zero number');
    if (modulo <= _0n$1)
        throw new Error('invert: expected positive modulus, got ' + modulo);
    // Fermat's little theorem "CT-like" version inv(n) = n^(m-2) mod m is 30x slower.
    let a = mod$1(number, modulo);
    let b = modulo;
    // prettier-ignore
    let x = _0n$1, u = _1n$2;
    while (a !== _0n$1) {
        // JIT applies optimization if those two lines follow each other
        const q = b / a;
        const r = b % a;
        const m = x - u * q;
        // prettier-ignore
        b = a, a = r, x = u, u = m;
    }
    const gcd = b;
    if (gcd !== _1n$2)
        throw new Error('invert: does not exist');
    return mod$1(x, modulo);
}
function assertIsSquare(Fp, root, n) {
    if (!Fp.eql(Fp.sqr(root), n))
        throw new Error('Cannot find square root');
}
// Not all roots are possible! Example which will throw:
// const NUM =
// n = 72057594037927816n;
// Fp = Field(BigInt('0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab'));
function sqrt3mod4(Fp, n) {
    const p1div4 = (Fp.ORDER + _1n$2) / _4n;
    const root = Fp.pow(n, p1div4);
    assertIsSquare(Fp, root, n);
    return root;
}
function sqrt5mod8(Fp, n) {
    const p5div8 = (Fp.ORDER - _5n$1) / _8n$1;
    const n2 = Fp.mul(n, _2n$2);
    const v = Fp.pow(n2, p5div8);
    const nv = Fp.mul(n, v);
    const i = Fp.mul(Fp.mul(nv, _2n$2), v);
    const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
    assertIsSquare(Fp, root, n);
    return root;
}
// Based on RFC9380, Kong algorithm
// prettier-ignore
function sqrt9mod16(P) {
    const Fp_ = Field(P);
    const tn = tonelliShanks(P);
    const c1 = tn(Fp_, Fp_.neg(Fp_.ONE)); //  1. c1 = sqrt(-1) in F, i.e., (c1^2) == -1 in F
    const c2 = tn(Fp_, c1); //  2. c2 = sqrt(c1) in F, i.e., (c2^2) == c1 in F
    const c3 = tn(Fp_, Fp_.neg(c1)); //  3. c3 = sqrt(-c1) in F, i.e., (c3^2) == -c1 in F
    const c4 = (P + _7n) / _16n; //  4. c4 = (q + 7) / 16        # Integer arithmetic
    return (Fp, n) => {
        let tv1 = Fp.pow(n, c4); //  1. tv1 = x^c4
        let tv2 = Fp.mul(tv1, c1); //  2. tv2 = c1 * tv1
        const tv3 = Fp.mul(tv1, c2); //  3. tv3 = c2 * tv1
        const tv4 = Fp.mul(tv1, c3); //  4. tv4 = c3 * tv1
        const e1 = Fp.eql(Fp.sqr(tv2), n); //  5.  e1 = (tv2^2) == x
        const e2 = Fp.eql(Fp.sqr(tv3), n); //  6.  e2 = (tv3^2) == x
        tv1 = Fp.cmov(tv1, tv2, e1); //  7. tv1 = CMOV(tv1, tv2, e1)  # Select tv2 if (tv2^2) == x
        tv2 = Fp.cmov(tv4, tv3, e2); //  8. tv2 = CMOV(tv4, tv3, e2)  # Select tv3 if (tv3^2) == x
        const e3 = Fp.eql(Fp.sqr(tv2), n); //  9.  e3 = (tv2^2) == x
        const root = Fp.cmov(tv1, tv2, e3); // 10.  z = CMOV(tv1, tv2, e3)   # Select sqrt from tv1 & tv2
        assertIsSquare(Fp, root, n);
        return root;
    };
}
/**
 * Tonelli-Shanks square root search algorithm.
 * 1. https://eprint.iacr.org/2012/685.pdf (page 12)
 * 2. Square Roots from 1; 24, 51, 10 to Dan Shanks
 * @param P field order
 * @returns function that takes field Fp (created from P) and number n
 */
function tonelliShanks(P) {
    // Initialization (precomputation).
    // Caching initialization could boost perf by 7%.
    if (P < _3n$1)
        throw new Error('sqrt is not defined for small field');
    // Factor P - 1 = Q * 2^S, where Q is odd
    let Q = P - _1n$2;
    let S = 0;
    while (Q % _2n$2 === _0n$1) {
        Q /= _2n$2;
        S++;
    }
    // Find the first quadratic non-residue Z >= 2
    let Z = _2n$2;
    const _Fp = Field(P);
    while (FpLegendre(_Fp, Z) === 1) {
        // Basic primality test for P. After x iterations, chance of
        // not finding quadratic non-residue is 2^x, so 2^1000.
        if (Z++ > 1000)
            throw new Error('Cannot find square root: probably non-prime P');
    }
    // Fast-path; usually done before Z, but we do "primality test".
    if (S === 1)
        return sqrt3mod4;
    // Slow-path
    // TODO: test on Fp2 and others
    let cc = _Fp.pow(Z, Q); // c = z^Q
    const Q1div2 = (Q + _1n$2) / _2n$2;
    return function tonelliSlow(Fp, n) {
        if (Fp.is0(n))
            return n;
        // Check if n is a quadratic residue using Legendre symbol
        if (FpLegendre(Fp, n) !== 1)
            throw new Error('Cannot find square root');
        // Initialize variables for the main loop
        let M = S;
        let c = Fp.mul(Fp.ONE, cc); // c = z^Q, move cc from field _Fp into field Fp
        let t = Fp.pow(n, Q); // t = n^Q, first guess at the fudge factor
        let R = Fp.pow(n, Q1div2); // R = n^((Q+1)/2), first guess at the square root
        // Main loop
        // while t != 1
        while (!Fp.eql(t, Fp.ONE)) {
            if (Fp.is0(t))
                return Fp.ZERO; // if t=0 return R=0
            let i = 1;
            // Find the smallest i >= 1 such that t^(2^i) ≡ 1 (mod P)
            let t_tmp = Fp.sqr(t); // t^(2^1)
            while (!Fp.eql(t_tmp, Fp.ONE)) {
                i++;
                t_tmp = Fp.sqr(t_tmp); // t^(2^2)...
                if (i === M)
                    throw new Error('Cannot find square root');
            }
            // Calculate the exponent for b: 2^(M - i - 1)
            const exponent = _1n$2 << BigInt(M - i - 1); // bigint is important
            const b = Fp.pow(c, exponent); // b = 2^(M - i - 1)
            // Update variables
            M = i;
            c = Fp.sqr(b); // c = b^2
            t = Fp.mul(t, c); // t = (t * b^2)
            R = Fp.mul(R, b); // R = R*b
        }
        return R;
    };
}
/**
 * Square root for a finite field. Will try optimized versions first:
 *
 * 1. P ≡ 3 (mod 4)
 * 2. P ≡ 5 (mod 8)
 * 3. P ≡ 9 (mod 16)
 * 4. Tonelli-Shanks algorithm
 *
 * Different algorithms can give different roots, it is up to user to decide which one they want.
 * For example there is FpSqrtOdd/FpSqrtEven to choice root based on oddness (used for hash-to-curve).
 */
function FpSqrt(P) {
    // P ≡ 3 (mod 4) => √n = n^((P+1)/4)
    if (P % _4n === _3n$1)
        return sqrt3mod4;
    // P ≡ 5 (mod 8) => Atkin algorithm, page 10 of https://eprint.iacr.org/2012/685.pdf
    if (P % _8n$1 === _5n$1)
        return sqrt5mod8;
    // P ≡ 9 (mod 16) => Kong algorithm, page 11 of https://eprint.iacr.org/2012/685.pdf (algorithm 4)
    if (P % _16n === _9n)
        return sqrt9mod16(P);
    // Tonelli-Shanks algorithm
    return tonelliShanks(P);
}
// Generic field functions
/**
 * Same as `pow` but for Fp: non-constant-time.
 * Unsafe in some contexts: uses ladder, so can expose bigint bits.
 */
function FpPow(Fp, num, power) {
    if (power < _0n$1)
        throw new Error('invalid exponent, negatives unsupported');
    if (power === _0n$1)
        return Fp.ONE;
    if (power === _1n$2)
        return num;
    let p = Fp.ONE;
    let d = num;
    while (power > _0n$1) {
        if (power & _1n$2)
            p = Fp.mul(p, d);
        d = Fp.sqr(d);
        power >>= _1n$2;
    }
    return p;
}
/**
 * Efficiently invert an array of Field elements.
 * Exception-free. Will return `undefined` for 0 elements.
 * @param passZero map 0 to 0 (instead of undefined)
 */
function FpInvertBatch(Fp, nums, passZero = false) {
    const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : undefined);
    // Walk from first to last, multiply them by each other MOD p
    const multipliedAcc = nums.reduce((acc, num, i) => {
        if (Fp.is0(num))
            return acc;
        inverted[i] = acc;
        return Fp.mul(acc, num);
    }, Fp.ONE);
    // Invert last element
    const invertedAcc = Fp.inv(multipliedAcc);
    // Walk from last to first, multiply them by inverted each other MOD p
    nums.reduceRight((acc, num, i) => {
        if (Fp.is0(num))
            return acc;
        inverted[i] = Fp.mul(acc, inverted[i]);
        return Fp.mul(acc, num);
    }, invertedAcc);
    return inverted;
}
/**
 * Legendre symbol.
 * Legendre constant is used to calculate Legendre symbol (a | p)
 * which denotes the value of a^((p-1)/2) (mod p).
 *
 * * (a | p) ≡ 1    if a is a square (mod p), quadratic residue
 * * (a | p) ≡ -1   if a is not a square (mod p), quadratic non residue
 * * (a | p) ≡ 0    if a ≡ 0 (mod p)
 */
function FpLegendre(Fp, n) {
    // We can use 3rd argument as optional cache of this value
    // but seems unneeded for now. The operation is very fast.
    const p1mod2 = (Fp.ORDER - _1n$2) / _2n$2;
    const powered = Fp.pow(n, p1mod2);
    const yes = Fp.eql(powered, Fp.ONE);
    const zero = Fp.eql(powered, Fp.ZERO);
    const no = Fp.eql(powered, Fp.neg(Fp.ONE));
    if (!yes && !zero && !no)
        throw new Error('invalid Legendre symbol result');
    return yes ? 1 : zero ? 0 : -1;
}
// CURVE.n lengths
function nLength(n, nBitLength) {
    // Bit size, byte size of CURVE.n
    if (nBitLength !== undefined)
        anumber$1(nBitLength);
    const _nBitLength = nBitLength !== undefined ? nBitLength : n.toString(2).length;
    const nByteLength = Math.ceil(_nBitLength / 8);
    return { nBitLength: _nBitLength, nByteLength };
}
/**
 * Creates a finite field. Major performance optimizations:
 * * 1. Denormalized operations like mulN instead of mul.
 * * 2. Identical object shape: never add or remove keys.
 * * 3. `Object.freeze`.
 * Fragile: always run a benchmark on a change.
 * Security note: operations don't check 'isValid' for all elements for performance reasons,
 * it is caller responsibility to check this.
 * This is low-level code, please make sure you know what you're doing.
 *
 * Note about field properties:
 * * CHARACTERISTIC p = prime number, number of elements in main subgroup.
 * * ORDER q = similar to cofactor in curves, may be composite `q = p^m`.
 *
 * @param ORDER field order, probably prime, or could be composite
 * @param bitLen how many bits the field consumes
 * @param isLE (default: false) if encoding / decoding should be in little-endian
 * @param redef optional faster redefinitions of sqrt and other methods
 */
function Field(ORDER, bitLenOrOpts, // TODO: use opts only in v2?
isLE = false, opts = {}) {
    if (ORDER <= _0n$1)
        throw new Error('invalid field: expected ORDER > 0, got ' + ORDER);
    let _nbitLength = undefined;
    let _sqrt = undefined;
    let modFromBytes = false;
    let allowedLengths = undefined;
    if (typeof bitLenOrOpts === 'object' && bitLenOrOpts != null) {
        if (opts.sqrt || isLE)
            throw new Error('cannot specify opts in two arguments');
        const _opts = bitLenOrOpts;
        if (_opts.BITS)
            _nbitLength = _opts.BITS;
        if (_opts.sqrt)
            _sqrt = _opts.sqrt;
        if (typeof _opts.isLE === 'boolean')
            isLE = _opts.isLE;
        if (typeof _opts.modFromBytes === 'boolean')
            modFromBytes = _opts.modFromBytes;
        allowedLengths = _opts.allowedLengths;
    }
    else {
        if (typeof bitLenOrOpts === 'number')
            _nbitLength = bitLenOrOpts;
        if (opts.sqrt)
            _sqrt = opts.sqrt;
    }
    const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);
    if (BYTES > 2048)
        throw new Error('invalid field: expected ORDER of <= 2048 bytes');
    let sqrtP; // cached sqrtP
    const f = Object.freeze({
        ORDER,
        isLE,
        BITS,
        BYTES,
        MASK: bitMask(BITS),
        ZERO: _0n$1,
        ONE: _1n$2,
        allowedLengths: allowedLengths,
        create: (num) => mod$1(num, ORDER),
        isValid: (num) => {
            if (typeof num !== 'bigint')
                throw new Error('invalid field element: expected bigint, got ' + typeof num);
            return _0n$1 <= num && num < ORDER; // 0 is valid element, but it's not invertible
        },
        is0: (num) => num === _0n$1,
        // is valid and invertible
        isValidNot0: (num) => !f.is0(num) && f.isValid(num),
        isOdd: (num) => (num & _1n$2) === _1n$2,
        neg: (num) => mod$1(-num, ORDER),
        eql: (lhs, rhs) => lhs === rhs,
        sqr: (num) => mod$1(num * num, ORDER),
        add: (lhs, rhs) => mod$1(lhs + rhs, ORDER),
        sub: (lhs, rhs) => mod$1(lhs - rhs, ORDER),
        mul: (lhs, rhs) => mod$1(lhs * rhs, ORDER),
        pow: (num, power) => FpPow(f, num, power),
        div: (lhs, rhs) => mod$1(lhs * invert(rhs, ORDER), ORDER),
        // Same as above, but doesn't normalize
        sqrN: (num) => num * num,
        addN: (lhs, rhs) => lhs + rhs,
        subN: (lhs, rhs) => lhs - rhs,
        mulN: (lhs, rhs) => lhs * rhs,
        inv: (num) => invert(num, ORDER),
        sqrt: _sqrt ||
            ((n) => {
                if (!sqrtP)
                    sqrtP = FpSqrt(ORDER);
                return sqrtP(f, n);
            }),
        toBytes: (num) => (isLE ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES)),
        fromBytes: (bytes, skipValidation = true) => {
            if (allowedLengths) {
                if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
                    throw new Error('Field.fromBytes: expected ' + allowedLengths + ' bytes, got ' + bytes.length);
                }
                const padded = new Uint8Array(BYTES);
                // isLE add 0 to right, !isLE to the left.
                padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
                bytes = padded;
            }
            if (bytes.length !== BYTES)
                throw new Error('Field.fromBytes: expected ' + BYTES + ' bytes, got ' + bytes.length);
            let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
            if (modFromBytes)
                scalar = mod$1(scalar, ORDER);
            if (!skipValidation)
                if (!f.isValid(scalar))
                    throw new Error('invalid field element: outside of range 0..ORDER');
            // NOTE: we don't validate scalar here, please use isValid. This done such way because some
            // protocol may allow non-reduced scalar that reduced later or changed some other way.
            return scalar;
        },
        // TODO: we don't need it here, move out to separate fn
        invertBatch: (lst) => FpInvertBatch(f, lst),
        // We can't move this out because Fp6, Fp12 implement it
        // and it's unclear what to return in there.
        cmov: (a, b, c) => (c ? b : a),
    });
    return Object.freeze(f);
}

/**
 * Montgomery curve methods. It's not really whole montgomery curve,
 * just bunch of very specific methods for X25519 / X448 from
 * [RFC 7748](https://www.rfc-editor.org/rfc/rfc7748)
 * @module
 */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const _0n = BigInt(0);
const _1n$1 = BigInt(1);
const _2n$1 = BigInt(2);
function validateOpts(curve) {
    _validateObject(curve, {
        adjustScalarBytes: 'function',
        powPminus2: 'function',
    });
    return Object.freeze({ ...curve });
}
function montgomery(curveDef) {
    const CURVE = validateOpts(curveDef);
    const { P, type, adjustScalarBytes, powPminus2, randomBytes: rand } = CURVE;
    const is25519 = type === 'x25519';
    if (!is25519 && type !== 'x448')
        throw new Error('invalid type');
    const randomBytes_ = rand || randomBytes;
    const montgomeryBits = is25519 ? 255 : 448;
    const fieldLen = is25519 ? 32 : 56;
    const Gu = is25519 ? BigInt(9) : BigInt(5);
    // RFC 7748 #5:
    // The constant a24 is (486662 - 2) / 4 = 121665 for curve25519/X25519 and
    // (156326 - 2) / 4 = 39081 for curve448/X448
    // const a = is25519 ? 156326n : 486662n;
    const a24 = is25519 ? BigInt(121665) : BigInt(39081);
    // RFC: x25519 "the resulting integer is of the form 2^254 plus
    // eight times a value between 0 and 2^251 - 1 (inclusive)"
    // x448: "2^447 plus four times a value between 0 and 2^445 - 1 (inclusive)"
    const minScalar = is25519 ? _2n$1 ** BigInt(254) : _2n$1 ** BigInt(447);
    const maxAdded = is25519
        ? BigInt(8) * _2n$1 ** BigInt(251) - _1n$1
        : BigInt(4) * _2n$1 ** BigInt(445) - _1n$1;
    const maxScalar = minScalar + maxAdded + _1n$1; // (inclusive)
    const modP = (n) => mod$1(n, P);
    const GuBytes = encodeU(Gu);
    function encodeU(u) {
        return numberToBytesLE(modP(u), fieldLen);
    }
    function decodeU(u) {
        const _u = ensureBytes('u coordinate', u, fieldLen);
        // RFC: When receiving such an array, implementations of X25519
        // (but not X448) MUST mask the most significant bit in the final byte.
        if (is25519)
            _u[31] &= 127; // 0b0111_1111
        // RFC: Implementations MUST accept non-canonical values and process them as
        // if they had been reduced modulo the field prime.  The non-canonical
        // values are 2^255 - 19 through 2^255 - 1 for X25519 and 2^448 - 2^224
        // - 1 through 2^448 - 1 for X448.
        return modP(bytesToNumberLE(_u));
    }
    function decodeScalar(scalar) {
        return bytesToNumberLE(adjustScalarBytes(ensureBytes('scalar', scalar, fieldLen)));
    }
    function scalarMult(scalar, u) {
        const pu = montgomeryLadder(decodeU(u), decodeScalar(scalar));
        // Some public keys are useless, of low-order. Curve author doesn't think
        // it needs to be validated, but we do it nonetheless.
        // https://cr.yp.to/ecdh.html#validate
        if (pu === _0n)
            throw new Error('invalid private or public key received');
        return encodeU(pu);
    }
    // Computes public key from private. By doing scalar multiplication of base point.
    function scalarMultBase(scalar) {
        return scalarMult(scalar, GuBytes);
    }
    // cswap from RFC7748 "example code"
    function cswap(swap, x_2, x_3) {
        // dummy = mask(swap) AND (x_2 XOR x_3)
        // Where mask(swap) is the all-1 or all-0 word of the same length as x_2
        // and x_3, computed, e.g., as mask(swap) = 0 - swap.
        const dummy = modP(swap * (x_2 - x_3));
        x_2 = modP(x_2 - dummy); // x_2 = x_2 XOR dummy
        x_3 = modP(x_3 + dummy); // x_3 = x_3 XOR dummy
        return { x_2, x_3 };
    }
    /**
     * Montgomery x-only multiplication ladder.
     * @param pointU u coordinate (x) on Montgomery Curve 25519
     * @param scalar by which the point would be multiplied
     * @returns new Point on Montgomery curve
     */
    function montgomeryLadder(u, scalar) {
        aInRange('u', u, _0n, P);
        aInRange('scalar', scalar, minScalar, maxScalar);
        const k = scalar;
        const x_1 = u;
        let x_2 = _1n$1;
        let z_2 = _0n;
        let x_3 = u;
        let z_3 = _1n$1;
        let swap = _0n;
        for (let t = BigInt(montgomeryBits - 1); t >= _0n; t--) {
            const k_t = (k >> t) & _1n$1;
            swap ^= k_t;
            ({ x_2, x_3 } = cswap(swap, x_2, x_3));
            ({ x_2: z_2, x_3: z_3 } = cswap(swap, z_2, z_3));
            swap = k_t;
            const A = x_2 + z_2;
            const AA = modP(A * A);
            const B = x_2 - z_2;
            const BB = modP(B * B);
            const E = AA - BB;
            const C = x_3 + z_3;
            const D = x_3 - z_3;
            const DA = modP(D * A);
            const CB = modP(C * B);
            const dacb = DA + CB;
            const da_cb = DA - CB;
            x_3 = modP(dacb * dacb);
            z_3 = modP(x_1 * modP(da_cb * da_cb));
            x_2 = modP(AA * BB);
            z_2 = modP(E * (AA + modP(a24 * E)));
        }
        ({ x_2, x_3 } = cswap(swap, x_2, x_3));
        ({ x_2: z_2, x_3: z_3 } = cswap(swap, z_2, z_3));
        const z2 = powPminus2(z_2); // `Fp.pow(x, P - _2n)` is much slower equivalent
        return modP(x_2 * z2); // Return x_2 * (z_2^(p - 2))
    }
    const lengths = {
        secretKey: fieldLen,
        publicKey: fieldLen,
        seed: fieldLen,
    };
    const randomSecretKey = (seed = randomBytes_(fieldLen)) => {
        abytes$1(seed, lengths.seed);
        return seed;
    };
    function keygen(seed) {
        const secretKey = randomSecretKey(seed);
        return { secretKey, publicKey: scalarMultBase(secretKey) };
    }
    const utils = {
        randomSecretKey,
        randomPrivateKey: randomSecretKey,
    };
    return {
        keygen,
        getSharedSecret: (secretKey, publicKey) => scalarMult(secretKey, publicKey),
        getPublicKey: (secretKey) => scalarMultBase(secretKey),
        scalarMult,
        scalarMultBase,
        utils,
        GuBytes: GuBytes.slice(),
        lengths,
    };
}

/**
 * ed25519 Twisted Edwards curve with following addons:
 * - X25519 ECDH
 * - Ristretto cofactor elimination
 * - Elligator hash-to-group / point indistinguishability
 * @module
 */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// prettier-ignore
const _1n = BigInt(1), _2n = BigInt(2), _3n = BigInt(3);
// prettier-ignore
const _5n = BigInt(5), _8n = BigInt(8);
// P = 2n**255n-19n
const ed25519_CURVE_p = BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed');
// N = 2n**252n + 27742317777372353535851937790883648493n
// a = Fp.create(BigInt(-1))
// d = -121665/121666 a.k.a. Fp.neg(121665 * Fp.inv(121666))
const ed25519_CURVE = /* @__PURE__ */ (() => ({
    p: ed25519_CURVE_p,
    n: BigInt('0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed'),
    h: _8n,
    a: BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec'),
    d: BigInt('0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3'),
    Gx: BigInt('0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a'),
    Gy: BigInt('0x6666666666666666666666666666666666666666666666666666666666666658'),
}))();
function ed25519_pow_2_252_3(x) {
    // prettier-ignore
    const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
    const P = ed25519_CURVE_p;
    const x2 = (x * x) % P;
    const b2 = (x2 * x) % P; // x^3, 11
    const b4 = (pow2(b2, _2n, P) * b2) % P; // x^15, 1111
    const b5 = (pow2(b4, _1n, P) * x) % P; // x^31
    const b10 = (pow2(b5, _5n, P) * b5) % P;
    const b20 = (pow2(b10, _10n, P) * b10) % P;
    const b40 = (pow2(b20, _20n, P) * b20) % P;
    const b80 = (pow2(b40, _40n, P) * b40) % P;
    const b160 = (pow2(b80, _80n, P) * b80) % P;
    const b240 = (pow2(b160, _80n, P) * b80) % P;
    const b250 = (pow2(b240, _10n, P) * b10) % P;
    const pow_p_5_8 = (pow2(b250, _2n, P) * x) % P;
    // ^ To pow to (p+3)/8, multiply it by x.
    return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes) {
    // Section 5: For X25519, in order to decode 32 random bytes as an integer scalar,
    // set the three least significant bits of the first byte
    bytes[0] &= 248; // 0b1111_1000
    // and the most significant bit of the last to zero,
    bytes[31] &= 127; // 0b0111_1111
    // set the second most significant bit of the last byte to 1
    bytes[31] |= 64; // 0b0100_0000
    return bytes;
}
const Fp = /* @__PURE__ */ (() => Field(ed25519_CURVE.p, { isLE: true }))();
/**
 * ECDH using curve25519 aka x25519.
 * @example
 * import { x25519 } from '@noble/curves/ed25519';
 * const priv = 'a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4';
 * const pub = 'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c';
 * x25519.getSharedSecret(priv, pub) === x25519.scalarMult(priv, pub); // aliases
 * x25519.getPublicKey(priv) === x25519.scalarMultBase(priv);
 * x25519.getPublicKey(x25519.utils.randomSecretKey());
 */
const x25519 = /* @__PURE__ */ (() => {
    const P = Fp.ORDER;
    return montgomery({
        P,
        type: 'x25519',
        powPminus2: (x) => {
            // x^(p-2) aka x^(2^255-21)
            const { pow_p_5_8, b2 } = ed25519_pow_2_252_3(x);
            return mod$1(pow2(pow_p_5_8, _3n, P) * b2, P);
        },
        adjustScalarBytes,
    });
})();

/**
 * Utilities for hex, bytes, CSPRNG.
 * @module
 */
/*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) */
/** Checks if something is Uint8Array. Be careful: nodejs Buffer will return true. */
function isBytes(a) {
    return a instanceof Uint8Array || (ArrayBuffer.isView(a) && a.constructor.name === 'Uint8Array');
}
/** Asserts something is boolean. */
function abool(b) {
    if (typeof b !== 'boolean')
        throw new Error(`boolean expected, not ${b}`);
}
/** Asserts something is positive integer. */
function anumber(n) {
    if (!Number.isSafeInteger(n) || n < 0)
        throw new Error('positive integer expected, got ' + n);
}
/** Asserts something is Uint8Array. */
function abytes(b, ...lengths) {
    if (!isBytes(b))
        throw new Error('Uint8Array expected');
    if (lengths.length > 0 && !lengths.includes(b.length))
        throw new Error('Uint8Array expected of length ' + lengths + ', got length=' + b.length);
}
/** Asserts a hash instance has not been destroyed / finished */
function aexists(instance, checkFinished = true) {
    if (instance.destroyed)
        throw new Error('Hash instance has been destroyed');
    if (checkFinished && instance.finished)
        throw new Error('Hash#digest() has already been called');
}
/** Asserts output is properly-sized byte array */
function aoutput(out, instance) {
    abytes(out);
    const min = instance.outputLen;
    if (out.length < min) {
        throw new Error('digestInto() expects output buffer of length at least ' + min);
    }
}
/** Cast u8 / u16 / u32 to u8. */
function u8(arr) {
    return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
/** Cast u8 / u16 / u32 to u32. */
function u32(arr) {
    return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
/** Zeroize a byte array. Warning: JS provides no guarantees. */
function clean(...arrays) {
    for (let i = 0; i < arrays.length; i++) {
        arrays[i].fill(0);
    }
}
/** Create DataView of an array for easy byte-level manipulation. */
function createView(arr) {
    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
/** Is current platform little-endian? Most are. Big-Endian platform: IBM */
const isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44)();
/**
 * Converts string to bytes using UTF8 encoding.
 * @example utf8ToBytes('abc') // new Uint8Array([97, 98, 99])
 */
function utf8ToBytes(str) {
    if (typeof str !== 'string')
        throw new Error('string expected');
    return new Uint8Array(new TextEncoder().encode(str)); // https://bugzil.la/1681809
}
/**
 * Normalizes (non-hex) string or Uint8Array to Uint8Array.
 * Warning: when Uint8Array is passed, it would NOT get copied.
 * Keep in mind for future mutable operations.
 */
function toBytes(data) {
    if (typeof data === 'string')
        data = utf8ToBytes(data);
    else if (isBytes(data))
        data = copyBytes(data);
    else
        throw new Error('Uint8Array expected, got ' + typeof data);
    return data;
}
function checkOpts(defaults, opts) {
    if (opts == null || typeof opts !== 'object')
        throw new Error('options must be defined');
    const merged = Object.assign(defaults, opts);
    return merged;
}
/** Compares 2 uint8array-s in kinda constant time. */
function equalBytes(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}
/**
 * Wraps a cipher: validates args, ensures encrypt() can only be called once.
 * @__NO_SIDE_EFFECTS__
 */
const wrapCipher = (params, constructor) => {
    function wrappedCipher(key, ...args) {
        // Validate key
        abytes(key);
        // Big-Endian hardware is rare. Just in case someone still decides to run ciphers:
        if (!isLE)
            throw new Error('Non little-endian hardware is not yet supported');
        // Validate nonce if nonceLength is present
        if (params.nonceLength !== undefined) {
            const nonce = args[0];
            if (!nonce)
                throw new Error('nonce / iv required');
            if (params.varSizeNonce)
                abytes(nonce);
            else
                abytes(nonce, params.nonceLength);
        }
        // Validate AAD if tagLength present
        const tagl = params.tagLength;
        if (tagl && args[1] !== undefined) {
            abytes(args[1]);
        }
        const cipher = constructor(key, ...args);
        const checkOutput = (fnLength, output) => {
            if (output !== undefined) {
                if (fnLength !== 2)
                    throw new Error('cipher output not supported');
                abytes(output);
            }
        };
        // Create wrapped cipher with validation and single-use encryption
        let called = false;
        const wrCipher = {
            encrypt(data, output) {
                if (called)
                    throw new Error('cannot encrypt() twice with same key + nonce');
                called = true;
                abytes(data);
                checkOutput(cipher.encrypt.length, output);
                return cipher.encrypt(data, output);
            },
            decrypt(data, output) {
                abytes(data);
                if (tagl && data.length < tagl)
                    throw new Error('invalid ciphertext length: smaller than tagLength=' + tagl);
                checkOutput(cipher.decrypt.length, output);
                return cipher.decrypt(data, output);
            },
        };
        return wrCipher;
    }
    Object.assign(wrappedCipher, params);
    return wrappedCipher;
};
/**
 * By default, returns u8a of length.
 * When out is available, it checks it for validity and uses it.
 */
function getOutput(expectedLength, out, onlyAligned = true) {
    if (out === undefined)
        return new Uint8Array(expectedLength);
    if (out.length !== expectedLength)
        throw new Error('invalid output length, expected ' + expectedLength + ', got: ' + out.length);
    if (onlyAligned && !isAligned32$1(out))
        throw new Error('invalid output, must be aligned');
    return out;
}
/** Polyfill for Safari 14. */
function setBigUint64(view, byteOffset, value, isLE) {
    if (typeof view.setBigUint64 === 'function')
        return view.setBigUint64(byteOffset, value, isLE);
    const _32n = BigInt(32);
    const _u32_max = BigInt(0xffffffff);
    const wh = Number((value >> _32n) & _u32_max);
    const wl = Number(value & _u32_max);
    const h = isLE ? 4 : 0;
    const l = isLE ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE);
    view.setUint32(byteOffset + l, wl, isLE);
}
function u64Lengths(dataLength, aadLength, isLE) {
    abool(isLE);
    const num = new Uint8Array(16);
    const view = createView(num);
    setBigUint64(view, 0, BigInt(aadLength), isLE);
    setBigUint64(view, 8, BigInt(dataLength), isLE);
    return num;
}
// Is byte array aligned to 4 byte offset (u32)?
function isAligned32$1(bytes) {
    return bytes.byteOffset % 4 === 0;
}
// copy bytes to new u8a (aligned). Because Buffer.slice is broken.
function copyBytes(bytes) {
    return Uint8Array.from(bytes);
}

/**
 * Basic utils for ARX (add-rotate-xor) salsa and chacha ciphers.

RFC8439 requires multi-step cipher stream, where
authKey starts with counter: 0, actual msg with counter: 1.

For this, we need a way to re-use nonce / counter:

    const counter = new Uint8Array(4);
    chacha(..., counter, ...); // counter is now 1
    chacha(..., counter, ...); // counter is now 2

This is complicated:

- 32-bit counters are enough, no need for 64-bit: max ArrayBuffer size in JS is 4GB
- Original papers don't allow mutating counters
- Counter overflow is undefined [^1]
- Idea A: allow providing (nonce | counter) instead of just nonce, re-use it
- Caveat: Cannot be re-used through all cases:
- * chacha has (counter | nonce)
- * xchacha has (nonce16 | counter | nonce16)
- Idea B: separate nonce / counter and provide separate API for counter re-use
- Caveat: there are different counter sizes depending on an algorithm.
- salsa & chacha also differ in structures of key & sigma:
  salsa20:      s[0] | k(4) | s[1] | nonce(2) | ctr(2) | s[2] | k(4) | s[3]
  chacha:       s(4) | k(8) | ctr(1) | nonce(3)
  chacha20orig: s(4) | k(8) | ctr(2) | nonce(2)
- Idea C: helper method such as `setSalsaState(key, nonce, sigma, data)`
- Caveat: we can't re-use counter array

xchacha [^2] uses the subkey and remaining 8 byte nonce with ChaCha20 as normal
(prefixed by 4 NUL bytes, since [RFC8439] specifies a 12-byte nonce).

[^1]: https://mailarchive.ietf.org/arch/msg/cfrg/gsOnTJzcbgG6OqD8Sc0GO5aR_tU/
[^2]: https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha#appendix-A.2

 * @module
 */
// prettier-ignore
// We can't make top-level var depend on utils.utf8ToBytes
// because it's not present in all envs. Creating a similar fn here
const _utf8ToBytes = (str) => Uint8Array.from(str.split('').map((c) => c.charCodeAt(0)));
const sigma16 = _utf8ToBytes('expand 16-byte k');
const sigma32 = _utf8ToBytes('expand 32-byte k');
const sigma16_32 = u32(sigma16);
const sigma32_32 = u32(sigma32);
function rotl(a, b) {
    return (a << b) | (a >>> (32 - b));
}
// Is byte array aligned to 4 byte offset (u32)?
function isAligned32(b) {
    return b.byteOffset % 4 === 0;
}
// Salsa and Chacha block length is always 512-bit
const BLOCK_LEN = 64;
const BLOCK_LEN32 = 16;
// new Uint32Array([2**32])   // => Uint32Array(1) [ 0 ]
// new Uint32Array([2**32-1]) // => Uint32Array(1) [ 4294967295 ]
const MAX_COUNTER = 2 ** 32 - 1;
const U32_EMPTY = new Uint32Array();
function runCipher(core, sigma, key, nonce, data, output, counter, rounds) {
    const len = data.length;
    const block = new Uint8Array(BLOCK_LEN);
    const b32 = u32(block);
    // Make sure that buffers aligned to 4 bytes
    const isAligned = isAligned32(data) && isAligned32(output);
    const d32 = isAligned ? u32(data) : U32_EMPTY;
    const o32 = isAligned ? u32(output) : U32_EMPTY;
    for (let pos = 0; pos < len; counter++) {
        core(sigma, key, nonce, b32, counter, rounds);
        if (counter >= MAX_COUNTER)
            throw new Error('arx: counter overflow');
        const take = Math.min(BLOCK_LEN, len - pos);
        // aligned to 4 bytes
        if (isAligned && take === BLOCK_LEN) {
            const pos32 = pos / 4;
            if (pos % 4 !== 0)
                throw new Error('arx: invalid block position');
            for (let j = 0, posj; j < BLOCK_LEN32; j++) {
                posj = pos32 + j;
                o32[posj] = d32[posj] ^ b32[j];
            }
            pos += BLOCK_LEN;
            continue;
        }
        for (let j = 0, posj; j < take; j++) {
            posj = pos + j;
            output[posj] = data[posj] ^ block[j];
        }
        pos += take;
    }
}
/** Creates ARX-like (ChaCha, Salsa) cipher stream from core function. */
function createCipher(core, opts) {
    const { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts({ allowShortKeys: false, counterLength: 8, counterRight: false, rounds: 20 }, opts);
    if (typeof core !== 'function')
        throw new Error('core must be a function');
    anumber(counterLength);
    anumber(rounds);
    abool(counterRight);
    abool(allowShortKeys);
    return (key, nonce, data, output, counter = 0) => {
        abytes(key);
        abytes(nonce);
        abytes(data);
        const len = data.length;
        if (output === undefined)
            output = new Uint8Array(len);
        abytes(output);
        anumber(counter);
        if (counter < 0 || counter >= MAX_COUNTER)
            throw new Error('arx: counter overflow');
        if (output.length < len)
            throw new Error(`arx: output (${output.length}) is shorter than data (${len})`);
        const toClean = [];
        // Key & sigma
        // key=16 -> sigma16, k=key|key
        // key=32 -> sigma32, k=key
        let l = key.length;
        let k;
        let sigma;
        if (l === 32) {
            toClean.push((k = copyBytes(key)));
            sigma = sigma32_32;
        }
        else if (l === 16 && allowShortKeys) {
            k = new Uint8Array(32);
            k.set(key);
            k.set(key, 16);
            sigma = sigma16_32;
            toClean.push(k);
        }
        else {
            throw new Error(`arx: invalid 32-byte key, got length=${l}`);
        }
        // Nonce
        // salsa20:      8   (8-byte counter)
        // chacha20orig: 8   (8-byte counter)
        // chacha20:     12  (4-byte counter)
        // xsalsa20:     24  (16 -> hsalsa,  8 -> old nonce)
        // xchacha20:    24  (16 -> hchacha, 8 -> old nonce)
        // Align nonce to 4 bytes
        if (!isAligned32(nonce))
            toClean.push((nonce = copyBytes(nonce)));
        const k32 = u32(k);
        // hsalsa & hchacha: handle extended nonce
        if (extendNonceFn) {
            if (nonce.length !== 24)
                throw new Error(`arx: extended nonce must be 24 bytes`);
            extendNonceFn(sigma, k32, u32(nonce.subarray(0, 16)), k32);
            nonce = nonce.subarray(16);
        }
        // Handle nonce counter
        const nonceNcLen = 16 - counterLength;
        if (nonceNcLen !== nonce.length)
            throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
        // Pad counter when nonce is 64 bit
        if (nonceNcLen !== 12) {
            const nc = new Uint8Array(12);
            nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
            nonce = nc;
            toClean.push(nonce);
        }
        const n32 = u32(nonce);
        runCipher(core, sigma, k32, n32, data, output, counter, rounds);
        clean(...toClean);
        return output;
    };
}

/**
 * Poly1305 ([PDF](https://cr.yp.to/mac/poly1305-20050329.pdf),
 * [wiki](https://en.wikipedia.org/wiki/Poly1305))
 * is a fast and parallel secret-key message-authentication code suitable for
 * a wide variety of applications. It was standardized in
 * [RFC 8439](https://datatracker.ietf.org/doc/html/rfc8439) and is now used in TLS 1.3.
 *
 * Polynomial MACs are not perfect for every situation:
 * they lack Random Key Robustness: the MAC can be forged, and can't be used in PAKE schemes.
 * See [invisible salamanders attack](https://keymaterial.net/2020/09/07/invisible-salamanders-in-aes-gcm-siv/).
 * To combat invisible salamanders, `hash(key)` can be included in ciphertext,
 * however, this would violate ciphertext indistinguishability:
 * an attacker would know which key was used - so `HKDF(key, i)`
 * could be used instead.
 *
 * Check out [original website](https://cr.yp.to/mac.html).
 * @module
 */
// Based on Public Domain poly1305-donna https://github.com/floodyberry/poly1305-donna
const u8to16 = (a, i) => (a[i++] & 0xff) | ((a[i++] & 0xff) << 8);
class Poly1305 {
    constructor(key) {
        this.blockLen = 16;
        this.outputLen = 16;
        this.buffer = new Uint8Array(16);
        this.r = new Uint16Array(10);
        this.h = new Uint16Array(10);
        this.pad = new Uint16Array(8);
        this.pos = 0;
        this.finished = false;
        key = toBytes(key);
        abytes(key, 32);
        const t0 = u8to16(key, 0);
        const t1 = u8to16(key, 2);
        const t2 = u8to16(key, 4);
        const t3 = u8to16(key, 6);
        const t4 = u8to16(key, 8);
        const t5 = u8to16(key, 10);
        const t6 = u8to16(key, 12);
        const t7 = u8to16(key, 14);
        // https://github.com/floodyberry/poly1305-donna/blob/e6ad6e091d30d7f4ec2d4f978be1fcfcbce72781/poly1305-donna-16.h#L47
        this.r[0] = t0 & 0x1fff;
        this.r[1] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
        this.r[2] = ((t1 >>> 10) | (t2 << 6)) & 0x1f03;
        this.r[3] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
        this.r[4] = ((t3 >>> 4) | (t4 << 12)) & 0x00ff;
        this.r[5] = (t4 >>> 1) & 0x1ffe;
        this.r[6] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
        this.r[7] = ((t5 >>> 11) | (t6 << 5)) & 0x1f81;
        this.r[8] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
        this.r[9] = (t7 >>> 5) & 0x007f;
        for (let i = 0; i < 8; i++)
            this.pad[i] = u8to16(key, 16 + 2 * i);
    }
    process(data, offset, isLast = false) {
        const hibit = isLast ? 0 : 1 << 11;
        const { h, r } = this;
        const r0 = r[0];
        const r1 = r[1];
        const r2 = r[2];
        const r3 = r[3];
        const r4 = r[4];
        const r5 = r[5];
        const r6 = r[6];
        const r7 = r[7];
        const r8 = r[8];
        const r9 = r[9];
        const t0 = u8to16(data, offset + 0);
        const t1 = u8to16(data, offset + 2);
        const t2 = u8to16(data, offset + 4);
        const t3 = u8to16(data, offset + 6);
        const t4 = u8to16(data, offset + 8);
        const t5 = u8to16(data, offset + 10);
        const t6 = u8to16(data, offset + 12);
        const t7 = u8to16(data, offset + 14);
        let h0 = h[0] + (t0 & 0x1fff);
        let h1 = h[1] + (((t0 >>> 13) | (t1 << 3)) & 0x1fff);
        let h2 = h[2] + (((t1 >>> 10) | (t2 << 6)) & 0x1fff);
        let h3 = h[3] + (((t2 >>> 7) | (t3 << 9)) & 0x1fff);
        let h4 = h[4] + (((t3 >>> 4) | (t4 << 12)) & 0x1fff);
        let h5 = h[5] + ((t4 >>> 1) & 0x1fff);
        let h6 = h[6] + (((t4 >>> 14) | (t5 << 2)) & 0x1fff);
        let h7 = h[7] + (((t5 >>> 11) | (t6 << 5)) & 0x1fff);
        let h8 = h[8] + (((t6 >>> 8) | (t7 << 8)) & 0x1fff);
        let h9 = h[9] + ((t7 >>> 5) | hibit);
        let c = 0;
        let d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
        c = d0 >>> 13;
        d0 &= 0x1fff;
        d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
        c += d0 >>> 13;
        d0 &= 0x1fff;
        let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
        c = d1 >>> 13;
        d1 &= 0x1fff;
        d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
        c += d1 >>> 13;
        d1 &= 0x1fff;
        let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
        c = d2 >>> 13;
        d2 &= 0x1fff;
        d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
        c += d2 >>> 13;
        d2 &= 0x1fff;
        let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
        c = d3 >>> 13;
        d3 &= 0x1fff;
        d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
        c += d3 >>> 13;
        d3 &= 0x1fff;
        let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
        c = d4 >>> 13;
        d4 &= 0x1fff;
        d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
        c += d4 >>> 13;
        d4 &= 0x1fff;
        let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
        c = d5 >>> 13;
        d5 &= 0x1fff;
        d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
        c += d5 >>> 13;
        d5 &= 0x1fff;
        let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
        c = d6 >>> 13;
        d6 &= 0x1fff;
        d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
        c += d6 >>> 13;
        d6 &= 0x1fff;
        let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
        c = d7 >>> 13;
        d7 &= 0x1fff;
        d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
        c += d7 >>> 13;
        d7 &= 0x1fff;
        let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
        c = d8 >>> 13;
        d8 &= 0x1fff;
        d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
        c += d8 >>> 13;
        d8 &= 0x1fff;
        let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
        c = d9 >>> 13;
        d9 &= 0x1fff;
        d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
        c += d9 >>> 13;
        d9 &= 0x1fff;
        c = ((c << 2) + c) | 0;
        c = (c + d0) | 0;
        d0 = c & 0x1fff;
        c = c >>> 13;
        d1 += c;
        h[0] = d0;
        h[1] = d1;
        h[2] = d2;
        h[3] = d3;
        h[4] = d4;
        h[5] = d5;
        h[6] = d6;
        h[7] = d7;
        h[8] = d8;
        h[9] = d9;
    }
    finalize() {
        const { h, pad } = this;
        const g = new Uint16Array(10);
        let c = h[1] >>> 13;
        h[1] &= 0x1fff;
        for (let i = 2; i < 10; i++) {
            h[i] += c;
            c = h[i] >>> 13;
            h[i] &= 0x1fff;
        }
        h[0] += c * 5;
        c = h[0] >>> 13;
        h[0] &= 0x1fff;
        h[1] += c;
        c = h[1] >>> 13;
        h[1] &= 0x1fff;
        h[2] += c;
        g[0] = h[0] + 5;
        c = g[0] >>> 13;
        g[0] &= 0x1fff;
        for (let i = 1; i < 10; i++) {
            g[i] = h[i] + c;
            c = g[i] >>> 13;
            g[i] &= 0x1fff;
        }
        g[9] -= 1 << 13;
        let mask = (c ^ 1) - 1;
        for (let i = 0; i < 10; i++)
            g[i] &= mask;
        mask = ~mask;
        for (let i = 0; i < 10; i++)
            h[i] = (h[i] & mask) | g[i];
        h[0] = (h[0] | (h[1] << 13)) & 0xffff;
        h[1] = ((h[1] >>> 3) | (h[2] << 10)) & 0xffff;
        h[2] = ((h[2] >>> 6) | (h[3] << 7)) & 0xffff;
        h[3] = ((h[3] >>> 9) | (h[4] << 4)) & 0xffff;
        h[4] = ((h[4] >>> 12) | (h[5] << 1) | (h[6] << 14)) & 0xffff;
        h[5] = ((h[6] >>> 2) | (h[7] << 11)) & 0xffff;
        h[6] = ((h[7] >>> 5) | (h[8] << 8)) & 0xffff;
        h[7] = ((h[8] >>> 8) | (h[9] << 5)) & 0xffff;
        let f = h[0] + pad[0];
        h[0] = f & 0xffff;
        for (let i = 1; i < 8; i++) {
            f = (((h[i] + pad[i]) | 0) + (f >>> 16)) | 0;
            h[i] = f & 0xffff;
        }
        clean(g);
    }
    update(data) {
        aexists(this);
        data = toBytes(data);
        abytes(data);
        const { buffer, blockLen } = this;
        const len = data.length;
        for (let pos = 0; pos < len;) {
            const take = Math.min(blockLen - this.pos, len - pos);
            // Fast path: we have at least one block in input
            if (take === blockLen) {
                for (; blockLen <= len - pos; pos += blockLen)
                    this.process(data, pos);
                continue;
            }
            buffer.set(data.subarray(pos, pos + take), this.pos);
            this.pos += take;
            pos += take;
            if (this.pos === blockLen) {
                this.process(buffer, 0, false);
                this.pos = 0;
            }
        }
        return this;
    }
    destroy() {
        clean(this.h, this.r, this.buffer, this.pad);
    }
    digestInto(out) {
        aexists(this);
        aoutput(out, this);
        this.finished = true;
        const { buffer, h } = this;
        let { pos } = this;
        if (pos) {
            buffer[pos++] = 1;
            for (; pos < 16; pos++)
                buffer[pos] = 0;
            this.process(buffer, 0, true);
        }
        this.finalize();
        let opos = 0;
        for (let i = 0; i < 8; i++) {
            out[opos++] = h[i] >>> 0;
            out[opos++] = h[i] >>> 8;
        }
        return out;
    }
    digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
    }
}
function wrapConstructorWithKey$1(hashCons) {
    const hashC = (msg, key) => hashCons(key).update(toBytes(msg)).digest();
    const tmp = hashCons(new Uint8Array(32));
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = (key) => hashCons(key);
    return hashC;
}
/** Poly1305 MAC from RFC 8439. */
const poly1305 = wrapConstructorWithKey$1((key) => new Poly1305(key));

/**
 * [ChaCha20](https://cr.yp.to/chacha.html) stream cipher, released
 * in 2008. Developed after Salsa20, ChaCha aims to increase diffusion per round.
 * It was standardized in [RFC 8439](https://datatracker.ietf.org/doc/html/rfc8439) and
 * is now used in TLS 1.3.
 *
 * [XChaCha20](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha)
 * extended-nonce variant is also provided. Similar to XSalsa, it's safe to use with
 * randomly-generated nonces.
 *
 * Check out [PDF](http://cr.yp.to/chacha/chacha-20080128.pdf) and
 * [wiki](https://en.wikipedia.org/wiki/Salsa20).
 * @module
 */
/**
 * ChaCha core function.
 */
// prettier-ignore
function chachaCore(s, k, n, out, cnt, rounds = 20) {
    let y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], // "expa"   "nd 3"  "2-by"  "te k"
    y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], // Key      Key     Key     Key
    y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], // Key      Key     Key     Key
    y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2]; // Counter  Counter	Nonce   Nonce
    // Save state to temporary variables
    let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
    for (let r = 0; r < rounds; r += 2) {
        x00 = (x00 + x04) | 0;
        x12 = rotl(x12 ^ x00, 16);
        x08 = (x08 + x12) | 0;
        x04 = rotl(x04 ^ x08, 12);
        x00 = (x00 + x04) | 0;
        x12 = rotl(x12 ^ x00, 8);
        x08 = (x08 + x12) | 0;
        x04 = rotl(x04 ^ x08, 7);
        x01 = (x01 + x05) | 0;
        x13 = rotl(x13 ^ x01, 16);
        x09 = (x09 + x13) | 0;
        x05 = rotl(x05 ^ x09, 12);
        x01 = (x01 + x05) | 0;
        x13 = rotl(x13 ^ x01, 8);
        x09 = (x09 + x13) | 0;
        x05 = rotl(x05 ^ x09, 7);
        x02 = (x02 + x06) | 0;
        x14 = rotl(x14 ^ x02, 16);
        x10 = (x10 + x14) | 0;
        x06 = rotl(x06 ^ x10, 12);
        x02 = (x02 + x06) | 0;
        x14 = rotl(x14 ^ x02, 8);
        x10 = (x10 + x14) | 0;
        x06 = rotl(x06 ^ x10, 7);
        x03 = (x03 + x07) | 0;
        x15 = rotl(x15 ^ x03, 16);
        x11 = (x11 + x15) | 0;
        x07 = rotl(x07 ^ x11, 12);
        x03 = (x03 + x07) | 0;
        x15 = rotl(x15 ^ x03, 8);
        x11 = (x11 + x15) | 0;
        x07 = rotl(x07 ^ x11, 7);
        x00 = (x00 + x05) | 0;
        x15 = rotl(x15 ^ x00, 16);
        x10 = (x10 + x15) | 0;
        x05 = rotl(x05 ^ x10, 12);
        x00 = (x00 + x05) | 0;
        x15 = rotl(x15 ^ x00, 8);
        x10 = (x10 + x15) | 0;
        x05 = rotl(x05 ^ x10, 7);
        x01 = (x01 + x06) | 0;
        x12 = rotl(x12 ^ x01, 16);
        x11 = (x11 + x12) | 0;
        x06 = rotl(x06 ^ x11, 12);
        x01 = (x01 + x06) | 0;
        x12 = rotl(x12 ^ x01, 8);
        x11 = (x11 + x12) | 0;
        x06 = rotl(x06 ^ x11, 7);
        x02 = (x02 + x07) | 0;
        x13 = rotl(x13 ^ x02, 16);
        x08 = (x08 + x13) | 0;
        x07 = rotl(x07 ^ x08, 12);
        x02 = (x02 + x07) | 0;
        x13 = rotl(x13 ^ x02, 8);
        x08 = (x08 + x13) | 0;
        x07 = rotl(x07 ^ x08, 7);
        x03 = (x03 + x04) | 0;
        x14 = rotl(x14 ^ x03, 16);
        x09 = (x09 + x14) | 0;
        x04 = rotl(x04 ^ x09, 12);
        x03 = (x03 + x04) | 0;
        x14 = rotl(x14 ^ x03, 8);
        x09 = (x09 + x14) | 0;
        x04 = rotl(x04 ^ x09, 7);
    }
    // Write output
    let oi = 0;
    out[oi++] = (y00 + x00) | 0;
    out[oi++] = (y01 + x01) | 0;
    out[oi++] = (y02 + x02) | 0;
    out[oi++] = (y03 + x03) | 0;
    out[oi++] = (y04 + x04) | 0;
    out[oi++] = (y05 + x05) | 0;
    out[oi++] = (y06 + x06) | 0;
    out[oi++] = (y07 + x07) | 0;
    out[oi++] = (y08 + x08) | 0;
    out[oi++] = (y09 + x09) | 0;
    out[oi++] = (y10 + x10) | 0;
    out[oi++] = (y11 + x11) | 0;
    out[oi++] = (y12 + x12) | 0;
    out[oi++] = (y13 + x13) | 0;
    out[oi++] = (y14 + x14) | 0;
    out[oi++] = (y15 + x15) | 0;
}
/**
 * ChaCha stream cipher. Conforms to RFC 8439 (IETF, TLS). 12-byte nonce, 4-byte counter.
 * With 12-byte nonce, it's not safe to use fill it with random (CSPRNG), due to collision chance.
 */
const chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
    counterRight: false,
    counterLength: 4,
    allowShortKeys: false,
});
const ZEROS16$1 = /* @__PURE__ */ new Uint8Array(16);
// Pad to digest size with zeros
const updatePadded = (h, msg) => {
    h.update(msg);
    const left = msg.length % 16;
    if (left)
        h.update(ZEROS16$1.subarray(left));
};
const ZEROS32$1 = /* @__PURE__ */ new Uint8Array(32);
function computeTag$1(fn, key, nonce, data, AAD) {
    const authKey = fn(key, nonce, ZEROS32$1);
    const h = poly1305.create(authKey);
    if (AAD)
        updatePadded(h, AAD);
    updatePadded(h, data);
    const num = u64Lengths(data.length, AAD ? AAD.length : 0, true);
    h.update(num);
    const res = h.digest();
    clean(authKey, num);
    return res;
}
/**
 * AEAD algorithm from RFC 8439.
 * Salsa20 and chacha (RFC 8439) use poly1305 differently.
 * We could have composed them similar to:
 * https://github.com/paulmillr/scure-base/blob/b266c73dde977b1dd7ef40ef7a23cc15aab526b3/index.ts#L250
 * But it's hard because of authKey:
 * In salsa20, authKey changes position in salsa stream.
 * In chacha, authKey can't be computed inside computeTag, it modifies the counter.
 */
const _poly1305_aead = (xorStream) => (key, nonce, AAD) => {
    const tagLength = 16;
    return {
        encrypt(plaintext, output) {
            const plength = plaintext.length;
            output = getOutput(plength + tagLength, output, false);
            output.set(plaintext);
            const oPlain = output.subarray(0, -tagLength);
            xorStream(key, nonce, oPlain, oPlain, 1);
            const tag = computeTag$1(xorStream, key, nonce, oPlain, AAD);
            output.set(tag, plength); // append tag
            clean(tag);
            return output;
        },
        decrypt(ciphertext, output) {
            output = getOutput(ciphertext.length - tagLength, output, false);
            const data = ciphertext.subarray(0, -tagLength);
            const passedTag = ciphertext.subarray(-tagLength);
            const tag = computeTag$1(xorStream, key, nonce, data, AAD);
            if (!equalBytes(passedTag, tag))
                throw new Error('invalid tag');
            output.set(ciphertext.subarray(0, -tagLength));
            xorStream(key, nonce, output, output, 1); // start stream with i=1
            clean(tag);
            return output;
        },
    };
};
/**
 * ChaCha20-Poly1305 from RFC 8439.
 *
 * Unsafe to use random nonces under the same key, due to collision chance.
 * Prefer XChaCha instead.
 */
const chacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 12, tagLength: 16 }, _poly1305_aead(chacha20));

/**
 * GHash from AES-GCM and its little-endian "mirror image" Polyval from AES-SIV.
 *
 * Implemented in terms of GHash with conversion function for keys
 * GCM GHASH from
 * [NIST SP800-38d](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf),
 * SIV from
 * [RFC 8452](https://datatracker.ietf.org/doc/html/rfc8452).
 *
 * GHASH   modulo: x^128 + x^7   + x^2   + x     + 1
 * POLYVAL modulo: x^128 + x^127 + x^126 + x^121 + 1
 *
 * @module
 */
// prettier-ignore
const BLOCK_SIZE$1 = 16;
// TODO: rewrite
// temporary padding buffer
const ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
const ZEROS32 = u32(ZEROS16);
const POLY$1 = 0xe1; // v = 2*v % POLY
// v = 2*v % POLY
// NOTE: because x + x = 0 (add/sub is same), mul2(x) != x+x
// We can multiply any number using montgomery ladder and this function (works as double, add is simple xor)
const mul2$1 = (s0, s1, s2, s3) => {
    const hiBit = s3 & 1;
    return {
        s3: (s2 << 31) | (s3 >>> 1),
        s2: (s1 << 31) | (s2 >>> 1),
        s1: (s0 << 31) | (s1 >>> 1),
        s0: (s0 >>> 1) ^ ((POLY$1 << 24) & -(hiBit & 1)), // reduce % poly
    };
};
const swapLE = (n) => (((n >>> 0) & 0xff) << 24) |
    (((n >>> 8) & 0xff) << 16) |
    (((n >>> 16) & 0xff) << 8) |
    ((n >>> 24) & 0xff) |
    0;
/**
 * `mulX_POLYVAL(ByteReverse(H))` from spec
 * @param k mutated in place
 */
function _toGHASHKey(k) {
    k.reverse();
    const hiBit = k[15] & 1;
    // k >>= 1
    let carry = 0;
    for (let i = 0; i < k.length; i++) {
        const t = k[i];
        k[i] = (t >>> 1) | carry;
        carry = (t & 1) << 7;
    }
    k[0] ^= -hiBit & 0xe1; // if (hiBit) n ^= 0xe1000000000000000000000000000000;
    return k;
}
const estimateWindow = (bytes) => {
    if (bytes > 64 * 1024)
        return 8;
    if (bytes > 1024)
        return 4;
    return 2;
};
class GHASH {
    // We select bits per window adaptively based on expectedLength
    constructor(key, expectedLength) {
        this.blockLen = BLOCK_SIZE$1;
        this.outputLen = BLOCK_SIZE$1;
        this.s0 = 0;
        this.s1 = 0;
        this.s2 = 0;
        this.s3 = 0;
        this.finished = false;
        key = toBytes(key);
        abytes(key, 16);
        const kView = createView(key);
        let k0 = kView.getUint32(0, false);
        let k1 = kView.getUint32(4, false);
        let k2 = kView.getUint32(8, false);
        let k3 = kView.getUint32(12, false);
        // generate table of doubled keys (half of montgomery ladder)
        const doubles = [];
        for (let i = 0; i < 128; i++) {
            doubles.push({ s0: swapLE(k0), s1: swapLE(k1), s2: swapLE(k2), s3: swapLE(k3) });
            ({ s0: k0, s1: k1, s2: k2, s3: k3 } = mul2$1(k0, k1, k2, k3));
        }
        const W = estimateWindow(expectedLength || 1024);
        if (![1, 2, 4, 8].includes(W))
            throw new Error('ghash: invalid window size, expected 2, 4 or 8');
        this.W = W;
        const bits = 128; // always 128 bits;
        const windows = bits / W;
        const windowSize = (this.windowSize = 2 ** W);
        const items = [];
        // Create precompute table for window of W bits
        for (let w = 0; w < windows; w++) {
            // truth table: 00, 01, 10, 11
            for (let byte = 0; byte < windowSize; byte++) {
                // prettier-ignore
                let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
                for (let j = 0; j < W; j++) {
                    const bit = (byte >>> (W - j - 1)) & 1;
                    if (!bit)
                        continue;
                    const { s0: d0, s1: d1, s2: d2, s3: d3 } = doubles[W * w + j];
                    (s0 ^= d0), (s1 ^= d1), (s2 ^= d2), (s3 ^= d3);
                }
                items.push({ s0, s1, s2, s3 });
            }
        }
        this.t = items;
    }
    _updateBlock(s0, s1, s2, s3) {
        (s0 ^= this.s0), (s1 ^= this.s1), (s2 ^= this.s2), (s3 ^= this.s3);
        const { W, t, windowSize } = this;
        // prettier-ignore
        let o0 = 0, o1 = 0, o2 = 0, o3 = 0;
        const mask = (1 << W) - 1; // 2**W will kill performance.
        let w = 0;
        for (const num of [s0, s1, s2, s3]) {
            for (let bytePos = 0; bytePos < 4; bytePos++) {
                const byte = (num >>> (8 * bytePos)) & 0xff;
                for (let bitPos = 8 / W - 1; bitPos >= 0; bitPos--) {
                    const bit = (byte >>> (W * bitPos)) & mask;
                    const { s0: e0, s1: e1, s2: e2, s3: e3 } = t[w * windowSize + bit];
                    (o0 ^= e0), (o1 ^= e1), (o2 ^= e2), (o3 ^= e3);
                    w += 1;
                }
            }
        }
        this.s0 = o0;
        this.s1 = o1;
        this.s2 = o2;
        this.s3 = o3;
    }
    update(data) {
        aexists(this);
        data = toBytes(data);
        abytes(data);
        const b32 = u32(data);
        const blocks = Math.floor(data.length / BLOCK_SIZE$1);
        const left = data.length % BLOCK_SIZE$1;
        for (let i = 0; i < blocks; i++) {
            this._updateBlock(b32[i * 4 + 0], b32[i * 4 + 1], b32[i * 4 + 2], b32[i * 4 + 3]);
        }
        if (left) {
            ZEROS16.set(data.subarray(blocks * BLOCK_SIZE$1));
            this._updateBlock(ZEROS32[0], ZEROS32[1], ZEROS32[2], ZEROS32[3]);
            clean(ZEROS32); // clean tmp buffer
        }
        return this;
    }
    destroy() {
        const { t } = this;
        // clean precompute table
        for (const elm of t) {
            (elm.s0 = 0), (elm.s1 = 0), (elm.s2 = 0), (elm.s3 = 0);
        }
    }
    digestInto(out) {
        aexists(this);
        aoutput(out, this);
        this.finished = true;
        const { s0, s1, s2, s3 } = this;
        const o32 = u32(out);
        o32[0] = s0;
        o32[1] = s1;
        o32[2] = s2;
        o32[3] = s3;
        return out;
    }
    digest() {
        const res = new Uint8Array(BLOCK_SIZE$1);
        this.digestInto(res);
        this.destroy();
        return res;
    }
}
class Polyval extends GHASH {
    constructor(key, expectedLength) {
        key = toBytes(key);
        abytes(key);
        const ghKey = _toGHASHKey(copyBytes(key));
        super(ghKey, expectedLength);
        clean(ghKey);
    }
    update(data) {
        data = toBytes(data);
        aexists(this);
        const b32 = u32(data);
        const left = data.length % BLOCK_SIZE$1;
        const blocks = Math.floor(data.length / BLOCK_SIZE$1);
        for (let i = 0; i < blocks; i++) {
            this._updateBlock(swapLE(b32[i * 4 + 3]), swapLE(b32[i * 4 + 2]), swapLE(b32[i * 4 + 1]), swapLE(b32[i * 4 + 0]));
        }
        if (left) {
            ZEROS16.set(data.subarray(blocks * BLOCK_SIZE$1));
            this._updateBlock(swapLE(ZEROS32[3]), swapLE(ZEROS32[2]), swapLE(ZEROS32[1]), swapLE(ZEROS32[0]));
            clean(ZEROS32);
        }
        return this;
    }
    digestInto(out) {
        aexists(this);
        aoutput(out, this);
        this.finished = true;
        // tmp ugly hack
        const { s0, s1, s2, s3 } = this;
        const o32 = u32(out);
        o32[0] = s0;
        o32[1] = s1;
        o32[2] = s2;
        o32[3] = s3;
        return out.reverse();
    }
}
function wrapConstructorWithKey(hashCons) {
    const hashC = (msg, key) => hashCons(key, msg.length).update(toBytes(msg)).digest();
    const tmp = hashCons(new Uint8Array(16), 0);
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = (key, expectedLength) => hashCons(key, expectedLength);
    return hashC;
}
/** GHash MAC for AES-GCM. */
const ghash = wrapConstructorWithKey((key, expectedLength) => new GHASH(key, expectedLength));
/** Polyval MAC for AES-SIV. */
wrapConstructorWithKey((key, expectedLength) => new Polyval(key, expectedLength));

/**
 * [AES](https://en.wikipedia.org/wiki/Advanced_Encryption_Standard)
 * a.k.a. Advanced Encryption Standard
 * is a variant of Rijndael block cipher, standardized by NIST in 2001.
 * We provide the fastest available pure JS implementation.
 *
 * Data is split into 128-bit blocks. Encrypted in 10/12/14 rounds (128/192/256 bits). In every round:
 * 1. **S-box**, table substitution
 * 2. **Shift rows**, cyclic shift left of all rows of data array
 * 3. **Mix columns**, multiplying every column by fixed polynomial
 * 4. **Add round key**, round_key xor i-th column of array
 *
 * Check out [FIPS-197](https://csrc.nist.gov/files/pubs/fips/197/final/docs/fips-197.pdf)
 * and [original proposal](https://csrc.nist.gov/csrc/media/projects/cryptographic-standards-and-guidelines/documents/aes-development/rijndael-ammended.pdf)
 * @module
 */
const BLOCK_SIZE = 16;
const BLOCK_SIZE32 = 4;
const EMPTY_BLOCK = /* @__PURE__ */ new Uint8Array(BLOCK_SIZE);
const POLY = 0x11b; // 1 + x + x**3 + x**4 + x**8
// TODO: remove multiplication, binary ops only
function mul2(n) {
    return (n << 1) ^ (POLY & -(n >> 7));
}
function mul(a, b) {
    let res = 0;
    for (; b > 0; b >>= 1) {
        // Montgomery ladder
        res ^= a & -(b & 1); // if (b&1) res ^=a (but const-time).
        a = mul2(a); // a = 2*a
    }
    return res;
}
// AES S-box is generated using finite field inversion,
// an affine transform, and xor of a constant 0x63.
const sbox = /* @__PURE__ */ (() => {
    const t = new Uint8Array(256);
    for (let i = 0, x = 1; i < 256; i++, x ^= mul2(x))
        t[i] = x;
    const box = new Uint8Array(256);
    box[0] = 0x63; // first elm
    for (let i = 0; i < 255; i++) {
        let x = t[255 - i];
        x |= x << 8;
        box[t[i]] = (x ^ (x >> 4) ^ (x >> 5) ^ (x >> 6) ^ (x >> 7) ^ 0x63) & 0xff;
    }
    clean(t);
    return box;
})();
// Rotate u32 by 8
const rotr32_8 = (n) => (n << 24) | (n >>> 8);
const rotl32_8 = (n) => (n << 8) | (n >>> 24);
// T-table is optimization suggested in 5.2 of original proposal (missed from FIPS-197). Changes:
// - LE instead of BE
// - bigger tables: T0 and T1 are merged into T01 table and T2 & T3 into T23;
//   so index is u16, instead of u8. This speeds up things, unexpectedly
function genTtable(sbox, fn) {
    if (sbox.length !== 256)
        throw new Error('Wrong sbox length');
    const T0 = new Uint32Array(256).map((_, j) => fn(sbox[j]));
    const T1 = T0.map(rotl32_8);
    const T2 = T1.map(rotl32_8);
    const T3 = T2.map(rotl32_8);
    const T01 = new Uint32Array(256 * 256);
    const T23 = new Uint32Array(256 * 256);
    const sbox2 = new Uint16Array(256 * 256);
    for (let i = 0; i < 256; i++) {
        for (let j = 0; j < 256; j++) {
            const idx = i * 256 + j;
            T01[idx] = T0[i] ^ T1[j];
            T23[idx] = T2[i] ^ T3[j];
            sbox2[idx] = (sbox[i] << 8) | sbox[j];
        }
    }
    return { sbox, sbox2, T0, T1, T2, T3, T01, T23 };
}
const tableEncoding = /* @__PURE__ */ genTtable(sbox, (s) => (mul(s, 3) << 24) | (s << 16) | (s << 8) | mul(s, 2));
const xPowers = /* @__PURE__ */ (() => {
    const p = new Uint8Array(16);
    for (let i = 0, x = 1; i < 16; i++, x = mul2(x))
        p[i] = x;
    return p;
})();
/** Key expansion used in CTR. */
function expandKeyLE(key) {
    abytes(key);
    const len = key.length;
    if (![16, 24, 32].includes(len))
        throw new Error('aes: invalid key size, should be 16, 24 or 32, got ' + len);
    const { sbox2 } = tableEncoding;
    const toClean = [];
    if (!isAligned32$1(key))
        toClean.push((key = copyBytes(key)));
    const k32 = u32(key);
    const Nk = k32.length;
    const subByte = (n) => applySbox(sbox2, n, n, n, n);
    const xk = new Uint32Array(len + 28); // expanded key
    xk.set(k32);
    // 4.3.1 Key expansion
    for (let i = Nk; i < xk.length; i++) {
        let t = xk[i - 1];
        if (i % Nk === 0)
            t = subByte(rotr32_8(t)) ^ xPowers[i / Nk - 1];
        else if (Nk > 6 && i % Nk === 4)
            t = subByte(t);
        xk[i] = xk[i - Nk] ^ t;
    }
    clean(...toClean);
    return xk;
}
// Apply tables
function apply0123(T01, T23, s0, s1, s2, s3) {
    return (T01[((s0 << 8) & 0xff00) | ((s1 >>> 8) & 0xff)] ^
        T23[((s2 >>> 8) & 0xff00) | ((s3 >>> 24) & 0xff)]);
}
function applySbox(sbox2, s0, s1, s2, s3) {
    return (sbox2[(s0 & 0xff) | (s1 & 0xff00)] |
        (sbox2[((s2 >>> 16) & 0xff) | ((s3 >>> 16) & 0xff00)] << 16));
}
function encrypt(xk, s0, s1, s2, s3) {
    const { sbox2, T01, T23 } = tableEncoding;
    let k = 0;
    (s0 ^= xk[k++]), (s1 ^= xk[k++]), (s2 ^= xk[k++]), (s3 ^= xk[k++]);
    const rounds = xk.length / 4 - 2;
    for (let i = 0; i < rounds; i++) {
        const t0 = xk[k++] ^ apply0123(T01, T23, s0, s1, s2, s3);
        const t1 = xk[k++] ^ apply0123(T01, T23, s1, s2, s3, s0);
        const t2 = xk[k++] ^ apply0123(T01, T23, s2, s3, s0, s1);
        const t3 = xk[k++] ^ apply0123(T01, T23, s3, s0, s1, s2);
        (s0 = t0), (s1 = t1), (s2 = t2), (s3 = t3);
    }
    // last round (without mixcolumns, so using SBOX2 table)
    const t0 = xk[k++] ^ applySbox(sbox2, s0, s1, s2, s3);
    const t1 = xk[k++] ^ applySbox(sbox2, s1, s2, s3, s0);
    const t2 = xk[k++] ^ applySbox(sbox2, s2, s3, s0, s1);
    const t3 = xk[k++] ^ applySbox(sbox2, s3, s0, s1, s2);
    return { s0: t0, s1: t1, s2: t2, s3: t3 };
}
// AES CTR with overflowing 32 bit counter
// It's possible to do 32le significantly simpler (and probably faster) by using u32.
// But, we need both, and perf bottleneck is in ghash anyway.
function ctr32(xk, isLE, nonce, src, dst) {
    abytes(nonce, BLOCK_SIZE);
    abytes(src);
    dst = getOutput(src.length, dst);
    const ctr = nonce; // write new value to nonce, so it can be re-used
    const c32 = u32(ctr);
    const view = createView(ctr);
    const src32 = u32(src);
    const dst32 = u32(dst);
    const ctrPos = isLE ? 0 : 12;
    const srcLen = src.length;
    // Fill block (empty, ctr=0)
    let ctrNum = view.getUint32(ctrPos, isLE); // read current counter value
    let { s0, s1, s2, s3 } = encrypt(xk, c32[0], c32[1], c32[2], c32[3]);
    // process blocks
    for (let i = 0; i + 4 <= src32.length; i += 4) {
        dst32[i + 0] = src32[i + 0] ^ s0;
        dst32[i + 1] = src32[i + 1] ^ s1;
        dst32[i + 2] = src32[i + 2] ^ s2;
        dst32[i + 3] = src32[i + 3] ^ s3;
        ctrNum = (ctrNum + 1) >>> 0; // u32 wrap
        view.setUint32(ctrPos, ctrNum, isLE);
        ({ s0, s1, s2, s3 } = encrypt(xk, c32[0], c32[1], c32[2], c32[3]));
    }
    // leftovers (less than a block)
    const start = BLOCK_SIZE * Math.floor(src32.length / BLOCK_SIZE32);
    if (start < srcLen) {
        const b32 = new Uint32Array([s0, s1, s2, s3]);
        const buf = u8(b32);
        for (let i = start, pos = 0; i < srcLen; i++, pos++)
            dst[i] = src[i] ^ buf[pos];
        clean(b32);
    }
    return dst;
}
// TODO: merge with chacha, however gcm has bitLen while chacha has byteLen
function computeTag(fn, isLE, key, data, AAD) {
    const aadLength = AAD ? AAD.length : 0;
    const h = fn.create(key, data.length + aadLength);
    if (AAD)
        h.update(AAD);
    const num = u64Lengths(8 * data.length, 8 * aadLength, isLE);
    h.update(data);
    h.update(num);
    const res = h.digest();
    clean(num);
    return res;
}
/**
 * GCM: Galois/Counter Mode.
 * Modern, parallel version of CTR, with MAC.
 * Be careful: MACs can be forged.
 * Unsafe to use random nonces under the same key, due to collision chance.
 * As for nonce size, prefer 12-byte, instead of 8-byte.
 */
const gcm = /* @__PURE__ */ wrapCipher({ blockSize: 16, nonceLength: 12, tagLength: 16, varSizeNonce: true }, function aesgcm(key, nonce, AAD) {
    // NIST 800-38d doesn't enforce minimum nonce length.
    // We enforce 8 bytes for compat with openssl.
    // 12 bytes are recommended. More than 12 bytes would be converted into 12.
    if (nonce.length < 8)
        throw new Error('aes/gcm: invalid nonce length');
    const tagLength = 16;
    function _computeTag(authKey, tagMask, data) {
        const tag = computeTag(ghash, false, authKey, data, AAD);
        for (let i = 0; i < tagMask.length; i++)
            tag[i] ^= tagMask[i];
        return tag;
    }
    function deriveKeys() {
        const xk = expandKeyLE(key);
        const authKey = EMPTY_BLOCK.slice();
        const counter = EMPTY_BLOCK.slice();
        ctr32(xk, false, counter, counter, authKey);
        // NIST 800-38d, page 15: different behavior for 96-bit and non-96-bit nonces
        if (nonce.length === 12) {
            counter.set(nonce);
        }
        else {
            const nonceLen = EMPTY_BLOCK.slice();
            const view = createView(nonceLen);
            setBigUint64(view, 8, BigInt(nonce.length * 8), false);
            // ghash(nonce || u64be(0) || u64be(nonceLen*8))
            const g = ghash.create(authKey).update(nonce).update(nonceLen);
            g.digestInto(counter); // digestInto doesn't trigger '.destroy'
            g.destroy();
        }
        const tagMask = ctr32(xk, false, counter, EMPTY_BLOCK);
        return { xk, authKey, counter, tagMask };
    }
    return {
        encrypt(plaintext) {
            const { xk, authKey, counter, tagMask } = deriveKeys();
            const out = new Uint8Array(plaintext.length + tagLength);
            const toClean = [xk, authKey, counter, tagMask];
            if (!isAligned32$1(plaintext))
                toClean.push((plaintext = copyBytes(plaintext)));
            ctr32(xk, false, counter, plaintext, out.subarray(0, plaintext.length));
            const tag = _computeTag(authKey, tagMask, out.subarray(0, out.length - tagLength));
            toClean.push(tag);
            out.set(tag, plaintext.length);
            clean(...toClean);
            return out;
        },
        decrypt(ciphertext) {
            const { xk, authKey, counter, tagMask } = deriveKeys();
            const toClean = [xk, authKey, tagMask, counter];
            if (!isAligned32$1(ciphertext))
                toClean.push((ciphertext = copyBytes(ciphertext)));
            const data = ciphertext.subarray(0, -tagLength);
            const passedTag = ciphertext.subarray(-tagLength);
            const tag = _computeTag(authKey, tagMask, data);
            toClean.push(tag);
            if (!equalBytes(tag, passedTag))
                throw new Error('aes/gcm: invalid ghash tag');
            const out = ctr32(xk, false, counter, data);
            clean(...toClean);
            return out;
        },
    };
});

// Shared across calls because every aead* below consumes it synchronously.
const NONCE = new Uint8Array(12);
const NONCE_VIEW = new DataView(NONCE.buffer);
function nonceLE(n) {
    NONCE_VIEW.setBigUint64(4, n, true);
    return NONCE;
}
function nonceBE(n) {
    NONCE_VIEW.setBigUint64(4, n, false);
    return NONCE;
}
const dh = (priv, pub) => x25519.getSharedSecret(priv, pub);
const publicKey = (priv) => x25519.getPublicKey(priv);
const generateKeypair = () => {
    const privateKey = x25519.utils.randomSecretKey();
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
};
const SUITES = {
    chacha: {
        name: "ChaChaPoly",
        dhLen: 32,
        dh,
        generateKeypair,
        publicKey,
        hash: sha256,
        aeadEncrypt: (k, n, ad, pt) => chacha20poly1305(k, nonceLE(n), ad).encrypt(pt),
        aeadDecrypt: (k, n, ad, ct) => chacha20poly1305(k, nonceLE(n), ad).decrypt(ct),
    },
    aesgcm: {
        name: "AESGCM",
        dhLen: 32,
        dh,
        generateKeypair,
        publicKey,
        hash: sha256,
        aeadEncrypt: (k, n, ad, pt) => gcm(k, nonceBE(n), ad).encrypt(pt),
        aeadDecrypt: (k, n, ad, ct) => gcm(k, nonceBE(n), ad).decrypt(ct),
    },
};
/** Maps the config suite id to the wire suite string in client/init. */
const SUITE_WIRE_NAME = {
    chacha: "25519_ChaChaPoly_SHA256",
    aesgcm: "25519_AESGCM_SHA256",
};

// base64url (RFC 4648 §5) with no padding, for wire identifiers and keys.
function base64urlEncode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}

const SK_KEY = "sendspin-identity-sk";
class Identity {
    constructor(privateKey, publicKey) {
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.clientId = base64urlEncode(publicKey);
    }
    get keypair() {
        return { privateKey: this.privateKey, publicKey: this.publicKey };
    }
    static loadOrCreate(storage) {
        const kp = SUITES.chacha; // DH/curve is suite-independent (both 25519)
        if (storage) {
            const stored = storage.getItem(SK_KEY);
            if (stored) {
                try {
                    const sk = base64urlDecode(stored);
                    return new Identity(sk, kp.publicKey(sk));
                }
                catch {
                    // Corrupt persisted key: fail open with a fresh identity (a new
                    // client_id) rather than making the player unconstructable.
                    console.warn("Sendspin: stored identity key is invalid, generating a new one");
                }
            }
            const fresh = kp.generateKeypair();
            storage.setItem(SK_KEY, base64urlEncode(fresh.privateKey));
            return new Identity(fresh.privateKey, fresh.publicKey);
        }
        // No storage: ephemeral keypair, so client_id is unstable and pairing is disabled.
        console.warn("Sendspin: no storage provided, using an ephemeral identity (client_id changes each session, pairing unavailable)");
        const fresh = kp.generateKeypair();
        return new Identity(fresh.privateKey, fresh.publicKey);
    }
}

const enc = new TextEncoder();
/** SHA-256("sendspin-sentinel-psk-v1"). */
const SENTINEL_PSK = sha256(enc.encode("sendspin-sentinel-psk-v1"));
const PSK_ID_LABEL = enc.encode("sendspin-psk-id-v1");
/** psk_id = base64url(SHA-256("sendspin-psk-id-v1" || PSK)); same label for all PSK categories. */
function pskId(psk) {
    const buf = new Uint8Array(PSK_ID_LABEL.length + psk.length);
    buf.set(PSK_ID_LABEL, 0);
    buf.set(psk, PSK_ID_LABEL.length);
    return base64urlEncode(sha256(buf));
}
pskId(SENTINEL_PSK);

/** A Sendspin PSK is 32 bytes from a CSPRNG. */
function randomPsk() {
    return crypto.getRandomValues(new Uint8Array(32));
}
const LONG_TERM_KEY = "sendspin-psks";
const PAIRING_KEY = "sendspin-pairing-psk";
class PskStore {
    constructor(storage) {
        this.storage = storage;
        this.entries = new Map();
        // Always a candidate: every unpaired connection's handshake matches its psk_id.
        this.add({
            psk: SENTINEL_PSK,
            pskId: pskId(SENTINEL_PSK),
            category: "sentinel",
        });
        this.loadPersisted();
    }
    add(e) {
        this.entries.set(e.pskId, e);
    }
    loadPersisted() {
        if (!this.storage)
            return;
        // Treat a corrupt entry as no stored PSK and clear it, rather than
        // letting a parse error abort connection setup.
        const raw = this.storage.getItem(LONG_TERM_KEY);
        if (raw) {
            try {
                const records = JSON.parse(raw);
                for (const r of records) {
                    const psk = base64urlDecode(r.psk);
                    this.add({
                        psk,
                        pskId: pskId(psk),
                        category: "long_term",
                        serverId: r.serverId,
                    });
                }
            }
            catch {
                this.storage.setItem(LONG_TERM_KEY, "[]");
            }
        }
        const pairing = this.storage.getItem(PAIRING_KEY);
        if (pairing) {
            try {
                const psk = base64urlDecode(pairing);
                this.add({ psk, pskId: pskId(psk), category: "pairing" });
            }
            catch {
                this.storage.setItem(PAIRING_KEY, "");
            }
        }
    }
    persistLongTerm() {
        if (!this.storage)
            return;
        const records = [];
        for (const e of this.entries.values()) {
            if (e.category === "long_term") {
                records.push({ psk: base64urlEncode(e.psk), serverId: e.serverId });
            }
        }
        this.storage.setItem(LONG_TERM_KEY, JSON.stringify(records));
    }
    lookup(id) {
        return this.entries.get(id) ?? null;
    }
    addLongTerm(psk, serverId) {
        const e = {
            psk,
            pskId: pskId(psk),
            category: "long_term",
            serverId,
        };
        this.add(e);
        this.persistLongTerm();
        return e;
    }
    /** Remove a long-term entry unless it is a shared-PSK record (no serverId). */
    removeByPskId(id) {
        const e = this.entries.get(id);
        if (!e || e.category !== "long_term" || e.serverId === undefined)
            return;
        this.entries.delete(id);
        this.persistLongTerm();
    }
    getOrCreatePairingPsk() {
        for (const e of this.entries.values()) {
            if (e.category === "pairing")
                return e.psk;
        }
        return this.setPairingPsk(randomPsk());
    }
    rotatePairingPsk() {
        for (const [id, e] of this.entries) {
            if (e.category === "pairing")
                this.entries.delete(id);
        }
        return this.setPairingPsk(randomPsk());
    }
    setPairingPsk(psk) {
        this.add({ psk, pskId: pskId(psk), category: "pairing" });
        this.storage?.setItem(PAIRING_KEY, base64urlEncode(psk));
        return psk;
    }
}

/**
 * HMAC: RFC2104 message authentication code.
 * @module
 */
class HMAC extends Hash {
    constructor(hash, _key) {
        super();
        this.finished = false;
        this.destroyed = false;
        ahash(hash);
        const key = toBytes$1(_key);
        this.iHash = hash.create();
        if (typeof this.iHash.update !== 'function')
            throw new Error('Expected instance of class which extends utils.Hash');
        this.blockLen = this.iHash.blockLen;
        this.outputLen = this.iHash.outputLen;
        const blockLen = this.blockLen;
        const pad = new Uint8Array(blockLen);
        // blockLen can be bigger than outputLen
        pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
        for (let i = 0; i < pad.length; i++)
            pad[i] ^= 0x36;
        this.iHash.update(pad);
        // By doing update (processing of first block) of outer hash here we can re-use it between multiple calls via clone
        this.oHash = hash.create();
        // Undo internal XOR && apply outer XOR
        for (let i = 0; i < pad.length; i++)
            pad[i] ^= 0x36 ^ 0x5c;
        this.oHash.update(pad);
        clean$1(pad);
    }
    update(buf) {
        aexists$1(this);
        this.iHash.update(buf);
        return this;
    }
    digestInto(out) {
        aexists$1(this);
        abytes$1(out, this.outputLen);
        this.finished = true;
        this.iHash.digestInto(out);
        this.oHash.update(out);
        this.oHash.digestInto(out);
        this.destroy();
    }
    digest() {
        const out = new Uint8Array(this.oHash.outputLen);
        this.digestInto(out);
        return out;
    }
    _cloneInto(to) {
        // Create new instance without calling constructor since key already in state and we don't know it.
        to || (to = Object.create(Object.getPrototypeOf(this), {}));
        const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
        to = to;
        to.finished = finished;
        to.destroyed = destroyed;
        to.blockLen = blockLen;
        to.outputLen = outputLen;
        to.oHash = oHash._cloneInto(to.oHash);
        to.iHash = iHash._cloneInto(to.iHash);
        return to;
    }
    clone() {
        return this._cloneInto();
    }
    destroy() {
        this.destroyed = true;
        this.oHash.destroy();
        this.iHash.destroy();
    }
}
/**
 * HMAC: RFC2104 message authentication code.
 * @param hash - function that would be used e.g. sha256
 * @param key - message key
 * @param message - message data
 * @example
 * import { hmac } from '@noble/hashes/hmac';
 * import { sha256 } from '@noble/hashes/sha2';
 * const mac1 = hmac(sha256, 'key', 'message');
 */
const hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new HMAC(hash, key);

const EMPTY$1 = new Uint8Array(0);
class CipherState {
    constructor(suite) {
        this.suite = suite;
        this.k = null;
        this.n = 0n;
    }
    initializeKey(key) {
        this.k = key;
        this.n = 0n;
    }
    hasKey() {
        return this.k !== null;
    }
    encryptWithAd(ad, plaintext) {
        if (this.k === null)
            return plaintext;
        const ct = this.suite.aeadEncrypt(this.k, this.n, ad, plaintext);
        this.n += 1n;
        return ct;
    }
    decryptWithAd(ad, ciphertext) {
        if (this.k === null)
            return ciphertext;
        const pt = this.suite.aeadDecrypt(this.k, this.n, ad, ciphertext);
        this.n += 1n;
        return pt;
    }
}

const HASHLEN = 32;
/** Noise HKDF: derive `num` 32-byte outputs from (chainingKey, ikm). */
function hkdf(ck, ikm, num) {
    const tempKey = hmac(sha256, ck, ikm);
    const o1 = hmac(sha256, tempKey, Uint8Array.of(1));
    const o2 = hmac(sha256, tempKey, concat$3(o1, Uint8Array.of(2)));
    if (num === 2)
        return [o1, o2];
    const o3 = hmac(sha256, tempKey, concat$3(o2, Uint8Array.of(3)));
    return [o1, o2, o3];
}
function concat$3(...parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
class SymmetricState {
    constructor(suite) {
        this.suite = suite;
        this.cipher = new CipherState(suite);
    }
    initialize(protocolName) {
        const name = new TextEncoder().encode(protocolName);
        if (name.length <= HASHLEN) {
            const h = new Uint8Array(HASHLEN);
            h.set(name);
            this.h = h;
        }
        else {
            this.h = this.suite.hash(name);
        }
        this.ck = this.h;
        this.cipher.initializeKey(null);
    }
    mixHash(data) {
        this.h = this.suite.hash(concat$3(this.h, data));
    }
    mixKey(ikm) {
        const [ck, tempK] = hkdf(this.ck, ikm, 2);
        this.ck = ck;
        this.cipher.initializeKey(tempK.slice(0, 32));
    }
    mixKeyAndHash(ikm) {
        const [ck, tempH, tempK] = hkdf(this.ck, ikm, 3);
        this.ck = ck;
        this.mixHash(tempH);
        this.cipher.initializeKey(tempK.slice(0, 32));
    }
    encryptAndHash(plaintext) {
        const ct = this.cipher.encryptWithAd(this.h, plaintext);
        this.mixHash(ct);
        return ct;
    }
    decryptAndHash(ciphertext) {
        const pt = this.cipher.decryptWithAd(this.h, ciphertext);
        this.mixHash(ciphertext);
        return pt;
    }
    /** Returns [sender-facing, receiver-facing] transport CipherStates. */
    split() {
        const [tempK1, tempK2] = hkdf(this.ck, EMPTY$1, 2);
        const c1 = new CipherState(this.suite);
        const c2 = new CipherState(this.suite);
        c1.initializeKey(tempK1.slice(0, 32));
        c2.initializeKey(tempK2.slice(0, 32));
        return [c1, c2];
    }
}

const MSG1 = ["e", "es", "ss"];
const MSG2 = ["e", "ee", "se", "psk"];
function concat$2(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
class HandshakeState {
    constructor(p) {
        this.suite = p.suite;
        this.role = p.role;
        this.s = p.s;
        this.rs = p.rs;
        this.psk = p.psk;
        this.fixedEphemeral = p.fixedEphemeral;
        this.sym = new SymmetricState(p.suite);
        this.sym.initialize(`Noise_KKpsk2_25519_${p.suite.name}_SHA256`);
        this.sym.mixHash(p.prologue);
        // Pre-messages: initiator static, then responder static.
        const initiatorStatic = p.role === "initiator" ? p.s.publicKey : p.rs;
        const responderStatic = p.role === "responder" ? p.s.publicKey : p.rs;
        this.sym.mixHash(initiatorStatic);
        this.sym.mixHash(responderStatic);
    }
    /** The running handshake hash, e.g. for the re-handshake prologue. */
    get handshakeHash() {
        return this.sym.h;
    }
    setPsk(psk) {
        this.psk = psk;
    }
    dhToken(token) {
        const init = this.role === "initiator";
        switch (token) {
            case "ee":
                return this.suite.dh(this.e.privateKey, this.re);
            case "ss":
                return this.suite.dh(this.s.privateKey, this.rs);
            case "es":
                return init
                    ? this.suite.dh(this.e.privateKey, this.rs)
                    : this.suite.dh(this.s.privateKey, this.re);
            case "se":
                return init
                    ? this.suite.dh(this.s.privateKey, this.re)
                    : this.suite.dh(this.e.privateKey, this.rs);
        }
    }
    processTokenWrite(token, out) {
        if (token === "e") {
            this.e = this.fixedEphemeral ?? this.suite.generateKeypair();
            this.sym.mixHash(this.e.publicKey);
            // PSK-mode rule (Noise 9.2): the ephemeral is also mixed into the key.
            this.sym.mixKey(this.e.publicKey);
            out.buf = concat$2(out.buf, this.e.publicKey);
        }
        else if (token === "s") {
            out.buf = concat$2(out.buf, this.sym.encryptAndHash(this.s.publicKey));
        }
        else if (token === "psk") {
            this.sym.mixKeyAndHash(this.psk);
        }
        else {
            this.sym.mixKey(this.dhToken(token));
        }
    }
    processTokenRead(token, cursor) {
        if (token === "e") {
            this.re = cursor.buf.slice(0, this.suite.dhLen);
            cursor.buf = cursor.buf.slice(this.suite.dhLen);
            this.sym.mixHash(this.re);
            // PSK-mode rule (Noise 9.2): the ephemeral is also mixed into the key.
            this.sym.mixKey(this.re);
        }
        else if (token === "s") {
            const len = this.suite.dhLen + 16;
            this.sym.decryptAndHash(cursor.buf.slice(0, len));
            cursor.buf = cursor.buf.slice(len);
        }
        else if (token === "psk") {
            this.sym.mixKeyAndHash(this.psk);
        }
        else {
            this.sym.mixKey(this.dhToken(token));
        }
    }
    writeMessage(tokens, payload) {
        const out = { buf: new Uint8Array(0) };
        for (const t of tokens)
            this.processTokenWrite(t, out);
        out.buf = concat$2(out.buf, this.sym.encryptAndHash(payload));
        return out.buf;
    }
    readMessage(tokens, message) {
        const cursor = { buf: message };
        for (const t of tokens)
            this.processTokenRead(t, cursor);
        return this.sym.decryptAndHash(cursor.buf);
    }
    split() {
        return this.sym.split();
    }
}

const EMPTY = new Uint8Array(0);
class NoiseSession {
    constructor(role, split) {
        const [c1, c2] = split;
        // c1: initiator->responder, c2: responder->initiator.
        if (role === "initiator") {
            this.sendCs = c1;
            this.recvCs = c2;
        }
        else {
            this.sendCs = c2;
            this.recvCs = c1;
        }
    }
    encrypt(plaintext) {
        return this.sendCs.encryptWithAd(EMPTY, plaintext);
    }
    decrypt(ciphertext) {
        return this.recvCs.decryptWithAd(EMPTY, ciphertext);
    }
}

/** Is this activity set allowed at all for the matched PSK category? */
function isAllowedActivitySet(category, set, unpairedAccess) {
    if (category === "long_term") {
        // ['pairing'] alone, or any subset of {playback, management}.
        if (set.has("pairing"))
            return set.size === 1;
        for (const a of set)
            if (a !== "playback" && a !== "management")
                return false;
        return true;
    }
    if (category === "pairing") {
        return set.size === 1 && set.has("pairing");
    }
    // sentinel
    if (set.size === 0)
        return true;
    if (set.size === 1 && set.has("pairing"))
        return true;
    if (set.size === 1 && set.has("playback"))
        return unpairedAccess;
    return false;
}
/**
 * Is the WHOLE activation admissible for the given unpairedAccess: activities allowed AND
 * (if active_roles present) the connection is playback-capable (activities + 'playback' allowed)?
 */
function isAdmissible(category, set, hasActiveRoles, unpairedAccess) {
    if (!isAllowedActivitySet(category, set, unpairedAccess))
        return false;
    if (hasActiveRoles) {
        const withPlayback = new Set(set);
        withPlayback.add("playback");
        if (!isAllowedActivitySet(category, withPlayback, unpairedAccess)) {
            return false;
        }
    }
    return true;
}
function authorizeActivate(category, activities, activeRoles, unpairedAccess) {
    // The activation's `pairing` object is ignored unless 'pairing' is in
    // activities, so it never bears on authorization.
    const set = new Set(activities);
    const hasActiveRoles = !!activeRoles && activeRoles.length > 0;
    if (isAdmissible(category, set, hasActiveRoles, unpairedAccess)) {
        return { ok: true };
    }
    // pairing_required exactly when the matched PSK is Sentinel and enabling unpaired
    // access would make the whole activation admissible. Covers both a ['playback']
    // activation AND an active_roles-gated one blocked solely by unpairedAccess=false.
    if (category === "sentinel" &&
        !unpairedAccess &&
        isAdmissible(category, set, hasActiveRoles, true)) {
        return { ok: false, goodbye: "pairing_required" };
    }
    return { ok: false, goodbye: "unauthorized" };
}

const utf8$2 = new TextEncoder();
const dutf8 = new TextDecoder();
const HANDSHAKE_TIMEOUT_MS = 30000;
const MAX_TRANSPORT_PLAINTEXT = 65519; // 65535 - 16 (tag); includes the type byte
const MAX_TRANSPORT_CIPHERTEXT = MAX_TRANSPORT_PLAINTEXT + 16; // Noise transport message cap
// Cap total reassembled size so an endless run of fragment-more frames can't exhaust memory.
const MAX_REASSEMBLY_BYTES = 4 * 1024 * 1024;
function concat$1(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
class SendspinTransport {
    constructor(wsManager, deps, cb) {
        this.wsManager = wsManager;
        this.deps = deps;
        this.cb = cb;
        this.state = "idle";
        this.hs = null;
        this.session = null;
        this.matched = null;
        this.serverId = "";
        this.rawClientInit = new Uint8Array(0);
        this.rawServerInit = new Uint8Array(0);
        this.timeout = null;
        this.frag = null;
        this.lastHandshakeHash = new Uint8Array(0);
        this.quiesced = false;
        this.outboundQueue = [];
        this.seenActivate = false;
        this.effectiveActiveRoles = undefined;
    }
    get suite() {
        return SUITES[this.deps.suiteId];
    }
    /** True once transport mode is established. */
    get ready() {
        return this.state === "transport";
    }
    get handshakeInfo() {
        if (!this.matched)
            return null;
        return {
            trustLevel: this.matched.category === "long_term" ? "user" : "none",
            category: this.matched.category,
            serverId: this.serverId,
            entry: this.matched,
        };
    }
    /** The Noise handshake hash h of the current session (PIN pairing binds to it). */
    get handshakeHash() {
        return this.lastHandshakeHash;
    }
    start() {
        // Reset per-connection state so a reconnect does not inherit a stale session.
        this.resetSession();
        const initStr = JSON.stringify({
            type: "client/init",
            payload: {
                client_id: this.deps.identity.clientId,
                version: 1,
                suite: SUITE_WIRE_NAME[this.deps.suiteId],
            },
        });
        this.rawClientInit = utf8$2.encode(initStr);
        this.wsManager.sendText(initStr);
        this.state = "await_server_init";
        this.armTimeout();
    }
    /** Reset per-connection handshake and session state. */
    resetSession() {
        this.hs = null;
        this.session = null;
        this.matched = null;
        this.frag = null;
        this.serverId = "";
        this.rawServerInit = new Uint8Array(0);
        this.quiesced = false;
        this.outboundQueue = [];
        this.lastHandshakeHash = new Uint8Array(0);
        this.seenActivate = false;
        this.effectiveActiveRoles = undefined;
    }
    /**
     * The socket closed. Drop the handshake timer and session so a reconnect
     * starts clean and no send targets the dead session's keys.
     */
    onSocketClosed() {
        this.clearTimeout();
        this.resetSession();
        this.state = "idle";
    }
    /** Public close: pair/abort and other flows need to tear down the socket. */
    close() {
        this.clearTimeout();
        this.wsManager.disconnect();
    }
    handleRaw(event) {
        if (this.state === "transport") {
            if (typeof event.data === "string")
                return this.fail(); // unexpected cleartext
            let plain;
            try {
                const bytes = new Uint8Array(event.data);
                if (bytes.length > MAX_TRANSPORT_CIPHERTEXT)
                    return this.fail();
                plain = this.session.decrypt(bytes); // AEAD failure is a real transport failure
            }
            catch {
                return this.fail();
            }
            if (plain.length < 1)
                return this.fail();
            // A malformed payload or a throwing app callback must not close the socket
            // or disable reconnect. Log and keep the connection.
            try {
                this.dispatchPlain(plain);
            }
            catch (e) {
                console.warn("Sendspin: dropped malformed transport message", e);
            }
            return;
        }
        try {
            if (typeof event.data !== "string")
                return this.fail(); // handshake is text only
            this.handleHandshakeText(event.data);
        }
        catch {
            this.fail();
        }
    }
    handleHandshakeText(raw) {
        const msg = JSON.parse(raw);
        if (this.state === "await_server_init" && msg.type === "server/init") {
            if (msg.payload.version !== 1)
                return this.fail();
            this.serverId = String(msg.payload.server_id);
            this.rawServerInit = utf8$2.encode(raw);
            this.hs = new HandshakeState({
                suite: this.suite,
                role: "responder",
                prologue: concat$1(this.rawClientInit, this.rawServerInit),
                s: this.deps.identity.keypair,
                rs: base64urlDecode(this.serverId),
            });
            this.state = "await_noise1";
            this.armTimeout();
            return;
        }
        if (this.state === "await_noise1" && msg.type === "noise/handshake") {
            this.processNoise1(base64urlDecode(String(msg.payload.data)));
            return;
        }
        this.fail();
    }
    processNoise1(data) {
        const payload1 = this.hs.readMessage(MSG1, data); // static-DH only; throws => fail
        const { psk_id } = JSON.parse(dutf8.decode(payload1));
        const entry = this.deps.pskStore.lookup(psk_id);
        if (!entry)
            return this.fail();
        if (entry.category === "long_term" &&
            entry.serverId !== undefined &&
            entry.serverId !== this.serverId) {
            return this.fail();
        }
        this.hs.setPsk(entry.psk);
        const m2 = this.hs.writeMessage(MSG2, utf8$2.encode("{}"));
        this.wsManager.sendText(JSON.stringify({
            type: "noise/handshake",
            payload: { data: base64urlEncode(m2) },
        }));
        this.session = new NoiseSession("responder", this.hs.split());
        this.matched = entry;
        this.state = "transport";
        this.clearTimeout();
        this.lastHandshakeHash = this.hs.handshakeHash;
        this.cb.onHandshakeComplete(this.handshakeInfo);
    }
    /** Route one decrypted plaintext frame on its leading message-type byte. */
    dispatchPlain(full) {
        const type = full[0];
        // The body view is built per branch: the binary path below is the hot one
        // and reads only `full`.
        if (type === 0) {
            this.handleControl(JSON.parse(dutf8.decode(full.subarray(1))));
        }
        else if (type === 2 || type === 3) {
            this.handleFragment(type, full.subarray(1));
        }
        else {
            // full is the decrypt output: exclusively owned, offset 0, exact length,
            // type byte intact. Hand it over without re-copying.
            this.cb.onBinaryMessage(full);
        }
    }
    handleFragment(type, body) {
        if (type === 2 && this.frag === null) {
            if (body.length < 1)
                return this.fail();
            // Reject a fragment whose inner type is itself a fragment marker.
            if (body[0] === 2 || body[0] === 3)
                return this.fail();
            const first = body.subarray(1);
            this.frag = { origType: body[0], parts: [first], size: first.length };
            return;
        }
        if (type === 2) {
            this.frag.parts.push(body);
            this.frag.size += body.length;
            if (this.frag.size > MAX_REASSEMBLY_BYTES) {
                this.frag = null;
                return this.fail();
            }
            return;
        }
        // type === 3: closing frame
        if (this.frag === null)
            return this.fail();
        this.frag.parts.push(body);
        this.frag.size += body.length;
        if (this.frag.size > MAX_REASSEMBLY_BYTES) {
            this.frag = null;
            return this.fail();
        }
        const origType = this.frag.origType;
        // Assemble into a size+1 buffer with the type byte at offset 0, so the
        // binary path can hand it over without a second copy to prepend the type.
        const assembled = new Uint8Array(this.frag.size + 1);
        assembled[0] = origType;
        let off = 1;
        for (const p of this.frag.parts) {
            assembled.set(p, off);
            off += p.length;
        }
        this.frag = null;
        if (origType === 0) {
            this.handleControl(JSON.parse(dutf8.decode(assembled.subarray(1))));
        }
        else {
            this.cb.onBinaryMessage(assembled);
        }
    }
    handleControl(msg) {
        if (msg.type === "noise/handshake") {
            this.handleRehandshake(msg);
            return;
        }
        if (msg.type === "server/activate") {
            this.handleActivate(msg);
            return;
        }
        if (msg.type === "server/unpair") {
            this.handleUnpair();
            return;
        }
        this.cb.onControlMessage(msg);
    }
    handleRehandshake(msg) {
        const newHs = new HandshakeState({
            suite: this.suite,
            role: "responder",
            prologue: this.lastHandshakeHash,
            s: this.deps.identity.keypair,
            rs: base64urlDecode(this.serverId),
        });
        const payload1 = newHs.readMessage(MSG1, base64urlDecode(msg.payload.data));
        const { psk_id } = JSON.parse(dutf8.decode(payload1));
        const entry = this.deps.pskStore.lookup(psk_id);
        if (!entry)
            return this.fail();
        if (entry.category === "long_term" &&
            entry.serverId !== undefined &&
            entry.serverId !== this.serverId) {
            return this.fail();
        }
        newHs.setPsk(entry.psk);
        const m2 = newHs.writeMessage(MSG2, utf8$2.encode("{}"));
        // Hold periodic outbound traffic until the post-re-handshake server/activate.
        this.quiesced = true;
        this.armTimeout();
        // Send msg 2 under the CURRENT keys, then swap.
        this.encryptSend({
            type: "noise/handshake",
            payload: { data: base64urlEncode(m2) },
        });
        this.session = new NoiseSession("responder", newHs.split());
        this.matched = entry;
        this.lastHandshakeHash = newHs.handshakeHash;
        // The re-handshake re-runs the activate sequence, so the next activate is a fresh first.
        this.seenActivate = false;
        this.effectiveActiveRoles = undefined;
        this.cb.onHandshakeComplete(this.handshakeInfo);
    }
    handleActivate(msg) {
        const payloadRoles = msg.payload.active_roles;
        // active_roles is required on the first activate and persists when later ones omit it.
        if (!this.seenActivate && payloadRoles === undefined) {
            this.sendGoodbyeAndClose("unauthorized");
            return;
        }
        if (payloadRoles !== undefined)
            this.effectiveActiveRoles = payloadRoles;
        this.seenActivate = true;
        const result = authorizeActivate(this.matched.category, msg.payload.activities, this.effectiveActiveRoles, this.deps.unpairedAccess);
        if (!result.ok) {
            this.sendGoodbyeAndClose(result.goodbye);
            return;
        }
        this.clearTimeout();
        const queuedCommands = !msg.payload.activities.includes("pairing") &&
            this.effectiveActiveRoles?.includes("controller@v1")
            ? this.outboundQueue.filter((queued) => queued.type === "client/command")
            : [];
        this.quiesced = false;
        this.outboundQueue = [];
        this.cb.onControlMessage(msg);
        for (const command of queuedCommands)
            this.encryptSend(command);
    }
    handleUnpair() {
        // trust_level none (Sentinel or in-flight pairing): ignore.
        if (this.matched?.category !== "long_term")
            return;
        this.deps.pskStore.removeByPskId(this.matched.pskId);
        this.sendGoodbyeAndClose("unpaired");
    }
    sendGoodbyeAndClose(reason) {
        try {
            this.encryptSend({ type: "client/goodbye", payload: { reason } });
        }
        catch {
            /* best effort */
        }
        this.close();
    }
    sendControl(msg) {
        if (this.state !== "transport" || !this.session) {
            console.warn("Sendspin: sendControl before transport ready");
            return;
        }
        const type = msg.type;
        if (this.quiesced &&
            type !== undefined &&
            SendspinTransport.QUIESCED_TYPES.has(type)) {
            this.outboundQueue.push(msg);
            return;
        }
        this.encryptSend(msg);
    }
    encryptSend(msg) {
        const json = utf8$2.encode(JSON.stringify(msg));
        const pt = concat$1(Uint8Array.of(0), json);
        if (pt.length > MAX_TRANSPORT_PLAINTEXT) {
            throw new Error("Sendspin: control message exceeds single-frame limit");
        }
        this.wsManager.sendBinary(this.session.encrypt(pt));
    }
    armTimeout() {
        this.clearTimeout();
        this.timeout = globalThis.setTimeout(() => this.fail(), HANDSHAKE_TIMEOUT_MS);
    }
    clearTimeout() {
        if (this.timeout !== null) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }
    /** Any handshake or transport failure: close the socket with no app-level error. */
    fail() {
        this.clearTimeout();
        this.wsManager.disconnect();
    }
}
// Hold normal traffic during a re-handshake. client/hello must still flow or
// the post-re-handshake server/activate would deadlock.
SendspinTransport.QUIESCED_TYPES = new Set([
    "client/command",
    "client/time",
    "client/state",
]);

// CPACE-X25519-SHA512 (draft-irtf-cfrg-cpace-21) in initiator-responder mode
// with the explicit mutual-confirmation flow (MCF) of §10.4. The Sendspin
// server is role A (initiator) and the client is role B (responder).
// Curve25519 field and Elligator2 parameters (draft G_X25519).
const Q = 2n ** 255n - 19n;
const A = 486662n;
const Z = 2n; // the non-square used by Elligator2 on Curve25519
const FIELD_BYTES = 32;
const SHARE_SIZE = 32;
const TAG_SIZE = 64;
const DSI = utf8$1("CPace255");
const DSI_ISK = utf8$1("CPace255_ISK");
const MAC_LABEL = utf8$1("CPaceMac");
const SHA512_BLOCK_BYTES = 128;
class CPaceError extends Error {
}
function utf8$1(s) {
    return new TextEncoder().encode(s);
}
function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
/** LEB128 length prefix per the CPace draft's prepend_len. */
function prependLen(data) {
    let length = data.length;
    const prefix = [];
    for (;;) {
        prefix.push(length < 128 ? length : (length & 0x7f) | 0x80);
        length >>= 7;
        if (length === 0)
            break;
    }
    return concat(new Uint8Array(prefix), data);
}
function lvCat(...parts) {
    return concat(...parts.map(prependLen));
}
function generatorString(prs, ci, sid) {
    const lenZpad = Math.max(0, SHA512_BLOCK_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
    return lvCat(DSI, prs, new Uint8Array(lenZpad), ci, sid);
}
function mod(n, m) {
    const r = n % m;
    return r < 0n ? r + m : r;
}
function modPow(base, exp, m) {
    let result = 1n;
    let b = mod(base, m);
    let e = exp;
    while (e > 0n) {
        if (e & 1n)
            result = (result * b) % m;
        b = (b * b) % m;
        e >>= 1n;
    }
    return result;
}
function modInv(n, m) {
    return modPow(n, m - 2n, m); // m prime
}
function decodeU(value) {
    const u = value.slice();
    u[u.length - 1] &= 0x7f; // 255-bit field: ignore the unused top bit (RFC 7748)
    let n = 0n;
    for (let i = u.length - 1; i >= 0; i--)
        n = (n << 8n) | BigInt(u[i]);
    return n;
}
function encodeU(x) {
    const out = new Uint8Array(FIELD_BYTES);
    let n = x;
    for (let i = 0; i < FIELD_BYTES; i++) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    return out;
}
/** Elligator2 map onto Curve25519 (B = 1), returning the u-coordinate bytes. */
function elligator2(r) {
    const rq = mod(r, Q);
    const v = mod(-A * modInv(mod(1n + Z * rq * rq, Q), Q), Q);
    const eps = modPow(mod(v * v * v + A * v * v + v, Q), (Q - 1n) / 2n, Q);
    const x = mod(eps * v - mod(1n - eps, Q) * A * modInv(2n, Q), Q);
    return encodeU(x);
}
function calculateGenerator(prs, ci, sid) {
    const genHash = sha512(generatorString(prs, ci, sid)).slice(0, FIELD_BYTES);
    return elligator2(decodeU(genHash));
}
/** X25519 scalar mult that rejects a result encoding the identity (low order). */
function scalarMultVfy(scalar, point, what) {
    let shared;
    try {
        shared = x25519.scalarMult(scalar, point);
    }
    catch {
        throw new CPaceError(`${what} encodes a low-order point`);
    }
    if (shared.every((b) => b === 0)) {
        throw new CPaceError(`${what} encodes a low-order point`);
    }
    return shared;
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}
/**
 * One side of a CPACE-X25519-SHA512 exchange with mutual confirmation.
 * Sendspin uses empty CI, ADa = "server", ADb = "client", and
 * sid = "sendspin-pair-pake-v1" || h || counter.
 */
class CPace {
    constructor(role, scalar, sid, ada, adb, generator) {
        this.role = role;
        this.sid = sid;
        this.ada = ada;
        this.adb = adb;
        this.macKey = null;
        this.initiatorShare = null;
        this.responderShare = null;
        this.iskValue = null;
        this.scalar = scalar;
        this.publicShare = scalarMultVfy(scalar, generator, "generator");
    }
    /** Begin a CPace run, sampling a scalar and computing the public share. */
    static start(opts) {
        const scalar = opts.scalar ?? crypto.getRandomValues(new Uint8Array(FIELD_BYTES));
        const generator = calculateGenerator(opts.prs, opts.ci ?? new Uint8Array(0), opts.sid);
        return new CPace(opts.role, scalar, opts.sid, opts.ada ?? new Uint8Array(0), opts.adb ?? new Uint8Array(0), generator);
    }
    /** Ingest the peer's public share, deriving the confirmation MAC key. */
    derive(peerShare) {
        if (!this.scalar) {
            throw new CPaceError("derive() may only be called once");
        }
        const scalar = this.scalar;
        this.scalar = null;
        if (peerShare.length !== SHARE_SIZE) {
            throw new CPaceError(`peer share must be ${SHARE_SIZE} bytes, got ${peerShare.length}`);
        }
        const shared = scalarMultVfy(scalar, peerShare, "peer share");
        if (this.role === "initiator") {
            this.initiatorShare = this.publicShare;
            this.responderShare = peerShare;
        }
        else {
            this.initiatorShare = peerShare;
            this.responderShare = this.publicShare;
        }
        const transcript = concat(lvCat(this.initiatorShare, this.ada), lvCat(this.responderShare, this.adb));
        this.iskValue = sha512(concat(lvCat(DSI_ISK, this.sid, shared), transcript));
        this.macKey = sha512(concat(MAC_LABEL, this.sid, this.iskValue));
    }
    /** The 64-byte CPace intermediate session key (ISK). derive() must run first. */
    get isk() {
        if (!this.iskValue) {
            throw new CPaceError("derive() must be called before reading the ISK");
        }
        return this.iskValue;
    }
    /** This side's confirmation tag (Ta for the initiator, Tb for the responder). */
    tag() {
        return this.mac(true);
    }
    /** Whether peerTag matches the peer's expected confirmation tag. */
    verify(peerTag) {
        const expected = this.mac(false);
        // With the same (Y, AD) on both sides the tag this side would accept is the
        // tag it published, which an attacker can echo back without knowing the PRS.
        if (constantTimeEqual(expected, this.mac(true)))
            return false;
        return constantTimeEqual(peerTag, expected);
    }
    mac(own) {
        if (!this.macKey || !this.initiatorShare || !this.responderShare) {
            throw new CPaceError("derive() must be called before confirmation tags");
        }
        // Ta authenticates (Ya, ADa) and Tb authenticates (Yb, ADb).
        const useInitiator = own === (this.role === "initiator");
        const share = useInitiator ? this.initiatorShare : this.responderShare;
        const ad = useInitiator ? this.ada : this.adb;
        return hmac(sha512, this.macKey, lvCat(share, ad));
    }
}

// Dynamic-PIN derivation and commitment (Sendspin pairing spec).
const PIN_DERIVE_LABEL = new TextEncoder().encode("sendspin-pin-derive-v1");
const PAIR_COMMIT_LABEL = new TextEncoder().encode("sendspin-pair-commit-v1");
const NONCE_SIZE = 32;
const MIN_PIN_DIGITS = 4;
const MAX_PIN_DIGITS = 12;
const DEFAULT_MIN_PIN_DIGITS = 6;
const STATIC_PIN_DIGITS = 8;
const STATIC_PIN_RE = new RegExp(`^[0-9]{${STATIC_PIN_DIGITS}}$`);
/** Whether pin is exactly 8 decimal digits, as the static-PIN method requires. */
function isValidStaticPin(pin) {
    return STATIC_PIN_RE.test(pin);
}
/** Fresh 32-byte CSPRNG nonce (nonce_A or nonce_B). */
function generateNonce() {
    return crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
}
/** SHA-256("sendspin-pair-commit-v1" || nonce), the commitment commit_B to nonce_B. */
function commitNonce(nonce) {
    const input = new Uint8Array(PAIR_COMMIT_LABEL.length + nonce.length);
    input.set(PAIR_COMMIT_LABEL, 0);
    input.set(nonce, PAIR_COMMIT_LABEL.length);
    return sha256(input);
}
/** Derive the pinLength-digit dynamic PIN from the handshake hash and both nonces. */
function derivePin(handshakeHash, nonceA, nonceB, pinLength) {
    const input = new Uint8Array(PIN_DERIVE_LABEL.length +
        handshakeHash.length +
        nonceA.length +
        nonceB.length);
    input.set(PIN_DERIVE_LABEL, 0);
    input.set(handshakeHash, PIN_DERIVE_LABEL.length);
    input.set(nonceA, PIN_DERIVE_LABEL.length + handshakeHash.length);
    input.set(nonceB, PIN_DERIVE_LABEL.length + handshakeHash.length + nonceA.length);
    const digest = sha256(input);
    let n = 0n;
    for (const b of digest)
        n = (n << 8n) | BigInt(b);
    const pin = n % 10n ** BigInt(pinLength);
    return pin.toString().padStart(pinLength, "0");
}

const utf8 = (s) => new TextEncoder().encode(s);
function concatBytes(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
/** CPace session-id label. sid = label || Noise handshake hash || counter. */
const PAKE_SID_LABEL = "sendspin-pair-pake-v1";
/** Label for the key that wraps the PSK in PIN pairing (PSK Wrapping). */
const PSK_WRAP_LABEL = utf8("sendspin-pair-psk-wrap-v1");
/** CPace associated data: distinct per side to prevent a reflected MAC. */
const CPACE_AD_A = utf8("server");
const CPACE_AD_B = utf8("client");
/** A PIN pairing attempt must complete within this bound (spec: 2 minutes). */
const ATTEMPT_TIMEOUT_MS = 120000;
/** Lifetime of an open pairing window, from the gesture until client/pair-init. */
const WINDOW_LIFETIME_MS = 300000;
/** Dynamic PIN escalates to gesture-gating at this many consecutive failures. */
const ESCALATION_THRESHOLD = 10;
/** Dynamic PIN below this length is gesture-gated: short PINs are bought with a gesture. */
const SHORT_PIN_LENGTH = 6;
/** Persisted PIN failure counter (dynamic PIN only, not partitioned by server). */
const FAILURES_STORAGE_KEY = "sendspin-pair-failures";
const PIN_METHODS = ["dynamic_pin", "static_pin"];
/** Only advertise a locations hint the integrator actually configured. */
function withLocations(descriptor, locations) {
    return locations?.length ? { ...descriptor, locations } : descriptor;
}
/** A languages hint that is not a non-empty list of tags is treated as absent. */
function readLanguages(value) {
    if (!Array.isArray(value) || value.length === 0)
        return undefined;
    return value.every((tag) => typeof tag === "string" && tag !== "")
        ? value
        : undefined;
}
class PairingManager {
    constructor(deps) {
        this.deps = deps;
        this.pendingPsk = null;
        this.phase = "idle";
        this.method = null;
        this.cpace = null;
        this.nonceB = null;
        this.attemptTimer = null;
        this.windowTimer = null;
        /** Whether the operator's pairing-window gesture is currently live. */
        this.windowOpen = false;
        /** The CPace sid for the current PIN attempt (for PSK wrapping). */
        this.currentSid = null;
        /** Pairing server/activate messages received since the last Noise handshake. */
        this.pairingActivateCount = 0;
        /** The counter for the current attempt (pairing_index and CPace sid counter). */
        this.attemptIndex = 0;
        /** The dynamic PIN length for the current attempt, from the activation. */
        this.pinLength = null;
        if (deps.staticPin !== undefined && !isValidStaticPin(deps.staticPin)) {
            throw new Error("staticPin must be exactly 8 decimal digits");
        }
        this.minPinLength = Math.min(MAX_PIN_DIGITS, Math.max(MIN_PIN_DIGITS, deps.minPinLength ?? DEFAULT_MIN_PIN_DIGITS));
        if (!deps.storage && deps.onPin) {
            // Spec requires the failure counter to survive reboots. Without storage
            // it is in-memory only and escalation resets on restart.
            console.warn("sendspin: dynamic PIN pairing is enabled without storage, so the failure counter will not persist across reboots.");
        }
        this.failures = this.loadFailures();
    }
    /** The pairing-method descriptors to advertise in client/hello. */
    descriptors() {
        const out = [
            withLocations({ method: "pairing_psk" }, this.deps.pairingPskLocations),
        ];
        if (this.deps.staticPin !== undefined) {
            out.push(withLocations({ method: "static_pin" }, this.deps.staticPinLocations));
        }
        if (this.deps.onPin) {
            out.push({
                method: "dynamic_pin",
                out_channels: this.deps.pinOutChannels ?? ["display"],
                min_pin_length: this.minPinLength,
            });
        }
        return out;
    }
    /**
     * Whether dynamic PIN has escalated to gesture-gating (spec: 10 failures).
     * Escalation is not an error state: the method stays offered, and every
     * attempt needs openPairingWindow() until a successful round de-escalates it.
     */
    isDynamicPinEscalated() {
        return this.failures >= ESCALATION_THRESHOLD;
    }
    /**
     * Operator gesture that opens the pairing window. If an attempt is already
     * waiting on it the attempt starts immediately, otherwise the window admits
     * one attempt within its lifetime (~5 minutes).
     */
    openPairingWindow() {
        if (this.phase === "await-window") {
            this.startAttempt();
            return;
        }
        this.windowOpen = true;
        if (this.windowTimer)
            clearTimeout(this.windowTimer);
        this.windowTimer = setTimeout(() => this.closeWindow(), WINDOW_LIFETIME_MS);
    }
    /**
     * Close the pairing window. The window is device state, not connection
     * state: it survives handshakes and drops until an attempt consumes it or
     * its lifetime runs out.
     */
    closeWindow() {
        this.windowOpen = false;
        if (this.windowTimer)
            clearTimeout(this.windowTimer);
        this.windowTimer = null;
    }
    /** Cancel an in-progress pairing attempt (sends pair/abort user_cancelled). */
    cancelPairing() {
        if (this.phase === "idle")
            return;
        this.abort("user_cancelled");
    }
    /** Called for every server/activate. Returns true if it consumed a pairing activation. */
    onActivate(activities, pairing) {
        const isPairing = activities.includes("pairing");
        if (!isPairing) {
            // Non-pairing activate in place of pair-finalize = leave-pairing.
            this.abandonAttempt("server_cancelled");
            return false;
        }
        // A pairing activate arriving mid-attempt supersedes it: the server has
        // moved on, and any message still carrying the old index is discarded.
        this.abandonAttempt("superseded");
        // Each pairing activate is one attempt, indexed for pairing_index and sid.
        this.pairingActivateCount += 1;
        this.attemptIndex = this.pairingActivateCount;
        const method = pairing?.method;
        const supported = this.descriptors().map((d) => d.method);
        // pairing_psk exactly when the matched PSK is the Pairing PSK, a PIN method otherwise.
        const fitsPsk = (method === "pairing_psk") ===
            (this.deps.matchedCategory() === "pairing");
        if (!method) {
            // A required field no conformant server omits, so it is a protocol error
            // rather than a rejection: close without any application-level message.
            // The log is local, so it still tells the integrator what went wrong.
            console.warn("sendspin: server/activate carried no pairing method, so the server is not speaking the current specification.");
            this.fail();
            return true;
        }
        // A method the PSK disallows or the client no longer offers is something a
        // conformant server can produce, since its view of the config may be stale.
        if (!fitsPsk || !supported.includes(method)) {
            this.abort("method_not_supported");
            return true;
        }
        this.method = method;
        if (method === "pairing_psk") {
            this.sendFinalize();
            // Arm the attempt timer and leave a non-idle phase so the attempt can be
            // cancelled and times out if the server never sends server/pair-finalize.
            this.phase = "await-finalize";
            this.armAttemptTimer();
            this.deps.onEvent?.("started");
            return true;
        }
        if (method === "dynamic_pin") {
            const length = pairing.pin_length;
            // Same protocol-error treatment as a missing method: pin_length_unacceptable
            // is defined over a value that is present but out of range.
            if (typeof length !== "number" || !Number.isInteger(length)) {
                this.fail();
                return true;
            }
            if (length < this.minPinLength || length > MAX_PIN_DIGITS) {
                this.abort("pin_length_unacceptable");
                return true;
            }
            this.pinLength = length;
            this.languages = readLanguages(pairing.languages);
        }
        if (this.isGestureGated() && !this.windowOpen) {
            this.phase = "await-window";
            // pair-pending does not start the attempt, so no attempt timer runs. The
            // server bounds the wait and cancels with a non-pairing server/activate.
            this.deps.sendControl({
                type: "client/pair-pending",
                payload: { pairing_index: this.attemptIndex },
            });
            this.deps.onEvent?.("pending");
            return true;
        }
        this.startAttempt();
        return true;
    }
    /**
     * Whether the selected method withholds client/pair-init until a window is
     * open: static PIN always, dynamic PIN when escalated or the PIN is short.
     */
    isGestureGated() {
        if (this.method === "static_pin")
            return true;
        if (this.method !== "dynamic_pin")
            return false;
        return this.isDynamicPinEscalated() || this.pinLength < SHORT_PIN_LENGTH;
    }
    /** server/pair-init: the server's nonce contribution (dynamic PIN). */
    onPairInit(payload) {
        // Leftover from an ended attempt (kept-open connection): discard silently.
        if (this.phase === "idle")
            return;
        if (this.phase !== "await-init" || this.method !== "dynamic_pin") {
            return this.fail();
        }
        const nonceA = this.decode(payload.nonce_A, NONCE_SIZE);
        if (!nonceA)
            return this.fail();
        const h = this.deps.handshakeHash();
        const pin = derivePin(h, nonceA, this.nonceB, this.pinLength);
        this.currentSid = this.sid(h, this.attemptIndex);
        this.cpace = CPace.start({
            role: "responder",
            prs: new TextEncoder().encode(pin),
            sid: this.currentSid,
            ada: CPACE_AD_A,
            adb: CPACE_AD_B,
        });
        this.phase = "await-auth";
        this.deps.onPin?.(pin, this.languages);
    }
    /** server/pair-auth: the server's CPace public share (both PIN methods). */
    onPairAuth(payload) {
        if (this.phase === "idle")
            return; // leftover from an ended attempt
        if (this.phase !== "await-auth" || !this.cpace)
            return this.fail();
        const peerShare = this.decode(payload.pake_msg_1, SHARE_SIZE);
        if (!peerShare)
            return this.fail();
        this.deps.sendControl({
            type: "client/pair-auth",
            payload: { pake_msg_2: base64urlEncode(this.cpace.publicShare) },
        });
        try {
            this.cpace.derive(peerShare);
        }
        catch (e) {
            if (e instanceof CPaceError)
                return this.fail();
            throw e;
        }
        this.phase = "await-confirm";
    }
    /** server/pair-confirm: verify the server's tag, then confirm and finalize. */
    onPairConfirm(payload) {
        if (this.phase === "idle")
            return; // leftover from an ended attempt
        if (this.phase !== "await-confirm" || !this.cpace)
            return this.fail();
        const serverKc = this.decode(payload.server_kc, TAG_SIZE);
        if (!serverKc)
            return this.fail();
        if (!this.cpace.verify(serverKc)) {
            if (this.method === "dynamic_pin")
                this.recordFailure();
            return this.abort("pin_mismatch");
        }
        // Reset on a verified server_kc, whether or not the attempt finalizes.
        if (this.method === "dynamic_pin")
            this.resetFailures();
        const confirm = {
            client_kc: base64urlEncode(this.cpace.tag()),
        };
        if (this.method === "dynamic_pin") {
            confirm.nonce_B = base64urlEncode(this.nonceB);
        }
        this.deps.sendControl({ type: "client/pair-confirm", payload: confirm });
        // client/pair-finalize follows immediately, without waiting (spec).
        this.phase = "await-finalize";
        this.sendFinalize();
    }
    onPairFinalize() {
        if (!this.pendingPsk)
            return;
        this.deps.pskStore.addLongTerm(this.pendingPsk, this.deps.serverId());
        this.clearAttempt();
        this.deps.onEvent?.("finalized");
    }
    /**
     * Inbound pair/abort from the server: discard the attempt. The sender closes
     * the connection when needed, so the receiver keeps it open. A pair/abort for
     * an already-ended attempt has no effect.
     */
    onAbort(reason) {
        if (this.phase === "idle" && !this.pendingPsk)
            return;
        this.clearAttempt();
        this.deps.onEvent?.("aborted", reason);
    }
    /** Discard any in-flight pairing state and the activate counter (on handshake/close). */
    reset() {
        this.clearAttempt();
        this.pairingActivateCount = 0;
        this.attemptIndex = 0;
    }
    /** Send client/pair-init. The window's lifetime ends here (spec: it runs
     * from the gesture until client/pair-init is sent). */
    startAttempt() {
        this.closeWindow();
        this.armAttemptTimer();
        this.deps.onEvent?.("started");
        if (this.method === "dynamic_pin") {
            this.nonceB = generateNonce();
            this.phase = "await-init";
            this.deps.sendControl({
                type: "client/pair-init",
                payload: {
                    pairing_index: this.attemptIndex,
                    commit_B: base64urlEncode(commitNonce(this.nonceB)),
                },
            });
            return;
        }
        const h = this.deps.handshakeHash();
        this.currentSid = this.sid(h, this.attemptIndex);
        this.cpace = CPace.start({
            role: "responder",
            prs: new TextEncoder().encode(this.deps.staticPin),
            sid: this.currentSid,
            ada: CPACE_AD_A,
            adb: CPACE_AD_B,
        });
        this.phase = "await-auth";
        this.deps.sendControl({
            type: "client/pair-init",
            payload: { pairing_index: this.attemptIndex },
        });
    }
    /** Mint the long-term PSK and send client/pair-finalize. */
    sendFinalize() {
        // A Sendspin PSK must be a 32-byte CSPRNG value, not a clamped X25519 private key.
        const psk = crypto.getRandomValues(new Uint8Array(32));
        this.pendingPsk = psk;
        if (this.cpace && this.currentSid) {
            // PIN flow: seal the PSK under a key derived from the CPace output.
            const kWrap = sha256(concatBytes(PSK_WRAP_LABEL, this.currentSid, this.cpace.isk));
            const wrapped = this.deps.aeadSeal(kWrap, psk);
            this.deps.sendControl({
                type: "client/pair-finalize",
                payload: { wrapped_psk: base64urlEncode(wrapped) },
            });
            return;
        }
        // Pairing PSK flow: the PSK travels directly.
        this.deps.sendControl({
            type: "client/pair-finalize",
            payload: { long_term_psk: base64urlEncode(psk) },
        });
    }
    sid(handshakeHash, index) {
        const label = utf8(PAKE_SID_LABEL);
        const sid = new Uint8Array(label.length + handshakeHash.length + 4);
        sid.set(label, 0);
        sid.set(handshakeHash, label.length);
        // counter: big-endian uint32 of the attempt index.
        new DataView(sid.buffer).setUint32(label.length + handshakeHash.length, index, false);
        return sid;
    }
    armAttemptTimer() {
        this.attemptTimer = setTimeout(() => this.abort("attempt_timeout"), ATTEMPT_TIMEOUT_MS);
    }
    /**
     * Send pair/abort with reason and discard state. The connection stays open
     * for a retry. Only concurrent_attempt closes it.
     */
    abort(reason) {
        this.clearAttempt();
        this.deps.sendControl({ type: "pair/abort", payload: { reason } });
        this.deps.onEvent?.("aborted", reason);
        if (reason === "concurrent_attempt")
            this.deps.close();
    }
    /** Protocol violation or malformed field: fail closed without an abort reason. */
    fail() {
        this.clearAttempt();
        this.deps.close();
    }
    clearAttempt() {
        if (this.attemptTimer)
            clearTimeout(this.attemptTimer);
        this.attemptTimer = null;
        if (this.method && PIN_METHODS.includes(this.method)) {
            this.deps.onPin?.(null);
        }
        this.pendingPsk = null;
        this.phase = "idle";
        this.method = null;
        this.cpace = null;
        this.currentSid = null;
        this.nonceB = null;
        this.pinLength = null;
        this.languages = undefined;
    }
    /**
     * End an attempt the server walked away from, without sending pair/abort.
     * The event lets the app drop any "waiting for gesture" UI, which a silent
     * cancel would otherwise leave up (the server's pair/abort is only a SHOULD).
     */
    abandonAttempt(detail) {
        if (this.phase === "idle" && !this.pendingPsk)
            return;
        this.clearAttempt();
        this.deps.onEvent?.("aborted", detail);
    }
    decode(value, size) {
        if (typeof value !== "string")
            return null;
        try {
            const raw = base64urlDecode(value);
            return raw.length === size ? raw : null;
        }
        catch {
            return null;
        }
    }
    loadFailures() {
        try {
            const raw = this.deps.storage?.getItem(FAILURES_STORAGE_KEY);
            if (!raw)
                return 0;
            const stored = JSON.parse(raw);
            return stored.dynamic_pin ?? 0;
        }
        catch {
            return 0;
        }
    }
    saveFailures() {
        this.deps.storage?.setItem(FAILURES_STORAGE_KEY, JSON.stringify({ dynamic_pin: this.failures }));
    }
    recordFailure() {
        this.failures += 1;
        this.saveFailures();
    }
    resetFailures() {
        this.failures = 0;
        this.saveFailures();
    }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const KEY_SIZE = 32;
function encodeBase32(bytes) {
    let bits = 0;
    let value = 0;
    let encoded = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if (bits > 0) {
        encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return encoded;
}
function encodePairingToken(clientId, pairingPsk) {
    const clientKey = base64urlDecode(clientId);
    const psk = base64urlDecode(pairingPsk);
    if (clientKey.length !== KEY_SIZE) {
        throw new Error(`clientId must decode to ${KEY_SIZE} bytes`);
    }
    if (psk.length !== KEY_SIZE) {
        throw new Error(`pairingPsk must decode to ${KEY_SIZE} bytes`);
    }
    const payload = new Uint8Array(clientKey.length + psk.length);
    payload.set(clientKey);
    payload.set(psk, clientKey.length);
    const body = encodeBase32(payload).replace(/2/g, "9");
    return `SP:0${body}`;
}

/**
 * SendspinCore: Protocol + decoding layer.
 *
 * Manages the WebSocket connection, Sendspin protocol, time synchronization,
 * state management, and audio decoding. Emits decoded PCM audio chunks that
 * can be consumed by SendspinPlayer for playback, or by visualization/analysis
 * tools directly.
 */
class SendspinCore {
    constructor(config) {
        this.handshakeInfo = null;
        // ========================================
        // StreamHandler implementation
        // (called by ProtocolHandler)
        // ========================================
        /** Visualizer role callbacks (set by SendspinPlayer). */
        this.onVisualizerFrame = null;
        this.onVisualizerStream = null;
        this.onVisualizerClear = null;
        /** Artwork role callbacks (set by SendspinPlayer). */
        this.onArtwork = null;
        this.onArtworkCancel = null;
        this.onArtworkStream = null;
        this.artworkConfig = null;
        // At most one transfer is in flight across all channels (spec: artwork binary).
        this.artworkTransfer = null;
        // Validate configured codecs up front so a set with no browser overlap
        // throws to the app instead of failing silently inside client/hello dispatch.
        if (config.codecs)
            getSupportedFormats(config.codecs);
        this.hasStorage = (config.storage ?? null) !== null;
        this.identity = Identity.loadOrCreate(config.storage ?? null);
        const clientName = config.clientName ??
            `Sendspin JS Client (${this.identity.clientId.slice(0, 6)})`;
        this.config = { ...config, clientName };
        // Initial delay precedence: explicit config, then persisted, then default.
        this.delayStore = new StaticDelayStore(config.storage ?? null);
        const persisted = this.delayStore.load();
        const initialDelay = config.syncDelay ?? persisted ?? config.defaultSyncDelay ?? 0;
        this._syncDelayMs = clampSyncDelayMs(initialDelay);
        this.timeFilter = new SendspinTimeFilter(0, 1.1, 2.0, 1e-12);
        this.stateManager = new StateManager(config.onStateChange);
        this.decoder = new SendspinDecoder((chunk) => this._onAudioData?.(chunk), () => this.stateManager.streamGeneration);
        this.wsManager = new WebSocketManager(config.reconnect);
        this.pskStore = new PskStore(config.storage ?? null);
        for (const r of config.longTermPsks ?? []) {
            this.pskStore.addLongTerm(base64urlDecode(r.psk), r.serverId);
        }
        // Standing candidate: a server may re-handshake to it before the app reads pairingPsk.
        if (this.hasStorage)
            this.pskStore.getOrCreatePairingPsk();
        this.transport = new SendspinTransport(this.wsManager, {
            identity: this.identity,
            pskStore: this.pskStore,
            suiteId: config.suite ?? "chacha",
            unpairedAccess: config.unpairedAccess ?? true,
        }, {
            onHandshakeComplete: (info) => {
                const isRehandshake = this.handshakeInfo !== null;
                this.handshakeInfo = info;
                // Drop any pending pairing PSK a re-handshake would otherwise strand.
                this.pairing.reset();
                this.protocolHandler.resetActivation(isRehandshake);
            },
            onControlMessage: (msg) => this.routeControl(msg),
            onBinaryMessage: (bytes) => this.handleBinaryMessage(bytes.buffer),
        });
        this.pairing = new PairingManager({
            sendControl: (m) => this.transport.sendControl(m),
            close: () => this.transport.close(),
            pskStore: this.pskStore,
            serverId: () => this.handshakeInfo?.serverId ?? "",
            matchedCategory: () => this.handshakeInfo?.category ?? "sentinel",
            handshakeHash: () => this.transport.handshakeHash,
            aeadSeal: (key, plaintext) => SUITES[config.suite ?? "chacha"].aeadEncrypt(key, 0n, new Uint8Array(0), plaintext),
            storage: config.storage ?? null,
            onPin: config.onPairingPin ?? null,
            pinOutChannels: config.pinOutChannels,
            minPinLength: config.minPinLength,
            staticPin: config.staticPin,
            staticPinLocations: config.staticPinLocations,
            pairingPskLocations: config.pairingPskLocations,
            onEvent: (e, d) => this.config.onPairing?.(e, d),
        });
        const helloContext = {
            trustLevel: () => this.handshakeInfo?.trustLevel ?? "none",
            pairMethods: () => (this.hasStorage ? this.pairing.descriptors() : []),
            unpairedAccess: config.unpairedAccess ?? true,
        };
        this.protocolHandler = new ProtocolHandler(this.transport, helloContext, this, // this class implements StreamHandler
        this.stateManager, this.timeFilter, {
            clientName,
            productName: config.productName,
            codecs: config.codecs,
            bufferCapacity: config.bufferCapacity,
            requiredLeadTimeMs: config.requiredLeadTimeMs,
            minBufferMs: config.minBufferMs,
            useHardwareVolume: config.useHardwareVolume,
            onVolumeCommand: config.onVolumeCommand,
            onDelayCommand: config.onDelayCommand,
            getExternalVolume: config.getExternalVolume,
        });
    }
    // Route decrypted control messages from the transport. Pairing consumes its
    // own activate/finalize/abort; everything else goes to the protocol handler.
    routeControl(msg) {
        if (msg.type === "server/activate") {
            const p = (msg.payload ?? {});
            if (p.activities?.includes("pairing")) {
                this.protocolHandler.suspendForPairing();
            }
            const consumed = this.pairing.onActivate(p.activities ?? [], p.pairing);
            if (!consumed)
                this.protocolHandler.handleServerMessage(msg);
            return;
        }
        if (msg.type === "server/pair-init") {
            return this.pairing.onPairInit((msg.payload ?? {}));
        }
        if (msg.type === "server/pair-auth") {
            return this.pairing.onPairAuth((msg.payload ?? {}));
        }
        if (msg.type === "server/pair-confirm") {
            return this.pairing.onPairConfirm((msg.payload ?? {}));
        }
        if (msg.type === "server/pair-finalize")
            return this.pairing.onPairFinalize();
        if (msg.type === "pair/abort") {
            return this.pairing.onAbort((msg.payload ?? {}).reason ?? "");
        }
        this.protocolHandler.handleServerMessage(msg);
    }
    onTransportClose() {
        // Drop the transport's handshake timer and stale session so a reconnect
        // starts clean and a synchronous send from onConnectionOpen can't emit a
        // frame under the dead session's keys.
        this.transport.onSocketClosed();
        this.handshakeInfo = null;
        this.protocolHandler.stopTimeSync();
        this.protocolHandler.resetActivation();
        this.pairing.reset();
        // Stop periodic state-update sends so they don't spam
        // "WebSocket not connected" warnings after the transport is gone.
        this.stateManager.clearStateUpdateInterval();
        this.artworkTransfer = null;
        console.log("Sendspin: Connection closed");
        this._onConnectionClose?.();
    }
    setVisualizerRequest(request) {
        this.protocolHandler.setVisualizerRequest(request);
    }
    setArtworkRequest(request) {
        this.protocolHandler.setArtworkRequest(request);
    }
    handleArtworkStreamStart(config) {
        console.log("Sendspin: Artwork stream started", config);
        this.artworkConfig = config;
        this.onArtworkStream?.(config);
    }
    handleArtworkStreamEnd() {
        console.log("Sendspin: Artwork stream ended");
        this.artworkConfig = null;
        this.artworkTransfer = null;
        this.onArtworkStream?.(null);
    }
    // Binary artwork message, types 8-11 = channels 0-3, byte 1 = flags:
    //   announce (bit 1): [type][flags][timestamp:8 BE int64][total_size:4 BE uint32]
    //   part (no bits):   [type][flags][data...]
    //   cancel (bit 0):   [type][flags]
    // The parts' data concatenated is the encoded image, complete at total_size bytes.
    // Servers on aiosendspin <= 9.1.x (Music Assistant) send the older single-message form instead,
    //   [type][timestamp:8 BE int64][image...] (header only = clear),
    // whose byte 1 is the timestamp's top byte, always 0. A flags byte of 0 is a part, which is only
    // valid while a transfer is in flight, so a 0 with none in flight is read as the older form.
    // Malformed input is logged and dropped rather than closing the connection.
    handleArtworkBinary(type, data) {
        const channel = type - 8;
        const bytes = new Uint8Array(data);
        if (bytes.length < 2)
            return;
        const flags = bytes[1];
        if (flags === 0 && !this.artworkTransfer && bytes.length >= 9) {
            const timestampUs = Number(new DataView(data).getBigInt64(1));
            const total = bytes.length - 9;
            this.artworkTransfer = { channel, timestampUs, total, received: total, parts: total ? [bytes.slice(9)] : [] };
            this.finishArtworkTransfer();
            return;
        }
        if (flags & 0xfc || (flags & 3) === 3) {
            console.warn("Sendspin: Malformed artwork message, flags", flags);
            return;
        }
        if (flags & 1) {
            if (this.artworkTransfer?.channel === channel)
                this.artworkTransfer = null;
            this.onArtworkCancel?.(channel);
            return;
        }
        if (flags & 2) {
            if (bytes.length !== 14) {
                console.warn("Sendspin: Malformed artwork announce, length", bytes.length);
                return;
            }
            const view = new DataView(data);
            const timestampUs = Number(view.getBigInt64(2));
            const total = view.getUint32(10);
            this.artworkTransfer = { channel, timestampUs, total, received: 0, parts: [] };
            if (total === 0)
                this.finishArtworkTransfer();
            return;
        }
        const t = this.artworkTransfer;
        if (!t || t.channel !== channel || t.received + bytes.length - 2 > t.total) {
            console.warn("Sendspin: Unexpected artwork part on channel", channel);
            this.artworkTransfer = null;
            return;
        }
        t.parts.push(bytes.slice(2));
        t.received += bytes.length - 2;
        if (t.received === t.total)
            this.finishArtworkTransfer();
    }
    finishArtworkTransfer() {
        const t = this.artworkTransfer;
        this.artworkTransfer = null;
        const format = this.artworkConfig?.channels[t.channel]?.format ?? "jpeg";
        const image = t.total === 0
            ? null
            : new Blob(t.parts, { type: `image/${format}` });
        this.onArtwork?.({ channel: t.channel, timestampUs: t.timestampUs, image });
    }
    handleVisualizerStreamStart(config) {
        console.log("Sendspin: Visualizer stream started", config);
        this.onVisualizerStream?.(config);
    }
    handleVisualizerStreamClear() {
        this.onVisualizerClear?.();
    }
    handleVisualizerStreamEnd() {
        console.log("Sendspin: Visualizer stream ended");
        this.onVisualizerStream?.(null);
    }
    // Binary visualizer frame: [type:1][timestamp:8 BE int64][data]
    // See spec roles/visualizer/v1.md. All uint16 fields are big-endian.
    handleVisualizerBinary(type, data) {
        if (!this.onVisualizerFrame || data.byteLength < 9)
            return;
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
                for (let i = 0; i < n; i++)
                    bins[i] = view.getUint16(9 + 2 * i);
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
    handleBinaryMessage(data) {
        const messageType = new Uint8Array(data, 0, 1)[0];
        if (messageType >= 16 && messageType <= 23) {
            this.handleVisualizerBinary(messageType, data);
            return;
        }
        if (messageType >= 8 && messageType <= 11) {
            this.handleArtworkBinary(messageType, data);
            return;
        }
        const format = this.stateManager.currentStreamFormat;
        if (!format) {
            console.warn("Sendspin: Received audio chunk but no stream format set");
            return;
        }
        const generation = this.stateManager.streamGeneration;
        this.decoder.handleBinaryMessage(data, format, generation);
    }
    handleStreamStart(format, isFormatUpdate) {
        if (!isFormatUpdate) {
            this.decoder.clearState();
        }
        this._onStreamStart?.(format, isFormatUpdate);
    }
    handleStreamClear() {
        this.decoder.clearState();
        this._onStreamClear?.();
    }
    handleStreamEnd() {
        this.decoder.clearState();
        this._onStreamEnd?.();
    }
    handleVolumeUpdate() {
        this._onVolumeUpdate?.();
    }
    applyDelay(delayMs) {
        this._syncDelayMs = clampSyncDelayMs(delayMs);
        this.delayStore.save(this._syncDelayMs);
        this._onSyncDelayChange?.(this._syncDelayMs);
    }
    handleSyncDelayChange(delayMs) {
        this.applyDelay(delayMs);
    }
    getSyncDelayMs() {
        return this._syncDelayMs;
    }
    // ========================================
    // Event registration
    // ========================================
    set onAudioData(cb) {
        this._onAudioData = cb;
    }
    set onStreamStart(cb) {
        this._onStreamStart = cb;
    }
    set onStreamClear(cb) {
        this._onStreamClear = cb;
    }
    set onStreamEnd(cb) {
        this._onStreamEnd = cb;
    }
    set onVolumeUpdate(cb) {
        this._onVolumeUpdate = cb;
    }
    set onSyncDelayChange(cb) {
        this._onSyncDelayChange = cb;
    }
    set onConnectionOpen(cb) {
        this._onConnectionOpen = cb;
    }
    set onConnectionClose(cb) {
        this._onConnectionClose = cb;
    }
    // ========================================
    // Connection
    // ========================================
    async connect() {
        const onOpen = () => {
            this._onConnectionOpen?.();
            this.transport.start();
        };
        const onMessage = (event) => {
            this.transport.handleRaw(event);
        };
        const onError = (error) => {
            console.error("Sendspin: WebSocket error", error);
        };
        const onClose = () => this.onTransportClose();
        if (this.config.webSocket) {
            // Adopt externally-managed WebSocket
            await this.wsManager.adopt(this.config.webSocket, onOpen, onMessage, onError, onClose);
        }
        else {
            // Create connection from baseUrl
            if (!this.config.baseUrl) {
                throw new Error("SendspinCore requires either baseUrl or webSocket to be provided.");
            }
            // Preserve path from baseUrl for reverse proxy support
            const url = new URL(this.config.baseUrl, typeof window !== "undefined" ? window.location.href : undefined);
            const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
            const basePath = url.pathname.replace(/\/$/, "");
            const wsUrl = basePath.endsWith("/sendspin")
                ? `${wsProtocol}//${url.host}${basePath}`
                : `${wsProtocol}//${url.host}${basePath}/sendspin`;
            await this.wsManager.connect(wsUrl, onOpen, onMessage, onError, onClose);
        }
    }
    /**
     * Reset playback-related state (isPlaying, currentStreamFormat) without
     * tearing down the connection. Intended for transport-loss cleanup after
     * any buffered audio has finished draining.
     */
    resetPlaybackState() {
        this.stateManager.isPlaying = false;
        this.stateManager.currentStreamFormat = null;
    }
    disconnect(reason = "restart") {
        if (this.transport.ready) {
            this.protocolHandler.sendGoodbye(reason);
        }
        this.protocolHandler.stopTimeSync();
        this.stateManager.clearAllIntervals();
        this.wsManager.disconnect();
        this.decoder.close();
        this.timeFilter.reset();
        this.stateManager.reset();
    }
    // ========================================
    // Volume / Mute
    // ========================================
    setVolume(volume) {
        this.stateManager.volume = volume;
        this._onVolumeUpdate?.();
        this.protocolHandler.sendStateUpdate();
    }
    setMuted(muted) {
        this.stateManager.muted = muted;
        this._onVolumeUpdate?.();
        this.protocolHandler.sendStateUpdate();
    }
    // ========================================
    // Sync delay
    // ========================================
    setSyncDelay(delayMs) {
        this.applyDelay(delayMs);
        this.protocolHandler.sendStateUpdate();
    }
    // ========================================
    // Buffer timing
    // ========================================
    setRequiredLeadTimeMs(leadTimeMs) {
        this.protocolHandler.setRequiredLeadTimeMs(leadTimeMs);
    }
    setMinBufferMs(minBufferMs) {
        this.protocolHandler.setMinBufferMs(minBufferMs);
    }
    // ========================================
    // Controller commands
    // ========================================
    sendCommand(command, params) {
        const supportedCommands = this.stateManager.serverState.controller?.supported_commands;
        if (supportedCommands && !supportedCommands.includes(command)) {
            throw new Error(`Command '${command}' is not supported by the server. ` +
                `Supported commands: ${supportedCommands.join(", ")}`);
        }
        this.protocolHandler.sendCommand(command, params);
    }
    // ========================================
    // State getters
    // ========================================
    get isPlaying() {
        return this.stateManager.isPlaying;
    }
    get volume() {
        return this.stateManager.volume;
    }
    get muted() {
        return this.stateManager.muted;
    }
    get playerState() {
        return this.stateManager.playerState;
    }
    get currentFormat() {
        return this.stateManager.currentStreamFormat;
    }
    get isConnected() {
        return this.wsManager.isConnected();
    }
    // ========================================
    // Identity / pairing
    // ========================================
    get clientId() {
        return this.identity.clientId;
    }
    /** The client's Pairing PSK (base64url), for the operator to enter into the server. Null without storage. */
    get pairingPsk() {
        return this.hasStorage
            ? base64urlEncode(this.pskStore.getOrCreatePairingPsk())
            : null;
    }
    get pairingToken() {
        const pairingPsk = this.pairingPsk;
        return pairingPsk ? encodePairingToken(this.clientId, pairingPsk) : null;
    }
    rotatePairingPsk() {
        if (!this.hasStorage)
            return null;
        this.pskStore.rotatePairingPsk();
        return this.pairingPsk;
    }
    /**
     * Operator gesture that opens the pairing window (~5 minutes, admits one
     * attempt). Required before each gesture-gated attempt: every static PIN
     * attempt, and dynamic PIN when escalated or the PIN is shorter than 6.
     */
    openPairingWindow() {
        this.pairing.openPairingWindow();
    }
    /** Cancel an in-progress pairing attempt (sends pair/abort user_cancelled). */
    cancelPairing() {
        this.pairing.cancelPairing();
    }
    /** Whether dynamic PIN has escalated to gesture-gating (10 failures). */
    isDynamicPinEscalated() {
        return this.pairing.isDynamicPinEscalated();
    }
    get timeSyncInfo() {
        return {
            synced: this.timeFilter.is_synchronized,
            offset: Math.round(this.timeFilter.offset / 1000),
            error: Math.round(this.timeFilter.error / 1000),
        };
    }
    getCurrentServerTimeUs() {
        return this.timeFilter.computeServerTime(Math.floor(performance.now() * 1000));
    }
    get trackProgress() {
        const metadata = this.stateManager.serverState.metadata;
        if (!metadata?.progress || metadata.timestamp === undefined) {
            return null;
        }
        const serverTimeUs = this.getCurrentServerTimeUs();
        const elapsedUs = serverTimeUs - metadata.timestamp;
        const positionMs = metadata.progress.track_progress +
            (elapsedUs * metadata.progress.playback_speed) / 1000000;
        const trackDuration = metadata.progress.track_duration;
        return {
            // track_duration 0 means unbounded (live radio), so floor at 0 only.
            positionMs: trackDuration === 0
                ? Math.max(0, positionMs)
                : Math.max(0, Math.min(positionMs, trackDuration)),
            durationMs: trackDuration,
            playbackSpeed: metadata.progress.playback_speed / 1000,
        };
    }
    // ========================================
    // Internal accessors (for SendspinPlayer)
    // ========================================
    /** @internal */
    get _stateManager() {
        return this.stateManager;
    }
    /** @internal */
    get _timeFilter() {
        return this.timeFilter;
    }
}

/**
 * Audio clock source selection and output timestamp validation.
 *
 * Manages two clock sources for AudioContext time:
 * - "estimated": De-quantized AudioContext.currentTime using wall-clock slew
 * - "timestamp": AudioContext.getOutputTimestamp() with extensive validation
 *
 * Promotes to "timestamp" after enough good samples, demotes on failures.
 *
 * Both sources report the same quantity: the *render* clock, in the
 * `AudioContext.currentTime` domain that `source.start()` accepts.
 * `getOutputTimestamp().contextTime` is the playout clock instead (the frame
 * leaving the output port), which trails the render clock by
 * baseLatency + outputLatency, so callers pass that latency in and it is added
 * back. Without it the two sources would disagree by one output latency and
 * playback would audibly step whenever the source is promoted or demoted.
 */
const OUTPUT_TIMESTAMP_MAX_FRESHNESS_MS = 250;
const OUTPUT_TIMESTAMP_MIN_SAMPLE_INTERVAL_MS = 40;
const OUTPUT_TIMESTAMP_SLOPE_MIN = 0.95;
const OUTPUT_TIMESTAMP_SLOPE_MAX = 1.05;
const OUTPUT_TIMESTAMP_MAX_DIVERGENCE_SEC = 0.25;
const OUTPUT_TIMESTAMP_MAX_DIVERGENCE_DELTA_SEC = 0.05;
const OUTPUT_TIMESTAMP_MAX_BACKWARD_SEC = 0.005;
const OUTPUT_TIMESTAMP_FUTURE_TOLERANCE_MS = 5;
const OUTPUT_TIMESTAMP_PROMOTION_MIN_GOOD_SAMPLES = 6;
const OUTPUT_TIMESTAMP_PROMOTION_MIN_SPAN_MS = 750;
const OUTPUT_TIMESTAMP_MAX_CONSECUTIVE_BAD_SAMPLES = 2;
// Timing estimate constants
const TIMING_MAX_SLEW_SEC = 0.002;
const TIMING_RESET_THRESHOLD_SEC = 0.5;
const TIMING_MAX_LEAD_SEC = 0.1;
class ClockSource {
    constructor() {
        this.activeSource = "estimated";
        this._pendingCutover = false;
        this._lastRejectReason = null;
        this._timestampPromotionDisabled = false;
        // Output timestamp validation state
        this.lastSample = null;
        this.goodSamples = 0;
        this.badSamples = 0;
        this.goodSinceMs = null;
        // Estimated time state
        this.estimateAudioTimeSec = null;
        this.estimateAtMs = null;
    }
    get active() {
        return this.activeSource;
    }
    get pendingCutover() {
        return this._pendingCutover;
    }
    set pendingCutover(value) {
        this._pendingCutover = value;
    }
    get lastRejectReason() {
        return this._lastRejectReason;
    }
    get timestampGoodSamples() {
        return this.goodSamples;
    }
    get timestampPromotionDisabled() {
        return this._timestampPromotionDisabled;
    }
    /** Disable timestamp promotion (e.g., on Cast receivers to avoid rate oscillations). */
    disableTimestampPromotion() {
        this._timestampPromotionDisabled = true;
    }
    setActive(source) {
        if (this.activeSource === source)
            return false;
        this.activeSource = source;
        this._pendingCutover = source === "timestamp";
        if (this._pendingCutover) {
            this._onPromotion?.();
        }
        return this._pendingCutover;
    }
    onPromotion(cb) {
        this._onPromotion = cb;
    }
    reset() {
        this.activeSource = "estimated";
        this._pendingCutover = false;
        this.lastSample = null;
        this.goodSamples = 0;
        this._lastRejectReason = null;
        this.badSamples = 0;
        this.goodSinceMs = null;
        this.estimateAudioTimeSec = null;
        this.estimateAtMs = null;
    }
    demote(reason) {
        this.reset();
        this._lastRejectReason = reason;
    }
    rejectSample(reason, catastrophic = false) {
        this.lastSample = null;
        this.goodSamples = 0;
        this.goodSinceMs = null;
        this._lastRejectReason = reason;
        if (this.activeSource !== "timestamp") {
            this.badSamples = 0;
            return;
        }
        this.badSamples += 1;
        if (catastrophic ||
            this.badSamples >= OUTPUT_TIMESTAMP_MAX_CONSECUTIVE_BAD_SAMPLES) {
            this.demote(reason);
        }
    }
    getEstimatedTime(rawTimeSec, nowMs) {
        if (this.estimateAudioTimeSec === null) {
            this.estimateAudioTimeSec = rawTimeSec;
            this.estimateAtMs = nowMs;
        }
        else if (this.estimateAtMs !== null) {
            const wallDeltaSec = Math.max(0, (nowMs - this.estimateAtMs) / 1000);
            const predicted = this.estimateAudioTimeSec + wallDeltaSec;
            this.estimateAtMs = nowMs;
            const errorSec = rawTimeSec - predicted;
            if (Math.abs(errorSec) > TIMING_RESET_THRESHOLD_SEC) {
                this.estimateAudioTimeSec = rawTimeSec;
            }
            else {
                const slew = Math.max(-TIMING_MAX_SLEW_SEC, Math.min(TIMING_MAX_SLEW_SEC, errorSec));
                const next = Math.max(this.estimateAudioTimeSec, predicted + slew);
                this.estimateAudioTimeSec = Math.min(next, rawTimeSec + TIMING_MAX_LEAD_SEC);
            }
        }
        return this.estimateAudioTimeSec ?? rawTimeSec;
    }
    getTimestampDerivedTime(rawTimeSec, audioContext, playoutLatencySec) {
        // On Cast receivers, stay on the estimated clock to avoid rate oscillations.
        if (this._timestampPromotionDisabled) {
            if (this.activeSource !== "estimated" ||
                this.lastSample !== null ||
                this.goodSamples !== 0 ||
                this._lastRejectReason !== null) {
                this.reset();
            }
            return null;
        }
        const getOutputTimestamp = audioContext.getOutputTimestamp;
        if (typeof getOutputTimestamp !== "function") {
            if (this.activeSource === "timestamp") {
                this.demote("getOutputTimestamp unavailable");
            }
            return null;
        }
        try {
            const ts = getOutputTimestamp.call(audioContext);
            const nowMs = performance.now();
            const rawFreshnessMs = nowMs - ts.performanceTime;
            if (rawFreshnessMs < -OUTPUT_TIMESTAMP_FUTURE_TOLERANCE_MS) {
                this.rejectSample(`performanceTime in future (${rawFreshnessMs.toFixed(1)}ms)`, true);
                return null;
            }
            const freshnessMs = Math.max(0, rawFreshnessMs);
            // contextTime is the playout clock; lift it into the render-clock domain
            // so it is directly comparable to (and interchangeable with) currentTime.
            const predictedAudioTimeSec = ts.contextTime + freshnessMs / 1000 + playoutLatencySec;
            const sample = {
                contextTimeSec: ts.contextTime,
                performanceTimeMs: ts.performanceTime,
                nowMs,
                predictedAudioTimeSec,
                rawAudioTimeSec: rawTimeSec,
            };
            if (freshnessMs > OUTPUT_TIMESTAMP_MAX_FRESHNESS_MS) {
                this.rejectSample(`stale timestamp (${freshnessMs.toFixed(1)}ms old)`, true);
                return null;
            }
            const divergenceSec = predictedAudioTimeSec - rawTimeSec;
            if (Math.abs(divergenceSec) > OUTPUT_TIMESTAMP_MAX_DIVERGENCE_SEC) {
                this.rejectSample(`timestamp/raw divergence ${Math.abs(divergenceSec * 1000).toFixed(1)}ms`, true);
                return null;
            }
            const prev = this.lastSample;
            if (prev) {
                const perfDeltaMs = ts.performanceTime - prev.performanceTimeMs;
                if (perfDeltaMs < 0) {
                    this.rejectSample(`performanceTime moved backward (${perfDeltaMs.toFixed(1)}ms)`, true);
                    return null;
                }
                if (predictedAudioTimeSec <
                    prev.predictedAudioTimeSec - OUTPUT_TIMESTAMP_MAX_BACKWARD_SEC) {
                    this.rejectSample(`predicted audio time moved backward ${((prev.predictedAudioTimeSec - predictedAudioTimeSec) * 1000).toFixed(1)}ms`, true);
                    return null;
                }
                const prevDivergenceSec = prev.predictedAudioTimeSec - prev.rawAudioTimeSec;
                if (Math.abs(divergenceSec - prevDivergenceSec) >
                    OUTPUT_TIMESTAMP_MAX_DIVERGENCE_DELTA_SEC) {
                    this.rejectSample(`timestamp/raw divergence drift ${Math.abs((divergenceSec - prevDivergenceSec) * 1000).toFixed(1)}ms`);
                    return null;
                }
                if (perfDeltaMs >= OUTPUT_TIMESTAMP_MIN_SAMPLE_INTERVAL_MS) {
                    const perfDeltaSec = perfDeltaMs / 1000;
                    const contextSlope = (ts.contextTime - prev.contextTimeSec) / perfDeltaSec;
                    const predictedSlope = (predictedAudioTimeSec - prev.predictedAudioTimeSec) / perfDeltaSec;
                    if (contextSlope < OUTPUT_TIMESTAMP_SLOPE_MIN ||
                        contextSlope > OUTPUT_TIMESTAMP_SLOPE_MAX) {
                        this.rejectSample(`context slope ${contextSlope.toFixed(3)} out of range`);
                        return null;
                    }
                    if (predictedSlope < OUTPUT_TIMESTAMP_SLOPE_MIN ||
                        predictedSlope > OUTPUT_TIMESTAMP_SLOPE_MAX) {
                        this.rejectSample(`predicted slope ${predictedSlope.toFixed(3)} out of range`);
                        return null;
                    }
                }
            }
            this.lastSample = sample;
            this.badSamples = 0;
            if (this.goodSinceMs === null) {
                this.goodSinceMs = nowMs;
            }
            this.goodSamples += 1;
            if (this.activeSource !== "timestamp" &&
                this.goodSamples >= OUTPUT_TIMESTAMP_PROMOTION_MIN_GOOD_SAMPLES &&
                this.goodSinceMs !== null &&
                nowMs - this.goodSinceMs >= OUTPUT_TIMESTAMP_PROMOTION_MIN_SPAN_MS) {
                this.setActive("timestamp");
                this._lastRejectReason = null;
            }
            return predictedAudioTimeSec;
        }
        catch (error) {
            const reason = error instanceof Error
                ? `getOutputTimestamp failed: ${error.message}`
                : `getOutputTimestamp failed: ${String(error)}`;
            this.rejectSample(reason, true);
            return null;
        }
    }
    /**
     * Get a timing snapshot with both derived and raw AudioContext times.
     *
     * @param playoutLatencySec Measured baseLatency + outputLatency, used to
     *   normalize the getOutputTimestamp-derived clock into the render-clock
     *   domain. Pass the measured value regardless of whether latency
     *   compensation is enabled: this only keeps the two clock sources in one
     *   domain, it does not compensate playback.
     */
    getTimingSnapshot(audioContext, playoutLatencySec = 0) {
        const nowMs = performance.now();
        const nowUs = nowMs * 1000;
        if (!audioContext) {
            return {
                audioContextTimeSec: 0,
                audioContextRawTimeSec: 0,
                nowMs,
                nowUs,
            };
        }
        const rawTimeSec = audioContext.currentTime;
        const estimatedTimeSec = this.getEstimatedTime(rawTimeSec, nowMs);
        const timestampTimeSec = this.getTimestampDerivedTime(rawTimeSec, audioContext, playoutLatencySec);
        let derivedTimeSec = this.activeSource === "timestamp" && timestampTimeSec !== null
            ? timestampTimeSec
            : estimatedTimeSec;
        if (!Number.isFinite(derivedTimeSec)) {
            derivedTimeSec = rawTimeSec;
        }
        return {
            audioContextTimeSec: derivedTimeSec,
            audioContextRawTimeSec: rawTimeSec,
            nowMs,
            nowUs,
        };
    }
}

/**
 * Recorrection monitor for detecting sustained sync drift.
 *
 * Runs on a periodic interval and detects when sync error exceeds a threshold
 * for long enough to warrant a hard resync. The monitor only detects — the
 * actual cutover execution is delegated to the scheduler via callback.
 */
const RECORRECTION_CHECK_INTERVAL_MS = 250;
const RECORRECTION_TRIGGER_MS = 30;
const RECORRECTION_SUSTAIN_MS = 400;
const RECORRECTION_COOLDOWN_MS = 1500;
const RECORRECTION_TRANSIENT_JUMP_MS = 25;
const RECORRECTION_TRANSIENT_CONFIRM_WINDOW_MS = RECORRECTION_CHECK_INTERVAL_MS * 4;
const HARD_RESYNC_STARTUP_GRACE_MS = 1000;
const HARD_RESYNC_COOLDOWN_MS = 500;
class RecorrectionMonitor {
    get minScheduleTimeSec() {
        return this._minScheduleTimeSec;
    }
    setMinScheduleTime(timeSec) {
        this._minScheduleTimeSec = timeSec;
    }
    clearMinScheduleTime() {
        this._minScheduleTimeSec = null;
    }
    constructor(onCheck) {
        this.onCheck = onCheck;
        this.interval = null;
        this.breachStartedAtMs = null;
        this.lastRecorrectionAtMs = -Infinity;
        this.prevRawSyncErrorMs = null;
        this.pendingJumpSign = null;
        this.pendingJumpAtMs = null;
        this.transientStartedAtMs = null;
        this._hardResyncGraceUntilMs = null;
        this._lastHardResyncAtMs = -Infinity;
        /** After a recorrection, scheduling must not start before this time. */
        this._minScheduleTimeSec = null;
    }
    start() {
        if (this.interval !== null)
            return;
        this.interval = globalThis.setInterval(() => this.onCheck(), RECORRECTION_CHECK_INTERVAL_MS);
    }
    stop() {
        if (this.interval !== null) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.resetCheckState();
        this.lastRecorrectionAtMs = -Infinity;
    }
    clearBreachState() {
        this.breachStartedAtMs = null;
        this.pendingJumpSign = null;
        this.pendingJumpAtMs = null;
        this.transientStartedAtMs = null;
    }
    resetCheckState() {
        this.clearBreachState();
        this.prevRawSyncErrorMs = null;
    }
    clearHardResyncCooldown() {
        this._hardResyncGraceUntilMs = null;
        this._lastHardResyncAtMs = -Infinity;
    }
    armStartupGrace(nowMs, isTimestampClock) {
        if (isTimestampClock) {
            this._hardResyncGraceUntilMs = null;
            return;
        }
        if (this._hardResyncGraceUntilMs === null) {
            this._hardResyncGraceUntilMs = nowMs + HARD_RESYNC_STARTUP_GRACE_MS;
        }
    }
    canUseHardResync(nowMs, isTimestampClock) {
        if (isTimestampClock) {
            this._hardResyncGraceUntilMs = null;
        }
        else if (this._hardResyncGraceUntilMs !== null &&
            nowMs < this._hardResyncGraceUntilMs) {
            return false;
        }
        return nowMs - this._lastHardResyncAtMs >= HARD_RESYNC_COOLDOWN_MS;
    }
    noteHardResync(nowMs) {
        this._lastHardResyncAtMs = nowMs;
    }
    /** Mark a recorrection as having just happened (for cooldown). */
    markRecorrection(nowMs) {
        this.lastRecorrectionAtMs = nowMs;
    }
    shouldIgnoreTransientJump(rawSyncErrorMs, nowMs) {
        const prev = this.prevRawSyncErrorMs;
        this.prevRawSyncErrorMs = rawSyncErrorMs;
        if (prev === null) {
            this.pendingJumpSign = null;
            this.pendingJumpAtMs = null;
            return false;
        }
        const jumpDeltaMs = rawSyncErrorMs - prev;
        const jumpSign = Math.sign(jumpDeltaMs);
        const isJumpDetected = Math.abs(jumpDeltaMs) >= RECORRECTION_TRANSIENT_JUMP_MS;
        if (!isJumpDetected) {
            this.pendingJumpSign = null;
            this.pendingJumpAtMs = null;
            return false;
        }
        const isConfirmed = this.pendingJumpSign === jumpSign &&
            this.pendingJumpAtMs !== null &&
            nowMs - this.pendingJumpAtMs <= RECORRECTION_TRANSIENT_CONFIRM_WINDOW_MS;
        this.pendingJumpSign = jumpSign;
        this.pendingJumpAtMs = nowMs;
        // Keep the pending jump so a sustained same-sign run stays confirmed.
        if (isConfirmed) {
            return false;
        }
        return true;
    }
    /**
     * Evaluate whether a recorrection should fire given the current sync state.
     * Returns true if the scheduler should perform a guarded cutover.
     */
    shouldRecorrect(smoothedAbsErrorMs, rawSyncErrorMs, nowMs) {
        const isTransient = this.shouldIgnoreTransientJump(rawSyncErrorMs, nowMs);
        if (smoothedAbsErrorMs < RECORRECTION_TRIGGER_MS) {
            this.clearBreachState();
            return false;
        }
        if (isTransient) {
            // Jitter that keeps suppressing for SUSTAIN_MS while smoothed stays high
            // is sustained drift, not a glitch. Stop treating it as transient.
            if (this.transientStartedAtMs === null) {
                this.transientStartedAtMs = nowMs;
            }
            if (nowMs - this.transientStartedAtMs < RECORRECTION_SUSTAIN_MS) {
                this.breachStartedAtMs = null;
                return false;
            }
            // Mature on the same budget as clean drift by counting from suppression start.
            if (this.breachStartedAtMs === null) {
                this.breachStartedAtMs = this.transientStartedAtMs;
            }
        }
        else {
            this.transientStartedAtMs = null;
        }
        if (this.breachStartedAtMs === null) {
            this.breachStartedAtMs = nowMs;
            return false;
        }
        if (nowMs - this.breachStartedAtMs < RECORRECTION_SUSTAIN_MS) {
            return false;
        }
        if (nowMs - this.lastRecorrectionAtMs < RECORRECTION_COOLDOWN_MS) {
            return false;
        }
        return true;
    }
    /** Full reset (on disconnect or stream clear). */
    fullReset() {
        this.stop();
        this._hardResyncGraceUntilMs = null;
        this._lastHardResyncAtMs = -Infinity;
        this._minScheduleTimeSec = null;
    }
}
const RECORRECTION_CUTOVER_GUARD_SEC = 0.3;

/**
 * Output latency tracker with EMA smoothing and persistence.
 *
 * Tracks AudioContext.baseLatency + outputLatency using exponential moving
 * average to filter browser jitter (especially Chrome). Persists the smoothed
 * value to storage for cross-session consistency.
 *
 * outputLatency is device-derived, so it follows the actual output path
 * (built-in speakers, USB DAC, Bluetooth) as it changes at runtime.
 */
/**
 * Stand-in for AudioContext.outputLatency on browsers that do not implement it
 * (Safari and iOS Safari before 18.4), which report baseLatency only.
 *
 * Estimated from the 40-50ms gap observed between Safari and browsers that do
 * report the property on comparable hardware; it is a stand-in, not a
 * measurement of the current device. Used only when the property is absent or
 * unusable, so a reported 0 is taken at face value. Exported for tests.
 */
const UNREPORTED_OUTPUT_LATENCY_SEC = 0.04;
const OUTPUT_LATENCY_ALPHA = 0.01;
const OUTPUT_LATENCY_STORAGE_KEY = "sendspin-output-latency-us";
const OUTPUT_LATENCY_PERSIST_INTERVAL_MS = 10000;
/**
 * Resolve a latency the AudioContext reports, in seconds.
 *
 * Falls back when the property is missing or holds a value that cannot be a
 * latency, so a single bad reading cannot reach the smoother, where it would
 * stick for the lifetime of the stream.
 */
function resolveLatencySec(reportedSec, fallbackSec) {
    const usable = typeof reportedSec === "number" &&
        Number.isFinite(reportedSec) &&
        reportedSec >= 0;
    return usable ? reportedSec : fallbackSec;
}
class OutputLatencyTracker {
    constructor(storage) {
        this.storage = storage;
        this.smoothedOutputLatencyUs = null;
        this.lastLatencyPersistAtMs = null;
        this.loadPersisted();
    }
    loadPersisted() {
        if (!this.storage)
            return;
        try {
            const stored = this.storage.getItem(OUTPUT_LATENCY_STORAGE_KEY);
            if (stored) {
                const latency = parseFloat(stored);
                if (!isNaN(latency) && latency >= 0) {
                    this.smoothedOutputLatencyUs = latency;
                }
            }
        }
        catch {
            // ignore
        }
    }
    persist() {
        if (!this.storage || this.smoothedOutputLatencyUs === null)
            return;
        try {
            this.storage.setItem(OUTPUT_LATENCY_STORAGE_KEY, this.smoothedOutputLatencyUs.toString());
        }
        catch {
            // ignore
        }
    }
    /** Get raw output latency in microseconds from AudioContext. */
    getRawUs(audioContext) {
        if (!audioContext)
            return 0;
        const baseLatency = resolveLatencySec(audioContext.baseLatency, 0);
        const outputLatency = resolveLatencySec(audioContext.outputLatency, UNREPORTED_OUTPUT_LATENCY_SEC);
        return (baseLatency + outputLatency) * 1000000;
    }
    /** Get EMA-smoothed output latency in microseconds. */
    getSmoothedUs(audioContext) {
        const rawLatencyUs = this.getRawUs(audioContext);
        if (rawLatencyUs <= 0 && this.smoothedOutputLatencyUs !== null) {
            return this.smoothedOutputLatencyUs;
        }
        if (this.smoothedOutputLatencyUs === null) {
            this.smoothedOutputLatencyUs = rawLatencyUs;
        }
        else {
            this.smoothedOutputLatencyUs =
                OUTPUT_LATENCY_ALPHA * rawLatencyUs +
                    (1 - OUTPUT_LATENCY_ALPHA) * this.smoothedOutputLatencyUs;
        }
        const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (this.lastLatencyPersistAtMs === null ||
            nowMs - this.lastLatencyPersistAtMs >= OUTPUT_LATENCY_PERSIST_INTERVAL_MS) {
            this.persist();
            this.lastLatencyPersistAtMs = nowMs;
        }
        return this.smoothedOutputLatencyUs;
    }
    /** Reset smoother (on stream change or audio context recreation). */
    reset() {
        this.smoothedOutputLatencyUs = null;
    }
}

const APPLE_WEBKIT_UNREPORTED_OUTPUT_LATENCY_MS = 100;
// All iOS browsers use WebKit, while this output path is Safari-only on macOS.
function getUnreportedOutputLatencyMs(navigatorInfo = typeof navigator === "undefined"
    ? undefined
    : navigator) {
    if (!navigatorInfo)
        return 0;
    const { userAgent } = navigatorInfo;
    // Keep detection local because importing helpers from index.ts would create a cycle.
    const isIOS = /iPad|iPhone|iPod/i.test(userAgent) ||
        (navigatorInfo.platform === "MacIntel" &&
            (navigatorInfo.maxTouchPoints ?? 0) > 1);
    if (isIOS)
        return APPLE_WEBKIT_UNREPORTED_OUTPUT_LATENCY_MS;
    const isMacSafari = /Macintosh/i.test(userAgent) &&
        /AppleWebKit/i.test(userAgent) &&
        /Safari/i.test(userAgent) &&
        !/Chrome|Chromium|Edg|OPR|Firefox/i.test(userAgent);
    return isMacSafari ? APPLE_WEBKIT_UNREPORTED_OUTPUT_LATENCY_MS : 0;
}

/**
 * Audio scheduler for synchronized playback.
 *
 * Handles Web Audio API scheduling, sync correction, AudioContext management,
 * volume control, and output routing. Receives pre-decoded audio chunks
 * (DecodedAudioChunk) from SendspinCore and schedules them for playback.
 */
// Sync correction constants
const SAMPLE_CORRECTION_FADE_LEN = 8;
const SAMPLE_CORRECTION_TARGET_BLEND_SUM = 1.0;
const SAMPLE_CORRECTION_FADE_STRENGTH = Math.min(1, (2 * SAMPLE_CORRECTION_TARGET_BLEND_SUM) / SAMPLE_CORRECTION_FADE_LEN);
const SAMPLE_CORRECTION_FADE_ALPHAS = new Float32Array(SAMPLE_CORRECTION_FADE_LEN);
for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
    SAMPLE_CORRECTION_FADE_ALPHAS[f] =
        ((SAMPLE_CORRECTION_FADE_LEN - f) / (SAMPLE_CORRECTION_FADE_LEN + 1)) *
            SAMPLE_CORRECTION_FADE_STRENGTH;
}
// Playback-rate correction tiers, both within the ±0.5% spec cap (inaudible).
const RATE_CORRECTION_SOFT = 0.003;
const RATE_CORRECTION_FIRM = 0.005;
// EMA weight for the sync error. Lower smooths clock noise but slows drift response. Exported only for tests.
const SYNC_ERROR_ALPHA = 0.05;
const SCHEDULE_HORIZON_PRECISE_SEC = 20;
const SCHEDULE_HORIZON_GOOD_SEC = 8;
const SCHEDULE_HORIZON_POOR_SEC = 4;
const CAST_SCHEDULE_HORIZON_SEC = 1.5;
const SCHEDULE_HORIZON_PRECISE_ERROR_MS = 2;
const SCHEDULE_HORIZON_GOOD_ERROR_MS = 8;
const SCHEDULE_REFILL_THRESHOLD_FRACTION = 0.5;
const SCHEDULE_REFILL_MIN_THRESHOLD_SEC = 0.1;
const SCHEDULE_REFILL_MAX_THRESHOLD_SEC = 5;
const VOLUME_RAMP_TIME_CONSTANT_SEC = 0.015;
function perceptualGain(volume) {
    return Math.pow(volume / 100, 1.5);
}
const DEFAULT_CORRECTION_THRESHOLDS = {
    sync: {
        resyncAboveMs: 200,
        rate2AboveMs: 35,
        rate1AboveMs: 8,
        samplesBelowMs: 8,
        deadbandBelowMs: 1,
        enableRecorrectionMonitor: true,
        immediateDelayCutover: true,
    },
    quality: {
        resyncAboveMs: 35,
        rate2AboveMs: Infinity,
        rate1AboveMs: Infinity,
        samplesBelowMs: 35,
        deadbandBelowMs: 1,
        enableRecorrectionMonitor: false,
        immediateDelayCutover: false,
    },
    "quality-local": {
        resyncAboveMs: 600,
        rate2AboveMs: Infinity,
        rate1AboveMs: Infinity,
        samplesBelowMs: 0,
        deadbandBelowMs: 5,
        enableRecorrectionMonitor: false,
        immediateDelayCutover: false,
    },
};
class AudioScheduler {
    constructor(options) {
        this.audioContext = null;
        this.gainNode = null;
        this.streamDestination = null;
        this.audioBufferQueue = [];
        this.scheduledSources = [];
        this.nextPlaybackTime = 0;
        this.nextScheduleTime = 0;
        this.lastScheduledServerTime = 0;
        this.currentSyncErrorMs = 0;
        this.smoothedSyncErrorMs = 0;
        this.resyncCount = 0;
        this.currentPlaybackRate = 1.0;
        this.currentCorrectionMethod = "none";
        this.lastSamplesAdjusted = 0;
        this._correctionMode = "sync";
        this._lastStatusLogMs = 0;
        this._intervalResyncCount = 0;
        this.scheduleTimeout = null;
        this.refillTimeout = null;
        this.queueProcessScheduled = false;
        // Sub-modules
        this.clockSource = new ClockSource();
        this.stateManager = options.stateManager;
        this.timeFilter = options.timeFilter;
        this.outputMode = options.outputMode ?? "direct";
        this.audioElement = options.audioElement;
        this.isAndroid = options.isAndroid ?? false;
        this.isCastRuntime = options.isCastRuntime ?? false;
        this.ownsAudioElement = options.ownsAudioElement ?? false;
        this.silentAudioSrc = options.silentAudioSrc;
        this.syncDelayMs = clampSyncDelayMs(options.syncDelayMs ?? 0);
        this.useHardwareVolume = options.useHardwareVolume ?? false;
        this._correctionMode = options.correctionMode ?? "sync";
        this.useOutputLatencyCompensation =
            options.useOutputLatencyCompensation ?? true;
        this.unreportedOutputLatencySec = this.useOutputLatencyCompensation
            ? getUnreportedOutputLatencyMs() / 1000
            : 0;
        // Merge user-provided threshold overrides with defaults
        this.correctionThresholds = { ...DEFAULT_CORRECTION_THRESHOLDS };
        const thresholdOverrides = options.correctionThresholds;
        if (thresholdOverrides) {
            for (const mode of Object.keys(thresholdOverrides)) {
                const overrides = thresholdOverrides[mode];
                if (overrides) {
                    this.correctionThresholds[mode] = {
                        ...DEFAULT_CORRECTION_THRESHOLDS[mode],
                        ...overrides,
                    };
                }
            }
        }
        this.latencyTracker = new OutputLatencyTracker(options.storage ?? null);
        if (this.isCastRuntime) {
            this.clockSource.disableTimestampPromotion();
        }
        this.clockSource.onPromotion(() => {
            if (this.audioBufferQueue.length > 0 ||
                this.scheduledSources.length > 0) {
                this.scheduleQueueProcessing();
            }
        });
        this.recorrectionMonitor = new RecorrectionMonitor(() => this.checkRecorrection());
    }
    get correctionMode() {
        return this._correctionMode;
    }
    setCorrectionMode(mode) {
        this._correctionMode = mode;
        if (!this.correctionThresholds[mode].enableRecorrectionMonitor) {
            this.recorrectionMonitor.stop();
        }
        else {
            this.recorrectionMonitor.start();
        }
    }
    get usesRecorrectionMonitor() {
        return this.correctionThresholds[this._correctionMode]
            .enableRecorrectionMonitor;
    }
    get usesImmediateDelayCutover() {
        return this.correctionThresholds[this._correctionMode]
            .immediateDelayCutover;
    }
    /**
     * Smoothed baseLatency + outputLatency in seconds: how long audio handed to
     * the renderer takes to reach the output port. Read on every scheduling pass
     * (even with compensation disabled) because the clock source needs it to keep
     * both of its clocks in the render-clock domain.
     */
    measurePlayoutLatencySec() {
        return this.latencyTracker.getSmoothedUs(this.audioContext) / 1000000;
    }
    getTargetScheduledHorizonSec() {
        if (this.isCastRuntime) {
            return CAST_SCHEDULE_HORIZON_SEC;
        }
        const errorMs = this.timeFilter.error / 1000;
        if (errorMs < SCHEDULE_HORIZON_PRECISE_ERROR_MS)
            return SCHEDULE_HORIZON_PRECISE_SEC;
        if (errorMs <= SCHEDULE_HORIZON_GOOD_ERROR_MS)
            return SCHEDULE_HORIZON_GOOD_SEC;
        return SCHEDULE_HORIZON_POOR_SEC;
    }
    getScheduledAheadSec(currentTimeSec) {
        let farthest = this.nextScheduleTime;
        for (const entry of this.scheduledSources) {
            if (entry.endTime > farthest)
                farthest = entry.endTime;
        }
        return farthest <= 0 ? 0 : Math.max(0, farthest - currentTimeSec);
    }
    resetScheduledPlaybackState(_reason) {
        this.nextPlaybackTime = 0;
        this.nextScheduleTime = 0;
        this.lastScheduledServerTime = 0;
        this.recorrectionMonitor.clearMinScheduleTime();
        this.recorrectionMonitor.clearHardResyncCooldown();
        this.clockSource.pendingCutover = false;
        this.recorrectionMonitor.resetCheckState();
        this.resetSyncErrorEma();
        this.currentSyncErrorMs = 0;
        this.currentPlaybackRate = 1.0;
        this.currentCorrectionMethod = "none";
        this.lastSamplesAdjusted = 0;
        this._lastStatusLogMs = 0;
        this._intervalResyncCount = 0;
    }
    pruneExpiredScheduledSources(currentTimeSec) {
        if (this.scheduledSources.length === 0)
            return;
        this.scheduledSources = this.scheduledSources.filter((entry) => entry.endTime > currentTimeSec);
        if (this.scheduledSources.length === 0) {
            this.resetScheduledPlaybackState("no scheduled audio ahead");
        }
    }
    performGuardedCutover(_reason, options = {}) {
        if (!this.audioContext)
            return;
        const incrementResyncCount = options.incrementResyncCount ?? false;
        const markCooldown = options.markCooldown ?? true;
        const nowMs = performance.now();
        const cutoffTime = this.audioContext.currentTime + RECORRECTION_CUTOVER_GUARD_SEC;
        if (incrementResyncCount) {
            this.resyncCount++;
            this._intervalResyncCount++;
        }
        this.resetSyncErrorEma();
        this.currentCorrectionMethod = "resync";
        this.lastSamplesAdjusted = 0;
        this.currentPlaybackRate = 1.0;
        const cutResult = this.cutScheduledSources(cutoffTime);
        this.recorrectionMonitor.setMinScheduleTime(Math.max(cutoffTime, cutResult.keptTailEndTimeSec));
        this.nextPlaybackTime = 0;
        this.nextScheduleTime = 0;
        this.lastScheduledServerTime = 0;
        this.recorrectionMonitor.resetCheckState();
        if (markCooldown)
            this.recorrectionMonitor.markRecorrection(nowMs);
        this.recorrectionMonitor.noteHardResync(nowMs);
        this.processAudioQueue();
    }
    checkRecorrection() {
        if (!this.usesRecorrectionMonitor) {
            this.recorrectionMonitor.resetCheckState();
            return;
        }
        if (!this.audioContext || this.audioContext.state !== "running") {
            this.recorrectionMonitor.resetCheckState();
            return;
        }
        if (!this.stateManager.isPlaying ||
            this.nextPlaybackTime === 0 ||
            this.lastScheduledServerTime === 0) {
            this.recorrectionMonitor.resetCheckState();
            return;
        }
        const playoutLatencySec = this.measurePlayoutLatencySec();
        const { audioContextTimeSec, audioContextRawTimeSec, nowMs, nowUs } = this.clockSource.getTimingSnapshot(this.audioContext, playoutLatencySec);
        this.pruneExpiredScheduledSources(audioContextRawTimeSec);
        if (this.getScheduledAheadSec(audioContextRawTimeSec) <= 0) {
            this.recorrectionMonitor.resetCheckState();
            if (this.audioBufferQueue.length > 0)
                this.processAudioQueue();
            return;
        }
        const outputLatencySec = this.useOutputLatencyCompensation
            ? playoutLatencySec
            : 0;
        const targetPlaybackTime = this.computeTargetPlaybackTime(this.lastScheduledServerTime, audioContextTimeSec, nowUs, outputLatencySec);
        const syncErrorMs = (this.nextPlaybackTime - targetPlaybackTime) * 1000;
        const smoothedSyncErrorMs = this.applySyncErrorEma(syncErrorMs);
        if (this.recorrectionMonitor.shouldRecorrect(Math.abs(smoothedSyncErrorMs), syncErrorMs, nowMs)) {
            this.performGuardedCutover("recorrection", {
                incrementResyncCount: true,
                markCooldown: true,
            });
        }
    }
    getSyncDelayMs() {
        return this.syncDelayMs;
    }
    setSyncDelay(delayMs) {
        const sanitized = clampSyncDelayMs(delayMs);
        const delta = sanitized - this.syncDelayMs;
        this.syncDelayMs = sanitized;
        if (delta === 0 || !this.usesImmediateDelayCutover)
            return;
        if (!this.audioContext || this.audioContext.state !== "running")
            return;
        if (!this.stateManager.isPlaying)
            return;
        if (this.scheduledSources.length === 0 &&
            this.audioBufferQueue.length === 0 &&
            this.nextPlaybackTime === 0)
            return;
        this.performGuardedCutover("delay-change", {
            incrementResyncCount: false,
            markCooldown: true,
        });
    }
    get syncInfo() {
        return {
            clockDriftPercent: this.timeFilter.drift * 100,
            syncErrorMs: this.currentSyncErrorMs,
            resyncCount: this.resyncCount,
            outputLatencyMs: this.latencyTracker.getRawUs(this.audioContext) / 1000 +
                this.unreportedOutputLatencySec * 1000,
            playbackRate: this.currentPlaybackRate,
            correctionMethod: this.currentCorrectionMethod,
            samplesAdjusted: this.lastSamplesAdjusted,
            correctionMode: this._correctionMode,
        };
    }
    emitStatusLog(nowMs) {
        if (this._lastStatusLogMs !== 0 && nowMs - this._lastStatusLogMs < 10000)
            return;
        this._lastStatusLogMs = nowMs;
        let corr;
        switch (this.currentCorrectionMethod) {
            case "rate":
                corr = `rate@${this.currentPlaybackRate}`;
                break;
            case "samples":
                corr = `samples:${this.lastSamplesAdjusted}`;
                break;
            default:
                corr = this.currentCorrectionMethod;
        }
        const queueDepth = this.audioBufferQueue.length + this.scheduledSources.length;
        const aheadSec = this.audioContext
            ? this.getScheduledAheadSec(this.audioContext.currentTime)
            : 0;
        let clock;
        if (this.clockSource.timestampPromotionDisabled) {
            clock = "estimated(cast-disabled)";
        }
        else if (this.clockSource.active === "timestamp") {
            clock = `timestamp(good:${this.clockSource.timestampGoodSamples})`;
        }
        else if (this.clockSource.lastRejectReason) {
            clock = `estimated(reject:"${this.clockSource.lastRejectReason}")`;
        }
        else {
            clock = "estimated";
        }
        const tf = this.timeFilter.is_synchronized
            ? `synced(err=${(this.timeFilter.error / 1000).toFixed(1)}ms,drift=${this.timeFilter.drift.toFixed(3)},n=${this.timeFilter.count})`
            : `pending(n=${this.timeFilter.count})`;
        const smoothedLatUs = this.latencyTracker.getSmoothedUs(this.audioContext);
        const latMs = Math.round(smoothedLatUs / 1000 + this.unreportedOutputLatencySec * 1000);
        console.log(`Sendspin: sync=${this.smoothedSyncErrorMs >= 0 ? "+" : ""}${this.smoothedSyncErrorMs.toFixed(1)}ms` +
            ` corr=${corr} q=${queueDepth}/${aheadSec.toFixed(1)}s resyncs=${this._intervalResyncCount}` +
            ` clock=${clock} tf=${tf} lat=${latMs}ms mode=${this._correctionMode}` +
            ` ctx=${this.audioContext?.state ?? "null"} gen=${this.stateManager.streamGeneration}`);
        this._intervalResyncCount = 0;
    }
    applySyncErrorEma(inputMs) {
        this.currentSyncErrorMs = inputMs;
        this.smoothedSyncErrorMs =
            SYNC_ERROR_ALPHA * inputMs +
                (1 - SYNC_ERROR_ALPHA) * this.smoothedSyncErrorMs;
        return this.smoothedSyncErrorMs;
    }
    resetSyncErrorEma() {
        this.smoothedSyncErrorMs = 0;
    }
    copyBuffer(buffer) {
        if (!this.audioContext)
            return buffer;
        const newBuffer = this.audioContext.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            newBuffer.getChannelData(ch).set(buffer.getChannelData(ch));
        }
        return newBuffer;
    }
    adjustBufferSamples(buffer, samplesToAdjust) {
        if (!this.audioContext || samplesToAdjust === 0 || buffer.length < 2)
            return this.copyBuffer(buffer);
        const channels = buffer.numberOfChannels;
        const len = buffer.length;
        const sampleRate = buffer.sampleRate;
        try {
            if (samplesToAdjust > 0) {
                const newBuffer = this.audioContext.createBuffer(channels, len + 1, sampleRate);
                for (let ch = 0; ch < channels; ch++) {
                    const oldData = buffer.getChannelData(ch);
                    const newData = newBuffer.getChannelData(ch);
                    newData[0] = oldData[0];
                    const insertedSample = (oldData[0] + oldData[1]) / 2;
                    newData[1] = insertedSample;
                    newData.set(oldData.subarray(1), 2);
                    for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
                        const pos = 2 + f;
                        if (pos >= newData.length)
                            break;
                        const alpha = SAMPLE_CORRECTION_FADE_ALPHAS[f];
                        newData[pos] = newData[pos] * (1 - alpha) + insertedSample * alpha;
                    }
                }
                return newBuffer;
            }
            else {
                const newBuffer = this.audioContext.createBuffer(channels, len - 1, sampleRate);
                for (let ch = 0; ch < channels; ch++) {
                    const oldData = buffer.getChannelData(ch);
                    const newData = newBuffer.getChannelData(ch);
                    newData.set(oldData.subarray(0, len - 2));
                    const replacementSample = (oldData[len - 2] + oldData[len - 1]) / 2;
                    newData[len - 2] = replacementSample;
                    for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
                        const pos = len - 3 - f;
                        if (pos < 0)
                            break;
                        const alpha = SAMPLE_CORRECTION_FADE_ALPHAS[f];
                        newData[pos] =
                            newData[pos] * (1 - alpha) + replacementSample * alpha;
                    }
                }
                return newBuffer;
            }
        }
        catch (e) {
            console.error("Sendspin: adjustBufferSamples error:", e);
            return buffer;
        }
    }
    initAudioContext() {
        if (this.audioContext)
            return;
        if (this.outputMode === "media-element" && this.ownsAudioElement) {
            this.audioElement = document.createElement("audio");
            this.audioElement.style.display = "none";
            document.body.appendChild(this.audioElement);
        }
        if (navigator.audioSession) {
            navigator.audioSession.type = "playback";
        }
        const streamSampleRate = this.stateManager.currentStreamFormat?.sample_rate || 48000;
        this.audioContext = new AudioContext({ sampleRate: streamSampleRate });
        this.gainNode = this.audioContext.createGain();
        const audioElement = this.audioElement;
        if (this.outputMode === "direct") {
            this.gainNode.connect(this.audioContext.destination);
        }
        else {
            if (!audioElement)
                throw new Error("Media-element output requires an audio element.");
            if (this.isAndroid && this.silentAudioSrc) {
                this.gainNode.connect(this.audioContext.destination);
                audioElement.src = this.silentAudioSrc;
                audioElement.loop = true;
                audioElement.muted = false;
                audioElement.volume = 1.0;
                audioElement.play().catch((e) => {
                    console.warn("Sendspin: Audio autoplay blocked:", e);
                });
            }
            else {
                this.streamDestination =
                    this.audioContext.createMediaStreamDestination();
                this.gainNode.connect(this.streamDestination);
                audioElement.srcObject = this.streamDestination.stream;
                audioElement.volume = 1.0;
                audioElement.play().catch((e) => {
                    console.warn("Sendspin: Audio autoplay blocked:", e);
                });
            }
        }
        this.updateVolume();
        if (this.usesRecorrectionMonitor)
            this.recorrectionMonitor.start();
    }
    async resumeAudioContext() {
        if (this.audioContext && this.audioContext.state === "suspended") {
            await this.audioContext.resume();
            console.log("Sendspin: AudioContext resumed");
            if (this.audioBufferQueue.length > 0)
                this.scheduleQueueProcessing();
            if (this.usesRecorrectionMonitor)
                this.recorrectionMonitor.start();
        }
    }
    cutScheduledSources(cutoffTime) {
        if (!this.audioContext)
            return { requeuedCount: 0, cutCount: 0, keptTailEndTimeSec: 0 };
        const stopTime = Math.max(cutoffTime, this.audioContext.currentTime);
        let requeued = 0, cutCount = 0, keptTailEndTimeSec = 0;
        this.scheduledSources = this.scheduledSources.filter((entry) => {
            if (entry.startTime < stopTime) {
                keptTailEndTimeSec = Math.max(keptTailEndTimeSec, entry.endTime);
                return true;
            }
            try {
                entry.source.onended = null;
                entry.source.stop(stopTime);
            }
            catch {
                /* ignore */
            }
            this.audioBufferQueue.push({
                buffer: entry.buffer,
                serverTime: entry.serverTime,
                generation: entry.generation,
            });
            requeued++;
            cutCount++;
            return false;
        });
        // Requeued sources predate the chunks still queued, and a cut from the drain
        // loop lands after that loop's own sort.
        if (requeued > 0) {
            this.audioBufferQueue.sort((a, b) => a.serverTime - b.serverTime);
        }
        return { requeuedCount: requeued, cutCount, keptTailEndTimeSec };
    }
    updateVolume() {
        if (!this.gainNode)
            return;
        if (this.useHardwareVolume) {
            this.gainNode.gain.value = 1.0;
            return;
        }
        const target = this.stateManager.muted
            ? 0
            : perceptualGain(this.stateManager.volume);
        if (this.audioContext) {
            this.gainNode.gain.setTargetAtTime(target, this.audioContext.currentTime, VOLUME_RAMP_TIME_CONSTANT_SEC);
        }
        else {
            this.gainNode.gain.value = target;
        }
    }
    measureBufferedPlaybackRunwaySec() {
        if (!this.audioContext)
            return 0;
        const currentTimeSec = this.audioContext.currentTime;
        this.pruneExpiredScheduledSources(currentTimeSec);
        const scheduledAheadSec = this.getScheduledAheadSec(currentTimeSec);
        const queuedAheadSec = this.audioBufferQueue.reduce((totalSec, chunk) => totalSec + chunk.buffer.duration, 0);
        return Math.max(0, scheduledAheadSec + queuedAheadSec);
    }
    cancelScheduledRefill() {
        if (this.refillTimeout !== null) {
            clearTimeout(this.refillTimeout);
            this.refillTimeout = null;
        }
    }
    getScheduledRefillThresholdSec(targetScheduledHorizonSec) {
        return Math.max(SCHEDULE_REFILL_MIN_THRESHOLD_SEC, Math.min(SCHEDULE_REFILL_MAX_THRESHOLD_SEC, targetScheduledHorizonSec * SCHEDULE_REFILL_THRESHOLD_FRACTION));
    }
    scheduleQueueRefill(targetScheduledHorizonSec) {
        this.cancelScheduledRefill();
        if (!this.audioContext ||
            this.audioContext.state !== "running" ||
            !this.stateManager.isPlaying ||
            this.audioBufferQueue.length === 0)
            return;
        const currentTimeSec = this.audioContext.currentTime;
        this.pruneExpiredScheduledSources(currentTimeSec);
        const scheduledAheadSec = this.getScheduledAheadSec(currentTimeSec);
        const refillThresholdSec = this.getScheduledRefillThresholdSec(targetScheduledHorizonSec);
        if (scheduledAheadSec <= refillThresholdSec) {
            this.scheduleQueueProcessing();
            return;
        }
        const delayMs = (scheduledAheadSec - refillThresholdSec) * 1000;
        const runRefill = () => {
            this.refillTimeout = null;
            if (!this.audioContext ||
                this.audioContext.state !== "running" ||
                !this.stateManager.isPlaying ||
                this.audioBufferQueue.length === 0)
                return;
            this.scheduleQueueProcessing();
        };
        if (typeof globalThis.setTimeout === "function") {
            this.refillTimeout = globalThis.setTimeout(runRefill, delayMs);
            return;
        }
        this.refillTimeout = null;
        if (typeof globalThis
            .queueMicrotask === "function") {
            globalThis.queueMicrotask(runRefill);
            return;
        }
        void Promise.resolve().then(runRefill);
    }
    scheduleQueueProcessing() {
        this.cancelScheduledRefill();
        if (this.queueProcessScheduled)
            return;
        this.queueProcessScheduled = true;
        if (typeof globalThis.setTimeout === "function") {
            this.scheduleTimeout = globalThis.setTimeout(() => {
                this.scheduleTimeout = null;
                this.queueProcessScheduled = false;
                this.processAudioQueue();
            }, 15);
            return;
        }
        const run = () => {
            this.queueProcessScheduled = false;
            this.processAudioQueue();
        };
        if (typeof globalThis
            .queueMicrotask === "function") {
            globalThis.queueMicrotask(run);
        }
        else {
            Promise.resolve().then(run);
        }
    }
    handleDecodedChunk(chunk) {
        if (!this.audioContext || !this.gainNode) {
            console.warn("Sendspin: Received audio chunk but no audio context");
            return;
        }
        if (chunk.generation !== this.stateManager.streamGeneration)
            return;
        const numChannels = chunk.samples.length;
        const numFrames = chunk.samples[0].length;
        const audioBuffer = this.audioContext.createBuffer(numChannels, numFrames, chunk.sampleRate);
        for (let ch = 0; ch < numChannels; ch++)
            audioBuffer.getChannelData(ch).set(chunk.samples[ch]);
        this.audioBufferQueue.push({
            buffer: audioBuffer,
            serverTime: chunk.serverTimeUs,
            generation: chunk.generation,
        });
        this.scheduleQueueProcessing();
    }
    processAudioQueue() {
        this.cancelScheduledRefill();
        if (!this.audioContext || !this.gainNode)
            return;
        if (this.audioContext.state !== "running")
            return;
        const currentGeneration = this.stateManager.streamGeneration;
        this.audioBufferQueue = this.audioBufferQueue.filter((chunk) => chunk.generation === currentGeneration);
        this.audioBufferQueue.sort((a, b) => a.serverTime - b.serverTime);
        if (!this.timeFilter.is_synchronized)
            return;
        const playoutLatencySec = this.measurePlayoutLatencySec();
        const { audioContextTimeSec: audioContextTime, audioContextRawTimeSec, nowMs, nowUs, } = this.clockSource.getTimingSnapshot(this.audioContext, playoutLatencySec);
        this.pruneExpiredScheduledSources(audioContextRawTimeSec);
        const outputLatencySec = this.useOutputLatencyCompensation
            ? playoutLatencySec
            : 0;
        const scheduleAdvanceSec = this.syncDelayMs / 1000 + this.unreportedOutputLatencySec;
        const targetScheduledHorizonSec = this.getTargetScheduledHorizonSec();
        if (this.usesRecorrectionMonitor)
            this.recorrectionMonitor.start();
        if (this.clockSource.pendingCutover) {
            this.clockSource.pendingCutover = false;
            if (this.scheduledSources.length > 0 ||
                this.nextPlaybackTime !== 0 ||
                this.lastScheduledServerTime !== 0) {
                this.performGuardedCutover("delay-change", {
                    incrementResyncCount: false,
                    markCooldown: false,
                });
                return;
            }
        }
        while (this.audioBufferQueue.length > 0) {
            const scheduledAheadSec = this.getScheduledAheadSec(audioContextRawTimeSec);
            if (this.nextPlaybackTime > 0 &&
                scheduledAheadSec >= targetScheduledHorizonSec)
                break;
            const chunk = this.audioBufferQueue.shift();
            let playbackTime;
            let scheduleTime;
            let playbackRate;
            const targetPlaybackTime = this.computeTargetPlaybackTime(chunk.serverTime, audioContextTime, nowUs, outputLatencySec);
            const isTimestamp = this.clockSource.active === "timestamp";
            if (this.nextPlaybackTime === 0 || this.lastScheduledServerTime === 0) {
                this.recorrectionMonitor.armStartupGrace(nowMs, isTimestamp);
                playbackTime = targetPlaybackTime;
                scheduleTime = playbackTime - scheduleAdvanceSec;
                const minScheduleTimeSec = this.recorrectionMonitor.minScheduleTimeSec;
                if (minScheduleTimeSec !== null) {
                    // After a cutover, drop backlog that ends at or before the kept tail
                    // rather than clamping it forward, so the snap claws back lateness.
                    if (scheduleTime + chunk.buffer.duration <= minScheduleTimeSec) {
                        continue;
                    }
                    scheduleTime = Math.max(scheduleTime, minScheduleTimeSec);
                    playbackTime = scheduleTime + scheduleAdvanceSec;
                }
                this.recorrectionMonitor.clearMinScheduleTime();
                playbackRate = 1.0;
            }
            else {
                const serverGapUs = chunk.serverTime - this.lastScheduledServerTime;
                const serverGapSec = serverGapUs / 1000000;
                if (Math.abs(serverGapSec) < 0.1) {
                    const syncErrorSec = this.nextPlaybackTime - targetPlaybackTime;
                    const syncErrorMs = syncErrorSec * 1000;
                    const correctionErrorMs = this.applySyncErrorEma(syncErrorMs);
                    const thresholds = this.correctionThresholds[this._correctionMode];
                    const canHardResync = this.recorrectionMonitor.canUseHardResync(nowMs, isTimestamp);
                    if (Math.abs(correctionErrorMs) > thresholds.resyncAboveMs &&
                        canHardResync) {
                        this.recorrectionMonitor.noteHardResync(nowMs);
                        this.resyncCount++;
                        this._intervalResyncCount++;
                        this.resetSyncErrorEma();
                        this.cutScheduledSources(targetPlaybackTime - scheduleAdvanceSec);
                        playbackTime = targetPlaybackTime;
                        scheduleTime = playbackTime - scheduleAdvanceSec;
                        playbackRate = 1.0;
                        this.currentCorrectionMethod = "resync";
                        this.lastSamplesAdjusted = 0;
                    }
                    else if (Math.abs(correctionErrorMs) > thresholds.resyncAboveMs) {
                        playbackTime = this.nextPlaybackTime;
                        scheduleTime = this.nextScheduleTime;
                        playbackRate = Number.isFinite(thresholds.rate2AboveMs)
                            ? correctionErrorMs > 0
                                ? 1 + RATE_CORRECTION_FIRM
                                : 1 - RATE_CORRECTION_FIRM
                            : 1.0;
                        this.currentCorrectionMethod =
                            playbackRate === 1.0 ? "none" : "rate";
                        this.lastSamplesAdjusted = 0;
                    }
                    else if (Math.abs(correctionErrorMs) < thresholds.deadbandBelowMs) {
                        playbackTime = this.nextPlaybackTime;
                        scheduleTime = this.nextScheduleTime;
                        playbackRate = 1.0;
                        this.currentCorrectionMethod = "none";
                        this.lastSamplesAdjusted = 0;
                    }
                    else if (Math.abs(correctionErrorMs) <= thresholds.samplesBelowMs) {
                        playbackTime = this.nextPlaybackTime;
                        scheduleTime = this.nextScheduleTime;
                        playbackRate = 1.0;
                        const samplesToAdjust = correctionErrorMs > 0 ? -1 : 1;
                        chunk.buffer = this.adjustBufferSamples(chunk.buffer, samplesToAdjust);
                        this.currentCorrectionMethod = "samples";
                        this.lastSamplesAdjusted = samplesToAdjust;
                    }
                    else {
                        playbackTime = this.nextPlaybackTime;
                        scheduleTime = this.nextScheduleTime;
                        const absErrorMs = Math.abs(correctionErrorMs);
                        if (correctionErrorMs > 0) {
                            playbackRate =
                                absErrorMs >= thresholds.rate2AboveMs
                                    ? 1 + RATE_CORRECTION_FIRM
                                    : absErrorMs >= thresholds.rate1AboveMs
                                        ? 1 + RATE_CORRECTION_SOFT
                                        : 1.0;
                        }
                        else {
                            playbackRate =
                                absErrorMs >= thresholds.rate2AboveMs
                                    ? 1 - RATE_CORRECTION_FIRM
                                    : absErrorMs >= thresholds.rate1AboveMs
                                        ? 1 - RATE_CORRECTION_SOFT
                                        : 1.0;
                        }
                        this.currentCorrectionMethod =
                            playbackRate === 1.0 ? "none" : "rate";
                        this.lastSamplesAdjusted = 0;
                    }
                }
                else {
                    // Gap detected in server timestamps - hard resync (gated on cooldown)
                    if (this.recorrectionMonitor.canUseHardResync(nowMs, isTimestamp)) {
                        this.recorrectionMonitor.noteHardResync(nowMs);
                        this.resyncCount++;
                        this._intervalResyncCount++;
                        this.cutScheduledSources(targetPlaybackTime - scheduleAdvanceSec);
                    }
                    playbackTime = targetPlaybackTime;
                    scheduleTime = playbackTime - scheduleAdvanceSec;
                    playbackRate = 1.0;
                    this.currentCorrectionMethod = "resync";
                    this.lastSamplesAdjusted = 0;
                }
            }
            this.currentPlaybackRate = playbackRate;
            if (playbackTime < audioContextRawTimeSec) {
                this.nextPlaybackTime = 0;
                this.nextScheduleTime = 0;
                this.lastScheduledServerTime = 0;
                continue;
            }
            const effectiveScheduleTime = Math.max(scheduleTime, audioContextRawTimeSec);
            const effectivePlaybackTime = effectiveScheduleTime + (playbackTime - scheduleTime);
            const source = this.audioContext.createBufferSource();
            source.buffer = chunk.buffer;
            source.playbackRate.value = playbackRate;
            source.connect(this.gainNode);
            source.start(effectiveScheduleTime);
            const actualDuration = chunk.buffer.duration / playbackRate;
            this.nextPlaybackTime = effectivePlaybackTime + actualDuration;
            this.nextScheduleTime = effectiveScheduleTime + actualDuration;
            this.lastScheduledServerTime =
                chunk.serverTime + chunk.buffer.duration * 1000000;
            const scheduledEntry = {
                source,
                startTime: effectiveScheduleTime,
                endTime: effectiveScheduleTime + actualDuration,
                buffer: chunk.buffer,
                serverTime: chunk.serverTime,
                generation: chunk.generation,
            };
            this.scheduledSources.push(scheduledEntry);
            source.onended = () => {
                const idx = this.scheduledSources.indexOf(scheduledEntry);
                if (idx > -1)
                    this.scheduledSources.splice(idx, 1);
                if (this.scheduledSources.length === 0) {
                    this.resetScheduledPlaybackState("all scheduled audio ended");
                    if (this.audioBufferQueue.length > 0)
                        this.processAudioQueue();
                }
            };
        }
        this.scheduleQueueRefill(targetScheduledHorizonSec);
        this.emitStatusLog(nowMs);
    }
    /**
     * AudioContext time at which a chunk must be started so its first sample
     * leaves the audio output port at the instant the server stamped it for.
     *
     * `audioContextTime` is the render clock, the same domain `source.start()`
     * takes; audio handed to the renderer becomes audible one output latency
     * later, so that latency is subtracted. Chunks whose target has already passed
     * are dropped by the caller rather than shifted forward, which would render
     * them late.
     */
    computeTargetPlaybackTime(serverTimeUs, audioContextTime, nowUs, outputLatencySec) {
        const chunkClientTimeUs = this.timeFilter.computeClientTime(serverTimeUs);
        const deltaSec = (chunkClientTimeUs - nowUs) / 1000000;
        return audioContextTime + deltaSec - outputLatencySec;
    }
    startAudioElement() {
        if (this.outputMode === "media-element" && this.audioElement?.paused) {
            this.audioElement.play().catch((e) => {
                console.warn("Sendspin: Failed to start audio element:", e);
            });
        }
    }
    stopAudioElement() {
        if (this.outputMode === "media-element" &&
            this.audioElement &&
            !this.audioElement.paused) {
            this.audioElement.pause();
        }
    }
    clearBuffers() {
        this.recorrectionMonitor.fullReset();
        this.cancelScheduledRefill();
        this.scheduledSources.forEach((entry) => {
            try {
                entry.source.stop();
            }
            catch {
                /* ignore */
            }
        });
        this.scheduledSources = [];
        this.audioBufferQueue = [];
        if (this.scheduleTimeout !== null) {
            clearTimeout(this.scheduleTimeout);
            this.scheduleTimeout = null;
        }
        this.queueProcessScheduled = false;
        this.stateManager.resetStreamAnchors();
        this.resetScheduledPlaybackState();
        this.resyncCount = 0;
        this.latencyTracker.reset();
        this.clockSource.reset();
    }
    close() {
        this.clearBuffers();
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.gainNode = null;
        this.streamDestination = null;
        if (this.outputMode === "media-element" && this.audioElement) {
            this.audioElement.pause();
            this.audioElement.srcObject = null;
            this.audioElement.loop = false;
            this.audioElement.removeAttribute("src");
            this.audioElement.load();
            if (this.ownsAudioElement) {
                this.audioElement.remove();
                this.audioElement = undefined;
            }
        }
    }
    getAudioContext() {
        return this.audioContext;
    }
}

// Auto-generated by scripts/bundle-silent-audio.js
// Almost-silent audio for Android MediaSession workaround
const SILENT_AUDIO_SRC = "data:audio/flac;base64,ZkxhQwAAACICQAJAAAAMAADIAfQBcAAHkwCKnZ7FLvzY30lWx+3k6wJCBAAALAwAAABMYXZmNjEuNy4xMDABAAAAFAAAAGVuY29kZXI9TGF2ZjYxLjcuMTAwgQAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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kkkkkkmSSSSSTJJJJJMkkkkySSSTJJJJMkkkk/+/+//f/7//9////////////z///z//8///P//n//+SSSSSSSSSSSSQkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkmSSSSSSSSSSSSSSST////+BVP//gkDBPnQAAAAOc/VEAP/////9//////////////////z////////+f/////////////////////////////////3///////////////////////////gAhn//gkDBTyQP///+c/y0Af/////5//////////////////////////////////v/////////////////////////////////P////////////////////+T8L/+CQMFfVAAAAA5z9xQB////////////3//////////////////////////////////+f///////////////////////////////////////////////gm0f/4JAwW/EAAAADnP9JAH///////7///////////////////////////////////////////////n///////////////////////////////////////+BEl//gkDBf7AAAAABAL//gkDBjWAAAAADVc//gkDBnRAAAAAEw0//gkDBrYAAAAAMeM//gkDBvfAAAAAL7k//gkDBzKAAAAAFD5//gkDB3NAAAAACmR//gkDB7EAAAAAKIp//gkDB/DAAAAANtB//gkDCB+AAAAAMWl//gkDCF5AAAAALzN//gkDCJwAAAAADd1//gkDCN3AAAAAE4d//gkDCRiAAAAAKAA//gkDCVlAAAAANlo//gkDCZsAAAAAFLQ//gkDCdrAAAAACu4//gkDChGAAAAAA7v//gkDClBAAAAAHeH//gkDCpIAAAAAPw///gkDCtPAAAAAIVX//gkDCxaAAAAAGtK//gkDC1dAAAAABIi//gkDC5UAAAAAJma//gkDC9TAAAAAODy//gkDDAOAAAAANM0//gkDDEJAAAAAKpc//gkDDIAAAAAACHk//gkDDMHAAAAAFiM//gkDDQSAAAAALaR//gkDDUVAAAAAM/5//gkDDYcAAAAAERB//gkDDcbAAAAAD0p//gkDDg2AAAAABh+//gkDDkxAAAAAGEW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";

// Sendspin Protocol Types and Interfaces
var MessageType;
(function (MessageType) {
    MessageType["CLIENT_HELLO"] = "client/hello";
    MessageType["SERVER_HELLO"] = "server/hello";
    MessageType["CLIENT_TIME"] = "client/time";
    MessageType["SERVER_TIME"] = "server/time";
    MessageType["CLIENT_STATE"] = "client/state";
    MessageType["SERVER_STATE"] = "server/state";
    MessageType["CLIENT_COMMAND"] = "client/command";
    MessageType["CLIENT_GOODBYE"] = "client/goodbye";
    MessageType["SERVER_COMMAND"] = "server/command";
    MessageType["STREAM_START"] = "stream/start";
    MessageType["STREAM_CLEAR"] = "stream/clear";
    MessageType["STREAM_REQUEST_FORMAT"] = "stream/request-format";
    MessageType["STREAM_END"] = "stream/end";
    MessageType["GROUP_UPDATE"] = "group/update";
    MessageType["CLIENT_INIT"] = "client/init";
    MessageType["SERVER_INIT"] = "server/init";
    MessageType["NOISE_HANDSHAKE"] = "noise/handshake";
    MessageType["SERVER_ACTIVATE"] = "server/activate";
    MessageType["CLIENT_PAIR_PENDING"] = "client/pair-pending";
    MessageType["CLIENT_PAIR_INIT"] = "client/pair-init";
    MessageType["SERVER_PAIR_INIT"] = "server/pair-init";
    MessageType["SERVER_PAIR_AUTH"] = "server/pair-auth";
    MessageType["CLIENT_PAIR_AUTH"] = "client/pair-auth";
    MessageType["SERVER_PAIR_CONFIRM"] = "server/pair-confirm";
    MessageType["CLIENT_PAIR_CONFIRM"] = "client/pair-confirm";
    MessageType["CLIENT_PAIR_FINALIZE"] = "client/pair-finalize";
    MessageType["SERVER_PAIR_FINALIZE"] = "server/pair-finalize";
    MessageType["PAIR_ABORT"] = "pair/abort";
    MessageType["SERVER_UNPAIR"] = "server/unpair";
})(MessageType || (MessageType = {}));

/**
 * Read the persisted client identity, creating it if absent.
 *
 * Apps that key their own state on the client id need it before a player
 * exists. A SendspinPlayer built afterwards with the same storage adopts this
 * identity rather than minting another.
 */
function loadSendspinClientIdentity(storage) {
    let resolved = null;
    if (storage !== undefined) {
        resolved = storage;
    }
    else if (typeof localStorage !== "undefined") {
        resolved = localStorage;
    }
    const identity = Identity.loadOrCreate(resolved);
    const pairingPsk = resolved
        ? base64urlEncode(new PskStore(resolved).getOrCreatePairingPsk())
        : null;
    return {
        clientId: identity.clientId,
        pairingPsk,
        pairingToken: pairingPsk
            ? encodePairingToken(identity.clientId, pairingPsk)
            : null,
    };
}

// Platform detection utilities
function detectIsAndroid() {
    if (typeof navigator === "undefined")
        return false;
    return /Android/i.test(navigator.userAgent);
}
function detectIsIOS() {
    if (typeof navigator === "undefined")
        return false;
    return (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
}
function detectIsMobile() {
    return detectIsAndroid() || detectIsIOS();
}
function detectIsCastRuntime() {
    if (typeof navigator === "undefined")
        return false;
    return /CrKey/i.test(navigator.userAgent);
}
// Add a small cushion beyond the measured buffered runway so delayed timer
// delivery does not cut playback off just before the last scheduled audio ends.
const DISCONNECT_PLAYBACK_RESET_GRACE_MS = 250;
class SendspinPlayer {
    constructor(config) {
        this.ownsAudioElement = false;
        this.disconnectPlaybackResetTimeout = null;
        this.suppressDisconnectPlaybackReset = false;
        // Auto-detect platform
        const isAndroid = detectIsAndroid();
        const isCastRuntime = detectIsCastRuntime();
        const isMobile = detectIsMobile();
        // Determine output mode
        const outputMode = config.audioElement || isMobile ? "media-element" : "direct";
        this.ownsAudioElement =
            outputMode === "media-element" && !config.audioElement;
        if (this.ownsAudioElement && typeof document === "undefined") {
            throw new Error("SendspinPlayer requires a DOM document to use media-element output without a provided audioElement.");
        }
        let storage = null;
        if (config.storage !== undefined) {
            storage = config.storage;
        }
        else if (typeof localStorage !== "undefined") {
            storage = localStorage;
        }
        // Create core (protocol + decoding). It resolves the effective initial
        // delay, so read it back below for the scheduler's starting value.
        this.core = new SendspinCore({
            baseUrl: config.baseUrl,
            clientName: config.clientName,
            productName: config.productName,
            webSocket: config.webSocket,
            codecs: config.codecs,
            bufferCapacity: config.bufferCapacity,
            syncDelay: config.syncDelay,
            defaultSyncDelay: config.defaultSyncDelay,
            storage,
            requiredLeadTimeMs: config.requiredLeadTimeMs,
            minBufferMs: config.minBufferMs,
            useHardwareVolume: config.useHardwareVolume,
            onVolumeCommand: config.onVolumeCommand,
            onDelayCommand: config.onDelayCommand,
            getExternalVolume: config.getExternalVolume,
            reconnect: config.reconnect,
            onStateChange: config.onStateChange,
            onPairing: config.onPairing,
            onPairingPin: config.onPairingPin,
            pinOutChannels: config.pinOutChannels,
            minPinLength: config.minPinLength,
            staticPin: config.staticPin,
            staticPinLocations: config.staticPinLocations,
            pairingPskLocations: config.pairingPskLocations,
            suite: config.suite,
            unpairedAccess: config.unpairedAccess,
            longTermPsks: config.longTermPsks,
        });
        const syncDelay = this.core.getSyncDelayMs();
        // Create scheduler (Web Audio playback)
        this.scheduler = new AudioScheduler({
            stateManager: this.core._stateManager,
            timeFilter: this.core._timeFilter,
            outputMode,
            audioElement: config.audioElement,
            isAndroid,
            isCastRuntime,
            ownsAudioElement: this.ownsAudioElement,
            silentAudioSrc: isAndroid ? SILENT_AUDIO_SRC : undefined,
            syncDelayMs: syncDelay,
            useHardwareVolume: config.useHardwareVolume ?? false,
            correctionMode: config.correctionMode ?? "sync",
            storage,
            useOutputLatencyCompensation: config.useOutputLatencyCompensation ?? true,
            correctionThresholds: config.correctionThresholds,
        });
        // Wire core events to scheduler
        this.core.onAudioData = (chunk) => {
            this.scheduler.handleDecodedChunk(chunk);
        };
        // Visualizer + colour roles
        this.core.onVisualizerFrame = config.onVisualizerFrame ?? null;
        this.core.onVisualizerStream = config.onVisualizerStream ?? null;
        this.core.onVisualizerClear = config.onVisualizerClear ?? null;
        if (config.visualizer)
            this.core.setVisualizerRequest(config.visualizer);
        // Artwork role
        this.core.onArtwork = config.onArtwork ?? null;
        this.core.onArtworkCancel = config.onArtworkCancel ?? null;
        this.core.onArtworkStream = config.onArtworkStream ?? null;
        if (config.artwork)
            this.core.setArtworkRequest(config.artwork);
        this.core.onStreamStart = (format, isFormatUpdate) => {
            this.scheduler.initAudioContext();
            void this.scheduler.resumeAudioContext().catch((error) => {
                console.warn("Sendspin: Failed to resume AudioContext:", error);
            });
            if (!isFormatUpdate) {
                this.scheduler.clearBuffers();
            }
            this.scheduler.startAudioElement();
        };
        this.core.onStreamClear = () => {
            this.scheduler.clearBuffers();
        };
        this.core.onStreamEnd = () => {
            this.scheduler.clearBuffers();
            this.scheduler.stopAudioElement();
        };
        this.core.onVolumeUpdate = () => {
            this.scheduler.updateVolume();
        };
        this.core.onSyncDelayChange = (delayMs) => {
            this.scheduler.setSyncDelay(delayMs);
        };
        // Wire connection lifecycle for disconnect playback deferral
        this.core.onConnectionOpen = () => {
            this.cancelPendingDisconnectPlaybackReset();
        };
        this.core.onConnectionClose = () => {
            if (this.suppressDisconnectPlaybackReset) {
                return;
            }
            this.scheduleDisconnectPlaybackReset();
        };
    }
    cancelPendingDisconnectPlaybackReset() {
        if (this.disconnectPlaybackResetTimeout !== null) {
            clearTimeout(this.disconnectPlaybackResetTimeout);
            this.disconnectPlaybackResetTimeout = null;
        }
    }
    resetPlaybackStateAfterDisconnect() {
        this.disconnectPlaybackResetTimeout = null;
        if (this.core.isConnected) {
            return;
        }
        this.scheduler.clearBuffers();
        this.core.resetPlaybackState();
        this.scheduler.stopAudioElement();
        if (typeof navigator !== "undefined" && navigator.mediaSession) {
            navigator.mediaSession.playbackState = "paused";
        }
    }
    scheduleDisconnectPlaybackReset() {
        this.cancelPendingDisconnectPlaybackReset();
        const runwaySec = this.scheduler.measureBufferedPlaybackRunwaySec();
        if (runwaySec <= 0) {
            this.resetPlaybackStateAfterDisconnect();
            return;
        }
        this.disconnectPlaybackResetTimeout = setTimeout(() => {
            this.resetPlaybackStateAfterDisconnect();
        }, runwaySec * 1000 + DISCONNECT_PLAYBACK_RESET_GRACE_MS);
    }
    /**
     * Initialize and resume audio playback. Call this directly from a click or
     * tap handler, before any other await, to satisfy browser autoplay policies.
     */
    async unlock() {
        this.scheduler.initAudioContext();
        await this.scheduler.resumeAudioContext();
    }
    // Connect to Sendspin server
    async connect() {
        this.suppressDisconnectPlaybackReset = false;
        return this.core.connect();
    }
    /**
     * Disconnect from Sendspin server
     * @param reason - Optional reason for disconnecting (default: 'restart')
     */
    disconnect(reason = "restart") {
        this.cancelPendingDisconnectPlaybackReset();
        this.suppressDisconnectPlaybackReset = true;
        this.core.disconnect(reason);
        // Close scheduler
        this.scheduler.close();
        // Reset MediaSession playbackState (if available)
        if (typeof navigator !== "undefined" && navigator.mediaSession) {
            navigator.mediaSession.playbackState = "none";
            navigator.mediaSession.metadata = null;
        }
    }
    // Set volume (0-100)
    setVolume(volume) {
        this.core.setVolume(volume);
    }
    // Set muted state
    setMuted(muted) {
        this.core.setMuted(muted);
    }
    // Set static delay (in milliseconds, 0-5000)
    setSyncDelay(delayMs) {
        this.core.setSyncDelay(delayMs);
    }
    /**
     * Update the reported startup lead time at runtime (ms). Reported to the
     * server via client/state. Debounce calls to avoid reacting to transient
     * fluctuations. Throws RangeError if not a non-negative finite number.
     */
    setRequiredLeadTimeMs(leadTimeMs) {
        this.core.setRequiredLeadTimeMs(leadTimeMs);
    }
    /**
     * Update the reported minimum ongoing buffer duration at runtime (ms).
     * Reported to the server via client/state. Debounce calls to avoid reacting
     * to transient fluctuations. Throws RangeError if not a non-negative finite
     * number.
     */
    setMinBufferMs(minBufferMs) {
        this.core.setMinBufferMs(minBufferMs);
    }
    /**
     * Set the sync correction mode at runtime.
     */
    setCorrectionMode(mode) {
        this.scheduler.setCorrectionMode(mode);
    }
    // ========================================
    // Controller Commands (sent to server)
    // ========================================
    /**
     * Send a controller command to the server.
     */
    sendCommand(command, params) {
        this.core.sendCommand(command, params);
    }
    // Getters for reactive state
    get isPlaying() {
        return this.core.isPlaying;
    }
    get volume() {
        return this.core.volume;
    }
    get muted() {
        return this.core.muted;
    }
    get playerState() {
        return this.core.playerState;
    }
    get currentFormat() {
        return this.core.currentFormat;
    }
    get isConnected() {
        return this.core.isConnected;
    }
    /** The client's stable identity id (base64url X25519 public key). */
    get clientId() {
        return this.core.clientId;
    }
    /** The client's Pairing PSK (base64url) for the operator to enter server-side. Null without storage. */
    get pairingPsk() {
        return this.core.pairingPsk;
    }
    get pairingToken() {
        return this.core.pairingToken;
    }
    /** Rotate the Pairing PSK, returning the new value (null without storage). */
    rotatePairingPsk() {
        return this.core.rotatePairingPsk();
    }
    /**
     * Operator gesture that opens the pairing window (~5 minutes, admits one
     * attempt). Required before each gesture-gated attempt: every static PIN
     * attempt, and dynamic PIN when escalated or the PIN is shorter than 6.
     * The "pending" pairing event fires when an attempt is waiting on this.
     */
    openPairingWindow() {
        this.core.openPairingWindow();
    }
    /** Cancel an in-progress pairing attempt (sends pair/abort user_cancelled). */
    cancelPairing() {
        this.core.cancelPairing();
    }
    /** Whether dynamic PIN has escalated to gesture-gating (10 failures). */
    isDynamicPinEscalated() {
        return this.core.isDynamicPinEscalated();
    }
    // Get current correction mode
    get correctionMode() {
        return this.scheduler.correctionMode;
    }
    // Time sync info for debugging
    get timeSyncInfo() {
        return this.core.timeSyncInfo;
    }
    /** Get current server time in microseconds using synchronized clock */
    /** Change what visualizer data is requested; takes effect on the next client/state. */
    setVisualizerRequest(request) {
        this.core.setVisualizerRequest(request);
    }
    /** Change the artwork request; takes effect on the next client/state. */
    setArtworkRequest(request) {
        this.core.setArtworkRequest(request);
    }
    getCurrentServerTimeUs() {
        return this.core.getCurrentServerTimeUs();
    }
    /** Get current track progress with real-time position calculation */
    get trackProgress() {
        return this.core.trackProgress;
    }
    // Sync info for debugging/display
    get syncInfo() {
        return this.scheduler.syncInfo;
    }
}

export { AudioScheduler, MessageType, SendspinCore, SendspinDecoder, SendspinPlayer, SendspinTimeFilter, detectIsAndroid, detectIsCastRuntime, detectIsIOS, detectIsMobile, loadSendspinClientIdentity };
