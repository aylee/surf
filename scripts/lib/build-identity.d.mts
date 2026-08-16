export const SOURCE_REVISION_PATTERN: RegExp;
export const BUILD_DIGEST_PATTERN: RegExp;

export function clientProductionFiles(root?: string): string[];
export function digestFiles(root: string, files: string[]): string;
export function clientBuildDigest(root?: string): string;
export function workerBundleDigest(path: string): string;
export function gitSourceRevision(root?: string): string;
export function resolveWebBuildIdentity(options?: {
  root?: string;
  environment?: NodeJS.ProcessEnv;
}): {
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly clientBuildDigest: string;
};
