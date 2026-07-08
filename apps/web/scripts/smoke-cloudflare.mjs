#!/usr/bin/env node

const baseUrl = process.env.SURF_CLOUDFLARE_URL || "https://surf.alex-1ca.workers.dev";
async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`Cloudflare smoke ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const health = await get("/api/health");
const spots = await get("/api/spots");
const forecast = await get("/api/forecast/obsf-central");
const report = await get("/api/reports/today");

if (health.status !== "ok") {
  throw new Error(`Unexpected health status: ${JSON.stringify(health)}`);
}

if (!Array.isArray(spots.spots) || spots.spots.length < 6) {
  throw new Error(`Expected v1 NorCal spots, got: ${JSON.stringify(spots)}`);
}

if (!Array.isArray(forecast.windows) || forecast.windows.length < 25) {
  throw new Error(`Expected 72-hour OBSF Central forecast windows, got: ${JSON.stringify(forecast)}`);
}

if (report.enabled !== false && typeof report.reportMarkdown !== "string") {
  throw new Error(`Expected disabled report or generated markdown, got: ${JSON.stringify(report)}`);
}

console.log(JSON.stringify({ status: "ok", baseUrl, generatedAt: new Date().toISOString() }));
