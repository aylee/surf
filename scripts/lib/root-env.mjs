import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const rootEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));

export function loadRootEnv() {
  if (existsSync(rootEnvPath)) {
    process.loadEnvFile(rootEnvPath);
  }
}
