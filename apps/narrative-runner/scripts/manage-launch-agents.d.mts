type RunnerDrainReceiptFields = Readonly<{
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

export type RunnerDrainReceipt =
  | (RunnerDrainReceiptFields & Readonly<{ schemaVersion: 1 }>)
  | (RunnerDrainReceiptFields &
      Readonly<{ schemaVersion: 2; heartbeatPid: number }>);

export type CommittedRunnerDrainEvidence = Readonly<{
  schemaVersion: 1;
  targetActivationId: string;
  targetReleaseSha: string;
  targetRecordSha256: string;
  priorActivationId: string | null;
  priorReleaseSha: string;
  priorRecordSha256: string;
  drainIntent: Readonly<Record<string, unknown>>;
  drainIntentSha256: string;
  drainReceipt: RunnerDrainReceipt;
  drainReceiptSha256: string;
  attemptDrainReceiptSha256: string | null;
  semanticReceiptSha256: string;
}>;

export function verifyCommittedRunnerDrainEvidence(
  options: {
    targetRecordPath: string;
    priorRecordPath: string;
    attemptDrainReceiptPath?: string | null;
  },
  dependencies?: Record<string, unknown>
): Promise<CommittedRunnerDrainEvidence>;

export type RunnerTransitionInstallState = Readonly<{
  schemaVersion: 1;
  targetActivationId: string;
  targetReleaseSha: string;
  targetRecordSha256: string;
  priorActivationId: string | null;
  priorReleaseSha: string;
  priorRecordSha256: string;
  narrativeRunner: "prior" | "target";
  omlxServer: "prior" | "target";
  targetCommitted: boolean;
  validPrecommit: boolean;
}>;

export function inspectRunnerTransitionInstallState(
  options: {
    targetRecordPath: string;
    priorRecordPath: string;
    environment?: NodeJS.ProcessEnv;
  },
  dependencies?: Record<string, unknown>
): Promise<RunnerTransitionInstallState>;

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
  drainIntent: Record<string, unknown>;
  priorPidAlive: boolean;
  heartbeatPidAlive: boolean;
  nowMs: number;
}): boolean;

export function canRecoverStoppedChildRunner(options: {
  priorRecord: Record<string, unknown>;
  targetRecord: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  labelUnloaded: boolean;
  drainIntent: Record<string, unknown>;
  priorPidAlive: boolean;
  heartbeatPidAlive: boolean;
  nowMs: number;
}): boolean;
