import { build } from "esbuild";
await build({ entryPoints: ["src/nostr-discovery.ts"], outfile: "dist/nostr-discovery.bundle.js", bundle: true,
  format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "eof" });
