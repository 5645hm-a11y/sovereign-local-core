import base from "./playwright.config.mjs";
export default { ...base, testDir: "./tests/network", timeout: 60000 };
