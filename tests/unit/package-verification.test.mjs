import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const source = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
async function inspect(t, overrides) {
  const directory = await mkdtemp(join(tmpdir(), "slc-package-verification-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "slc-package-verification-")));
    await rm(directory, { recursive: true, force: true });
  });
  const packaged = join(directory, "package");
  for (const file of ["LICENSE", "README.md", "SECURITY.md", "CONTRIBUTING.md", "package-dist/index.js", "package-dist/worker.js", "package-dist/react.js", "package-dist/nostr.js", "package-dist/types/index.d.ts"]) {
    const path = join(packaged, file); await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, "synthetic package-verifier fixture, not a usable engine");
  }
  const marker = join(directory, "executed");
  await writeFile(join(packaged, "package.json"), JSON.stringify({ name: source.name, version: source.version, license: "MIT", scripts: { prepack: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }, ...overrides }));
  const archive = join(directory, "fixture.tgz");
  execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
  const result = spawnSync(process.execPath, [resolve(root, "scripts/verify-package.mjs"), archive], { encoding: "utf8" });
  assert.equal(await access(marker).then(() => true, () => false), false, "archive lifecycle commands must never execute during inspection");
  return { result, directory };
}
test("archive inspection reports digests without executing package scripts", async t => {
  const { result, directory } = await inspect(t, {}); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(join(directory, "package-verification.json"), "utf8"));
  assert.match(report.sha256, /^[a-f0-9]{64}$/); assert.match(report.integrity, /^sha512-/);
  assert.deepEqual(report.installLifecycleHooks, []);
});
test("archive inspection rejects an injected install hook without executing it", async t => {
  const { result } = await inspect(t, { scripts: { postinstall: "throw-if-executed" } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unexpected lifecycle hook: postinstall/);
});
test("archive inspection rejects an unreviewed runtime dependency", async t => {
  const { result } = await inspect(t, { dependencies: { "synthetic-unreviewed-package": "*" } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Runtime dependencies changed/);
});
