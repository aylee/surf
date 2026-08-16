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
    replacePreMutation: null,
    replaceBeforeUpload: null,
    replaceInactiveUpload: null,
    replaceRunnerFailure: null,
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
      replacePreMutation: null,
      replaceBeforeUpload: null,
      replaceInactiveUpload: null,
      replaceRunnerFailure: null,
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
  assert.deepEqual(
    parseReleaseProdArguments([
      "--replace-pre-mutation",
      "failed-release",
      "--yes",
      "--sha",
      "b".repeat(40)
    ]),
    {
      plan: false,
      yes: true,
      sha: "b".repeat(40),
      resume: null,
      fixForward: null,
      replacePreMutation: "failed-release",
      replaceBeforeUpload: null,
      replaceInactiveUpload: null,
      replaceRunnerFailure: null,
      forceFull: false
    }
  );
  assert.throws(
    () =>
      parseReleaseProdArguments([
        "--resume",
        "one",
        "--replace-pre-mutation",
        "two"
      ]),
    /mutually exclusive/
  );
  assert.deepEqual(
    parseReleaseProdArguments([
      "--plan",
      "--replace-before-upload",
      "failed-before-upload"
    ]),
    {
      plan: true,
      yes: false,
      sha: null,
      resume: null,
      fixForward: null,
      replacePreMutation: null,
      replaceBeforeUpload: "failed-before-upload",
      replaceInactiveUpload: null,
      replaceRunnerFailure: null,
      forceFull: false
    }
  );
  assert.throws(
    () =>
      parseReleaseProdArguments([
        "--replace-pre-mutation",
        "one",
        "--replace-before-upload",
        "two"
      ]),
    /mutually exclusive/
  );
  assert.deepEqual(
    parseReleaseProdArguments([
      "--plan",
      "--replace-inactive-upload",
      "failed-inactive-upload"
    ]),
    {
      plan: true,
      yes: false,
      sha: null,
      resume: null,
      fixForward: null,
      replacePreMutation: null,
      replaceBeforeUpload: null,
      replaceInactiveUpload: "failed-inactive-upload",
      replaceRunnerFailure: null,
      forceFull: false
    }
  );
  assert.throws(
    () =>
      parseReleaseProdArguments([
        "--replace-before-upload",
        "one",
        "--replace-inactive-upload",
        "two"
      ]),
    /mutually exclusive/
  );
  assert.deepEqual(
    parseReleaseProdArguments([
      "--plan",
      "--replace-runner-failure",
      "failed-runner-release"
    ]),
    {
      plan: true,
      yes: false,
      sha: null,
      resume: null,
      fixForward: null,
      replacePreMutation: null,
      replaceBeforeUpload: null,
      replaceInactiveUpload: null,
      replaceRunnerFailure: "failed-runner-release",
      forceFull: false
    }
  );
  assert.throws(
    () =>
      parseReleaseProdArguments([
        "--replace-runner-failure",
        "runner-failure",
        "--replace-inactive-upload",
        "upload-failure"
      ]),
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
