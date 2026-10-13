import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startSignalingServer } from "../../scripts/signaling-server.mjs";

let signaling;
test.beforeEach(async () => { signaling = await startSignalingServer({ port: 0 }); });
test.afterEach(async () => { await signaling?.close(); });

async function replicas(browser) {
  // Separate profiles/OPFS roots/actor identities, not two clients over the same locked file.
  const options = { baseURL: test.info().project.use.baseURL };
  const contexts = [await browser.newContext(options), await browser.newContext(options)];
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  await Promise.all(pages.map(page => page.goto("/examples/p2p.html?db=replica")));
  await Promise.all(pages.map(page => page.evaluate(() => window.ready)));
  await authorizePair(pages[0], pages[1]);
  return { a: pages[0], b: pages[1], close: () => Promise.all(contexts.map(context => context.close())) };
}
async function authorizePair(a, b) {
  const recipient = (await b.evaluate(() => window.ready)).actorId;
  await a.evaluate(() => window.createDemoProject());
  const { invitation, event } = await a.evaluate(actorId => window.db.inviteMember(actorId), recipient);
  await b.evaluate(invitation => window.joinDemoProject(invitation), invitation);
  await b.evaluate(event => window.db.ingestEvents([event]), event);
}
async function connect(a, b, room = randomUUID()) {
  await Promise.all([a, b].map(page => page.evaluate(
    ({ room, url }) => window.connectP2P(room, url), { room, url: signaling.url },
  )));
  await online(a, b);
  return room;
}
async function online(...pages) {
  await Promise.all(pages.map(page => expect.poll(async () => page.evaluate(() => ({
    state: window.sync.state, error: window.sync.lastError,
  })), { timeout: 15000 }).toEqual({ state: "online", error: null })));
}
async function dispatch(page, command) { return page.evaluate(command => window.db.dispatch(command), command); }
async function snapshot(page) { return page.evaluate(() => window.db.snapshot()); }
async function converged(a, b) {
  await expect.poll(async () => JSON.stringify(await snapshot(a)) === JSON.stringify(await snapshot(b)), { timeout: 10000 }).toBe(true);
}

test("initial catch-up, bidirectional live edits, concurrent convergence and durable remote recovery", async ({ browser }) => {
  const replicas_ = await replicas(browser);
  const { a, b } = replicas_;
  try {
    await dispatch(a, { type: "ITEM_ADDED", itemId: "task-a", fields: { title: "from A", done: false } });
    await dispatch(b, { type: "ITEM_ADDED", itemId: "task-b", fields: { title: "from B" } });
    const actorA = (await a.evaluate(() => window.ready)).actorId;
    const actorB = (await b.evaluate(() => window.ready)).actorId;
    expect(actorA).not.toBe(actorB);
    const room = await connect(a, b);
    await converged(a, b);
    expect((await snapshot(a)).items).toHaveLength(2);
    expect(await a.evaluate(() => window.sync.stats.eventsSent)).toBe(1);
    expect(await b.evaluate(() => window.sync.stats.eventsSent)).toBe(1);
    const update = await dispatch(a, { type: "ITEM_UPDATED", itemId: "task-a", fields: { title: "live from A" } });
    await expect.poll(async () => (await snapshot(b)).items.find(item => item.id === "task-a").fields.title).toBe("live from A");
    expect(await b.evaluate(id => window.db.readEvents().then(events => events.some(event => event.id === id)), update.event.id)).toBe(true);
    await Promise.all([
      dispatch(a, { type: "ITEM_UPDATED", itemId: "task-a", fields: { done: true } }),
      dispatch(b, { type: "ITEM_UPDATED", itemId: "task-a", fields: { owner: "B" } }),
    ]);
    await converged(a, b);
    expect((await snapshot(a)).items.find(item => item.id === "task-a").fields).toEqual({ title: "live from A", done: true, owner: "B" });
    await Promise.all([
      dispatch(a, { type: "ITEM_UPDATED", itemId: "task-a", fields: { title: "concurrent A" } }),
      dispatch(b, { type: "ITEM_UPDATED", itemId: "task-a", fields: { title: "concurrent B" } }),
    ]);
    await converged(a, b);
    const before = await snapshot(b);
    await b.reload();
    const recovered = await b.evaluate(() => window.ready);
    expect(recovered.actorId).toBe(actorB);
    expect(recovered.snapshot).toEqual(before);
    await b.evaluate(({ room, url }) => window.connectP2P(room, url), { room, url: signaling.url });
    await online(a, b);
    await dispatch(b, { type: "ITEM_UPDATED", itemId: "task-b", fields: { title: "B after reload" } });
    await expect.poll(async () => (await snapshot(a)).items.find(item => item.id === "task-b").fields.title).toBe("B after reload");
  } finally { await replicas_.close(); }
});

