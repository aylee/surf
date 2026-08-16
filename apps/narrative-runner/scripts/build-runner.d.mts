import type { NarrativeProtocolDescriptor } from "@surf/narrative-contracts";

export type RunnerArtifactBuildResult = {
  artifactPath: string;
  manifestPath: string;
  artifact: {
    sha256: string;
    bytes: number;
  };
  acceptedProtocols: readonly NarrativeProtocolDescriptor[];
};

export function buildRunnerArtifact(options?: {
  root?: string;
  outputDir?: string;
}): Promise<RunnerArtifactBuildResult>;
