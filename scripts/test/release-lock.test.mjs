import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { acquireReleaseLock } from "../lib/release-lock.mjs";

const targetGitSha = "a".repeat(40);
const ownerIdentity = "1".repeat(64);

function fixture(t) {
  const root = resolve(mkdtempSync(join(tmpdir(), "surf-release-lock-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("one owner holds and exactly releases the private lock", (t) => {
  const root = fixture(t);
  const lock = acquireReleaseLock({
    stateDirectory: root,
    targetGitSha,
    pid: 123,
    processGroupId: 123,
    processIdentity: () => ownerIdentity,
    now: () => new Date("2026-08-15T00:00:00.000Z"),
    signal() {
      const error = new Error("dead");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(existsSync(lock.path), true);
  assert.doesNotMatch(readFileSync(lock.path, "utf8"), /token|secret/i);
  lock.release();
  assert.equal(existsSync(lock.path), false);
});

test("a live owner blocks a concurrent production release", (t) => {
  const root = fixture(t);
  const first = acquireReleaseLock({
    stateDirectory: root,
    targetGitSha,
    pid: 123,
    processGroupId: 123,
    processIdentity: () => ownerIdentity,
    signal(target) {
      if (target !== 123 && target !== -123) throw new Error("unexpected target");
    }
  });
  assert.throws(
    () =>
      acquireReleaseLock({
        stateDirectory: root,
        targetGitSha,
        pid: 456,
        processGroupId: 456,
        processIdentity: () => "2".repeat(64),
        signal() {}
      }),
    /Another production release/
  );
  first.release();
});

test("a dead owner's lock is retained and recovered", (t) => {
  const root = fixture(t);
  acquireReleaseLock({
    stateDirectory: root,
    targetGitSha,
    pid: 123,
    processGroupId: 123,
    processIdentity: () => ownerIdentity,
    now: () => new Date("2026-08-15T00:00:00.000Z"),
    signal() {}
  });
  const recovered = acquireReleaseLock({
    stateDirectory: root,
    targetGitSha,
    pid: 456,
    processGroupId: 456,
    processIdentity(pid) {
      return pid === 456 ? "2".repeat(64) : null;
    },
    now: () => new Date("2026-08-15T00:01:00.000Z"),
    signal(pid) {
      if (pid === 123 || pid === -123) {
        const error = new Error("dead");
        error.code = "ESRCH";
        throw error;
      }
    }
  });
  const stale = readdirSync(join(root, "stale-locks"));
  assert.equal(stale.length, 1);
  assert.match(readFileSync(join(root, "stale-locks", stale[0]), "utf8"), /"pid":123/);
  recovered.release();
});

test("a dead leader cannot be reclaimed while an orphaned mutation group lives", (t) => {
  const root = fixture(t);
  acquireReleaseLock({
    stateDirectory: root,
    targetGitSha,
    pid: 123,
    processGroupId: 123,
    processIdentity: () => ownerIdentity,
    signal() {}
  });

  assert.throws(
    () =>
      acquireReleaseLock({
        stateDirectory: root,
        targetGitSha,
        pid: 456,
        processGroupId: 456,
        processIdentity(pid) {
          return pid === 456 ? "2".repeat(64) : null;
        },
        signal(target) {
          if (target === 123) {
            const error = new Error("dead leader");
            error.code = "ESRCH";
            throw error;
          }
          if (target === -123 || target === 456 || target === -456) return;
          throw new Error("unexpected target");
        }
      }),
    /mutation subprocesses is active/
  );
});

test("PID reuse without the old process group does not permanently wedge recovery", (t) => {
  const root = fixture(t);
  acquireReleaseLock({
    stateDirectory: root,
    targetGitSha,
    pid: 123,
    processGroupId: 123,
    processIdentity: () => ownerIdentity,
    signal() {}
  });
  const replacementIdentity = "3".repeat(64);
  const recovered = acquireReleaseLock({
    stateDirectory: root,
    targetGitSha,
    pid: 456,
    processGroupId: 456,
    processIdentity(pid) {
      return pid === 123 ? replacementIdentity : "2".repeat(64);
    },
    signal(target) {
      if (target === -123) {
        const error = new Error("old group is gone");
        error.code = "ESRCH";
        throw error;
      }
    }
  });
  recovered.release();
});
