#!/usr/bin/env node

import { lstatSync, opendirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readProductionProfile } from "./lib/release-profile.mjs";
import {
  RELEASE_JOURNAL_STATES,
  RELEASE_POINTER_KINDS,
  assertReleaseJournal,
  assertReleaseJournalRevisionHistory,
  assertReleasePointer,
  createReleasePointer,
  fingerprintReleaseJournal
} from "./lib/release-journal.mjs";

function privateJson(path, validator) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("Release status file is not a private regular file");
    }
    if (realpathSync(path) !== path) {
      throw new Error("Release status file must use a canonical path");
    }
    return validator(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const profilePath =
  process.env.SURF_PRODUCTION_PROFILE?.trim() ||
  resolve(homedir(), "Services/surf/production-profile.json");
const { profile } = readProductionProfile(profilePath);
const journalsDirectory = resolve(profile.stateDirectory, "journals");

function validatedJournal(releaseId) {
  const current = privateJson(
    resolve(journalsDirectory, `${releaseId}.json`),
    assertReleaseJournal
  );
  if (!current) return null;
  const revisions = Array.from(
    { length: current.revision + 1 },
    (_unused, revision) =>
      privateJson(
        resolve(
          journalsDirectory,
          `${releaseId}.revisions`,
          `${String(revision).padStart(6, "0")}.json`
        ),
        assertReleaseJournal
      )
  );
  if (revisions.some((revision) => revision === null)) {
    throw new Error(`${releaseId} journal revision history is incomplete`);
  }
  assertReleaseJournalRevisionHistory(current, revisions);

  const pending = privateJson(
    resolve(
      journalsDirectory,
      `${releaseId}.revisions`,
      `${String(current.revision + 1).padStart(6, "0")}.json`
    ),
    assertReleaseJournal
  );
  if (pending !== null) {
    revisions.push(pending);
  }
  const latest = assertReleaseJournalRevisionHistory(
    pending ?? current,
    revisions
  );
  return Object.freeze({ latest, revisions: Object.freeze(revisions) });
}

function journalForPointer(pointer, validated) {
  const matches = validated.revisions.filter(
    (journal) =>
      pointer.journalSha256 === fingerprintReleaseJournal(journal)
  );
  if (matches.length !== 1) {
    throw new Error(`${pointer.kind} pointer does not match its journal history`);
  }
  const journal = matches[0];
  let expected;
  try {
    expected = createReleasePointer(journal, pointer.kind, {
      at: pointer.updatedAt
    });
  } catch {
    throw new Error(`${pointer.kind} pointer does not identify a valid journal state`);
  }
  if (
    pointer.releaseId !== expected.releaseId ||
    pointer.targetGitSha !== expected.targetGitSha ||
    pointer.workerVersionId !== expected.workerVersionId ||
    pointer.journalSha256 !== expected.journalSha256
  ) {
    throw new Error(`${pointer.kind} pointer does not match its journal revision`);
  }
  return journal;
}

let journalsDirectoryHandle = null;
try {
  journalsDirectoryHandle = opendirSync(journalsDirectory);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const incompleteJournals = [];
if (journalsDirectoryHandle !== null) {
  try {
    for (
      let entry = journalsDirectoryHandle.readSync();
      entry !== null;
      entry = journalsDirectoryHandle.readSync()
    ) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const releaseId = entry.name.slice(0, -".json".length);
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(releaseId)) {
        throw new Error("Release status contains an invalid journal filename");
      }
      const journal = validatedJournal(releaseId)?.latest;
      if (
        ![
          RELEASE_JOURNAL_STATES.COMPLETE,
          RELEASE_JOURNAL_STATES.SUPERSEDED
        ].includes(journal.state)
      ) {
        if (incompleteJournals.length === 256) {
          throw new Error("Release status contains too many incomplete journals");
        }
        incompleteJournals.push(journal);
      }
    }
  } finally {
    journalsDirectoryHandle.closeSync();
  }
}
const result = {};
for (const kind of Object.values(RELEASE_POINTER_KINDS)) {
  const pointer = privateJson(
    resolve(profile.stateDirectory, "pointers", `${kind}.json`),
    assertReleasePointer
  );
  if (!pointer) {
    result[kind] = null;
    continue;
  }
  const validated = validatedJournal(pointer.releaseId);
  if (!validated) throw new Error(`${kind} pointer journal is missing`);
  const journal = journalForPointer(pointer, validated);
  result[kind] = {
    releaseId: journal.releaseId,
    targetGitSha: journal.targetGitSha,
    lane: journal.lane,
    state: journal.state,
    workerVersionId: journal.receipts.workerVersionId,
    deploymentId: journal.receipts.deploymentId,
    updatedAt: journal.updatedAt
  };
}
result.incomplete = incompleteJournals
  .sort((left, right) => left.releaseId.localeCompare(right.releaseId))
  .map((journal) => ({
    releaseId: journal.releaseId,
    targetGitSha: journal.targetGitSha,
    lane: journal.lane,
    state: journal.state,
    resumeFrom: journal.resumeFrom,
    failureCode: journal.failureCode,
    updatedAt: journal.updatedAt
  }));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
