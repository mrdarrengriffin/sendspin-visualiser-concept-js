# tools

Everything needed to rebuild `src/lib/sendspin/vendor/` and to test without Music Assistant.

## Rebuild the patched sendspin-js

The stock `@sendspin/sendspin-js` only speaks the player, controller and metadata roles.
`sendspin-js-visualizer-role.patch` adds `visualizer@v1` (binary frame types 16-20, the
`client/state` visualizer object, `stream/start|clear|end` handling), `color@v1`
(`server/state.color`) and `artwork@v1` (binary types 8-11, both the current chunked form and
aiosendspin 9.1.x's single-message form), plus `visualizer`, `onVisualizerFrame`,
`onVisualizerStream`, `onVisualizerClear`, `artwork`, `onArtwork`, `onArtworkCancel`,
`onArtworkStream` options and `setVisualizerRequest()` / `setArtworkRequest()` on `SendspinPlayer`.

    git clone https://github.com/Sendspin/sendspin-js.git
    cd sendspin-js && git checkout 7d10307 && git apply ../tools/sendspin-js-visualizer-role.patch
    npm install && npm run build
    cp ../tools/rollup.bundle.config.mjs . && npx rollup -c rollup.bundle.config.mjs

`rollup.bundle.config.mjs` writes an ESM bundle to `src/lib/sendspin/vendor/` (adjust the output dir).
Built this way from 7d10307 the bundle is byte-identical to the vendored one.

`patch_sendspin_js.py` is the older scripted form of the patch and covers only the visualizer and
colour roles (it also assumes CRLF sources); the `.patch` file is the current one.

## Local test server

`testserver.py` runs an aiosendspin server (the same library Music Assistant embeds) that
streams a synthetic 120 BPM groove with beats, a colour palette, metadata and artwork (a new
stand-in cover and title every 20 s, `--art-every N`, to exercise the track-change cross-fade).

    python -m venv venv && venv/Scripts/pip install "aiosendspin[server]"
    venv/Scripts/python tools/testserver.py 8928

Then point `player.html` at `http://127.0.0.1:8928`.
