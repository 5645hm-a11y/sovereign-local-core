import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const archive = `sovereign-local-core-${version}.tgz`;
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this through npm run test:dx");
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir(resolve(root, "artifacts"), { recursive: true });
run([npm, "pack", "--pack-destination", "artifacts"]);
for (const name of ["react-demo", "vanilla-todo"]) {
  const directory = resolve(root, "examples", name);
  run([npm, "install", `../../artifacts/${archive}`], directory);
  run([npm, "run", "build"], directory);
}
const demo = resolve(root, "tests/fixtures/react-probe"), next = resolve(root, "tests/fixtures/next-app");
run([npm, "install", `../../../artifacts/${archive}`], demo);
run([npm, "install", `../../../artifacts/${archive}`], next);
// The optional adapter must also be safe to import during SSR before browser use.
run(["--input-type=module", "-e", 'await import("sovereign-local-core/nostr")'], demo);
run([resolve(root, "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--jsx", "react-jsx", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer-check.tsx"], demo);
run([resolve(root, "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "src/main.ts"], resolve(root, "examples/vanilla-todo"));
run([npm, "run", "build"], demo);
run([npm, "run", "build"], next);
run([resolve(root, "node_modules/@playwright/test/cli.js"), "test", "--config", "playwright.dx.config.mjs"]);
