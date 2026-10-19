import { test, expect } from "@playwright/test";

test("wallet, complete WASM boot, durable OPFS write and reload", async ({ page, browser }, info) => {
  await info.attach("runtime", { body: JSON.stringify({ engine: info.project.name, version: browser.version(), platform: process.platform, date: new Date().toISOString() }), contentType: "application/json" });
  await page.goto("/sync.html");
  await expect(page.locator("#capabilities")).not.toContainText("Checking");
  await info.attach("capability-result", { body: await page.locator("#capabilities").innerText(), contentType: "text/plain" });
  await expect(page.locator("#capabilities")).toContainText("checks passed");
  const passphrase = "synthetic-browser-compatibility-passphrase";
  await page.getByLabel("Local passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock wallet", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.locator("#project-status")).toContainText("Admin");
  await page.getByLabel("Record title", { exact: true }).fill("Durable browser check");
  await page.getByRole("button", { name: "Add record", exact: true }).click();
  await expect(page.locator("#records")).toContainText("Durable browser check");
  await expect(page.locator("body")).toHaveAttribute("aria-busy", "false");
  await page.reload();
  await page.getByLabel("Local passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock wallet", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.getByRole("button", { name: "Reopen local project", exact: true }).click();
  await expect(page.locator("#records")).toContainText("Durable browser check");
});
