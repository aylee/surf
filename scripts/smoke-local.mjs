#!/usr/bin/env node

import { smokeForecastInstance } from "./lib/smoke-instance.mjs";

const baseUrl = "http://127.0.0.1:8787";
const result = await smokeForecastInstance(baseUrl, {
  label: "Local smoke",
  requireForecastData: true
});
console.log(JSON.stringify(result));
