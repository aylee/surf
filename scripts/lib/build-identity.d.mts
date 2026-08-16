export const SOURCE_REVISION_PATTERN: RegExp;
export const BUILD_DIGEST_PATTERN: RegExp;

export function clientProductionFiles(root?: string): string[];
export function digestFiles(root: string, files: string[]): string;
export function clientBuildDigest(root?: string): string;
export function workerBundleDigest(path: string): string;
export type ClientOutputIdentity = Readonly<{
  schemaVersion: 1;
  sha256: string;
  entries: readonly Readonly<{
    kind: "directory" | "file";
    path: string;
    bytes?: number;
  }>[];
}>;
export function captureClientOutputIdentity(directory: string): ClientOutputIdentity;
export function assertClientOutputIdentity(
  directory: string,
  expected: ClientOutputIdentity
): ClientOutputIdentity;
export function gitSourceRevision(root?: string): string;
export function resolveWebBuildIdentity(options?: {
  root?: string;
  environment?: NodeJS.ProcessEnv;
}): {
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly clientBuildDigest: string;
};
