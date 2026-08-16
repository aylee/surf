export type RunnerDrainReceipt = Readonly<{
  schemaVersion: 1;
  priorActivationId: string | null;
  priorReleaseSha: string;
  priorPid: number;
  outcome: "stopped" | "compatible-halted";
  heartbeatUpdatedAt: string;
  observedAt: string;
  acceptedProtocolFingerprints: readonly string[];
  runnerLabelInitiallyLoaded: boolean;
  runnerLabelUnloaded: true;
  maxWaitMs: number;
}>;

export function activateLaunchAgents(
  options: {
    recordPath: string;
    priorRecordPath?: string | null;
    environment?: NodeJS.ProcessEnv;
    transitionMode?: "activate" | "rollback";
  },
  dependencies?: Record<string, unknown>
): Promise<{
  status: "ok";
  releaseSha: string;
  activationId: string | null;
  changed: boolean;
  drainReceipt: RunnerDrainReceipt | null;
}>;

export function canRecoverHaltedRunner(options: {
  priorRecord: Record<string, unknown>;
  targetRecord: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  labelUnloaded: boolean;
  priorPid: number;
  pidAlive: boolean;
  nowMs: number;
}): boolean;
