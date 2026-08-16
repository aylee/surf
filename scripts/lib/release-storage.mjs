import * as nodeFs from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWriteReleaseJsonSync } from "./release-journal.mjs";

export const RELEASE_D1_BACKUP_RECEIPT_SCHEMA_VERSION = 1;
export const ROUTINE_MIGRATION_SCANNER_VERSION = 2;

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MIGRATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.sql$/;
const BOOKMARK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "databaseName",
  "bookmark",
  "exportPath",
  "exportBytes",
  "exportSha256"
]);
const BACKUP_EVIDENCE_SCHEMA_VERSION = 2;
const BACKUP_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "state",
  "databaseName",
  "bookmark",
  "exportPath",
  "exportBytes",
  "exportSha256",
  "exportDevice",
  "exportInode",
  "temporaryPath"
]);
const BACKUP_EVIDENCE_STATES = new Set([
  "planned",
  "bookmarked",
  "landing",
  "complete"
]);
const MAX_BACKUP_EVIDENCE_BYTES = 64 * 1024;
const FILE_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const MAX_SEED_BYTES = 4 * 1024 * 1024;
const MAX_SEED_ROWS = 2_000;
const SEED_SPOT_COLUMNS = Object.freeze([
  "id",
  "name",
  "region",
  "lat",
  "lon",
  "timezone",
  "shore_normal_deg",
  "config_json",
  "active"
]);
const SEED_SOURCE_COLUMNS = Object.freeze([
  "id",
  "name",
  "type",
  "provider",
  "external_id",
  "url",
  "format",
  "parser_runtime",
  "attribution",
  "license_note",
  "refresh_minutes",
  "active",
  "metadata_json"
]);

const BARE_SQL_IDENTIFIER = "[A-Za-z_][A-Za-z0-9_]*";
const ROUTINE_ADDITIVE_STATEMENTS = Object.freeze([
  new RegExp(
    `^create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${BARE_SQL_IDENTIFIER}\\s*\\([\\s\\S]*\\)$`,
    "i"
  ),
  new RegExp(
    `^create\\s+(?:unique\\s+)?index\\s+(?:if\\s+not\\s+exists\\s+)?${BARE_SQL_IDENTIFIER}\\s+on\\s+${BARE_SQL_IDENTIFIER}\\s*\\([\\s\\S]*\\)(?:\\s+where\\s+[\\s\\S]+)?$`,
    "i"
  ),
  new RegExp(
    `^alter\\s+table\\s+${BARE_SQL_IDENTIFIER}\\s+add\\s+(?:column\\s+)?${BARE_SQL_IDENTIFIER}\\s+[\\s\\S]+$`,
    "i"
  )
]);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function safeDatabaseName(value) {
  if (typeof value !== "string" || !DATABASE_NAME_PATTERN.test(value)) {
    throw new Error("D1 database name is invalid");
  }
  return value;
}

