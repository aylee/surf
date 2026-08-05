import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUDFLARE_COMMAND_TIMEOUT_MS,
  resolveCloudflareCommandTimeout,
  runPnpm
} from "../lib/cloudflare-commands.mjs";
import { runWranglerPassthrough } from "../wrangler.mjs";

test("shared pnpm boundary times out without exposing captured child output", () => {
  const secret = "timeout-secret-must-not-escape";
  const childCode =
    "process.stderr.write(process.env.SURF_TIMEOUT_TEST_SECRET); setTimeout(() => {}, 1000)";
  const logged = [];
  const originalLog = console.log;
  let caught;
  const startedAt = Date.now();
  console.log = (...args) => logged.push(args.join(" "));
  try {
    runPnpm(["exec", process.execPath, "-e", childCode], {
      capture: true,
      echo: false,
      timeoutMs: 100,
      env: { SURF_TIMEOUT_TEST_SECRET: secret }
    });
  } catch (error) {
    caught = error;
  } finally {
    console.log = originalLog;
  }

  assert.equal(caught?.name, "TimeoutError");
  assert.match(caught?.message ?? "", /exceeded its 100ms timeout/);
  assert.doesNotMatch(caught?.message ?? "", new RegExp(secret));
  assert.doesNotMatch(logged.join("\n"), new RegExp(secret));
  assert.ok(Date.now() - startedAt < 5_000, "timeout boundary should return promptly");
});

test("shared pnpm boundary rejects invalid timeout configuration before spawning", () => {
  for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => runPnpm(["--version"], { timeoutMs }),
      /positive integer in milliseconds/
    );
  }
});

test("generic Wrangler passthrough makes only exact tail explicitly unbounded", () => {
  const calls = [];
  const runner = (args, options) => calls.push({ args, options });

  runWranglerPassthrough(["--", "tail", "--format", "json"], runner);
  runWranglerPassthrough(["deployments", "status", "--json"], runner);
  runWranglerPassthrough(["versions", "list"], runner);

  assert.deepEqual(calls, [
    {
      args: ["tail", "--format", "json"],
      options: { timeoutPolicy: "unbounded" }
    },
    {
      args: ["deployments", "status", "--json"],
      options: {}
    },
    { args: ["versions", "list"], options: {} }
  ]);
  assert.equal(
    resolveCloudflareCommandTimeout(calls[0].options),
    undefined
  );
  assert.equal(
    resolveCloudflareCommandTimeout(calls[1].options),
    CLOUDFLARE_COMMAND_TIMEOUT_MS
  );
  assert.ok(Number.isFinite(CLOUDFLARE_COMMAND_TIMEOUT_MS));
});

test("unbounded timeout policy rejects an ambiguous millisecond limit", () => {
  assert.throws(
    () =>
      resolveCloudflareCommandTimeout({
        timeoutPolicy: "unbounded",
        timeoutMs: 100
      }),
    /cannot also configure timeoutMs/
  );
  assert.throws(
    () => resolveCloudflareCommandTimeout({ timeoutPolicy: "forever" }),
    /must be finite or unbounded/
  );
});
