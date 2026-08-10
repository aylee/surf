import assert from "node:assert/strict";
import test from "node:test";
import {
  UNSUPPORTED_CUSTOM_CPU_LIMIT_CODE,
  workerVersionUploadFailure
} from "../lib/worker-release-errors.mjs";

function commandError(codes) {
  const error = new Error("pnpm command failed");
  Object.defineProperty(error, "cloudflareApiErrorCodes", {
    value: codes,
    enumerable: false
  });
  return error;
}

test("100328 is classified specifically without claiming Queues were untouched", () => {
  const cause = commandError([UNSUPPORTED_CUSTOM_CPU_LIMIT_CODE]);
  const error = workerVersionUploadFailure(cause);
  assert.equal(error.cause, cause);
  assert.match(error.message, /2,000 ms CPU limit \(100328\)/);
  assert.match(error.message, /Queue reconciliation may already have created/);
  assert.match(error.message, /has not run any D1 migration or seed/);
  assert.match(error.message, /Workers Free is unsupported/);
});

test("non-plan upload failures remain generic and make only the D1 guarantee", () => {
  const cause = commandError([]);
  const error = workerVersionUploadFailure(cause);
  assert.equal(error.cause, cause);
  assert.doesNotMatch(error.message, /Workers Free/);
  assert.match(error.message, /after configured Queue reconciliation/);
  assert.match(error.message, /before any D1 migration or seed/);
});
