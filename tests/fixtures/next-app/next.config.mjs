import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
export default { basePath: "/nested", outputFileTracingRoot: root, turbopack: { root } };
