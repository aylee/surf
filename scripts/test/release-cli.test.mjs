import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedReleasePreview,
  parseReleaseProdArguments,
  releaseIdFor
} from "../lib/release-cli.mjs";

test("parses the supported owner interface without downgrade switches", () => {
  assert.deepEqual(parseReleaseProdArguments([]), {
    plan: false,
    yes: false,
    sha: null,
    resume: null,
    fixForward: null,
    forceFull: false
  });
  assert.deepEqual(
    parseReleaseProdArguments(["--yes", "--sha", "a".repeat(40)]),
    {
      plan: false,
      yes: true,
      sha: "a".repeat(40),
      resume: null,
      fixForward: null,
      forceFull: false
    }
  );
  assert.throws(() => parseReleaseProdArguments(["--ui-only"]), /Unknown/);
  assert.throws(() => parseReleaseProdArguments(["--skip-d1"]), /Unknown/);
  assert.throws(() => parseReleaseProdArguments(["--yes"]), /Non-interactive/);
  assert.throws(
    () => parseReleaseProdArguments(["--yes", "--resume", "release-1"]),
    /Non-interactive/
  );
  assert.throws(
    () => parseReleaseProdArguments(["--resume", "one", "--fix-forward", "two"]),
    /mutually exclusive/
  );
});

test("release IDs are stable bounded UTC identities", () => {
  assert.equal(
    releaseIdFor("b".repeat(40), new Date("2026-08-15T22:12:13.456Z")),
    `20260815t221213z-${"b".repeat(12)}`
  );
});

test("preview contains only bounded identifiers and planned mutations", () => {
  assert.deepEqual(
    boundedReleasePreview({
      releaseId: "release-1",
      targetGitSha: "c".repeat(40),
      lane: "assets-only",
      changedPaths: ["apps/web/src/App.tsx"],
      reasonCodes: ["assets_only_verified"],
      mismatchKeys: [],
      predecessorWorkerVersionId: null,
      mutations: ["upload inactive Worker", "activate target at 100%"]
    }).mutations,
    ["upload inactive Worker", "activate target at 100%"]
  );
});