function safeSqlIdentifier(value, label) {
  if (typeof value !== "string" || !SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is not a safe SQL identifier`);
  }
  return value;
}

function canonicalAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    basename(value).length === 0 ||
    basename(value) === "." ||
    basename(value) === ".."
  ) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
  return value;
}

function lstatOrNull(fs, path) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertPlainDirectory(fs, path, label) {
  const stat = lstatOrNull(fs, path);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
}

function assertNewDestination(fs, path) {
  canonicalAbsolutePath(path, "D1 export destination");
  assertPlainDirectory(fs, dirname(path), "D1 export parent");
  if (lstatOrNull(fs, path)) {
    throw new Error("D1 export destination already exists without a reusable receipt");
  }
}

function backupEvidencePath(exportPath) {
  return `${exportPath}.receipt.json`;
}

function validateBackupEvidence(value, { databaseName, destination } = {}) {
  exactKeys(value, BACKUP_EVIDENCE_KEYS, "D1 backup evidence");
  if (value.schemaVersion !== BACKUP_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("D1 backup evidence schema version is unsupported");
  }
  if (!BACKUP_EVIDENCE_STATES.has(value.state)) {
    throw new Error("D1 backup evidence state is invalid");
  }
  safeDatabaseName(value.databaseName);
  if (databaseName !== undefined && value.databaseName !== safeDatabaseName(databaseName)) {
    throw new Error("D1 backup evidence belongs to a different database");
  }
  canonicalAbsolutePath(value.exportPath, "D1 backup evidence export path");
  if (destination !== undefined && value.exportPath !== destination) {
    throw new Error("D1 backup evidence belongs to a different export path");
  }

  if (value.state === "planned") {
    if (
      value.bookmark !== null ||
      value.exportBytes !== null ||
      value.exportSha256 !== null ||
      value.exportDevice !== null ||
      value.exportInode !== null ||
      value.temporaryPath !== null
    ) {
      throw new Error("Planned D1 backup evidence cannot contain completed evidence");
    }
  } else {
    if (typeof value.bookmark !== "string" || !BOOKMARK_PATTERN.test(value.bookmark)) {
      throw new Error("D1 backup evidence bookmark is invalid");
    }
    if (value.state === "bookmarked") {
      if (
        value.exportBytes !== null ||
        value.exportSha256 !== null ||
        value.exportDevice !== null ||
        value.exportInode !== null ||
        value.temporaryPath !== null
      ) {
        throw new Error("Bookmarked D1 backup evidence cannot contain export evidence");
      }
    } else {
      if (
        !Number.isSafeInteger(value.exportBytes) ||
        value.exportBytes <= 0 ||
        typeof value.exportSha256 !== "string" ||
        !SHA256_PATTERN.test(value.exportSha256) ||
        typeof value.exportDevice !== "string" ||
        !FILE_ID_PATTERN.test(value.exportDevice) ||
        typeof value.exportInode !== "string" ||
        !FILE_ID_PATTERN.test(value.exportInode)
      ) {
        throw new Error("Landed D1 backup evidence is invalid");
      }
      if (value.temporaryPath !== null) {
        canonicalAbsolutePath(
          value.temporaryPath,
          "D1 backup evidence temporary path"
        );
        const temporaryDirectory = dirname(value.temporaryPath);
        if (
          dirname(temporaryDirectory) !== dirname(value.exportPath) ||
          basename(value.temporaryPath) !== "export.sql" ||
          !basename(temporaryDirectory).startsWith(
            `.${basename(value.exportPath)}.partial-`
          )
        ) {
          throw new Error("D1 backup evidence temporary path is invalid");
        }
      }
      if (value.state === "landing" && value.temporaryPath === null) {
        throw new Error("Landing D1 backup evidence requires its exact temporary path");
      }
    }
  }
  return Object.freeze({ ...value });
}

function readBackupEvidence(fs, path, options) {
  const invalidEvidence = () =>
    new Error(
      "D1 backup evidence must be a bounded non-symlink mode-0600 regular file"
    );
  const noFollow = fs.constants?.O_NOFOLLOW ?? fsConstants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw new Error("This runtime cannot safely open no-follow D1 backup evidence");
  }
  let fd;
  try {
    fd = fs.openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") throw invalidEvidence();
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      (before.mode & 0o7777) !== 0o600 ||
      !Number.isSafeInteger(before.size) ||
      before.size <= 0 ||
      before.size > MAX_BACKUP_EVIDENCE_BYTES
    ) {
      throw invalidEvidence();
    }
    const contents = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (after.mode & 0o7777) !== 0o600 ||
      contents.byteLength !== after.size
    ) {
      throw new Error("D1 backup evidence changed while it was being verified");
    }
    let value;
    try {
      value = JSON.parse(contents.toString("utf8"));
    } catch {
      throw new Error("D1 backup evidence must contain valid JSON");
    }
    return validateBackupEvidence(value, options);
  } finally {
    fs.closeSync(fd);
  }
}

function writeBackupEvidence(fs, path, value, options) {
  const evidence = validateBackupEvidence(value, options);
  atomicWriteReleaseJsonSync(path, evidence, { fileSystem: fs });
  return evidence;
}

function plannedBackupEvidence(databaseName, exportPath) {
  return Object.freeze({
    schemaVersion: BACKUP_EVIDENCE_SCHEMA_VERSION,
    state: "planned",
    databaseName,
    bookmark: null,
    exportPath,
    exportBytes: null,
    exportSha256: null,
    exportDevice: null,
    exportInode: null,
    temporaryPath: null
  });
}

function receiptFromCompleteEvidence(evidence) {
  if (evidence.state !== "complete") {
    throw new Error("D1 backup evidence is not complete");
  }
  return validateD1BackupReceipt({
    schemaVersion: RELEASE_D1_BACKUP_RECEIPT_SCHEMA_VERSION,
    databaseName: evidence.databaseName,
    bookmark: evidence.bookmark,
    exportPath: evidence.exportPath,
    exportBytes: evidence.exportBytes,
    exportSha256: evidence.exportSha256
  });
}

function completeEvidenceFromReceipt(receipt, fileEvidence) {
  return validateBackupEvidence({
    schemaVersion: BACKUP_EVIDENCE_SCHEMA_VERSION,
    state: "complete",
    databaseName: receipt.databaseName,
    bookmark: receipt.bookmark,
    exportPath: receipt.exportPath,
    exportBytes: receipt.exportBytes,
    exportSha256: receipt.exportSha256,
    exportDevice: fileEvidence.dev,
    exportInode: fileEvidence.ino,
    temporaryPath: null
  });
}

function receiptsEqual(left, right) {
  return RECEIPT_KEYS.every((key) => left[key] === right[key]);
}

function safeJsonParse(output, label) {
  if (typeof output !== "string") {
    throw new Error(`${label} did not return text`);
  }
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

export function parseTimeTravelBookmark(output) {
  const value = safeJsonParse(output, "D1 Time Travel info");
  exactKeys(value, ["bookmark"], "D1 Time Travel info");
  if (typeof value.bookmark !== "string" || !BOOKMARK_PATTERN.test(value.bookmark)) {
    throw new Error("D1 Time Travel info returned an invalid bookmark");
  }
  return value.bookmark;
}

function parseD1Select(output, label) {
  const value = safeJsonParse(output, label);
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${label} must return exactly one statement result`);
  }
  const [statement] = value;
  if (
    !statement ||
    typeof statement !== "object" ||
    Array.isArray(statement) ||
    statement.success !== true ||
    !Array.isArray(statement.results)
  ) {
    throw new Error(`${label} did not complete successfully`);
  }
  return statement.results;
}

function stripSeedSqlComments(sql) {
  let result = "";
  let state = "normal";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (state === "normal") {
      if (character === "-") {
        if (next === "-") {
          result += "  ";
          index += 1;
          state = "line-comment";
          continue;
        }
      }
      if (character === "/" && next === "*") {
        result += "  ";
        index += 1;
        state = "block-comment";
        continue;
      }
      result += character;
      if (character === "'") state = "single-quote";
      continue;
    }
    if (state === "single-quote") {
      result += character;
      if (character === "'") {
        if (next === "'") {
          result += next;
          index += 1;
        } else {
          state = "normal";
        }
      }
      continue;
    }
    if (state === "line-comment") {
      result += character === "\n" ? "\n" : " ";
      if (character === "\n") state = "normal";
      continue;
    }
    result += character === "\n" ? "\n" : " ";
    if (character === "*" && next === "/") {
      result += " ";
      index += 1;
      state = "normal";
    }
  }
  if (state === "single-quote" || state === "block-comment") {
    throw new Error("Generated D1 seed contains an unclosed SQL token");
  }
  return result;
}

