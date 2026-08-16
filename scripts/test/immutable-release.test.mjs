import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertAppendOnlyMigrationHistory,
  listChangedReleasePaths,
  prepareImmutableRelease,
  resolveGitRevision,
  validateImmutableRelease
} from "../lib/immutable-release.mjs";

const LOCK_OWNER_IDENTITY = "1".repeat(64);
const PREPARER_IDENTITY = "2".repeat(64);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repositoryFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "surf-release-repo-")));
  const repositoryPath = join(root, "source");
  const releasesDirectory = join(root, "releases");
  mkdirSync(repositoryPath);
  mkdirSync(releasesDirectory, { mode: 0o700 });
  git(repositoryPath, "init", "--quiet");
  git(repositoryPath, "config", "user.email", "release-test@example.test");
  git(repositoryPath, "config", "user.name", "Release Test");
  writeFileSync(join(repositoryPath, "package.json"), '{"private":true}\n');
  git(repositoryPath, "add", "package.json");
  git(repositoryPath, "commit", "--quiet", "-m", "fixture");
  return {
    root,
    repositoryPath,
    releasesDirectory,
    sha: git(repositoryPath, "rev-parse", "HEAD")
  };
}

function prepare(fixture, overrides = {}) {
  return prepareImmutableRelease({
    ...fixture,
    targetSha: fixture.sha,
    install: false,
    pid: 456,
    processIdentity(pid) {
      if (pid === 456) return PREPARER_IDENTITY;
      return null;
    },
    ...overrides
  });
}

