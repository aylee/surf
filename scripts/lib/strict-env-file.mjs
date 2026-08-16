import { lstatSync } from "node:fs";
import { readVerifiedFileSnapshot } from "./verified-file-snapshot.mjs";

const MAX_ENVIRONMENT_FILE_BYTES = 1024 * 1024;

export function assertMode0600RegularFile(path, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${label} must name an existing mode-0600 regular file.`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must name a non-symlink regular file with mode 0600.`);
  }
}

export function parseStrictDotenv(contents, label = "Environment file") {
  const values = {};
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = rawLine.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
    );
    if (!match) throw new Error(`${label} line ${index + 1} is malformed.`);
    const name = match[1];
    if (Object.hasOwn(values, name)) {
      throw new Error(`${label} contains duplicate ${name}.`);
    }

    const rawValue = match[2];
    const trimmed = rawValue.trim();
    let value;
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
      const quote = trimmed[0];
      if (trimmed.length < 2 || trimmed.at(-1) !== quote) {
        throw new Error(`${label} ${name} has an unterminated quoted value.`);
      }
      value = trimmed.slice(1, -1);
    } else {
      // Node's --env-file and Wrangler treat an unquoted # as a comment. Fail
      // closed so validation never checks a longer value than runtime loads.
      if (rawValue.includes("#")) {
        throw new Error(`${label} ${name} contains an unquoted #.`);
      }
      value = rawValue;
    }
    values[name] = value;
  }
  return values;
}

export function readStrictDotenvFile(path, label = "Environment file") {
  const snapshot = readVerifiedFileSnapshot(path, {
    label,
    maximumBytes: MAX_ENVIRONMENT_FILE_BYTES,
    requireMode0600: true,
    requireCanonical: true
  });
  return parseStrictDotenv(snapshot.contents.toString("utf8"), label);
}

export function assertSupportedRunnerEnvironment(values) {
  let targets;
  try {
    targets = JSON.parse(values.NARRATIVE_RUNNER_TARGET_MAP_JSON);
  } catch {
    throw new Error("attested runner target map is invalid");
  }
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    throw new Error("attested runner target map is invalid");
  }
  const tokenNames = new Set();
  for (const target of Object.values(targets)) {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("attested runner target map is invalid");
    }
    const tokenEnv = target.tokenEnv;
    if (
      typeof tokenEnv !== "string" ||
      !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_TOKEN$/.test(tokenEnv) ||
      tokenEnv.startsWith("NARRATIVE_RUNNER_")
    ) {
      throw new Error(`unsupported runner target token environment ${String(tokenEnv)}`);
    }
    tokenNames.add(tokenEnv);
  }
  for (const name of Object.keys(values)) {
    if (!name.startsWith("NARRATIVE_RUNNER_") && !tokenNames.has(name)) {
      throw new Error(`unsupported runner environment setting ${name}`);
    }
  }
  return tokenNames;
}
