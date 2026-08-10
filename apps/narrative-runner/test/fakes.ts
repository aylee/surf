import { Buffer } from "node:buffer";
import type {
  JsonValue,
  NarrativeJob,
  NarrativeResultResponse
} from "@surf/narrative-contracts";
import type { RunnerConfig } from "../src/config";
import { MemoryLogger } from "../src/logger";
import type { OmlxClient, OmlxGeneration } from "../src/omlx-client";
import type {
  PulledQueueMessage,
  QueueClient,
  QueuePullResult
} from "../src/queue-client";
import type { ResultClient } from "../src/result-client";
import type { RunnerTerminalReport } from "../src/result-client";
import { NarrativeRunner } from "../src/runner";
import { MemoryStatusStore, StatusTracker } from "../src/status";

export type JobOptions = {
  deadlineAt?: string;
  domain?: string;
  jobId?: string;
  target?: string;
  submissionId?: string;
  responseSchema?: Record<string, JsonValue>;
};

export function makeJob(options: JobOptions = {}): NarrativeJob {
  return {
    schemaVersion: 1,
    jobId: options.jobId ?? "job-1",
    domain: options.domain ?? "weather",
    entity: { id: "entity-1", localDate: "2026-08-09" },
    factFingerprint: "a".repeat(64),
    materialFingerprint: "b".repeat(64),
    generationFingerprint: "c".repeat(64),
    promptVersion: "narrative.v1",
    outputSchemaVersion: 1,
    deadlineAt: options.deadlineAt ?? "2026-08-09T20:00:00.000Z",
    capability: {
      protocol: "openai-chat-completions",
      structuredOutput: "json-schema"
    },
    result: {
      target: options.target ?? "weather.summary.v1",
      submissionId: options.submissionId ?? "submission-1"
    },
    inference: {
      messages: [
        { role: "system", content: "Return a concise structured summary." },
        { role: "user", content: "Summarize the supplied public facts." }
      ],
      responseSchema: options.responseSchema ?? {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false
      },
      maxOutputTokens: 256,
      temperature: 0
    }
  };
}

export function queueMessage(
  job: NarrativeJob,
  options: {
    id?: string;
    leaseId?: string;
    attempts?: number;
    contentType?: "json" | "text" | "bytes";
  } = {}
): PulledQueueMessage {
  const contentType = options.contentType ?? "json";
  const serialized = JSON.stringify(job);
  return {
    id: options.id ?? `message-${job.jobId}`,
    lease_id: options.leaseId ?? `lease-${job.jobId}`,
    attempts: options.attempts ?? 1,
    timestamp_ms: Date.parse("2026-08-09T18:00:00.000Z"),
    metadata: { "CF-Content-Type": contentType },
    body:
      contentType === "text"
        ? serialized
        : Buffer.from(serialized, "utf8").toString("base64")
  };
}

export class FakeQueueClient implements QueueClient {
  preflightCalls = 0;
  readonly pullCalls: number[] = [];
  readonly acked: string[] = [];
  readonly retried: Array<{ leaseId: string; delaySeconds: number }> = [];
  pullError: unknown = null;
  ackError: unknown = null;
  retryError: unknown = null;
  preflightError: unknown = null;

  constructor(readonly messages: PulledQueueMessage[] = []) {}

  async preflight(): Promise<{
    queueName: string;
    consumerType: "http_pull";
    deadLetterQueueName: string;
  }> {
    this.preflightCalls += 1;
    if (this.preflightError) throw this.preflightError;
    return {
      queueName: "surf-narrative",
      consumerType: "http_pull",
      deadLetterQueueName: "surf-narrative-dlq"
    };
  }

  async pull(batchSize: number): Promise<QueuePullResult> {
    this.pullCalls.push(batchSize);
    if (this.pullError) throw this.pullError;
    return {
      messages: this.messages.splice(0, batchSize),
      backlogCount: this.messages.length
    };
  }

  async ack(leaseId: string): Promise<void> {
    if (this.ackError) throw this.ackError;
    this.acked.push(leaseId);
  }

  async retry(leaseId: string, delaySeconds: number): Promise<void> {
    if (this.retryError) throw this.retryError;
    this.retried.push({ leaseId, delaySeconds });
  }
}

export class FakeOmlxClient implements OmlxClient {
  preflightCalls = 0;
  readonly generateCalls: Array<{ job: NarrativeJob; timeoutMs: number | undefined }> = [];
  preflightHandler: () => Promise<void> = async () => undefined;
  generateHandler: (job: NarrativeJob, timeoutMs?: number) => Promise<OmlxGeneration> =
    async () => ({
      output: { summary: "ok" },
      modelId: "local-model"
    });

  async preflight(): Promise<void> {
    this.preflightCalls += 1;
    await this.preflightHandler();
  }

  async generate(job: NarrativeJob, timeoutMs?: number): Promise<OmlxGeneration> {
    this.generateCalls.push({ job, timeoutMs });
    return this.generateHandler(job, timeoutMs);
  }
}