function writePreparationLock(
  fixture,
  {
    pid = 123,
    processIdentity = LOCK_OWNER_IDENTITY,
    startedAt = "2026-08-15T00:00:00.000Z"
  } = {}
) {
  const locksPath = join(fixture.releasesDirectory, ".locks");
  const lockPath = join(locksPath, fixture.sha);
  mkdirSync(locksPath, { recursive: true, mode: 0o700 });
  writeFileSync(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid,
      processIdentity,
      startedAt,
      targetGitSha: fixture.sha
    })}\n`,
    { mode: 0o600 }
  );
  chmodSync(lockPath, 0o600);
  return lockPath;
}

test("prepares and safely reuses a clean detached exact-SHA worktree", () => {
  const fixture = repositoryFixture();
  const first = prepareImmutableRelease({
    ...fixture,
    targetSha: fixture.sha,
    install: false
  });
  assert.equal(first.reused, false);
  assert.equal(first.sourceRevision, fixture.sha);
  assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.deepEqual(validateImmutableRelease(first.path, fixture.sha), {
    path: first.path,
    sourceRevision: fixture.sha
  });

  const second = prepareImmutableRelease({
    ...fixture,
    targetSha: fixture.sha,
    install: false
  });
  assert.equal(second.reused, true);
  assert.equal(second.path, first.path);
});

test("rejects dirty, attached, wrong-SHA, and symlink release paths", () => {
  const fixture = repositoryFixture();
  const release = prepare(fixture);
  writeFileSync(join(release.path, "untracked"), "dirty\n");
  assert.throws(() => validateImmutableRelease(release.path, fixture.sha), /must be clean/);
  assert.throws(() => validateImmutableRelease(release.path, "b".repeat(40)), /does not match/);

  const alias = join(fixture.root, "release-alias");
  symlinkSync(release.path, alias);
  assert.throws(() => validateImmutableRelease(alias, fixture.sha), /non-symlink/);
  assert.throws(
    () => validateImmutableRelease(fixture.repositoryPath, fixture.sha),
    /detached HEAD/
  );
});

test("a live exact owner blocks preparation and retains its lock", () => {
  const fixture = repositoryFixture();
  const lockPath = writePreparationLock(fixture);
  const original = readFileSync(lockPath, "utf8");
  assert.throws(
    () =>
      prepare(fixture, {
        processIdentity(pid) {
          return pid === 123 ? LOCK_OWNER_IDENTITY : PREPARER_IDENTITY;
        },
        signal(pid) {
          assert.equal(pid, 123);
        }
      }),
    /already locked/
  );
  assert.equal(readFileSync(lockPath, "utf8"), original);
  assert.equal(
    git(fixture.repositoryPath, "worktree", "list", "--porcelain").includes(
      fixture.sha
    ),
    true
  );
});

test("recovers a dead owner's lock and retains the stale ownership record", () => {
  const fixture = repositoryFixture();
  const lockPath = writePreparationLock(fixture);
  const release = prepare(fixture, {
    now: () => new Date("2026-08-15T00:01:00.000Z"),
    signal(pid) {
      assert.equal(pid, 123);
      const error = new Error("dead owner");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(release.reused, false);
  assert.equal(existsSync(lockPath), false);
  const stalePath = join(fixture.releasesDirectory, ".locks", "stale");
  const stale = readdirSync(stalePath);
  assert.equal(stale.length, 1);
  assert.match(readFileSync(join(stalePath, stale[0]), "utf8"), /"pid":123/);
});

test("an interrupted unpublished candidate cannot wedge preparation", () => {
  const fixture = repositoryFixture();
  const pendingPath = join(
    fixture.releasesDirectory,
    ".locks",
    "pending"
  );
  mkdirSync(pendingPath, { recursive: true, mode: 0o700 });
  const interruptedPath = join(pendingPath, "interrupted-owner.json");
  writeFileSync(interruptedPath, "{", { mode: 0o600 });

  const release = prepare(fixture);
  assert.equal(release.reused, false);
  assert.equal(existsSync(interruptedPath), true);
  assert.equal(
    existsSync(join(fixture.releasesDirectory, ".locks", fixture.sha)),
    false
  );
});

test("recovers from PID reuse only when the exact prior identity is gone", () => {
  const fixture = repositoryFixture();
  const lockPath = writePreparationLock(fixture);
  const release = prepare(fixture, {
    processIdentity(pid) {
      return pid === 123 ? "3".repeat(64) : PREPARER_IDENTITY;
    },
    signal(pid) {
      assert.equal(pid, 123);
    }
  });

  assert.equal(release.reused, false);
  assert.equal(existsSync(lockPath), false);
  assert.equal(
    readdirSync(join(fixture.releasesDirectory, ".locks", "stale")).length,
    1
  );
});

test("fails closed when a live lock owner cannot be identified", () => {
  const fixture = repositoryFixture();
  const lockPath = writePreparationLock(fixture);
  const original = readFileSync(lockPath, "utf8");
  assert.throws(
    () =>
      prepare(fixture, {
        signal() {},
        processIdentity(pid) {
          return pid === 456 ? PREPARER_IDENTITY : null;
        }
      }),
    /identity could not be verified/
  );
  assert.equal(readFileSync(lockPath, "utf8"), original);
});

test("fails closed on a malformed preparation lock and never removes it", () => {
  const fixture = repositoryFixture();
  const lockPath = join(fixture.releasesDirectory, ".locks", fixture.sha);
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  assert.throws(
    () => prepare(fixture),
    /mode-0600 regular file/
  );
  assert.equal(existsSync(lockPath), true);
});

test("resolves a named revision to an exact commit", () => {
  const fixture = repositoryFixture();
  assert.equal(resolveGitRevision(fixture.repositoryPath, "HEAD"), fixture.sha);
  assert.throws(() => resolveGitRevision(fixture.repositoryPath, "--help"), /unsafe/);
});

test("changed paths include deletions and both sides of renames", () => {
  const fixture = repositoryFixture();
  const sourcePath = join(fixture.repositoryPath, "scripts", "runtime.mjs");
  const targetPath = join(fixture.repositoryPath, "apps", "web", "src", "App.tsx");
  mkdirSync(join(fixture.repositoryPath, "scripts"));
  mkdirSync(join(fixture.repositoryPath, "apps", "web", "src"), {
    recursive: true
  });
  writeFileSync(sourcePath, "export const runtime = true;\n");
  git(fixture.repositoryPath, "add", "scripts/runtime.mjs");
  git(fixture.repositoryPath, "commit", "--quiet", "-m", "add runtime");
  const base = git(fixture.repositoryPath, "rev-parse", "HEAD");

  renameSync(sourcePath, targetPath);
  git(fixture.repositoryPath, "add", "-A");
  git(fixture.repositoryPath, "commit", "--quiet", "-m", "move runtime");
  const renamed = git(fixture.repositoryPath, "rev-parse", "HEAD");
  assert.deepEqual(
    listChangedReleasePaths(fixture.repositoryPath, base, renamed),
    ["apps/web/src/App.tsx", "scripts/runtime.mjs"]
  );

  unlinkSync(targetPath);
  git(fixture.repositoryPath, "add", "-A");
  git(fixture.repositoryPath, "commit", "--quiet", "-m", "delete runtime");
  const deleted = git(fixture.repositoryPath, "rev-parse", "HEAD");
  assert.deepEqual(
    listChangedReleasePaths(fixture.repositoryPath, renamed, deleted),
    ["apps/web/src/App.tsx"]
  );
});

test("migration history permits only new append-only files", () => {
  const fixture = repositoryFixture();
  const migrations = join(fixture.repositoryPath, "packages", "db", "migrations");
  mkdirSync(migrations, { recursive: true });
  const firstPath = join(migrations, "0000_initial.sql");
  writeFileSync(firstPath, "create table one(id integer);\n");
  git(fixture.repositoryPath, "add", "packages/db/migrations/0000_initial.sql");
  git(fixture.repositoryPath, "commit", "--quiet", "-m", "initial migration");
  const base = git(fixture.repositoryPath, "rev-parse", "HEAD");

  writeFileSync(join(migrations, "0001_next.sql"), "create table two(id integer);\n");
  git(fixture.repositoryPath, "add", "packages/db/migrations/0001_next.sql");
  git(fixture.repositoryPath, "commit", "--quiet", "-m", "append migration");
  const appended = git(fixture.repositoryPath, "rev-parse", "HEAD");
  assert.equal(
    assertAppendOnlyMigrationHistory(fixture.repositoryPath, base, appended),
    true
  );

  writeFileSync(firstPath, "create table changed(id text);\n");
  git(fixture.repositoryPath, "add", "packages/db/migrations/0000_initial.sql");
  git(fixture.repositoryPath, "commit", "--quiet", "-m", "rewrite migration");
  const rewritten = git(fixture.repositoryPath, "rev-parse", "HEAD");
  assert.throws(
    () =>
      assertAppendOnlyMigrationHistory(
        fixture.repositoryPath,
        appended,
        rewritten
      ),
    /append-only/
  );
});
