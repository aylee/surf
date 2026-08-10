import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUDFLARE_COMMAND_TIMEOUT_MS,
  cloudflareApiErrorCodes,
  hasCloudflareApiErrorCode,
  resolveCloudflareCommandTimeout,
  runPnpm
} from "../lib/cloudflare-commands.mjs";
import {
  isSecretlessLocalWranglerInvocation,
  runWranglerPassthrough
} from "../wrangler.mjs";

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

  const prepared = [];
  const prepare = () => prepared.push(true);
  runWranglerPassthrough(["--", "tail", "--format", "json"], runner, prepare);
  runWranglerPassthrough(["deployments", "status", "--json"], runner, prepare);
  runWranglerPassthrough(["versions", "list"], runner, prepare);

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
  assert.equal(prepared.length, 3);
});

test("generic Wrangler passthrough never spawns when activation pinning fails", () => {
  let spawned = false;
  assert.throws(
    () =>
      runWranglerPassthrough(
        ["deployments", "status", "--json"],
        () => {
          spawned = true;
        },
        () => {
          throw new Error("Wrangler config snapshot SHA-256 does not match activation");
        }
      ),
    /SHA-256 does not match activation/
  );
  assert.equal(spawned, false);
});

test("only exact local Wrangler --version bypasses activation pinning", () => {
  const calls = [];
  let prepared = 0;
  runWranglerPassthrough(
    ["--", "--version"],
    (args, options) => calls.push({ args, options }),
    () => {
      prepared += 1;
    }
  );

  assert.equal(isSecretlessLocalWranglerInvocation(["--version"]), true);
  assert.equal(prepared, 0);
  assert.deepEqual(calls, [{ args: ["--version"], options: {} }]);

  for (const args of [
    ["version"],
    ["--version", "--help"],
    ["--help"],
    ["whoami", "--help"]
  ]) {
    let spawned = false;
    assert.equal(isSecretlessLocalWranglerInvocation(args), false);
    assert.throws(
      () =>
        runWranglerPassthrough(
          args,
          () => {
            spawned = true;
          },
          () => {
            throw new Error("activation snapshot required");
          }
        ),
      /activation snapshot required/
    );
    assert.equal(spawned, false);
  }
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

test("failed commands expose only structured Cloudflare API codes for classification", () => {
  assert.deepEqual(
    cloudflareApiErrorCodes(
      "custom CPU limits require another plan [code: 100328]\nrepeat [code: 100328]"
    ),
    [100328]
  );
  assert.deepEqual(cloudflareApiErrorCodes("ordinary failure 100328"), []);

  const classified = new Error("bounded command failure");
  Object.defineProperty(classified, "cloudflareApiErrorCodes", {
    value: [100328],
    enumerable: false
  });
  const wrapped = new Error("staging failed", { cause: classified });
  assert.equal(hasCloudflareApiErrorCode(wrapped, 100328), true);
  assert.equal(hasCloudflareApiErrorCode(wrapped, 1102), false);
  assert.deepEqual(Object.keys(classified), []);
});
