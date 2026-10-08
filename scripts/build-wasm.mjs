import { mkdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = resolve(root, ".tools/emsdk-main/upstream/emscripten/em++.py");
const browser = process.argv.includes("--browser");
const output = browser ? ".package-build/wasm" : "dist/wasm";
const args = ["native/core_engine.cpp", "-std=c++20", "-O3", "-flto", "-fwasm-exceptions", "--no-entry",
  "-sMODULARIZE=1", "-sEXPORT_ES6=1", browser ? "-sENVIRONMENT=web,worker" : "-sENVIRONMENT=web,worker,node", "-sFILESYSTEM=0",
  "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=8388608", "-sMAXIMUM_MEMORY=536870912",
  "-sSTACK_SIZE=262144", "-sABORTING_MALLOC=0",
  '-sEXPORTED_FUNCTIONS=["_malloc","_free","_core_abi_version","_core_merge","_core_output_ptr","_core_output_size","_core_clear_output","_core_session_create","_core_session_destroy","_core_session_apply","_core_session_snapshot","_core_session_checkpoint","_core_session_restore","_core_session_reset"]',
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]', "-o", `${output}/core_engine.mjs`];
await mkdir(resolve(root, output), { recursive: true });
// Prefer an explicit SDK/compiler, then the task-local SDK; otherwise use the activated PATH.
const taskSDK = process.env.EMSDK;
const sdkCompiler = taskSDK ? resolve(taskSDK, "upstream/emscripten/em++.py") : local;
const pythonCompiler = await stat(sdkCompiler).then(() => sdkCompiler, () => null);
const command = process.env.EMXX ?? (pythonCompiler ? (process.env.PYTHON ?? "python") : "em++");
const invocation = pythonCompiler && !process.env.EMXX ? [pythonCompiler, ...args] : args;
const result = spawnSync(command, invocation, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && /\.(bat|cmd)$/i.test(command) });
if (result.error) throw new Error("WASM compiler unavailable. Activate Emscripten or set EMSDK/EMXX; see docs/WASM.md", { cause: result.error });
if (result.status !== 0) process.exit(result.status ?? 1);
const version = spawnSync(command, pythonCompiler && !process.env.EMXX ? [pythonCompiler, "--version"] : ["--version"], { cwd: root, encoding: "utf8" });
await writeFile(resolve(root, output, "build-info.json"), JSON.stringify({ compiler: version.stdout.trim(), standard: "C++20", optimization: "-O3 -flto", abi: 1 }, null, 2));
