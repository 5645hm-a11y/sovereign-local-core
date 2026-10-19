import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const raw = JSON.parse(await readFile("artifacts/browser-compatibility.json", "utf8"));
const pkg = JSON.parse(await readFile("examples/vanilla-todo/node_modules/sovereign-local-core/package.json", "utf8"));
const worker = await readFile("examples/vanilla-todo/node_modules/sovereign-local-core/package-dist/worker.js");
const observations = [];
function visit(suite) {
  for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
    const result = test.results.at(-1);
    const attachment = name => {
      const a = result.attachments?.find(a => a.name === name);
      return a?.body ? Buffer.from(a.body, "base64").toString("utf8") : null;
    };
    const runtime = attachment("runtime");
    const diagnostics = attachment("transport-diagnostics");
    observations.push({ engine: test.projectName, test: spec.title, status: result.status,
      ...(runtime ? { runtime: JSON.parse(runtime) } : {}),
      ...(diagnostics ? { transportDiagnostics: JSON.parse(diagnostics) } : {}),
      capabilityResult: attachment("capability-result"),
      error: result.error?.message?.replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0] ?? null,
    });
  }
  for (const nested of suite.suites ?? []) visit(nested);
}
for (const suite of raw.suites) visit(suite);
const report = { measuredAt: new Date().toISOString(), packageVersion: pkg.version,
  workerSha256: createHash("sha256").update(worker).digest("hex"), platform: process.platform,
  scope: "Installed-package desktop automation on this host; mock blind Nostr relay with real WebRTC/Workers/OPFS. No physical mobile devices, Safari product, Capacitor WebViews, public-internet NAT or background suspension certification.",
  observations };
const output = resolve("docs/benchmarks/browser-support.json");
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Wrote ${observations.length} observations to ${output}`);
