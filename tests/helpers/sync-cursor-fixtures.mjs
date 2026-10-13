import { Device, alice, projectId, concat } from "./core-fixtures.mjs";
import { ProjectContext } from "../../dist/project.js";
import { LocalCore } from "../../dist/engine.js";
import { LocalEventStore } from "../../dist/local-store.js";
import { signEvent } from "../../dist/identity.js";
import { encryptFields, fieldsAAD } from "../../dist/project-crypto.js";
import { encodeFrame } from "../../dist/framed-log.js";

export class ReadTrackedDevice extends Device {
  stats = { bytes: 0, calls: 0, largestRead: 0 };
  overrideBytes = null;
  resetReads() { this.stats = { bytes: 0, calls: 0, largestRead: 0 }; }
  open() {
    const file = super.open();
    return { ...file, read: (bytes, options) => {
      let count;
      if (this.overrideBytes) {
        count = Math.min(bytes.length, this.maxChunk, this.overrideBytes.length - options.at);
        bytes.set(this.overrideBytes.subarray(options.at, options.at + count));
      } else count = file.read(bytes, options);
      this.stats.bytes += count; this.stats.calls++; this.stats.largestRead = Math.max(this.stats.largestRead, bytes.length);
      return count;
    } };
  }
}

/** Real signed/encrypted records, prepared before timing without quadratic appends. */
export async function seedCursorCore(count = 200, padding = 1024, options = {}) {
  const context = await ProjectContext.create(alice, projectId), initial = await context.evaluate([]);
  const key = initial.keys.get(initial.currentKeyId), events = [];
  for (let sequence = 1; sequence <= count; sequence++) {
    const metadata = { schemaVersion: 3, projectId, actorId: alice.actorId, id: `${alice.actorId}:${sequence}`,
      sequence, lamport: sequence, certificate: context.certificate };
    const itemId = `record_${sequence}`;
    const encryptedFields = await encryptFields({ revision: sequence, text: "x".repeat(padding) }, fieldsAAD(metadata, "ITEM_ADDED", itemId, key.id), key);
    events.push(await signEvent({ ...metadata, type: "ITEM_ADDED", itemId, keyId: key.id, encryptedFields }, alice));
  }
  const device = new ReadTrackedDevice();
  device.durable = concat(encodeFrame({ kind: "identity", version: 3, actorId: alice.actorId, projectId }), ...events.map(event => encodeFrame({ kind: "event", event })));
  const store = await LocalEventStore.open(device.open(), { actorId: alice.actorId, projectId });
  const core = await LocalCore.open(store, alice, context, options);
  device.resetReads();
  return { core, device, context, store, events };
}

export async function drainCursor(core, summary = {}) {
  const handle = await core.openSyncCursor(summary); if (!handle) throw new Error("Expected bounded log support");
  const events = [], pages = [];
  try {
    while (true) {
      const page = await core.readSyncCursor(handle.id); pages.push(page); events.push(...page.events);
      if (page.done) break;
    }
  } finally { await core.closeSyncCursor(handle.id); }
  return { events, pages };
}
