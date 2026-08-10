import type { ChildProcess } from "node:child_process";

export function runVerifiedRunner(
  argv: string[],
  dependencies?: {
    verify?: (
      recordPath: string,
      options: { requireInstalled: true }
    ) => Promise<unknown>;
    spawn?: (
      command: string,
      args: string[],
      options: Record<string, unknown>
    ) => ChildProcess;
  }
): Promise<number>;
