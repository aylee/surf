import assert from "node:assert/strict";
import test from "node:test";
import { enqueueAndWaitForRemoteIngest } from "../lib/remote-ingest.mjs";

const baseUrl = "https://surf.example";
const requestedAt = "2026-08-03T01:00:00.000Z";
const ingestId = "ingest-test-id";
const spot = { id: "test-break", timezone: "America/Los_Angeles" };

function pendingResponse(interval) {
  return Response.json(
    {
      error: "forecast_temporarily_unavailable",
      message: "Forecast data is being refreshed. Please retry shortly.",
      retryable: true,
      spotId: spot.id,
      interval
    },
    { status: 503 }
  );
}

test("remote ingest enqueues work and waits for every interval to publish a fresh read model", async () => {
  let clock = Date.parse(requestedAt);
  const forecastRequests = new Map();
  const authorizationHeaders = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ingest/once") {
      authorizationHeaders.push(init.headers?.Authorization);
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt, region: "norcal" },
        { status: 202 }
      );
    }
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === `/api/forecast/${spot.id}`) {
      const interval = url.searchParams.get("interval");
      const requests = (forecastRequests.get(interval) ?? 0) + 1;
      forecastRequests.set(interval, requests);
      if (interval === "3h" && requests === 1) return pendingResponse(interval);
      const materializedAt = interval === "1h"
        ? "2026-08-03T01:00:30.000Z"
        : "2026-08-03T01:01:00.000Z";
      return new Response("{}", {
        headers: {
          "X-Surf-Forecast-Generated-At": requestedAt,
          "X-Surf-Forecast-Materialized-At": materializedAt,
          "X-Surf-Ingest-Id": ingestId
        }
      });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    pollIntervalMs: 5,
    timeoutMs: 20
  });

  assert.deepEqual(authorizationHeaders, ["Bearer secret-token"]);
  assert.equal(result.status, "published");
  assert.equal(result.ingestId, ingestId);
  assert.equal(result.attempts, 2);
  assert.equal(result.spots, 1);
  assert.equal(result.forecastReadModels, 2);
  assert.equal(result.materializedAt, "2026-08-03T01:01:00.000Z");
  assert.deepEqual(Object.fromEntries(forecastRequests), { "3h": 2, "1h": 1 });
});

test("remote ingest polling is bounded and names unpublished read models", async () => {
  let clock = Date.parse(requestedAt);
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt, region: "norcal" },
        { status: 202 }
      );
    }
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === `/api/forecast/${spot.id}`) {
      return pendingResponse(url.searchParams.get("interval"));
    }
    return new Response("not found", { status: 404 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      pollIntervalMs: 5,
      timeoutMs: 10
    }),
    /pending: test-break:3h, test-break:1h/
  );
});

test("remote ingest ignores fresh read models from a different ingest", async () => {
  let clock = Date.parse(requestedAt);
  let forecastRequests = 0;
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt, region: "norcal" },
        { status: 202 }
      );
    }
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === `/api/forecast/${spot.id}`) {
      forecastRequests += 1;
      const wrongIngest = forecastRequests <= 2;
      return new Response("{}", {
        headers: {
          "X-Surf-Forecast-Generated-At": "2026-08-03T01:05:00.000Z",
          "X-Surf-Forecast-Materialized-At": "2026-08-03T01:05:30.000Z",
          "X-Surf-Ingest-Id": wrongIngest ? "different-ingest" : ingestId
        }
      });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    pollIntervalMs: 5,
    timeoutMs: 20
  });

  assert.equal(result.status, "published");
  assert.equal(result.ingestId, ingestId);
  assert.equal(result.attempts, 2);
  assert.equal(forecastRequests, 4);
});