export class FakeResultClient implements ResultClient {
  readonly submitCalls: Array<{
    job: NarrativeJob;
    modelId: string;
    output: JsonValue;
    timeoutMs: number | undefined;
  }> = [];
  readonly terminalCalls: Array<{
    job: NarrativeJob;
    terminal: RunnerTerminalReport;
    timeoutMs: number | undefined;
  }> = [];
  submitHandler: (
    job: NarrativeJob,
    modelId: string,
    output: JsonValue,
    timeoutMs?: number
  ) => Promise<NarrativeResultResponse> = async (job) => ({
    disposition: "published",
    jobId: job.jobId
  });
  terminalHandler: (
    job: NarrativeJob,
    terminal: RunnerTerminalReport,
    timeoutMs?: number
  ) => Promise<NarrativeResultResponse> = async (job, terminal) => ({
    disposition: terminal.status,
    jobId: job.jobId
  });

  constructor(readonly targets = new Set(["weather.summary.v1"])) {}

  hasTarget(targetId: string): boolean {
    return this.targets.has(targetId);
  }

  async submit(
    job: NarrativeJob,
    modelId: string,
    output: JsonValue,
    timeoutMs?: number
  ): Promise<NarrativeResultResponse> {
    this.submitCalls.push({ job, modelId, output, timeoutMs });
    return this.submitHandler(job, modelId, output, timeoutMs);
  }

  async submitTerminal(
    job: NarrativeJob,
    terminal: RunnerTerminalReport,
    timeoutMs?: number
  ): Promise<NarrativeResultResponse> {
    this.terminalCalls.push({ job, terminal, timeoutMs });
    return this.terminalHandler(job, terminal, timeoutMs);
  }
}

type ConfigOverrides = Partial<Omit<RunnerConfig, "queue" | "omlx" | "targets">> & {
  queue?: Partial<RunnerConfig["queue"]>;
  omlx?: Partial<RunnerConfig["omlx"]>;
  targets?: RunnerConfig["targets"];
};

export function makeConfig(overrides: ConfigOverrides = {}): RunnerConfig {
  const base: RunnerConfig = {
    runnerId: "runner-test",
    releaseSha: "a".repeat(40),
    runtimeFingerprint: "b".repeat(64),
    queue: {
      apiBaseUrl: "https://api.cloudflare.com/client/v4",
      accountId: "account-test",
      queueId: "queue-test",
      name: "surf-narrative",
      deadLetterQueueName: "surf-narrative-dlq",
      retryDelaySeconds: 30,
      apiToken: "queue-secret"
    },
    omlx: {
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local-model",
      apiToken: null,
      enableThinking: false,
      timeoutMs: 120_000
    },
    targets: new Map([
      [
        "weather.summary.v1",
        { url: "https://result.example/internal/results", token: "result-secret" }
      ]
    ]),
    concurrency: 1,
    visibilityTimeoutMs: 180_000,
    queueTimeoutMs: 30_000,
    pollIntervalMs: 1_000,
    idleMaxMs: 16_000,
    heartbeatIntervalMs: 5_000,
    preflightIntervalMs: 10_000,
    modelBackoffMs: 5_000,
    resultTimeoutMs: 10_000,
    retryBaseSeconds: 30,
    retryMaxSeconds: 3_600,
    statusFile: "/tmp/narrative-runner-test-status.json"
  };
  return {
    ...base,
    ...overrides,
    queue: { ...base.queue, ...overrides.queue },
    omlx: { ...base.omlx, ...overrides.omlx },
    targets: overrides.targets ?? base.targets
  };
}

export class TestClock {
  constructor(public milliseconds = Date.parse("2026-08-09T18:00:00.000Z")) {}

  readonly now = (): Date => new Date(this.milliseconds);

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

export function makeRunnerHarness(options: {
  config?: RunnerConfig;
  queue?: FakeQueueClient;
  omlx?: FakeOmlxClient;
  results?: FakeResultClient;
  clock?: TestClock;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
} = {}) {
  const config = options.config ?? makeConfig();
  const queue = options.queue ?? new FakeQueueClient();
  const omlx = options.omlx ?? new FakeOmlxClient();
  const results = options.results ?? new FakeResultClient();
  const clock = options.clock ?? new TestClock();
  const store = new MemoryStatusStore();
  const status = new StatusTracker(
    config.runnerId,
    config.omlx.modelId,
    config.releaseSha,
    config.runtimeFingerprint,
    store,
    clock.now
  );
  const logger = new MemoryLogger();
  const runner = new NarrativeRunner(config, {
    queue,
    omlx,
    results,
    status,
    logger,
    now: clock.now,
    random: options.random ?? (() => 0.5),
    sleep: options.sleep ?? (async () => undefined)
  });
  return { config, queue, omlx, results, clock, store, status, logger, runner };
}
