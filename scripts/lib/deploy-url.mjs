export function resolveDeployedUrl(output, configuredUrl) {
  const plainOutput = output.replace(/\u001b\[[0-9;]*m/g, "");
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
