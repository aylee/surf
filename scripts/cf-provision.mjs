#!/usr/bin/env node

import { readFileSync } from "node:fs";

const accountId =
  process.env.CLOUDFLARE_ACCOUNT_ID || "1cad681ec2a198b48cd88f4ad5f455ce";
const token = process.env.CLOUDFLARE_API_TOKEN;

const expected = {
  d1: "surf",
  r2: "surf-raw",
  kv: "surf-cache",
  queue: "surf-ingest",
  dlq: "surf-ingest-dlq"
};

function requireTokenOrConfigured() {
  if (token) return;
  const config = readFileSync("apps/web/wrangler.jsonc", "utf8");
  const configured =
    config.includes("a3e856fe-9ce3-4e71-ba60-f33ca3a15d4e") &&
    config.includes("392b927b791d406bbd662be3844b1b2a") &&
    config.includes("surf-raw") &&
    config.includes("surf-ingest");
  if (configured) {
    console.log("Cloudflare resources are already configured in wrangler.jsonc.");
    console.log("Set CLOUDFLARE_API_TOKEN to reconcile or recreate live resources.");
    process.exit(0);
  }
  console.error("CLOUDFLARE_API_TOKEN is required to provision missing resources.");
  process.exit(1);
}

async function api(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!payload.success) {
    const detail = JSON.stringify(payload.errors || payload, null, 2);
    throw new Error(`${method} ${path} failed: ${detail}`);
  }
  return payload.result;
}

async function ensureD1() {
  const list = await api("GET", `/accounts/${accountId}/d1/database`);
  const found = list.find((db) => db.name === expected.d1);
  return found || api("POST", `/accounts/${accountId}/d1/database`, {
    name: expected.d1,
    primary_location_hint: "wnam"
  });
}

async function ensureR2() {
  const list = await api("GET", `/accounts/${accountId}/r2/buckets`);
  const buckets = Array.isArray(list?.buckets) ? list.buckets : list;
  const found = buckets.find((bucket) => bucket.name === expected.r2);
  return found || api("POST", `/accounts/${accountId}/r2/buckets`, {
    name: expected.r2,
    locationHint: "wnam"
  });
}

async function ensureKV() {
  const list = await api("GET", `/accounts/${accountId}/storage/kv/namespaces`);
  const found = list.find((namespace) => namespace.title === expected.kv);
  return found || api("POST", `/accounts/${accountId}/storage/kv/namespaces`, {
    title: expected.kv
  });
}

async function ensureQueue(name) {
  const list = await api("GET", `/accounts/${accountId}/queues`);
  const queues = Array.isArray(list?.queues) ? list.queues : list;
  const found = queues.find((queue) => queue.queue_name === name);
  return found || api("POST", `/accounts/${accountId}/queues`, {
    queue_name: name
  });
}

requireTokenOrConfigured();

const resources = {
  d1: await ensureD1(),
  r2: await ensureR2(),
  kv: await ensureKV(),
  queue: await ensureQueue(expected.queue),
  dlq: await ensureQueue(expected.dlq)
};

console.log(JSON.stringify(resources, null, 2));

