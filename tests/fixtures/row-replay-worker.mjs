import { BinaryProjection } from "/dist/wasm-loader.js";
import { encodeCommands } from "/dist/binary-command.js";

self.onmessage = async () => {
  const policy = { version: 1, defaultAllow: false, rules: [{ prefix: "asset_", create: ["Admin"], update: ["Admin"], delete: ["Admin"],
    checkout: ["Admin", "Member"], return: ["Admin", "Member"], ownerField: null, library: true }] };
  const native = await BinaryProjection.create(policy); let restored;
  const command = (actorId, sequence, lamport, type, itemId, fields) => encodeCommands([{ id: `${actorId}:${sequence}`, actorId, sequence, lamport, type, itemId, fields }]);
  try {
    const blocks = Array.from({ length: 1000 }, (_, i) => command("actor_root", i + 1, i + 1, "ITEM_ADDED", `asset_${i}`, { label: `Asset ${i}` }));
    native.applyAuthorized(blocks, blocks.map(() => "Admin"));
    native.applyAuthorized([command("actor_root", 1001, 2000, "ITEM_UPDATED", "asset_0", { label: "Tail" })], ["Admin"]);
    const suffix = native.replayWork;
    native.applyAuthorized([command("actor_other", 1, 2, "CHECKOUT", "asset_0", { borrowerId: "first" })], ["Member"]);
    const late = native.replayWork, checkpoint = native.checkpoint();
    restored = await BinaryProjection.create(policy); restored.restore(checkpoint); const restore = restored.replayWork;
    const early = command("actor_first", 1, 2, "CHECKOUT", "asset_0", { borrowerId: "winner" });
    native.applyAuthorized([early], ["Member"]); restored.applyAuthorized([early], ["Member"]);
    const original = native.snapshot(2000), recovered = restored.snapshot(2000);
    const cp = native.checkpoint(); let denied;
    try { native.applyAuthorized([command("actor_other", 2, 3000, "ITEM_DELETED", "asset_999", {})], ["Member"]); }
    catch (error) { denied = error.status; }
    const after = native.checkpoint();
    self.postMessage({ suffix, late, restore, denied, rows: original.items.length,
      viewEqual: JSON.stringify(original) === JSON.stringify(recovered),
      checkpointIntact: cp.length === after.length && cp.every((value, i) => value === after[i]),
      winner: original.items.find(i => i.id === "asset_0").fields.loanId,
      loser: original.decisions.find(d => d.eventId === "actor_other:1").status,
      unchanged: original.items.find(i => i.id === "asset_999").fields.label });
    checkpoint.fill(0); cp.fill(0); after.fill(0);
  } catch (error) { self.postMessage({ error: error.message }); }
  finally { native.close(); restored?.close(); }
};
