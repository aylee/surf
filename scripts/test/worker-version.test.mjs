import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
  SURF_WORKER_VERSION_HEADER,
  responseWorkerVersion,
  waitForWorkerVersion,
  workerVersionRequestHeaders
} from "../lib/worker-version.mjs";

const expectedVersionId = "11111111-2222-4333-8444-555555555555";
const otherVersionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const expectedWorkerName = "surf";

function versionResponse(versionId = expectedVersionId, status = 200) {
  return new Response(status === 200 ? '{"status":"ok"}' : "unavailable", {
    status,
    headers: versionId ? { [SURF_WORKER_VERSION_HEADER]: versionId } : {}
  });
}

function fakeTime() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    }
  };
}

test("version request headers preserve caller headers and select the exact Worker version", () => {
  const baseHeaders = new Headers({ Accept: "application/json" });
  const headers = workerVersionRequestHeaders({
    expectedVersionId,
    expectedWorkerName,
    headers: baseHeaders
  });

  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(
    headers.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER),
    `${expectedWorkerName}="${expectedVersionId}"`
  );
  assert.equal(baseHeaders.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER), null);
  assert.throws(
    () => workerVersionRequestHeaders({
      expectedVersionId: "not-a-version-id",
      expectedWorkerName
    }),
    /must be a UUID/
  );
  assert.throws(
    () => workerVersionRequestHeaders({
      expectedVersionId,
      expectedWorkerName: "Not Structured"
    }),
    /must start with a lowercase letter/
  );
  assert.throws(
    () => workerVersionRequestHeaders({ expectedVersionId }),
    /must be provided together/
  );
  assert.throws(
    () => workerVersionRequestHeaders({ expectedWorkerName }),
    /must be provided together/
  );
});

test("version request headers can validate identity without overriding ordinary routing", () => {
  const headers = workerVersionRequestHeaders({
    expectedVersionId,
    expectedWorkerName,
    override: false,
    headers: { Accept: "application/json" }
  });
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER), null);
});

test("exact override preserves an active instance Worker name", () => {
  const headers = workerVersionRequestHeaders({
    expectedVersionId,
    expectedWorkerName: "friends-surf2"
  });
  assert.equal(
    headers.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER),
    `friends-surf2="${expectedVersionId}"`
  );
});

test("response version extraction trims the Worker-owned response header", () => {
  assert.equal(
    responseWorkerVersion(
      new Response(null, {
        headers: { [SURF_WORKER_VERSION_HEADER]: ` ${expectedVersionId} ` }
      })
    ),
    expectedVersionId
  );
  assert.equal(responseWorkerVersion(new Response()), null);
});

test("readiness requires exact override reachability then three unpinned responses", async () => {
  const { now, sleep } = fakeTime();
  const responses = [
    versionResponse(expectedVersionId),
    versionResponse(otherVersionId),
    versionResponse(expectedVersionId),
    versionResponse(expectedVersionId),
    versionResponse(expectedVersionId)
  ];
  const requests = [];
  const result = await waitForWorkerVersion({
    baseUrl: "https://surf.example/",
    expectedVersionId,
    expectedWorkerName,
    fetcher: async (input, init) => {
      requests.push({ input: String(input), init });
      return responses.shift();
    },
    now,
    sleep,
    pollIntervalMs: 5,
    timeoutMs: 30,
    requestTimeoutMs: 10
  });

  assert.equal(result.status, "ready");
  assert.equal(result.workerVersion, expectedVersionId);
  assert.equal(result.workerName, expectedWorkerName);
  assert.equal(result.attempts, 5);
  assert.equal(result.overrideReachable, true);
  assert.equal(result.consecutiveReady, 3);
  assert.equal(requests.length, 5);
  for (const [index, request] of requests.entries()) {
    const url = new URL(request.input);
    assert.equal(url.origin + url.pathname, "https://surf.example/api/health");
    assert.equal(url.searchParams.get("surf_rollout_probe"), expectedVersionId);
    assert.equal(url.searchParams.get("phase"), index === 0 ? "override" : "default");
    assert.equal(url.searchParams.get("attempt"), String(index + 1));
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.cache, "no-store");
    assert.equal(request.init.headers.get("Cache-Control"), "no-store");
    assert.equal(
      request.init.headers.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER),
      index === 0 ? `${expectedWorkerName}="${expectedVersionId}"` : null
    );
    assert.equal(request.init.signal instanceof AbortSignal, true);
  }
});

