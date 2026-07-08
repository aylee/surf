#!/usr/bin/env node

const baseUrl = process.env.SURF_CLOUDFLARE_URL || "https://surf.alex-1ca.workers.dev";
const response = await fetch(`${baseUrl}/api/health`);
if (!response.ok) {
  throw new Error(`Cloudflare smoke failed: ${response.status} ${await response.text()}`);
}
console.log(await response.text());
