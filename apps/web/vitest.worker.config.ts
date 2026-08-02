import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Keep this config beside no .dev.vars file so tests never load Alex's
      // real local Gemini secret. The config binds a non-secret sentinel.
      wrangler: { configPath: "./worker/test/wrangler.agent-test.jsonc" },
      additionalExports: {
        ForecastBriefAgent: "DurableObject"
      },
      miniflare: {
        bindings: {
          // Tests replace the queue boundary before signaling, so this sentinel
          // can never be sent to Gemini.
          GEMINI_API_KEY: "worker-pool-test-key",
          TEST_MIGRATIONS: await readD1Migrations(
            resolve(import.meta.dirname, "../../packages/db/migrations")
          )
        }
      }
    }))
  ],
  test: {
    include: ["worker/**/*.workers.spec.ts"],
    fileParallelism: false,
    setupFiles: ["./worker/test/apply-agent-migrations.ts"]
  }
});