function parseSeedColumns(value, expected, label) {
  const columns = value.split(",").map((column) => column.trim());
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => column !== expected[index])
  ) {
    throw new Error(`Generated D1 seed ${label} columns are not canonical`);
  }
  return columns;
}

function parseSeedUpsert(value, columns, label) {
  const assignments = value.split(",").map((assignment) =>
    assignment.replace(/\s+/g, " ").trim().toLowerCase()
  );
  const expected = columns.slice(1).map(
    (column) => `${column} = excluded.${column}`
  );
  if (
    assignments.length !== expected.length ||
    assignments.some((assignment, index) => assignment !== expected[index])
  ) {
    throw new Error(`Generated D1 seed ${label} upsert is not canonical`);
  }
}

function parseSeedValueRows(value, columns, label) {
  let cursor = 0;
  const rows = [];
  const skipWhitespace = () => {
    while (/\s/.test(value[cursor] ?? "")) cursor += 1;
  };
  const parseValue = () => {
    skipWhitespace();
    if (value[cursor] === "'") {
      cursor += 1;
      let result = "";
      while (cursor < value.length) {
        if (value[cursor] !== "'") {
          result += value[cursor];
          cursor += 1;
          continue;
        }
        if (value[cursor + 1] === "'") {
          result += "'";
          cursor += 2;
          continue;
        }
        cursor += 1;
        return result;
      }
      throw new Error(`Generated D1 seed ${label} contains an unclosed string`);
    }
    const remaining = value.slice(cursor);
    const nullMatch = /^null\b/i.exec(remaining);
    if (nullMatch) {
      cursor += nullMatch[0].length;
      return null;
    }
    const numberMatch = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?\b/i.exec(
      remaining
    );
    if (!numberMatch) {
      throw new Error(`Generated D1 seed ${label} contains a nonliteral value`);
    }
    cursor += numberMatch[0].length;
    const number = Number(numberMatch[0]);
    if (!Number.isFinite(number)) {
      throw new Error(`Generated D1 seed ${label} contains a non-finite number`);
    }
    return number;
  };

  while (true) {
    skipWhitespace();
    if (cursor === value.length) break;
    if (rows.length > 0) {
      if (value[cursor] !== ",") {
        throw new Error(`Generated D1 seed ${label} rows are malformed`);
      }
      cursor += 1;
      skipWhitespace();
    }
    if (value[cursor] !== "(") {
      throw new Error(`Generated D1 seed ${label} row is malformed`);
    }
    cursor += 1;
    const row = [];
    while (true) {
      row.push(parseValue());
      skipWhitespace();
      if (value[cursor] === ")") {
        cursor += 1;
        break;
      }
      if (value[cursor] !== ",") {
        throw new Error(`Generated D1 seed ${label} value list is malformed`);
      }
      cursor += 1;
    }
    if (row.length !== columns.length) {
      throw new Error(`Generated D1 seed ${label} row has the wrong arity`);
    }
    rows.push(Object.fromEntries(columns.map((column, index) => [column, row[index]])));
    if (rows.length > MAX_SEED_ROWS) {
      throw new Error("Generated D1 seed contains too many rows");
    }
  }
  if (rows.length === 0) {
    throw new Error(`Generated D1 seed ${label} must contain rows`);
  }
  const ids = rows.map((row) => row.id);
  if (
    ids.some(
      (id) => typeof id !== "string" || id.length === 0 || id.length > 256
    ) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(`Generated D1 seed ${label} IDs are invalid or duplicated`);
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function parseRetiredSourceIds(value) {
  let cursor = 0;
  const ids = [];
  while (cursor < value.length) {
    while (/\s/.test(value[cursor] ?? "")) cursor += 1;
    if (ids.length > 0) {
      if (value[cursor] !== ",") {
        throw new Error("Generated D1 seed retired-source list is malformed");
      }
      cursor += 1;
      while (/\s/.test(value[cursor] ?? "")) cursor += 1;
    }
    if (value[cursor] !== "'") {
      throw new Error("Generated D1 seed retired-source ID must be a string");
    }
    cursor += 1;
    let id = "";
    let closed = false;
    while (cursor < value.length) {
      if (value[cursor] !== "'") {
        id += value[cursor];
        cursor += 1;
      } else if (value[cursor + 1] === "'") {
        id += "'";
        cursor += 2;
      } else {
        cursor += 1;
        closed = true;
        break;
      }
    }
    if (!closed || id.length === 0 || id.length > 256) {
      throw new Error("Generated D1 seed retired-source ID is invalid");
    }
    ids.push(id);
    while (/\s/.test(value[cursor] ?? "")) cursor += 1;
  }
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Generated D1 seed retired-source IDs are empty or duplicated");
  }
  ids.sort((left, right) => left.localeCompare(right));
  return Object.freeze(ids);
}

function parseGeneratedSeedSql(sql, sha256) {
  const uncommented = stripSeedSqlComments(sql);
  const match = /^\s*insert\s+into\s+spots\s*\(([^)]*)\)\s*values\s*([\s\S]*?)\s*on\s+conflict\s*\(\s*id\s*\)\s*do\s+update\s+set\s*([\s\S]*?);\s*insert\s+into\s+sources\s*\(([^)]*)\)\s*values\s*([\s\S]*?)\s*on\s+conflict\s*\(\s*id\s*\)\s*do\s+update\s+set\s*([\s\S]*?);\s*update\s+sources\s+set\s+active\s*=\s*0\s+where\s+id\s+in\s*\(([\s\S]*?)\)\s*;\s*$/i.exec(
    uncommented
  );
  if (!match) {
    throw new Error("Generated D1 seed has unsupported statements or ordering");
  }
  const spotColumns = parseSeedColumns(match[1], SEED_SPOT_COLUMNS, "spot");
  const sourceColumns = parseSeedColumns(
    match[4],
    SEED_SOURCE_COLUMNS,
    "source"
  );
  parseSeedUpsert(match[3], spotColumns, "spot");
  parseSeedUpsert(match[6], sourceColumns, "source");
  const spots = parseSeedValueRows(match[2], spotColumns, "spot");
  const sources = parseSeedValueRows(match[5], sourceColumns, "source");
  const retiredSourceIds = parseRetiredSourceIds(match[7]);
  const sourceIds = new Set(sources.map((row) => row.id));
  if (retiredSourceIds.some((id) => sourceIds.has(id))) {
    throw new Error("Generated D1 seed cannot both upsert and retire one source");
  }
  const semantic = { spots, sources, retiredSourceIds };
  return Object.freeze({
    seedSha256: sha256,
    semanticSha256: createHash("sha256")
      .update(JSON.stringify(semantic))
      .digest("hex"),
    ...semantic
  });
}

