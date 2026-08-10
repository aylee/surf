export type LaunchAgentRenderOptions = {
  outputDir: string;
  repositoryPath: string;
  releaseSha: string;
  runnerEnvPath: string;
  launchAgentsDir?: string;
  runnerExitTimeoutSeconds: number | string;
  pnpmPath: string;
  nodeBinPath: string;
  omlxPath: string;
  omlxDataPath: string;
  modelArtifactPath: string;
  wranglerConfigPath: string;
  wranglerConfigSha256: string;
  workerSecretsPath: string;
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
  options?: { requireInstalled?: boolean }
): Promise<{
  status: "ok";
  releaseSha: string;
  modelId: string;
  wranglerConfigSha256: string;
  modelArtifactSha256: string;
}>;
