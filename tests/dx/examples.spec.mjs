import { test, expect } from "@playwright/test";

async function signIn(page, email) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("synthetic-example-test-password");
  await page.getByRole("button", { name: "Open project", exact: true }).click();
}
test("public React example uses user credentials and persists task edits and encrypted file metadata", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:4182");
  const projectId = await page.getByLabel("Project ID", { exact: true }).inputValue();
  expect(projectId).toMatch(/^[a-f0-9-]{36}$/);
  await signIn(page, "public-react-test@example.test"); await expect(page.getByTestId("project-status")).toContainText("Ready");
  await page.getByLabel("Task title").fill("Public React task"); await page.getByRole("button", { name: "Add task", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: "Public React task" }); await expect(checkbox).not.toBeChecked();
  await checkbox.click(); await expect(checkbox).toBeChecked();
  await page.getByLabel("Upload file").setInputFiles({ name: "public-example.txt", mimeType: "text/plain", buffer: Buffer.from("Encrypted example file") });
  await expect(page.getByTestId("storage-status")).toContainText("success"); await expect(page.getByTestId("files")).toContainText("public-example.txt");
  await page.reload();
  expect(await page.getByLabel("Project ID", { exact: true }).inputValue()).toBe(projectId);
  expect(await page.getByLabel("Password", { exact: true }).inputValue()).toBe("");
  await signIn(page, "public-react-test@example.test"); await expect(page.getByTestId("project-status")).toContainText("Ready");
  await expect(page.getByRole("checkbox", { name: "Public React task" })).toBeChecked();
  await expect(page.getByTestId("files")).toContainText("public-example.txt");
  await page.getByRole("button", { name: "Delete Public React task", exact: true }).click(); await expect(page.getByTestId("tasks").locator("li")).toHaveCount(0);
  await page.getByRole("button", { name: "Close project", exact: true }).click(); await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  expect(errors).toEqual([]);
});
test("public TypeScript example creates, updates, reloads and deletes tasks without preset credentials", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:4183"); await signIn(page, "public-vanilla-test@example.test");
  await expect(page.locator("#project")).toBeVisible();
  await page.getByLabel("Task title").fill("Public TypeScript task"); await page.getByRole("button", { name: "Add task", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: "Public TypeScript task" }); await checkbox.check(); await expect(checkbox).toBeChecked();
  await expect(page.locator("#project")).toHaveAttribute("aria-busy", "false");
  await page.reload(); await signIn(page, "public-vanilla-test@example.test");
  await expect(page.getByRole("checkbox", { name: "Public TypeScript task" })).toBeChecked();
  await page.getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.locator("#tasks li")).toHaveCount(0);
  await page.getByRole("button", { name: "Close project", exact: true }).click(); await expect(page.locator("#login")).toBeVisible();
  expect(errors).toEqual([]);
});
