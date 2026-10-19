import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/dx", workers: 1, timeout: 60000,
  use: { headless: true, channel: "chrome", trace: "retain-on-failure" },
  webServer: [
    { command: "npm run dev --prefix tests/fixtures/react-probe", url: "http://127.0.0.1:4180/demo/", reuseExistingServer: false },
    { command: "npm run preview --prefix tests/fixtures/react-probe", url: "http://127.0.0.1:4181/demo/", reuseExistingServer: false },
    { command: "npm run start --prefix tests/fixtures/next-app", url: "http://127.0.0.1:4190/nested", env: { NEXT_TELEMETRY_DISABLED: "1" }, reuseExistingServer: false, timeout: 30000 },
    { command: "npm run dev --prefix examples/react-demo", url: "http://127.0.0.1:4182", reuseExistingServer: false },
    { command: "npm run dev --prefix examples/vanilla-todo", url: "http://127.0.0.1:4183", reuseExistingServer: false },
  ],
});
