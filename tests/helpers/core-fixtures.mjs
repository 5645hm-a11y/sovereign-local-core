import { signEvent } from "../../dist/identity.js";
import { toBase64Url } from "../../dist/crypto-codec.js";
import { LocalEventStore } from "../../dist/local-store.js";
import { LocalCore } from "../../dist/engine.js";
import { ProjectContext } from "../../dist/project.js";
import { encryptFields, fieldsAAD } from "../../dist/project-crypto.js";

export const projectId = "test-project";
async function identity() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const bytes = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return { publicKey: pair.publicKey,
    privateKey: await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    agreementKey: await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    actorId: `p256_${toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey))}` };
}
export const alice = await identity();
export const bob = await identity();
export const project = await ProjectContext.create(alice, projectId);
const initial = await project.evaluate([]);
export const bobInvitation = await project.invite(bob.actorId, "Member", 0, initial);
export const bobProject = await ProjectContext.open(bobInvitation, bob, projectId);
export async function event(sequence, type, fields, signer = alice, lamport = sequence, itemId = "item-1", projectIdValue = projectId) {
  const context = signer === alice ? project : bobProject;
  const key = initial.keys.get(initial.currentKeyId);
  const metadata = { schemaVersion: 3, projectId: projectIdValue, id: `${signer.actorId}:${sequence}`,
    actorId: signer.actorId, sequence, lamport, certificate: context.certificate };
  const encryptedFields = await encryptFields(type === "ITEM_DELETED" ? {} : fields,
    fieldsAAD(metadata, type, itemId, key.id), key);
  return signEvent({ ...metadata, type, itemId, keyId: key.id, encryptedFields }, signer);
}
export function store(device, signer = alice) { return LocalEventStore.open(device.open(), { actorId: signer.actorId, projectId }); }
export async function core(device, signer = alice) { return LocalCore.open(await store(device, signer), signer, signer === alice ? project : bobProject); }
export function concat(...arrays) {
  const bytes = new Uint8Array(arrays.reduce((size, array) => size + array.length, 0));
  let offset = 0;
  for (const array of arrays) { bytes.set(array, offset); offset += array.length; }
  return bytes;
}
export function* permutations(array) {
  if (array.length === 0) { yield []; return; }
  for (let i = 0; i < array.length; i++) {
    for (const rest of permutations(array.filter((_, j) => i !== j))) yield [array[i], ...rest];
  }
}
// Fault injection separates buffered bytes from durable bytes; native OPFS is tested in Chrome.
export class Device {
  durable = new Uint8Array(); maxChunk = Infinity; failAfter = Infinity; flushFailure = false; flushCount = 0;
  open() {
    let bytes = this.durable.slice(), closed = false;
    const assertOpen = () => { if (closed) throw new Error("closed"); };
    return {
      getSize: () => { assertOpen(); return bytes.length; },
      read: (buffer, { at }) => {
        assertOpen();
        const count = Math.min(buffer.length, Math.max(0, bytes.length - at), this.maxChunk);
        buffer.set(bytes.subarray(at, at + count)); return count;
      },
      write: (buffer, { at }) => {
        assertOpen(); if (this.failAfter <= 0) throw new Error("simulated write failure");
        const count = Math.min(buffer.length, this.maxChunk, this.failAfter);
        const next = new Uint8Array(Math.max(bytes.length, at + count));
        next.set(bytes); next.set(buffer.subarray(0, count), at);
        bytes = next; this.failAfter -= count; return count;
      },
      truncate: size => { assertOpen(); bytes = bytes.slice(0, size); },
      flush: () => {
        assertOpen(); this.flushCount++;
        if (this.flushFailure) throw new Error("simulated flush failure");
        this.durable = bytes.slice();
      },
      close: () => { closed = true; },
    };
  }
}