function readGeneratedSeedPlan(fs, path) {
  canonicalAbsolutePath(path, "D1 seed path");
  const noFollow = fs.constants?.O_NOFOLLOW ?? fsConstants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw new Error("This runtime cannot safely open a no-follow D1 seed");
  }
  let fd;
  try {
    fd = fs.openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("D1 seed must be a non-symlink regular file");
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size <= 0 ||
      before.size > MAX_SEED_BYTES
    ) {
      throw new Error("D1 seed must be a bounded nonempty regular file");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error("D1 seed changed while it was being inspected");
    }
    let sql;
    try {
      sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("D1 seed must be valid UTF-8");
    }
    return parseGeneratedSeedSql(
      sql,
      createHash("sha256").update(bytes).digest("hex")
    );
  } finally {
    fs.closeSync(fd);
  }
}

function quotedSqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function exactSeedRowsMatch(actualRows, expectedRows, columns) {
  if (actualRows.length !== expectedRows.length) return false;
  return actualRows.every((actual, index) => {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const keys = Object.keys(actual).sort();
    const expectedKeys = [...columns].sort();
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
    ) {
      return false;
    }
    return columns.every((column) => actual[column] === expectedRows[index][column]);
  });
}

function retiredSeedRowsMatch(actualRows, retiredSourceIds) {
  const expectedIds = new Set(retiredSourceIds);
  const seenIds = new Set();
  return actualRows.every((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    if (
      Object.keys(row).sort().join(",") !== "active,id" ||
      typeof row.id !== "string" ||
      !expectedIds.has(row.id) ||
      seenIds.has(row.id) ||
      row.active !== 0
    ) {
      return false;
    }
    seenIds.add(row.id);
    return true;
  });
}

async function sha256FileEvidence(fs, path) {
  const noFollow = fs.constants?.O_NOFOLLOW ?? fsConstants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw new Error("This runtime cannot safely open a no-follow D1 export");
  }
  const directoryOnly = fs.constants?.O_DIRECTORY ?? fsConstants.O_DIRECTORY;
  if (!Number.isInteger(directoryOnly)) {
    throw new Error("This runtime cannot safely fsync a D1 export directory");
  }
  const fd = fs.openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const beforeSync = fs.fstatSync(fd);
    if (
      !beforeSync.isFile() ||
      beforeSync.isSymbolicLink?.() ||
      (beforeSync.mode & 0o7777) !== 0o600 ||
      !Number.isSafeInteger(beforeSync.size) ||
      beforeSync.size <= 0
    ) {
      throw new Error("D1 export must be a nonempty mode-0600 regular file");
    }

    // A receipt is useful for recovery only if both the export bytes and the
    // directory entry naming them have reached durable storage. Flush the
    // exact no-follow file descriptor that will be hashed, then its containing
    // directory, before taking the evidence snapshot.
    fs.fsyncSync(fd);
    const directoryFd = fs.openSync(
      dirname(path),
      fsConstants.O_RDONLY | noFollow | directoryOnly
    );
    try {
      const directoryStat = fs.fstatSync(directoryFd);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink?.()) {
        throw new Error("D1 export parent must be a non-symlink directory");
      }
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }

    const before = fs.fstatSync(fd);
    if (
      beforeSync.dev !== before.dev ||
      beforeSync.ino !== before.ino ||
      beforeSync.size !== before.size ||
      beforeSync.mtimeMs !== before.mtimeMs ||
      (before.mode & 0o7777) !== 0o600
    ) {
      throw new Error("D1 export changed while it was being made durable");
    }
    const hash = createHash("sha256");
    const stream = fs.createReadStream(path, { fd, autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (after.mode & 0o7777) !== 0o600
    ) {
      throw new Error("D1 export changed while it was being verified");
    }
    return Object.freeze({
      bytes: after.size,
      sha256: hash.digest("hex"),
      dev: String(after.dev),
      ino: String(after.ino)
    });
  } finally {
    fs.closeSync(fd);
  }
}

