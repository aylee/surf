export function activateLaunchAgents(
  options: {
    recordPath: string;
    priorRecordPath?: string | null;
    environment?: NodeJS.ProcessEnv;
  },
  dependencies?: Record<string, unknown>
): Promise<{ status: "ok"; releaseSha: string; changed: boolean }>;
