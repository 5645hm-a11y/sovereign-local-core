import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: ["**/compat/*.spec.mjs", "**/dx/peer-sync.spec.mjs"], workers: 1, timeout: 60000,
  reporter: [["list"], ["json", { outputFile: "artifacts/browser-compatibility.json" }]],
  use: { headless: true, baseURL: "http://127.0.0.1:4184" },
  projects: [
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: { command: "npm run dev --prefix examples/vanilla-todo -- --port 4184", url: "http://127.0.0.1:4184/sync.html", reuseExistingServer: false },
});
