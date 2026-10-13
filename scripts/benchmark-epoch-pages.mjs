import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { cpus, platform } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { newIdentity } from "../tests/helpers/epoch-fixtures.mjs";
import { ProjectContext } from "../dist/project.js";
import { generateProjectKey, wrapProjectKey } from "../dist/project-crypto.js";
import { buildEpochPages, MAX_EPOCH_PAGE_BYTES } from "../dist/epoch-pages.js";
import { encodeWire } from "../dist/binary-events.js";
import { toBase64Url } from "../dist/crypto-codec.js";
import { signEvent } from "../dist/identity.js";

const count = 10000, projectId = "epoch-benchmark", identity = await newIdentity();
const context = await ProjectContext.create(identity, projectId), key = await generateProjectKey();
const box = await wrapProjectKey(key, projectId, identity.actorId), keys = [box], history = [];
const actor = i => { const p = new Uint8Array(65); p[0] = 4; new DataView(p.buffer).setUint32(61, i); return `p256_${toBase64Url(p)}`; };
for (let i = 1; i <= count; i++) {
  if (i < count) keys.push({ ...box, recipient: actor(i) });
  history.push({ id: `${actor(i)}:1`, digest: "A".repeat(43) });
}
const epochId = `epoch_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
let events = [], manifest;
try {
  const before = performance.now();
  const plan = await buildEpochPages(projectId, key.id, actor(0), epochId, keys, history);
  const planMs = performance.now() - before, signingStarted = performance.now();
  for (let i = 0; i < plan.pages.length; i++) events.push(await signEvent({ schemaVersion: 4, projectId, actorId: identity.actorId,
    certificate: context.certificate, sequence: i + 1, lamport: i + 1, id: `${identity.actorId}:${i + 1}`, type: "KEY_EPOCH_PAGE", epochPage: plan.pages[i] }, identity));
  const sequence = events.length + 1;
  manifest = await signEvent({ schemaVersion: 4, projectId, actorId: identity.actorId, certificate: context.certificate,
    sequence, lamport: sequence, id: `${identity.actorId}:${sequence}`, type: "MEMBER_REVOKED",
    revocation: { targetActorId: actor(0), keyId: key.id, envelopes: [], allowedHistory: [], epoch: plan.commitment } }, identity);
  const signingMs = performance.now() - signingStarted, validationStarted = performance.now();
  const state = await context.evaluateBinary([...events, manifest]);
  const validationMs = performance.now() - validationStarted;
  assert.deepEqual(state.pendingEpochs, []); assert.equal(state.currentKeyId, key.id);
  assert.equal(state.epochs.get(manifest.id).envelopes.length, count);
  assert.equal(state.epochs.get(manifest.id).history.size, count);
  assert.equal(state.keys.get(key.id).id, key.id);
  const sizes = events.map(e => encodeWire(e).length), bodies = plan.pages.map(p => encodeWire(p).length);
  assert.ok(Math.max(...bodies) <= MAX_EPOCH_PAGE_BYTES); assert.ok(Math.max(...sizes) < 131072);
  const inlineBytes = encodeWire({ ...manifest, schemaVersion: 3, revocation: { targetActorId: actor(0), keyId: key.id, envelopes: keys, allowedHistory: history } }).length;
  const report = { date: new Date().toISOString(), node: process.version, platform: platform(), cpu: cpus()[0]?.model,
    scope: "10,000 synthetic envelope records and 10,000 synthetic witness records; one genuine recipient-encrypted Root key, real Root signatures, Merkle proofs and ProjectContext verification/unwrap. Copied envelopes at synthetic IDs are not usable recipient grants; witness digests are synthetic. No 10k-member governance, OPFS flush, Worker RPC, RTC, database data replay, memory peak or WAN benchmark.",
    recipients: count, witnesses: count, pageEntries: 128, pageCount: events.length,
    pageBodyLimitBytes: MAX_EPOCH_PAGE_BYTES, maximumPageBodyBytes: Math.max(...bodies),
    maximumSignedPageBytes: Math.max(...sizes), manifestBytes: encodeWire(manifest).length,
    totalSignedBytes: sizes.reduce((a, b) => a + b, 0) + encodeWire(manifest).length,
    hypotheticalInlineBytes: inlineBytes,
    inlineNote: "Byte-size comparison only: the hypothetical inline record exceeds both legacy array and 1 MiB log limits and is never signed/admitted as an inline event.",
    planMs, signingMs, validationMs,
    limitations: "Paging bounds each record, not complete plan/history memory. All pages remain necessary for activation, and governance reevaluation/checkpoints remain linear. Legacy invitation keyring (128), finite history/native bounds and cold discovery after key rotation remain separate constraints." };
  await mkdir(new URL("../docs/benchmarks/", import.meta.url), { recursive: true });
  await writeFile(new URL("../docs/benchmarks/epoch-pages-node.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  for (const k of state.keys.values()) if (k.id !== context.descriptor.genesisKeyId) k.bytes.fill(0);
} finally { key.bytes.fill(0); context.close(); }
