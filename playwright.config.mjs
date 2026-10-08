import { defineConfig } from "@playwright/test";

const port = process.env.LOCAL_CORE_TEST_PORT ?? "4174";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL, headless: true },
  projects: [{ name: "chrome", use: { browserName: "chromium", channel: "chrome" } }],
  webServer: {
    command: "node scripts/serve-fixtures.mjs",
    url: baseURL,
    env: { ...process.env, LOCAL_CORE_PORT: port },
    reuseExistingServer: false,
    timeout: 15000,
  },
});
