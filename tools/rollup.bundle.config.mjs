import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
export default {
  input: "dist/index.js",
  output: { dir: "C:/Users/darre/Documents/Dev/sendspin/vendor/sendspin", format: "esm", entryFileNames: "sendspin.js", chunkFileNames: "chunk-[name]-[hash].js" },
  plugins: [resolve({ browser: true, preferBuiltins: false }), commonjs()],
};
