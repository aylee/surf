export type LaunchAgentRenderOptions = {
  outputDir: string;
  repositoryPath: string;
  releaseSha: string;
  runnerEnvPath: string;
  runnerArtifactPath: string;
  runnerArtifactManifestPath?: string;
  launchAgentsDir?: string;
  runnerExitTimeoutSeconds: number | string;
  nodeBinPath: string;
  omlxPath: string;
  omlxDataPath: string;
  modelArtifactPath: string;
  logDir: string;
  environment?: NodeJS.ProcessEnv;
};

export function renderLaunchAgents(
  options: LaunchAgentRenderOptions
): Promise<string[]>;

export function validateImmutableRelease(
  repositoryPath: string,
  releaseSha: string
): Promise<void>;

export function verifyLaunchActivation(
  recordPath: string,
  options?: { requireInstalled?: boolean; allowLegacyV3?: boolean }
): Promise<{
  status: "ok";
  schemaVersion: 3 | 4;
  transitionOnly: boolean;
  activationId?: string;
  releaseSha: string;
  modelId: string;
  runnerArtifactSha256?: string;
  acceptedProtocols: Array<{
    family: string;
    version: number;
    fingerprint: string;
  }>;
  modelArtifactSha256: string;
}>;
