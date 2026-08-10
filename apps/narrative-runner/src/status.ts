import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const RunnerStateSchema = z.enum([
  "starting",
  "idle",
  "processing",
  "backing_off",
  "halted",
  "stopped"
]);

export const RunnerStatusSchema = z
  .object({
    schemaVersion: z.literal(2),
    runnerId: z.string().min(1),
    pid: z.number().int().positive(),
    modelId: z.string().min(1),
    releaseSha: z.string().regex(/^[0-9a-f]{40}$/),
    runtimeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    state: RunnerStateSchema,
    startedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    inFlight: z.number().int().nonnegative(),
    pulled: z.number().int().nonnegative(),
    acked: z.number().int().nonnegative(),
    retried: z.number().int().nonnegative(),
    terminal: z.number().int().nonnegative(),
    backlogCount: z.number().int().nonnegative().nullable(),
    lastOutcome: z.string().nullable(),
    lastErrorCode: z.string().nullable()
  })
  .strict();

export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;

export interface StatusStore {
  write(status: RunnerStatus): Promise<void>;
}

export class FileStatusStore implements StatusStore {
  constructor(private readonly path: string) {}

  async write(status: RunnerStatus): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(RunnerStatusSchema.parse(status))}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
  }
}

export class MemoryStatusStore implements StatusStore {
  readonly writes: RunnerStatus[] = [];

  async write(status: RunnerStatus): Promise<void> {
    this.writes.push(structuredClone(status));
  }
}

export async function readRunnerStatus(path: string): Promise<RunnerStatus | null> {
  try {
    return RunnerStatusSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new Error("Runner status file is invalid");
  }
}

export class StatusTracker {
  private snapshot: RunnerStatus;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    runnerId: string,
    modelId: string,
    releaseSha: string,
    runtimeFingerprint: string,
    private readonly store: StatusStore,
    now: () => Date = () => new Date()
  ) {
    const timestamp = now().toISOString();
    this.now = now;
    this.snapshot = {
      schemaVersion: 2,
      runnerId,
      pid: process.pid,
      modelId,
      releaseSha,
      runtimeFingerprint,
      state: "starting",
      startedAt: timestamp,
      updatedAt: timestamp,
      inFlight: 0,
      pulled: 0,
      acked: 0,
      retried: 0,
      terminal: 0,
      backlogCount: null,
      lastOutcome: null,
      lastErrorCode: null
    };
  }

  private readonly now: () => Date;

  current(): RunnerStatus {
    return structuredClone(this.snapshot);
  }

  update(
    change: Partial<
      Pick<
        RunnerStatus,
        "state" | "inFlight" | "backlogCount" | "lastOutcome" | "lastErrorCode"
      >
    > & {
      pulledDelta?: number;
      ackedDelta?: number;
      retriedDelta?: number;
      terminalDelta?: number;
    }
  ): Promise<void> {
    const {
      pulledDelta = 0,
      ackedDelta = 0,
      retriedDelta = 0,
      terminalDelta = 0,
      ...fields
    } = change;
    this.snapshot = RunnerStatusSchema.parse({
      ...this.snapshot,
      ...fields,
      updatedAt: this.now().toISOString(),
      pulled: this.snapshot.pulled + pulledDelta,
      acked: this.snapshot.acked + ackedDelta,
      retried: this.snapshot.retried + retriedDelta,
      terminal: this.snapshot.terminal + terminalDelta
    });
    const value = this.current();
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(() => this.store.write(value));
    return this.pendingWrite;
  }
}