export function validateD1BackupReceipt(value, { databaseName, destination } = {}) {
  exactKeys(value, RECEIPT_KEYS, "D1 backup receipt");
  if (value.schemaVersion !== RELEASE_D1_BACKUP_RECEIPT_SCHEMA_VERSION) {
    throw new Error("D1 backup receipt schema version is unsupported");
  }
  safeDatabaseName(value.databaseName);
  if (databaseName !== undefined && value.databaseName !== safeDatabaseName(databaseName)) {
    throw new Error("D1 backup receipt belongs to a different database");
  }
  if (typeof value.bookmark !== "string" || !BOOKMARK_PATTERN.test(value.bookmark)) {
    throw new Error("D1 backup receipt bookmark is invalid");
  }
  canonicalAbsolutePath(value.exportPath, "D1 backup receipt export path");
  if (destination !== undefined && value.exportPath !== destination) {
    throw new Error("D1 backup receipt belongs to a different export path");
  }
  if (!Number.isSafeInteger(value.exportBytes) || value.exportBytes <= 0) {
    throw new Error("D1 backup receipt byte count is invalid");
  }
  if (typeof value.exportSha256 !== "string" || !SHA256_PATTERN.test(value.exportSha256)) {
    throw new Error("D1 backup receipt SHA-256 is invalid");
  }
  return Object.freeze({ ...value });
}

async function revalidateD1BackupReceipt(fs, receipt) {
  assertPlainDirectory(fs, dirname(receipt.exportPath), "D1 export parent");
  const pathStat = lstatOrNull(fs, receipt.exportPath);
  if (!pathStat || pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error("D1 backup receipt export is missing or is not a regular file");
  }
  const evidence = await sha256FileEvidence(fs, receipt.exportPath);
  if (
    evidence.bytes !== receipt.exportBytes ||
    evidence.sha256 !== receipt.exportSha256
  ) {
    throw new Error("D1 backup receipt export no longer matches its exact evidence");
  }
  return evidence;
}

function exactLandedReceipt(evidence) {
  return validateD1BackupReceipt({
    schemaVersion: RELEASE_D1_BACKUP_RECEIPT_SCHEMA_VERSION,
    databaseName: evidence.databaseName,
    bookmark: evidence.bookmark,
    exportPath: evidence.exportPath,
    exportBytes: evidence.exportBytes,
    exportSha256: evidence.exportSha256
  });
}

async function assertLandedExportMatches(fs, evidence, path) {
  const stat = lstatOrNull(fs, path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Landed D1 export is missing or is not a regular file");
  }
  const actual = await sha256FileEvidence(fs, path);
  if (
    actual.dev !== evidence.exportDevice ||
    actual.ino !== evidence.exportInode ||
    actual.bytes !== evidence.exportBytes ||
    actual.sha256 !== evidence.exportSha256
  ) {
    throw new Error(
      "Landed D1 export no longer matches its exact inode, size, and hash evidence"
    );
  }
  return actual;
}

function removeExactTemporaryLink(fs, evidence) {
  if (evidence.temporaryPath === null) return;
  const temporary = lstatOrNull(fs, evidence.temporaryPath);
  if (temporary) {
    if (
      temporary.isDirectory() ||
      temporary.isSymbolicLink() ||
      String(temporary.dev) !== evidence.exportDevice ||
      String(temporary.ino) !== evidence.exportInode
    ) {
      throw new Error("D1 backup temporary link no longer matches landed evidence");
    }
    fs.unlinkSync(evidence.temporaryPath);
  }
  const temporaryDirectory = dirname(evidence.temporaryPath);
  const directory = lstatOrNull(fs, temporaryDirectory);
  if (directory) {
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error("D1 backup temporary directory is no longer a plain directory");
    }
    const entries = fs.readdirSync(temporaryDirectory);
    if (entries.length !== 0) {
      throw new Error("D1 backup temporary directory contains unexpected entries");
    }
    fs.rmdirSync(temporaryDirectory);
  }
}

function maskSql(sql) {
  let masked = "";
  let state = "normal";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (state === "normal") {
      if (character === "-" && next === "-") {
        masked += "  ";
        index += 1;
        state = "line-comment";
      } else if (character === "/" && next === "*") {
        masked += "  ";
        index += 1;
        state = "block-comment";
      } else if (character === "'") {
        masked += " ";
        state = "single-quote";
      } else if (character === '"') {
        masked += " ";
        state = "double-quote";
      } else if (character === "`") {
        masked += " ";
        state = "backtick";
      } else if (character === "[") {
        masked += " ";
        state = "bracket";
      } else {
        masked += character;
      }
      continue;
    }
    if (state === "line-comment") {
      masked += character === "\n" ? "\n" : " ";
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      masked += character === "\n" ? "\n" : " ";
      if (character === "*" && next === "/") {
        masked += " ";
        index += 1;
        state = "normal";
      }
      continue;
    }
    masked += character === "\n" ? "\n" : " ";
    const terminator = {
      "single-quote": "'",
      "double-quote": '"',
      backtick: "`",
      bracket: "]"
    }[state];
    if (character === terminator) {
      if (next === terminator) {
        masked += " ";
        index += 1;
      } else {
        state = "normal";
      }
    }
  }
  return Object.freeze({ masked, complete: state === "normal" || state === "line-comment" });
}

export function scanRoutineMigrationSql(sql) {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("Migration SQL must be nonempty text");
  }
  const { masked, complete } = maskSql(sql);
  const codes = new Set();
  let statementCount = 0;
  if (!complete) codes.add("unclosed-sql-token");
  for (const statement of masked.split(";")) {
    const normalized = statement.trim();
    if (!normalized) continue;
    statementCount += 1;
    if (
      !ROUTINE_ADDITIVE_STATEMENTS.some((pattern) => pattern.test(normalized))
    ) {
      codes.add("statement-not-allowlisted");
    }
  }
  if (statementCount === 0) codes.add("no-sql-statements");
  return Object.freeze({
    scannerVersion: ROUTINE_MIGRATION_SCANNER_VERSION,
    assurance: "fail-closed-additive-allowlist",
    safeForRoutineRelease: codes.size === 0,
    findingCodes: Object.freeze([...codes].sort())
  });
}

