import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)), npm = process.env.npm_execpath;
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const archive = `sovereign-local-core-${version}.tgz`;
if (!npm) throw new Error("Run through npm run demo:prepare");
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir(resolve(root, "artifacts"), { recursive: true });
run(["pack", "--pack-destination", "artifacts"]);
for (const name of ["react-demo", "vanilla-todo"]) {
  const directory = resolve(root, "examples", name);
  run(["install", `../../artifacts/${archive}`], directory);
  run(["run", "build"], directory);
}
