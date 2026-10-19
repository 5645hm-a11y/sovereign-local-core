import { test, expect } from "@playwright/test";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";

async function unlock(page) {
  await page.goto(new URL("/sync.html", test.info().project.use.baseURL ?? "http://127.0.0.1:4183").href);
  await expect(page.locator("#capabilities")).toContainText("checks passed");
  await page.getByLabel("Local passphrase", { exact: true }).fill("synthetic-public-sync-example-passphrase");
  await page.getByRole("button", { name: "Unlock wallet", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
}
async function add(page, title) {
  await page.getByLabel("Record title", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Add record", exact: true }).click();
  await expect(page.locator("#records")).toContainText(title);
  await expect(page.locator("body")).toHaveAttribute("aria-busy", "false");
}
async function connect(page, relay) {
  await page.getByLabel("Nostr relay URLs", { exact: true }).fill(relay);
  if (!await page.getByLabel("ICE servers (JSON array)", { exact: true }).isVisible()) await page.getByText("STUN / TURN configuration", { exact: true }).click();
  await page.getByLabel("ICE servers (JSON array)", { exact: true }).fill("[]");
  await page.getByRole("button", { name: "Connect peers", exact: true }).click();
}
test("public installed-package example pairs independent wallets, syncs offline edits and reopens OPFS", async ({ browser }) => {
  test.setTimeout(90000);
  const relay = await startMockNostrRelay(), contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
  const errors = []; for (const page of [a, b]) page.on("pageerror", error => errors.push(error.message));
  try {
    console.log("Peer example: unlock independent wallets");
    await Promise.all([unlock(a), unlock(b)]);
    await a.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(a.locator("#project-status")).toContainText("Admin");
    const project = await a.getByLabel("Project ID", { exact: true }).inputValue();
    const actor = await b.getByLabel("This device’s public ActorID", { exact: true }).inputValue();
    await a.getByLabel("Recipient ActorID", { exact: true }).fill(actor);
    await a.getByRole("button", { name: "Create Member invitation", exact: true }).click();
    await expect(a.locator("#invitation-output")).not.toHaveValue("");
    const invitation = await a.locator("#invitation-output").inputValue(), root = await a.locator("#root").inputValue();
    await b.getByLabel("Signed invitation", { exact: true }).fill(invitation);
    await b.getByLabel("Trusted root ActorID", { exact: true }).fill("untrusted-root");
    await b.getByRole("button", { name: "Verify invitation and join", exact: true }).click();
    await expect(b.locator("#error")).toContainText("does not match");
    await b.getByLabel("Trusted root ActorID", { exact: true }).fill(root);
    await b.getByRole("button", { name: "Verify invitation and join", exact: true }).click();
    await expect(b.locator("#project-status")).toContainText("Member");
    console.log("Peer example: membership verified; start initial sync");
    await add(a, "Before connection");
    await Promise.all([connect(a, relay.url), connect(b, relay.url)]);
    await expect(b.locator("#records")).toContainText("Before connection", { timeout: 25000 });
    console.log("Peer example: catch-up complete; test live edit");
    await b.getByRole("checkbox", { name: "Before connection", exact: true }).check();
    await expect(a.getByRole("checkbox", { name: "Before connection", exact: true })).toBeChecked();
    await b.getByRole("button", { name: "Pause sync", exact: true }).click();
    await add(a, "Offline on A"); await add(b, "Offline on B");
    await expect(b.locator("#records")).not.toContainText("Offline on A");
    await connect(b, relay.url);
    console.log("Peer example: reconnect after offline edits");
    for (const page of [a, b]) {
      await expect(page.locator("#records")).toContainText("Offline on A", { timeout: 25000 });
      await expect(page.locator("#records")).toContainText("Offline on B");
    }
    await b.reload(); await expect(b.locator("#capabilities")).toContainText("checks passed");
    console.log("Peer example: reload and recover OPFS");
    expect(await b.getByLabel("Local passphrase", { exact: true }).inputValue()).toBe("");
    await b.getByLabel("Local passphrase", { exact: true }).fill("synthetic-public-sync-example-passphrase");
    await b.getByRole("button", { name: "Unlock wallet", exact: true }).click();
    await expect(b.locator("#workspace")).toBeVisible();
    expect(await b.getByLabel("Project ID", { exact: true }).inputValue()).toBe(project);
    await b.getByRole("button", { name: "Reopen local project", exact: true }).click();
    await expect(b.locator("#records")).toContainText("Offline on B");
    await expect(b.getByRole("checkbox", { name: "Before connection", exact: true })).toBeChecked();
    // The view appears before its cursor-close RPC settles. Wait for the app
    // action to finish so its busy guard cannot discard the subsequent lock.
    await expect(b.locator("body")).toHaveAttribute("aria-busy", "false");
    console.log("Peer example: recovered; lock both wallets");
    await Promise.all([a, b].map(page => page.getByRole("button", { name: "Lock wallet", exact: true }).click()));
    await Promise.all([a, b].map(page => expect(page.locator("#wallet")).toBeVisible()));
    await expect.poll(() => relay.activeSubscriptions).toBe(0);
    console.log("Peer example: locks and relay cleanup complete");
    expect(errors).toEqual([]);
    expect(relay.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(relay.events)).not.toContain("Before connection");
  } finally {
    // During finally Playwright may not have marked a thrown assertion failed yet.
    {
      const diagnostics = await Promise.all([a, b].map(async page => ({
        error: await page.locator("#error").innerText({ timeout: 2000 }).catch(() => "Page unavailable"),
        network: await page.locator("#network-status").innerText({ timeout: 2000 }).catch(() => "Page unavailable"),
      })));
      await test.info().attach("transport-diagnostics", { body: JSON.stringify(diagnostics), contentType: "application/json" });
    }
    await Promise.all(contexts.map(context => context.close())); await relay.close();
  }
});