function readMigrationFileEvidence(fs, path, name) {
  const noFollow = fs.constants?.O_NOFOLLOW ?? fsConstants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw new Error("This runtime cannot safely open a no-follow migration");
  }
  let fd;
  try {
    fd = fs.openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`Migration must be a non-symlink regular file: ${name}`);
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0) {
      throw new Error(`Migration must be a nonempty regular file: ${name}`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error(`Migration changed while it was being inspected: ${name}`);
    }
    let sql;
    try {
      sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Migration must be valid UTF-8: ${name}`);
    }
    return Object.freeze({
      sql,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  } finally {
    fs.closeSync(fd);
  }
}

async function migrationEvidence(fs, path) {
  canonicalAbsolutePath(path, "Migration path");
  const name = basename(path);
  if (!MIGRATION_NAME_PATTERN.test(name)) {
    throw new Error(`Migration filename is invalid: ${name}`);
  }
  const stat = lstatOrNull(fs, path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Migration must be a non-symlink regular file: ${name}`);
  }
  const file = readMigrationFileEvidence(fs, path, name);
  const safety = scanRoutineMigrationSql(file.sql);
  return Object.freeze({
    name,
    path,
    sha256: file.sha256,
    safety
  });
}

function assertNoDuplicateMigrations(migrations) {
  const names = new Set();
  for (const migration of migrations) {
    if (names.has(migration.name)) {
      throw new Error(`Duplicate migration filename: ${migration.name}`);
    }
    names.add(migration.name);
  }
}

function quotedSqlIdentifier(identifier) {
  return `"${identifier}"`;
}

function d1SelectArgs(databaseName, sql) {
  return [
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--json",
    "--command",
    sql
  ];
}

