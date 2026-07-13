import type { SourceFetch } from "./types";

/** Safe local/default identity; deployed operators should configure their own contact. */
export const PUBLIC_FEED_USER_AGENT =
  "surf-self-hosted/1.0 (+https://github.com/aylee/surf)";

export function withPublicFeedUserAgent(
  fetcher: SourceFetch,
  configuredUserAgent?: string
): SourceFetch {
  const userAgent = configuredUserAgent?.trim() || PUBLIC_FEED_USER_AGENT;
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", userAgent);
    return fetcher(input, { ...init, headers });
  };
}