test("readiness retries bounded transient statuses and network failures", async () => {
  const { now, sleep } = fakeTime();
  const outcomes = [
    new TypeError("network reset"),
    versionResponse(null, 408),
    versionResponse(null, 429),
    versionResponse(null, 503),
    versionResponse(),
    versionResponse(),
    versionResponse(),
    versionResponse()
  ];
  const result = await waitForWorkerVersion({
    baseUrl: "https://surf.example",
    expectedVersionId,
    expectedWorkerName,
    fetcher: async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    now,
    sleep,
    pollIntervalMs: 1,
    timeoutMs: 10,
    requestTimeoutMs: 5
  });

  assert.equal(result.attempts, 8);
});

test("readiness times out individual requests and keeps polling", async () => {
  const { now, sleep } = fakeTime();
  const signals = [];
  let requests = 0;
  const result = await waitForWorkerVersion({
    baseUrl: "https://surf.example",
    expectedVersionId,
    expectedWorkerName,
    fetcher: async (_input, init) => {
      requests += 1;
      signals.push(init.signal);
      if (requests === 1) return new Promise(() => {});
      return versionResponse();
    },
    now,
    sleep,
    pollIntervalMs: 1,
    timeoutMs: 10,
    requestTimeoutMs: 1
  });

  assert.equal(result.attempts, 5);
  assert.equal(signals[0].aborted, true);
});

test("readiness never waits for response-body cancellation", async () => {
  let cancellationCalls = 0;
  const stalledCancellation = () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancellationCalls += 1;
          return new Promise(() => {});
        }
      }),
      { headers: { [SURF_WORKER_VERSION_HEADER]: expectedVersionId } }
    );

  const result = await Promise.race([
    waitForWorkerVersion({
      baseUrl: "https://surf.example",
      expectedVersionId,
      expectedWorkerName,
      fetcher: async () => stalledCancellation(),
      consecutiveReady: 1,
      pollIntervalMs: 1,
      timeoutMs: 10,
      requestTimeoutMs: 5
    }),
    new Promise((resolve) => setTimeout(() => resolve("stalled"), 50))
  ]);

  assert.notEqual(result, "stalled");
  assert.equal(result.status, "ready");
  assert.equal(cancellationCalls, 2);
});

test("readiness fails fast for non-retryable health statuses", async () => {
  const { now, sleep } = fakeTime();
  let attempts = 0;
  await assert.rejects(
    waitForWorkerVersion({
      baseUrl: "https://surf.example",
      expectedVersionId,
      expectedWorkerName,
      fetcher: async () => {
        attempts += 1;
        return new Response("unauthorized", { status: 401 });
      },
      now,
      sleep,
      pollIntervalMs: 1,
      timeoutMs: 10,
      requestTimeoutMs: 5
    }),
    /failed fast.*HTTP 401/
  );
  assert.equal(attempts, 1);
});

test("readiness rejects an ambiguous non-origin deployment target", async () => {
  await assert.rejects(
    waitForWorkerVersion({
      baseUrl: "https://surf.example/unrelated-path",
      expectedVersionId,
      expectedWorkerName,
      fetcher: async () => versionResponse()
    }),
    /must be a bare HTTP\(S\) origin/
  );
});

test("readiness timeout reports the last observed version state", async () => {
  const { now, sleep } = fakeTime();
  await assert.rejects(
    waitForWorkerVersion({
      baseUrl: "https://surf.example",
      expectedVersionId,
      expectedWorkerName,
      fetcher: async () => versionResponse(otherVersionId),
      now,
      sleep,
      pollIntervalMs: 2,
      timeoutMs: 5,
      requestTimeoutMs: 3
    }),
    (error) => {
      assert.match(error.message, /within 5ms after 3 attempt\(s\)/);
      assert.match(error.message, new RegExp(otherVersionId));
      assert.match(error.message, new RegExp(expectedVersionId));
      return true;
    }
  );
});

test("readiness rejects a callable version that default traffic has not adopted", async () => {
  const { now, sleep } = fakeTime();
  const requests = [];
  await assert.rejects(
    waitForWorkerVersion({
      baseUrl: "https://surf.example",
      expectedVersionId,
      expectedWorkerName,
      fetcher: async (input, init) => {
        requests.push({ input: String(input), headers: new Headers(init.headers) });
        return versionResponse(requests.length === 1 ? expectedVersionId : otherVersionId);
      },
      now,
      sleep,
      pollIntervalMs: 2,
      timeoutMs: 7,
      requestTimeoutMs: 3
    }),
    /default route returned Worker version/
  );

  assert.ok(requests.length >= 2);
  assert.equal(
    requests[0].headers.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER),
    `${expectedWorkerName}="${expectedVersionId}"`
  );
  for (const request of requests.slice(1)) {
    assert.equal(
      request.headers.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER),
      null
    );
  }
});
