import { encodeCommands } from "../../dist/binary-command.js";
import { encodePolicies, roleCode } from "../../dist/policies.js";

// Independent construction of the existing SCK2 history transcript. restore() uses
// the retained full canonical reducer, never incremental affected-row planning.
export function fullReplayCheckpoint(policy, candidates) {
  const unique = new Map();
  for (const candidate of candidates) unique.set(candidate.command.id, candidate);
  const ordered = [...unique.values()].sort((a, b) => a.command.lamport - b.command.lamport ||
    (a.command.actorId < b.command.actorId ? -1 : a.command.actorId > b.command.actorId ? 1 : a.command.sequence - b.command.sequence));
  const policies = encodePolicies(policy), blocks = ordered.map(c => encodeCommands([c.command]));
  const bytes = new Uint8Array(20 + policies.length + blocks.reduce((n, block) => n + block.length + 8, 0));
  const view = new DataView(bytes.buffer); let offset = 0;
  const u32 = n => { view.setUint32(offset, n, true); offset += 4; };
  u32(0x324b4353); u32(2); u32(ordered.length); u32(bytes.length); u32(policies.length);
  bytes.set(policies, offset); offset += policies.length;
  for (let i = 0; i < ordered.length; i++) { u32(roleCode(ordered[i].role)); u32(blocks[i].length); bytes.set(blocks[i], offset); offset += blocks[i].length; }
  return bytes;
}
