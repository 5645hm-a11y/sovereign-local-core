import { execFileSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const files = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
if (!files.length) throw new Error("Stage release files with git add before checking, or run in a cloned repository");
const failures = [];
const forbidden = /(^|\/)(node_modules|dist|package-dist|artifacts|\.tools|\.package-build|\.next|test-results|playwright-report)(\/|$)|(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx|jwk|slc|slp|slv|log)$/i;
const tokens = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
for (const path of files) {
  if (forbidden.test(path) && !/\.env\..*example$/.test(path)) failures.push(`${path}: generated, local-data or credential file staged`);
  const contents = await readFile(resolve(root, path), "utf8");
  if (tokens.test(contents)) failures.push(`${path}: possible credential detected (value redacted)`);
  if (/@my-p2p|UNLICENSED|E:\\Développement|C:\\Users\\1/.test(contents) && path !== "scripts/check-release.mjs") failures.push(`${path}: old release placeholder or local path`);
  if (path.startsWith("examples/") && /\.(ts|tsx|jsx|mjs)$/.test(path) && /(?:password|projectId)\s*:\s*["'][^"']+["']/.test(contents)) failures.push(`${path}: public example hardcodes credentials or a project ID`);
  if (/\.md$/.test(path)) {
    const prose = contents.replace(/```[^\n]*\n[\s\S]*?```/g, "");
    for (const link of prose.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
      const target = link[1]; if (/^(https?:|mailto:|#)/.test(target)) continue;
      const local = resolve(dirname(resolve(root, path)), decodeURIComponent(target.split("#")[0]));
      try { await access(local); } catch { failures.push(`${path}: broken local link ${relative(root, local)}`); }
    }
  }
}
for (const name of ["README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "examples/README.md"]) {
  if (!files.includes(name)) failures.push(`${name}: missing from release`);
}
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (pkg.name !== "sovereign-local-core" || pkg.license !== "MIT" || pkg.publishConfig?.access !== "public") failures.push("package.json: unexpected release metadata");
if (!pkg.repository?.url || !pkg.homepage || !pkg.bugs?.url || !pkg.files.includes("LICENSE")) failures.push("package.json: missing repository, license or support metadata");
if (failures.length) { for (const failure of failures) console.error(failure); process.exit(1); }
console.log(`Release hygiene passed for ${files.length} tracked source files; no recognized credential patterns found. Run Gitleaks as well.`);
