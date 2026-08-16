import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const RUNNER_STATUS_MAX_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

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
    schemaVersion: z.literal(3),
    runnerId: z.string().min(1),
    pid: z.number().int().positive(),
    modelId: z.string().min(1),
    activationId: z.string().min(1).max(200),
    runnerArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
    runtimeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    acceptedProtocolFingerprints: z
      .array(z.string().regex(/^[0-9a-f]{64}$/))
      .min(1)
      .max(16)
      .refine((values) => new Set(values).size === values.length, {
        message: "accepted protocol fingerprints must be unique"
      }),
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

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Runner status directory is unsafe");
  }
}

async function assertExistingStatusFileIsSafe(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw new Error("Runner status path is not a mode-0600 regular file");
    }
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, fsConstants.O_RDONLY);
  try {
    await directory.sync();
  } catch (error) {
    if (
      !["EINVAL", "ENOTSUP", "EISDIR"].some((code) =>
        isFileSystemError(error, code)
      )
    ) {
      throw error;
    }
  } finally {
    await directory.close();
  }
}

export class FileStatusStore implements StatusStore {
  constructor(private readonly path: string) {}

  async write(status: RunnerStatus): Promise<void> {
    if (!isAbsolute(this.path)) {
      throw new Error("Runner status path must be absolute");
    }
    const contents = `${JSON.stringify(RunnerStatusSchema.parse(status))}\n`;
    if (new TextEncoder().encode(contents).byteLength > RUNNER_STATUS_MAX_BYTES) {
      throw new Error("Runner status exceeds its bounded file size");
    }
    const directory = dirname(this.path);
    await ensurePrivateDirectory(directory);
    await assertExistingStatusFileIsSafe(this.path);
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
      await syncDirectory(directory);
    } finally {
      if (handle) await handle.close();
      await rm(temporaryPath, { force: true });
    }
  }
}

export class MemoryStatusStore implements StatusStore {
  readonly writes: RunnerStatus[] = [];

  async write(status: RunnerStatus): Promise<void> {
    this.writes.push(structuredClone(status));
  }
}

export async function readRunnerStatus(path: string): Promise<RunnerStatus | null> {
  let handle;
  try {
    if (!isAbsolute(path)) throw new Error("Runner status path must be absolute");
    const directoryMetadata = await lstat(dirname(path));
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error("Runner status directory is unsafe");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      (before.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE) ||
      before.size < 2n ||
      before.size > BigInt(RUNNER_STATUS_MAX_BYTES)
    ) {
      throw new Error("Runner status path is not a bounded mode-0600 regular file");
    }
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(contents.byteLength) !== before.size
    ) {
      throw new Error("Runner status file changed while it was read");
    }
    return RunnerStatusSchema.parse(JSON.parse(contents.toString("utf8")));
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return null;
    }
    throw new Error("Runner status file is invalid");
  } finally {
    if (handle) await handle.close();
  }
}

export class StatusTracker {
  private snapshot: RunnerStatus;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    identity: {
      runnerId: string;
      modelId: string;
      activationId: string;
      runnerArtifactSha256: string;
      sourceRevision: string;
      runtimeFingerprint: string;
      acceptedProtocolFingerprints: readonly string[];
    },
    private readonly store: StatusStore,
    now: () => Date = () => new Date()
  ) {
    const timestamp = now().toISOString();
    this.now = now;
    this.snapshot = {
      schemaVersion: 3,
      runnerId: identity.runnerId,
      pid: process.pid,
      modelId: identity.modelId,
      activationId: identity.activationId,
      runnerArtifactSha256: identity.runnerArtifactSha256,
      sourceRevision: identity.sourceRevision,
      runtimeFingerprint: identity.runtimeFingerprint,
      acceptedProtocolFingerprints: [...identity.acceptedProtocolFingerprints],
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
