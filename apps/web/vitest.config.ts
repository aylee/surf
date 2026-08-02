import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:email": fileURLToPath(new URL("./worker/test/cloudflare-email-stub.ts", import.meta.url)),
      "cloudflare:workers": fileURLToPath(
        new URL("./worker/test/cloudflare-workers-stub.ts", import.meta.url)
      )
    }
  },
  test: {
    include: ["worker/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    server: {
      deps: {
        inline: ["agents", "partyserver"]
      }
    }
  }
});
