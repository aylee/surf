#!/usr/bin/env node

import { loadRootEnv } from "../../../scripts/lib/root-env.mjs";
import { smokeForecastInstance } from "../../../scripts/lib/smoke-instance.mjs";

loadRootEnv();

const configuredUrl = process.env.SURF_BASE_URL;
if (!configuredUrl) {
  throw new Error(
    "SURF_BASE_URL is required (for example: https://your-worker.workers.dev)."
  );
}

const requireForecastData = process.env.SURF_REQUIRE_FORECAST_DATA !== "false";
const result = await smokeForecastInstance(configuredUrl, {
  label: "Cloudflare smoke",
  requireForecastData
});
console.log(JSON.stringify(result));
