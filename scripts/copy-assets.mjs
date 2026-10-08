#!/usr/bin/env node
import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const destination = process.argv[2];
if (!destination) throw new Error("Usage: p2p-core-copy-assets <public-directory/p2p-core>");
await mkdir(resolve(destination), { recursive: true });
await copyFile(fileURLToPath(new URL("../package-dist/worker.js", import.meta.url)), resolve(destination, "worker.js"));
console.log(`Self-contained Worker copied to ${resolve(destination, "worker.js")}`);
