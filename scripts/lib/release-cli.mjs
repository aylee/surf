const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function parseReleaseProdArguments(argv) {
  const options = {
    plan: false,
    yes: false,
    sha: null,
    resume: null,
    fixForward: null,
    replacePreMutation: null,
    forceFull: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") options.plan = true;
    else if (argument === "--yes") options.yes = true;
    else if (argument === "--force-full") options.forceFull = true;
    else if (
      [
        "--sha",
        "--resume",
        "--fix-forward",
        "--replace-pre-mutation"
      ].includes(argument)
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires one value`);
      }
      index += 1;
      if (argument === "--sha") options.sha = value;
      if (argument === "--resume") options.resume = value;
      if (argument === "--fix-forward") options.fixForward = value;
      if (argument === "--replace-pre-mutation") {
        options.replacePreMutation = value;
      }
    } else {
      throw new Error(`Unknown release option: ${argument}`);
    }
  }
  if (options.sha !== null && !SHA_PATTERN.test(options.sha)) {
    throw new Error("--sha must be an exact lowercase 40-character Git SHA");
  }
  for (const [name, value] of [
    ["--resume", options.resume],
    ["--fix-forward", options.fixForward],
    ["--replace-pre-mutation", options.replacePreMutation]
  ]) {
    if (value !== null && !RELEASE_ID_PATTERN.test(value)) {
      throw new Error(`${name} requires a valid release ID`);
    }
  }
  if (
    [options.resume, options.fixForward, options.replacePreMutation].filter(Boolean)
      .length > 1
  ) {
    throw new Error(
      "--resume, --fix-forward, and --replace-pre-mutation are mutually exclusive"
    );
  }
  if ((options.resume || options.fixForward) && options.sha) {
    throw new Error("Resume/fix-forward target identity comes from its journal, not --sha");
  }
  if (options.plan && (options.resume || options.fixForward)) {
    throw new Error("--plan cannot resume or fix forward a journal");
  }
  if (options.yes && !options.sha) {
    throw new Error("Non-interactive release requires --yes with an exact --sha");
  }
  return Object.freeze(options);
}

export function releaseIdFor(targetSha, now = new Date()) {
  if (!SHA_PATTERN.test(targetSha ?? "")) {
    throw new Error("Release ID target must be an exact Git SHA");
  }
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "z")
    .toLowerCase();
  return `${timestamp}-${targetSha.slice(0, 12)}`;
}

export function boundedReleasePreview({
  releaseId,
  targetGitSha,
  lane,
  changedPaths,
  reasonCodes,
  mismatchKeys,
  predecessorWorkerVersionId,
  mutations
}) {
  if (!RELEASE_ID_PATTERN.test(releaseId ?? "") || !SHA_PATTERN.test(targetGitSha ?? "")) {
    throw new Error("Release preview identity is invalid");
  }
  const boundedArray = (value, label, limit = 256) => {
    if (
      !Array.isArray(value) ||
      value.length > limit ||
      value.some(
        (entry) =>
          typeof entry !== "string" ||
          entry.length === 0 ||
          entry.length > 1024 ||
          /[\x00-\x1f\x7f]/.test(entry)
      )
    ) {
      throw new Error(`Release preview ${label} is unsafe`);
    }
    return Object.freeze([...value]);
  };
  return Object.freeze({
    schemaVersion: 1,
    releaseId,
    targetGitSha,
    lane,
    changedPaths: boundedArray(changedPaths, "changed paths"),
    reasonCodes: boundedArray(reasonCodes, "reason codes"),
    mismatchKeys: boundedArray(mismatchKeys, "mismatch keys"),
    predecessorWorkerVersionId: predecessorWorkerVersionId ?? null,
    mutations: boundedArray(mutations, "mutations", 32)
  });
}
