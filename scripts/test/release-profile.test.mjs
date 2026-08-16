import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertProductionProfile,
  readProductionProfile
} from "../lib/release-profile.mjs";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "surf-release-profile-")));
  const repositoryPath = join(root, "repo");
  const serviceRoot = join(root, "service");
  mkdirSync(repositoryPath);
  mkdirSync(serviceRoot);
  const privateFile = (name, contents = "fixture\n") => {
    const path = join(serviceRoot, name);
    writeFileSync(path, contents, { mode: 0o600 });
    return path;
  };
  const profile = {
    schemaVersion: 1,
    repositoryPath,
    serviceRoot,
    releasesDirectory: join(serviceRoot, "releases"),
    stateDirectory: join(serviceRoot, "release-state"),
    wranglerSourcePath: privateFile("wrangler.jsonc", "{}\n"),
    workerSecretsSourcePath: privateFile("worker.env"),
    runnerEnvironmentPath: privateFile("runner.env"),
    operatorEnvironmentPath: privateFile("operator.env"),
    customOrigin: "https://surf.example",
    workersDevOrigin: "https://surf.example-account.workers.dev"
  };
  return { root, profile, privateFile };
}

test("reads a strict external mode-0600 profile without secret values", () => {
  const { profile, privateFile } = fixture();
  const path = privateFile("profile.json", `${JSON.stringify(profile)}\n`);
  const result = readProductionProfile(path);
  assert.equal(result.path, path);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.profile, profile);
  assert.equal(JSON.stringify(result).includes("fixture"), false);
});

test("rejects permissive or symlinked profiles and private inputs", () => {
  const { root, profile, privateFile } = fixture();
  const path = privateFile("profile.json", `${JSON.stringify(profile)}\n`);
  chmodSync(path, 0o644);
  assert.throws(() => readProductionProfile(path), /mode 0600/);
  chmodSync(path, 0o600);
  const alias = join(root, "profile-link.json");
  symlinkSync(path, alias);
  assert.throws(() => readProductionProfile(alias), /non-symlink/);

  const sourceAlias = join(root, "worker-source-link.env");
  symlinkSync(profile.workerSecretsSourcePath, sourceAlias);
  assert.throws(
    () => assertProductionProfile({ ...profile, workerSecretsSourcePath: sourceAlias }),
    /non-symlink/
  );
});

test("rejects oversized profiles before parsing them", () => {
  const { root, privateFile } = fixture();
  try {
    const path = privateFile(
      "oversized-profile.json",
      " ".repeat(256 * 1024 + 1)
    );
    assert.throws(() => readProductionProfile(path), /bounded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects path escape, overlapping roots, duplicate private roles, and unsafe origins", () => {
  const { root, profile } = fixture();
  assert.throws(
    () => assertProductionProfile({ ...profile, stateDirectory: join(root, "elsewhere") }),
    /inside serviceRoot/
  );
  assert.throws(
    () => assertProductionProfile({ ...profile, serviceRoot: profile.repositoryPath }),
    /disjoint/
  );
  assert.throws(
    () =>
      assertProductionProfile({
        ...profile,
        operatorEnvironmentPath: profile.runnerEnvironmentPath
      }),
    /must be distinct/
  );
  assert.throws(
    () => assertProductionProfile({ ...profile, customOrigin: "http://surf.example" }),
    /bare HTTPS/
  );
  assert.throws(
    () => assertProductionProfile({ ...profile, workersDevOrigin: "https://example.com" }),
    /workers.dev/
  );
});

test("rejects unknown fields so secrets cannot be smuggled into the profile", () => {
  const { profile } = fixture();
  assert.throws(
    () => assertProductionProfile({ ...profile, apiToken: "must-not-live-here" }),
    /must contain exactly/
  );
});