export function createReleaseStorage({ commandContext, fs = nodeFs } = {}) {
  if (
    !commandContext ||
    typeof commandContext.runWrangler !== "function" ||
    typeof commandContext.assertUnchanged !== "function"
  ) {
    throw new Error(
      "Release storage requires a command context with runWrangler and assertUnchanged"
    );
  }
  const requiredFsMethods = [
    "lstatSync",
    "mkdirSync",
    "openSync",
    "fstatSync",
    "fsyncSync",
    "closeSync",
    "createReadStream",
    "readFileSync",
    "readdirSync",
    "writeFileSync",
    "mkdtempSync",
    "chmodSync",
    "linkSync",
    "renameSync",
    "unlinkSync",
    "rmdirSync"
  ];
  if (requiredFsMethods.some((method) => typeof fs?.[method] !== "function")) {
    throw new Error("Release storage filesystem dependency is incomplete");
  }

  const inspectPendingMigrations = async ({
    databaseName,
    migrationPaths,
    migrationsTable = "d1_migrations"
  }) => {
    const database = safeDatabaseName(databaseName);
    const table = safeSqlIdentifier(migrationsTable, "D1 migrations table");
    if (!Array.isArray(migrationPaths)) {
      throw new Error("Migration paths must be an explicit array");
    }
    commandContext.assertUnchanged();
    const migrations = await Promise.all(
      migrationPaths.map((path) => migrationEvidence(fs, path))
    );
    migrations.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    assertNoDuplicateMigrations(migrations);

    const tableRows = parseD1Select(
      await Promise.resolve(
        commandContext.runWrangler(
          d1SelectArgs(
            database,
            `select name from sqlite_schema where type='table' and name='${table}'`
          ),
          { capture: true }
        )
      ),
      "D1 migrations-table inspection"
    );
    if (
      tableRows.length > 1 ||
      tableRows.some(
        (row) =>
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          row.name !== table
      )
    ) {
      throw new Error("D1 migrations-table inspection returned invalid rows");
    }

    let appliedNames = [];
    if (tableRows.length === 1) {
      const appliedRows = parseD1Select(
        await Promise.resolve(
          commandContext.runWrangler(
            d1SelectArgs(
              database,
              `select name from ${quotedSqlIdentifier(table)} order by id`
            ),
            { capture: true }
          )
        ),
        "D1 applied-migrations inspection"
      );
      appliedNames = appliedRows.map((row) => {
        if (
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          typeof row.name !== "string" ||
          !MIGRATION_NAME_PATTERN.test(row.name)
        ) {
          throw new Error("D1 applied-migrations inspection returned an invalid row");
        }
        return row.name;
      });
      if (new Set(appliedNames).size !== appliedNames.length) {
        throw new Error("D1 applied-migrations inspection returned duplicate names");
      }
    }

    const localByName = new Map(migrations.map((migration) => [migration.name, migration]));
    const unknownApplied = appliedNames.filter((name) => !localByName.has(name));
    if (unknownApplied.length > 0) {
      throw new Error(
        `Target release is missing applied D1 migration(s): ${unknownApplied.join(", ")}`
      );
    }
    const appliedSet = new Set(appliedNames);
    const expectedAppliedNames = migrations
      .filter((migration) => appliedSet.has(migration.name))
      .map((migration) => migration.name);
    if (
      appliedNames.length !== expectedAppliedNames.length ||
      appliedNames.some((name, index) => name !== expectedAppliedNames[index])
    ) {
      throw new Error("D1 applied migration history is not in local file order");
    }
    const pending = migrations.filter((migration) => !appliedSet.has(migration.name));
    const firstPendingIndex = migrations.findIndex((migration) => !appliedSet.has(migration.name));
    if (
      firstPendingIndex >= 0 &&
      migrations.slice(firstPendingIndex + 1).some((migration) => appliedSet.has(migration.name))
    ) {
      throw new Error("D1 applied migration history contains a local ordering gap");
    }
    const blocked = pending.filter(
      (migration) => !migration.safety.safeForRoutineRelease
    );
    if (blocked.length > 0) {
      throw new Error(
        `Routine release blocked by migration(s) outside the additive allowlist: ${blocked
          .map((migration) => `${migration.name} (${migration.safety.findingCodes.join(", ")})`)
          .join("; ")}`
      );
    }
    commandContext.assertUnchanged();
    return Object.freeze({
      databaseName: database,
      migrationsTable: table,
      scannerVersion: ROUTINE_MIGRATION_SCANNER_VERSION,
      applied: Object.freeze(
        migrations.filter((migration) => appliedSet.has(migration.name))
      ),
      pending: Object.freeze(pending),
      hasPending: pending.length > 0
    });
  };

  const inspectSeedState = ({ databaseName, seedPath }) => {
    const database = safeDatabaseName(databaseName);
    const plan = readGeneratedSeedPlan(fs, seedPath);
    const selectRows = (table, columns, ids, label) => {
      const idList = ids.map(quotedSqlString).join(", ");
      if (idList.length > 128 * 1024) {
        throw new Error("Generated D1 seed reconciliation query is too large");
      }
      const output = commandContext.runWrangler(
        d1SelectArgs(
          database,
          `select ${columns.join(", ")} from ${table} where id in (${idList}) order by id`
        ),
        { capture: true }
      );
      if (output && typeof output.then === "function") {
        throw new Error("D1 seed reconciliation requires a synchronous command context");
      }
      return parseD1Select(output, label);
    };
    commandContext.assertUnchanged();
    const spotRows = selectRows(
      "spots",
      SEED_SPOT_COLUMNS,
      plan.spots.map((row) => row.id),
      "D1 seeded-spot inspection"
    );
    const sourceRows = selectRows(
      "sources",
      SEED_SOURCE_COLUMNS,
      plan.sources.map((row) => row.id),
      "D1 seeded-source inspection"
    );
    const retiredColumns = ["id", "active"];
    const retiredRows = selectRows(
      "sources",
      retiredColumns,
      plan.retiredSourceIds,
      "D1 retired-source inspection"
    );
    const matches =
      exactSeedRowsMatch(spotRows, plan.spots, SEED_SPOT_COLUMNS) &&
      exactSeedRowsMatch(sourceRows, plan.sources, SEED_SOURCE_COLUMNS) &&
      retiredSeedRowsMatch(retiredRows, plan.retiredSourceIds);
    commandContext.assertUnchanged();
    return Object.freeze({
      schemaVersion: 1,
      seedSha256: plan.seedSha256,
      semanticSha256: plan.semanticSha256,
      matches
    });
  };

  const prepareBackup = async ({ databaseName, destination, receipt = null }) => {
    const database = safeDatabaseName(databaseName);
    const exportPath = canonicalAbsolutePath(destination, "D1 export destination");
    const evidencePath = backupEvidencePath(exportPath);
    commandContext.assertUnchanged();
    let durableEvidence = readBackupEvidence(fs, evidencePath, {
      databaseName: database,
      destination: exportPath
    });

    if (receipt !== null) {
      const reusable = validateD1BackupReceipt(receipt, {
        databaseName: database,
        destination: exportPath
      });
      const reusableFileEvidence = await revalidateD1BackupReceipt(fs, reusable);
      if (
        durableEvidence?.state === "bookmarked" &&
        durableEvidence.bookmark !== reusable.bookmark
      ) {
        throw new Error("D1 backup receipt conflicts with durable bookmark evidence");
      }
      if (
        durableEvidence?.state === "complete" ||
        durableEvidence?.state === "landing"
      ) {
        const durableReceipt = exactLandedReceipt(durableEvidence);
        if (!receiptsEqual(durableReceipt, reusable)) {
          throw new Error("D1 backup receipt conflicts with durable backup evidence");
        }
        await assertLandedExportMatches(fs, durableEvidence, exportPath);
        if (durableEvidence.state === "landing") {
          durableEvidence = writeBackupEvidence(
            fs,
            evidencePath,
            { ...durableEvidence, state: "complete" },
            { databaseName: database, destination: exportPath }
          );
        }
        removeExactTemporaryLink(fs, durableEvidence);
      } else {
        durableEvidence = writeBackupEvidence(
          fs,
          evidencePath,
          completeEvidenceFromReceipt(reusable, reusableFileEvidence),
          { databaseName: database, destination: exportPath }
        );
      }
      commandContext.assertUnchanged();
      return reusable;
    }

    if (durableEvidence?.state === "complete") {
      const reusable = receiptFromCompleteEvidence(durableEvidence);
      await assertLandedExportMatches(fs, durableEvidence, exportPath);
      removeExactTemporaryLink(fs, durableEvidence);
      commandContext.assertUnchanged();
      return reusable;
    }

    if (durableEvidence?.state === "landing") {
      const destinationStat = lstatOrNull(fs, exportPath);
      if (destinationStat) {
        await assertLandedExportMatches(fs, durableEvidence, exportPath);
      } else {
        const temporaryStat = lstatOrNull(fs, durableEvidence.temporaryPath);
        if (temporaryStat) {
          await assertLandedExportMatches(
            fs,
            durableEvidence,
            durableEvidence.temporaryPath
          );
          fs.linkSync(durableEvidence.temporaryPath, exportPath);
          await assertLandedExportMatches(fs, durableEvidence, exportPath);
        } else {
          durableEvidence = writeBackupEvidence(
            fs,
            evidencePath,
            {
              ...durableEvidence,
              state: "bookmarked",
              exportBytes: null,
              exportSha256: null,
              exportDevice: null,
              exportInode: null,
              temporaryPath: null
            },
            { databaseName: database, destination: exportPath }
          );
        }
      }
      if (durableEvidence.state === "landing") {
        const reusable = exactLandedReceipt(durableEvidence);
        durableEvidence = writeBackupEvidence(
          fs,
          evidencePath,
          { ...durableEvidence, state: "complete" },
          { databaseName: database, destination: exportPath }
        );
        removeExactTemporaryLink(fs, durableEvidence);
        commandContext.assertUnchanged();
        return reusable;
      }
    }

    if (lstatOrNull(fs, exportPath)) {
      throw new Error(
        durableEvidence?.state === "bookmarked"
          ? "D1 export destination exists with bookmark-only evidence; it cannot be proven to be the Wrangler export and must not be promoted; choose a fresh nonexisting destination"
          : "D1 export destination already exists without a reusable receipt"
      );
    }

    assertNewDestination(fs, exportPath);
    if (durableEvidence === null) {
      durableEvidence = writeBackupEvidence(
        fs,
        evidencePath,
        plannedBackupEvidence(database, exportPath),
        { databaseName: database, destination: exportPath }
      );
    }
    if (durableEvidence.state === "planned") {
      const bookmark = parseTimeTravelBookmark(
        await Promise.resolve(
          commandContext.runWrangler(
            ["d1", "time-travel", "info", database, "--json"],
            { capture: true }
          )
        )
      );
      commandContext.assertUnchanged();
      durableEvidence = writeBackupEvidence(
        fs,
        evidencePath,
        {
          ...durableEvidence,
          state: "bookmarked",
          bookmark
        },
        { databaseName: database, destination: exportPath }
      );
    }

    const temporaryDirectory = fs.mkdtempSync(
      join(dirname(exportPath), `.${basename(exportPath)}.partial-`)
    );
    fs.chmodSync(temporaryDirectory, 0o700);
    assertPlainDirectory(fs, temporaryDirectory, "D1 temporary export directory");
    const temporaryPath = join(temporaryDirectory, "export.sql");
    let destinationCreated = false;
    let linkedEvidence = null;
    let recoverableLinkedExport = false;
    try {
      await Promise.resolve(
        commandContext.runWrangler(
          [
            "d1",
            "export",
            database,
            "--remote",
            "--output",
            temporaryPath,
            "--skip-confirmation"
          ],
          { capture: true }
        )
      );
      commandContext.assertUnchanged();
      const temporaryStat = lstatOrNull(fs, temporaryPath);
      if (!temporaryStat || temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) {
        throw new Error("Wrangler did not create a regular D1 export file");
      }
      fs.chmodSync(temporaryPath, 0o600);
      const temporaryEvidence = await sha256FileEvidence(fs, temporaryPath);
      if (lstatOrNull(fs, exportPath)) {
        throw new Error("D1 export destination appeared during backup creation");
      }
      durableEvidence = writeBackupEvidence(
        fs,
        evidencePath,
        {
          ...durableEvidence,
          state: "landing",
          exportBytes: temporaryEvidence.bytes,
          exportSha256: temporaryEvidence.sha256,
          exportDevice: temporaryEvidence.dev,
          exportInode: temporaryEvidence.ino,
          temporaryPath
        },
        { databaseName: database, destination: exportPath }
      );
      fs.linkSync(temporaryPath, exportPath);
      destinationCreated = true;
      linkedEvidence = temporaryEvidence;
      const finalStat = lstatOrNull(fs, exportPath);
      if (!finalStat || finalStat.isSymbolicLink() || !finalStat.isFile()) {
        throw new Error("Final D1 export is not a non-symlink regular file");
      }
      const finalEvidence = await sha256FileEvidence(fs, exportPath);
      if (
        finalEvidence.dev !== temporaryEvidence.dev ||
        finalEvidence.ino !== temporaryEvidence.ino ||
        finalEvidence.bytes !== temporaryEvidence.bytes ||
        finalEvidence.sha256 !== temporaryEvidence.sha256
      ) {
        throw new Error("Final D1 export differs from the verified temporary export");
      }
      recoverableLinkedExport = true;
      const createdReceipt = validateD1BackupReceipt({
        schemaVersion: RELEASE_D1_BACKUP_RECEIPT_SCHEMA_VERSION,
        databaseName: database,
        bookmark: durableEvidence.bookmark,
        exportPath,
        exportBytes: finalEvidence.bytes,
        exportSha256: finalEvidence.sha256
      });
      durableEvidence = writeBackupEvidence(
        fs,
        evidencePath,
        { ...durableEvidence, state: "complete" },
        { databaseName: database, destination: exportPath }
      );
      removeExactTemporaryLink(fs, durableEvidence);
      commandContext.assertUnchanged();
      return createdReceipt;
    } catch (error) {
      if (destinationCreated && !recoverableLinkedExport) {
        const current = lstatOrNull(fs, exportPath);
        if (
          current &&
          !current.isDirectory() &&
          !current.isSymbolicLink() &&
          String(current.dev) === linkedEvidence?.dev &&
          String(current.ino) === linkedEvidence?.ino
        ) {
          fs.unlinkSync(exportPath);
        }
      }
      throw error;
    } finally {
      if (durableEvidence?.state !== "landing") {
        const temporary = lstatOrNull(fs, temporaryPath);
        if (temporary && !temporary.isDirectory()) fs.unlinkSync(temporaryPath);
        const directory = lstatOrNull(fs, temporaryDirectory);
        if (directory?.isDirectory() && !directory.isSymbolicLink()) {
          fs.rmdirSync(temporaryDirectory);
        }
      }
    }
  };

  return Object.freeze({ inspectPendingMigrations, inspectSeedState, prepareBackup });
}
