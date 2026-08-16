const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_NANOSECONDS_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function stripAnsi(output) {
  return output.replace(/\u001b\[[0-9;]*m/g, "");
}

export function resolveDeployedVersionId(output) {
  const lines = stripAnsi(output).split(/\r?\n/);
  const versionLines = lines.filter((line) =>
    /^\s*Current Version ID:/.test(line)
  );
  if (versionLines.length !== 1) {
    throw new Error(
      `Wrangler deploy output must contain exactly one Current Version ID line; found ${versionLines.length}.`
    );
  }

  const match = versionLines[0].match(
    /^\s*Current Version ID:\s*([^\s]+)\s*$/
  );
  if (!match || !VERSION_ID_PATTERN.test(match[1])) {
    throw new Error("Wrangler deploy output contained an invalid Current Version ID UUID.");
  }
  return match[1];
}

export function resolveUploadedVersionId(output) {
  const lines = stripAnsi(output).split(/\r?\n/);
  const versionLines = lines.filter((line) =>
    /^\s*Worker Version ID:/.test(line)
  );
  if (versionLines.length !== 1) {
    throw new Error(
      `Wrangler versions upload output must contain exactly one Worker Version ID line; found ${versionLines.length}.`
    );
  }

  const match = versionLines[0].match(
    /^\s*Worker Version ID:\s*([^\s]+)\s*$/
  );
  if (!match || !VERSION_ID_PATTERN.test(match[1])) {
    throw new Error(
      "Wrangler versions upload output contained an invalid Worker Version ID UUID."
    );
  }
  return match[1];
}

function exactCloudflareTimestamp(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = value.match(ISO_UTC_NANOSECONDS_PATTERN);
  if (!match) return null;
  const wholeSecond = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  const milliseconds = Date.parse(`${wholeSecond}.000Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== `${wholeSecond}.000Z`
  ) {
    return null;
  }
  return value;
}

function activeDeploymentStatus(output, expectedVersionId) {
  if (!VERSION_ID_PATTERN.test(expectedVersionId)) {
    throw new Error("Expected Worker version must be a UUID.");
  }

  let status;
  try {
    status = JSON.parse(stripAnsi(output).trim());
  } catch {
    throw new Error("Wrangler deployment status must be exactly one JSON object.");
  }
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("Wrangler deployment status must be a JSON object.");
  }
  if (!VERSION_ID_PATTERN.test(status.id ?? "")) {
    throw new Error("Wrangler deployment status contained an invalid deployment ID UUID.");
  }
  if (status.strategy !== "percentage") {
    throw new Error(
      `Wrangler deployment status used an unsupported strategy: ${String(status.strategy)}.`
    );
  }
  if (!Array.isArray(status.versions) || status.versions.length !== 1) {
    throw new Error(
      `Active deployment must contain exactly one version; found ${Array.isArray(status.versions) ? status.versions.length : "invalid"}.`
    );
  }

  const [activeVersion] = status.versions;
  if (!activeVersion || typeof activeVersion !== "object" || Array.isArray(activeVersion)) {
    throw new Error("Active deployment version must be a JSON object.");
  }
  if (activeVersion.version_id !== expectedVersionId) {
    throw new Error(
      `Active deployment version does not match the uploaded Worker version; expected ${expectedVersionId}, received ${activeVersion.version_id ?? "missing"}.`
    );
  }
  if (
    typeof activeVersion.percentage !== "number" ||
    !Number.isFinite(activeVersion.percentage) ||
    activeVersion.percentage !== 100
  ) {
    throw new Error(
      `Uploaded Worker version must receive exactly 100% of deployment traffic; received ${String(activeVersion.percentage)}.`
    );
  }
  return status;
}

export function resolveActiveDeploymentId(output, expectedVersionId) {
  return activeDeploymentStatus(output, expectedVersionId).id;
}

export function resolveActiveDeploymentEvidence(output, expectedVersionId) {
  const status = activeDeploymentStatus(output, expectedVersionId);
  const createdOn = exactCloudflareTimestamp(status.created_on);
  if (createdOn === null) {
    throw new Error(
      "Wrangler deployment status contained an invalid Cloudflare creation time."
    );
  }
  return Object.freeze({ deploymentId: status.id, createdOn });
}

export function resolveDeployedUrl(output, configuredUrl) {
  const plainOutput = stripAnsi(output);
  const candidates = plainOutput.match(/https:\/\/[^\s]+/g) ?? [];
  const emittedUrl = candidates
    .map((candidate) => candidate.replace(/[),.;]+$/, ""))
    .find((candidate) => candidate.includes(".workers.dev"));
  if (emittedUrl) return emittedUrl;

  if (!configuredUrl) return undefined;
  const url = new URL(configuredUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("SURF_BASE_URL fallback must be a bare HTTPS origin.");
  }
  return url.origin;
}
