import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({ base: "./", build: { rollupOptions: { input: {
  todo: fileURLToPath(new URL("./index.html", import.meta.url)),
  sync: fileURLToPath(new URL("./sync.html", import.meta.url)),
} } } });
