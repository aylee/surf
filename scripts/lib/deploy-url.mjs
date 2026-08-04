const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