test("offline writes are reconciled on reconnect without replaying the known prefix", async ({ browser }) => {
  const replicas_ = await replicas(browser);
  const { a, b } = replicas_;
  try {
    await dispatch(a, { type: "ITEM_ADDED", itemId: "shared", fields: { title: "initial" } });
    await connect(a, b);
    await converged(a, b);
    await b.evaluate(() => window.sync.stop());
    await expect.poll(() => a.evaluate(() => window.sync.state)).not.toBe("online");
    const sentA = await a.evaluate(() => window.sync.stats.eventsSent);
    const sentB = await b.evaluate(() => window.sync.stats.eventsSent);
    await dispatch(a, { type: "ITEM_UPDATED", itemId: "shared", fields: { title: "A offline" } });
    await dispatch(a, { type: "ITEM_ADDED", itemId: "offline-a", fields: { n: 1 } });
    await dispatch(b, { type: "ITEM_ADDED", itemId: "offline-b", fields: { n: 2 } });
    await b.evaluate(() => window.sync.start());
    await online(a, b);
    await converged(a, b);
    expect((await snapshot(a)).items).toHaveLength(3);
    expect(await a.evaluate(() => window.sync.stats.eventsSent)).toBe(sentA + 2);
    expect(await b.evaluate(() => window.sync.stats.eventsSent)).toBe(sentB + 1);
    const sentAfter = await a.evaluate(() => window.sync.stats.eventsSent);
    await a.evaluate(() => window.sync.reconnect());
    await online(a, b);
    expect(await a.evaluate(() => window.sync.stats.eventsSent)).toBe(sentAfter);
  } finally { await replicas_.close(); }
});

test("data continues during signaling outage and automatically rejoins after server restart", async ({ browser }) => {
  const replicas_ = await replicas(browser);
  const { a, b } = replicas_;
  try {
    await dispatch(a, { type: "ITEM_ADDED", itemId: "shared", fields: { title: "initial" } });
    await connect(a, b);
    const initialPairings = await a.evaluate(() => window.sync.stats.pairings);
    const port = signaling.port;
    await signaling.close(); signaling = null;
    await dispatch(a, { type: "ITEM_UPDATED", itemId: "shared", fields: { title: "no signaling needed" } });
    await expect.poll(async () => (await snapshot(b)).items[0].fields.title).toBe("no signaling needed");
    signaling = await startSignalingServer({ port });
    await expect.poll(() => a.evaluate(() => window.sync.stats.pairings), { timeout: 15000 }).toBeGreaterThan(initialPairings);
    await online(a, b);
    await dispatch(b, { type: "ITEM_UPDATED", itemId: "shared", fields: { done: true } });
    await expect.poll(async () => (await snapshot(a)).items[0].fields.done).toBe(true);
  } finally { await replicas_.close(); }
});

test("large Unicode events are fragmented and persist identically on the receiving peer", async ({ browser }) => {
  const replicas_ = await replicas(browser);
  const { a, b } = replicas_;
  try {
    const text = "שלום".repeat(30000); // 240 kB UTF-8, above an individual SCTP message limit.
    await dispatch(a, { type: "ITEM_ADDED", itemId: "large", fields: { text } });
    await connect(a, b);
    expect((await snapshot(b)).items[0].fields.text).toBe(text);
    const next = text + " updated";
    await dispatch(b, { type: "ITEM_UPDATED", itemId: "large", fields: { text: next } });
    await expect.poll(async () => (await snapshot(a)).items[0].fields.text).toBe(next);
    await b.reload();
    expect((await b.evaluate(() => window.ready)).snapshot.items[0].fields.text).toBe(next);
  } finally { await replicas_.close(); }
});

test("interrupted catch-up resumes after its durable prefix even when no ACK was sent", async ({ browser }) => {
  const replicas_ = await replicas(browser);
  const { a, b } = replicas_;
  try {
    await a.evaluate(async () => {
      for (let i = 0; i < 70; i++) await window.db.dispatch({
        type: "ITEM_ADDED", itemId: `item-${i}`, fields: { n: i },
      });
    });
    await b.evaluate(() => {
      const original = window.db.ingestCommitted.bind(window.db);
      let interrupted = false;
      window.db.ingestCommitted = async events => {
        if (!interrupted && events.length > 1) {
          interrupted = true;
          const result = await original(events.slice(0, 1));
          window.sync.reconnect(); // Persisted first event, but destroy transport before durable ACK.
          return result;
        }
        return original(events);
      };
    });
    await connect(a, b);
    await converged(a, b);
    expect((await snapshot(b)).items).toHaveLength(70);
    expect(await b.evaluate(() => window.db.readEvents().then(events => events.length))).toBe(71);
    expect(await b.evaluate(() => window.sync.stats.pairings)).toBeGreaterThan(1);
    const actorA = (await a.evaluate(() => window.ready)).actorId;
    expect(await b.evaluate(() => window.db.getSyncSummary())).toEqual({ [actorA]: 71 });
  } finally { await replicas_.close(); }
});

test("two tabs in one browser profile synchronize using distinct replica files", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const a = await context.newPage(), b = await context.newPage();
    await Promise.all([
      a.goto("/examples/p2p.html?db=replica-a"),
      b.goto("/examples/p2p.html?db=replica-b"),
    ]);
    await Promise.all([a, b].map(page => page.evaluate(() => window.ready)));
    await authorizePair(a, b);
    await dispatch(a, { type: "ITEM_ADDED", itemId: "shared", fields: { title: "A" } });
    await connect(a, b);
    expect((await snapshot(b)).items[0].fields.title).toBe("A");
    await dispatch(b, { type: "ITEM_UPDATED", itemId: "shared", fields: { title: "B" } });
    await expect.poll(async () => (await snapshot(a)).items[0].fields.title).toBe("B");
  } finally { await context.close(); }
});
