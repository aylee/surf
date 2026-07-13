export function resolveIngestTarget(mode, env = process.env) {
  if (mode === "--local") {
    return { baseUrl: "http://127.0.0.1:8787", token: undefined };
  }
  if (mode !== "--remote") {
    throw new Error("Choose an explicit target: --local or --remote");
  }

  const configuredUrl = env.SURF_BASE_URL;
  const token = env.SURF_INGEST_TOKEN;
  if (!configuredUrl) {
    throw new Error("Remote ingest requires SURF_BASE_URL in the shell or root .env.");
  }
  if (!token) {
    throw new Error("Remote ingest requires SURF_INGEST_TOKEN in the shell or root .env.");
  }

  const url = new URL(configuredUrl);
  if (url.protocol !== "https:") throw new Error("Remote ingest requires an https:// SURF_BASE_URL.");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SURF_BASE_URL must be a bare HTTPS origin without credentials, path, query, or fragment.");
  }
  return { baseUrl: url.origin, token };
}
