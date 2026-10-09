import { build } from "esbuild";
import { readFile, mkdir, cp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(root, "package-dist");
await mkdir(out, { recursive: true });
const wasm = await readFile(resolve(root, ".package-build/wasm/core_engine.wasm"));
const nativeFactory = resolve(root, ".package-build/wasm/core_engine.mjs").replaceAll("\\", "/");
const plugin = {
  name: "self-contained-native-runtime",
  setup(b) {
    b.onLoad({ filter: /[\\/]wasm[\\/]core_engine\.mjs$/ }, async args => ({ loader: "js",
      contents: (await readFile(args.path, "utf8")).replace('return new URL("core_engine.wasm",import.meta.url).href',
        'throw new Error("Packaged WASM requires the embedded instantiateWasm adapter")') }));
    b.onLoad({ filter: /[\\/]wasm-loader\.ts$/ }, async args => {
      let contents = await readFile(args.path, "utf8");
      const start = contents.indexOf('    const url = new URL("./wasm/core_engine.mjs", import.meta.url);');
      const end = contents.indexOf("    if (runtime._core_abi_version()", start);
      if (start < 0 || end < 0) throw new Error("Native loader changed; update package adapter");
      contents = `import factory from ${JSON.stringify(nativeFactory)};\n` + contents.slice(0, start) + `
    const bytes = Uint8Array.from(atob(${JSON.stringify(wasm.toString("base64"))}), c => c.charCodeAt(0));
    const compiled = await WebAssembly.compile(bytes);
    const runtime = await factory({ instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(compiled, imports); receive(instance); return instance.exports;
    } });
` + contents.slice(end);
      return { contents, loader: "ts", resolveDir: resolve(root, "src") };
    });
  },
};
const common = { bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "none", plugins: [plugin] };
const worker = await build({ ...common, entryPoints: [resolve(root, "src/worker.ts")], write: false });
const workerSource = worker.outputFiles[0].text;
await writeFile(resolve(out, "worker.js"), workerSource);
const inlineWorker = {
  name: "portable-worker",
  setup(b) {
    b.onLoad({ filter: /[\\/]worker-factory\.ts$/ }, () => ({ loader: "ts", contents: `
      const source = ${JSON.stringify(workerSource)};
      export function createCoreWorker(options) {
        if (options.workerFactory) return options.workerFactory();
        if (options.workerUrl) return new Worker(options.workerUrl, { type: "module" });
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        try { return new Worker(url, { type: "module" }); } finally { URL.revokeObjectURL(url); }
      }` }));
  },
};
await build({ ...common, plugins: [plugin, inlineWorker], entryPoints: [resolve(root, "src/index.ts")], outfile: resolve(out, "index.js") });
await build({ ...common, plugins: [{ name: "shared-core", setup(b) {
  b.onResolve({ filter: /^\.\/((client)|(p2p-sync))\.js$/ }, () => ({ path: "./index.js", external: true }));
} }], external: ["react"], entryPoints: [resolve(root, "src/react.ts")], outfile: resolve(out, "react.js"), banner: { js: '"use client";' } });
await cp(resolve(root, "dist"), resolve(out, "types"), { recursive: true, filter: source => !/\.(js|mjs|wasm|map|json)$/.test(source) && !source.includes("/wasm/") });
await build({ bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "eof",
  entryPoints: [resolve(root, "src/nostr-discovery.ts")], outfile: resolve(out, "nostr.js") });
await cp(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(out, "THIRD_PARTY_NOTICES.md"));
console.log(`NPM bundles written to ${out}; worker includes ${wasm.byteLength} WASM bytes.`);
