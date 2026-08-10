import { hasCloudflareApiErrorCode } from "./cloudflare-commands.mjs";

export const UNSUPPORTED_CUSTOM_CPU_LIMIT_CODE = 100328;

export function workerVersionUploadFailure(error) {
  if (hasCloudflareApiErrorCode(error, UNSUPPORTED_CUSTOM_CPU_LIMIT_CODE)) {
    return new Error(
      "Cloudflare rejected the configured 2,000 ms CPU limit (100328). Workers Free is unsupported. Queue reconciliation may already have created missing Queues, but this deployment has not run any D1 migration or seed. Do not remove the runtime guard or retry on Free.",
      { cause: error }
    );
  }
  return new Error(
    "Worker version staging failed after configured Queue reconciliation and before any D1 migration or seed. Only a successful upload proves that the account accepts the configured 2,000 ms CPU limit. Fix the reported upload error before retrying.",
    { cause: error }
  );
}
