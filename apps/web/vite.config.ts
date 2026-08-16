import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { resolveWebBuildIdentity } from "../../scripts/lib/build-identity.mjs";

const {
  sourceRevision,
  clientBuildDigest
} = resolveWebBuildIdentity();
const buildIdentity = { sourceRevision, clientBuildDigest };

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "surf-build-identity",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build.json",
          source: `${JSON.stringify(buildIdentity)}\n`
        });
      }
    }
  ],
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  }
});
