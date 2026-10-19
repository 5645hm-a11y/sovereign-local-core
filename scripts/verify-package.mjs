import { execFileSync } from "node:child_process";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, basename } from "node:path";

// Inspect the archive without installing it, extracting files or running its code.
const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const archive = resolve(process.argv[2] ?? `artifacts/sovereign-local-core-${source.version}.tgz`);
const bytes = await readFile(archive);
if (bytes.length > 8 * 1024 * 1024) throw new Error("Unexpected package size; review the distribution before publishing");
const tar = args => execFileSync("tar", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const files = tar(["-tzf", archive]).trim().split(/\r?\n/);
if (files.some(name => !name.startsWith("package/") || name.split("/").includes("..") || name.includes("\\"))) throw new Error("Archive contains unexpected paths");
const pkg = JSON.parse(tar(["-xOf", archive, "package/package.json"]));
if (pkg.name !== "sovereign-local-core" || pkg.version !== source.version || pkg.license !== "MIT") throw new Error("Distribution metadata differs from source");
for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) {
  if (pkg.scripts?.[hook]) throw new Error(`Unexpected lifecycle hook: ${hook}`);
}
if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) throw new Error("Runtime dependencies changed; review the supply chain before publishing");
if (files.some(name => /(^|\/)(binding\.gyp|\.env(?:\..*)?|node_modules)(\/|$)|\.(?:pem|key|jwk|slc|slv|slp)$/.test(name))) throw new Error("Unexpected native build, credential or local-data file");
for (const name of ["LICENSE", "README.md", "SECURITY.md", "CONTRIBUTING.md", "package-dist/index.js", "package-dist/worker.js", "package-dist/react.js", "package-dist/nostr.js", "package-dist/types/index.d.ts"]) {
  if (!files.includes(`package/${name}`)) throw new Error(`Missing distribution file: ${name}`);
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
const report = {
  name: pkg.name, version: pkg.version, archive: basename(archive), bytes: bytes.length, sha256,
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  files: files.length, installLifecycleHooks: [], runtimeDependencies: [],
  scope: "Static archive structure and metadata checks only. Not a security audit or proof of harmless runtime behavior.",
};
await writeFile(resolve(archive, "..", "package-verification.json"), JSON.stringify(report, null, 2) + "\n");
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${pkg.version}\nsha256=${sha256}\narchive=${basename(archive)}\n`);
console.log(JSON.stringify(report, null, 2));
