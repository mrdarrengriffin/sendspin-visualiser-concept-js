# tools

Everything needed to rebuild `src/lib/sendspin/vendor/` and to test without Music Assistant.

## Rebuild the patched sendspin-js

The stock `@sendspin/sendspin-js` only speaks the player, controller and metadata roles.
`sendspin-js-visualizer-role.patch` adds `visualizer@v1` (binary frame types 16-20, the
`client/state` visualizer object, `stream/start|clear|end` handling) and `color@v1`
(`server/state.color`), plus `visualizer`, `onVisualizerFrame`, `onVisualizerStream`,
`onVisualizerClear` options and `setVisualizerRequest()` on `SendspinPlayer`.

    git clone https://github.com/Sendspin/sendspin-js.git
    cd sendspin-js && git apply ../tools/sendspin-js-visualizer-role.patch   # or run patch_sendspin_js.py
    npm install && npm run build
    cp ../tools/rollup.bundle.config.mjs . && npx rollup -c rollup.bundle.config.mjs

`rollup.bundle.config.mjs` writes an ESM bundle to `src/lib/sendspin/vendor/` (adjust the output dir).

## Local test server

`testserver.py` runs an aiosendspin server (the same library Music Assistant embeds) that
streams a synthetic 120 BPM groove with beats, a colour palette and metadata.

    python -m venv venv && venv/Scripts/pip install "aiosendspin[server]"
    venv/Scripts/python tools/testserver.py 8928

Then point `player.html` at `http://127.0.0.1:8928`.
