import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUDFLARE_WORKERS_VERSION_KEY_HEADER,
  SURF_WORKER_VERSION_HEADER,
  responseWorkerVersion,
  waitForWorkerVersion,
  workerVersionRequestHeaders
} from "../lib/worker-version.mjs";

const expectedVersionId = "11111111-2222-4333-8444-555555555555";
const otherVersionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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

test("version request headers preserve caller headers and add Cloudflare affinity", () => {
  const baseHeaders = new Headers({ Accept: "application/json" });
  const headers = workerVersionRequestHeaders(expectedVersionId, baseHeaders);

  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(
    headers.get(CLOUDFLARE_WORKERS_VERSION_KEY_HEADER),
    expectedVersionId
  );
  assert.equal(baseHeaders.get(CLOUDFLARE_WORKERS_VERSION_KEY_HEADER), null);
  assert.throws(
    () => workerVersionRequestHeaders("not-a-version-id"),
    /must be a UUID/
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

test("readiness requires three consecutive exact-version health responses", async () => {
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
  assert.equal(result.attempts, 5);
  assert.equal(result.consecutiveReady, 3);
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(request.input, "https://surf.example/api/health");
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.cache, "no-store");
    assert.equal(request.init.headers.get("Cache-Control"), "no-store");
    assert.equal(
      request.init.headers.get(CLOUDFLARE_WORKERS_VERSION_KEY_HEADER),
      expectedVersionId
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
    versionResponse()
  ];
  const result = await waitForWorkerVersion({
    baseUrl: "https://surf.example",
    expectedVersionId,
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

  assert.equal(result.attempts, 7);
});

test("readiness times out individual requests and keeps polling", async () => {
  const { now, sleep } = fakeTime();
  const signals = [];
  let requests = 0;
  const result = await waitForWorkerVersion({
    baseUrl: "https://surf.example",
    expectedVersionId,
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

  assert.equal(result.attempts, 4);
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
      fetcher: async () => stalledCancellation(),
      consecutiveReady: 1,
      timeoutMs: 10,
      requestTimeoutMs: 5
    }),
    new Promise((resolve) => setTimeout(() => resolve("stalled"), 50))
  ]);

  assert.notEqual(result, "stalled");
  assert.equal(result.status, "ready");
  assert.equal(cancellationCalls, 1);
});

test("readiness fails fast for non-retryable health statuses", async () => {
  const { now, sleep } = fakeTime();
  let attempts = 0;
  await assert.rejects(
    waitForWorkerVersion({
      baseUrl: "https://surf.example",
      expectedVersionId,
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
