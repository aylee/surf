#!/usr/bin/env node

const baseUrl = process.env.SURF_BASE_URL || "http://127.0.0.1:8787";
const response = await fetch(`${baseUrl}/api/reports/today`);
if (!response.ok) {
  throw new Error(`report fetch failed: ${response.status} ${await response.text()}`);
}
console.log(await response.text());

