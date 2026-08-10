import type { NarrativeJob, NarrativeResultDisposition } from "@surf/narrative-contracts";
import type { RunnerConfig } from "./config";
import { RunnerFailure, runnerFailure } from "./errors";
import { JsonLineLogger, type RunnerLogger } from "./logger";
import { OpenAiCompatibleOmlxClient, type OmlxClient } from "./omlx-client";
import {
  CloudflareQueueClient,
  decodeNarrativeJob,
  type PulledQueueMessage,
  type QueueClient
} from "./queue-client";
import {
  createResultClient,
  type ResultClient,
  type RunnerTerminalReport
} from "./result-client";
import { FileStatusStore, StatusTracker } from "./status";

export type MessageOutcome = {
  messageId: string;
  jobId: string | null;
  domain: string | null;
  action: "ack" | "retry" | "unsettled";
  code: string;
  disposition: NarrativeResultDisposition | null;
  retryDelaySeconds: number | null;
};

export type PollResult = {
  pulled: number;
  tasks: Array<Promise<MessageOutcome>>;
};

export type RunnerDependencies = {
  queue: QueueClient;
  omlx: OmlxClient;
  results: ResultClient;
  status: StatusTracker;
  logger: RunnerLogger;
  now: () => Date;
  random: () => number;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function deadlineMs(job: NarrativeJob): number {
  return Date.parse(job.deadlineAt);
}

export class NarrativeRunner {
  private static readonly RESULT_SUBMISSION_MARGIN_MS = 5_000;
  private static readonly LOCAL_RETRY_BASE_MS = 250;
  private readonly inFlight = new Set<Promise<MessageOutcome>>();
  private modelReadyUntilMs = 0;
  private intakeBlockedUntilMs = 0;
  private intakeBlockedCode: string | null = null;
  private intakeHaltedCode: string | null = null;

  constructor(
    private readonly config: RunnerConfig,
    private readonly dependencies: RunnerDependencies
  ) {}

  availableCapacity(): number {
    return Math.max(0, this.config.concurrency - this.inFlight.size);
  }

  private async updateStatus(
    change: Parameters<StatusTracker["update"]>[0]
  ): Promise<void> {
    try {
      await this.dependencies.status.update(change);
    } catch {
      this.dependencies.logger.event("narrative_status_write_failed", {
        runnerId: this.config.runnerId
      });
    }
  }

  private async ensureModelReady(force = false): Promise<void> {
    const currentMs = this.dependencies.now().getTime();
    if (!force && currentMs < this.modelReadyUntilMs) return;
    await this.dependencies.omlx.preflight();
    this.modelReadyUntilMs = currentMs + this.config.preflightIntervalMs;
  }

  async preflight(): Promise<void> {
    await this.ensureModelReady(true);
  }

  private retryDelaySeconds(attempts: number): number {
    const exponent = Math.min(20, Math.max(0, attempts - 1));
    return Math.min(
      this.config.retryMaxSeconds,
      this.config.retryBaseSeconds * 2 ** exponent
    );
  }

  private expired(job: NarrativeJob): boolean {
    return this.dependencies.now().getTime() >= deadlineMs(job);
  }

  private remainingMs(job: NarrativeJob): number {
    return Math.max(0, deadlineMs(job) - this.dependencies.now().getTime());
  }

  private leaseRemainingMs(leaseStartedMs: number): number {
    return Math.max(
      0,
      this.config.visibilityTimeoutMs -
        (this.dependencies.now().getTime() - leaseStartedMs)
    );
  }

  private async waitForLocalRetry(options: {
    operation: "inference" | "generated_result" | "terminal_result";
    code: string;
    job: NarrativeJob;
    leaseStartedMs: number;
    deadlineReserveMs?: number;
    leaseReserveMs: number;
  }): Promise<boolean> {
    const random = Math.min(1, Math.max(0, this.dependencies.random()));
    const delayMs =
      NarrativeRunner.LOCAL_RETRY_BASE_MS +
      Math.round(NarrativeRunner.LOCAL_RETRY_BASE_MS * random);
    if (
      (options.deadlineReserveMs !== undefined &&
        this.remainingMs(options.job) <= delayMs + options.deadlineReserveMs) ||
      this.leaseRemainingMs(options.leaseStartedMs) <=
        delayMs + options.leaseReserveMs
    ) {
      return false;
    }
    this.dependencies.logger.event("narrative_local_retry_scheduled", {
      jobId: options.job.jobId,
      domain: options.job.domain,
      operation: options.operation,
      code: options.code,
      delayMs
    });
    await this.dependencies.sleep(delayMs);
    return (
      (options.deadlineReserveMs === undefined ||
        this.remainingMs(options.job) > options.deadlineReserveMs) &&
      this.leaseRemainingMs(options.leaseStartedMs) > options.leaseReserveMs
    );
  }

  private intakeBlocked(): boolean {
    return this.dependencies.now().getTime() < this.intakeBlockedUntilMs;
  }

  private intakeHalted(): boolean {
    return this.intakeHaltedCode !== null;
  }

  private inactiveState(): "idle" | "backing_off" | "halted" {
    if (this.intakeHalted()) return "halted";
    return this.intakeBlocked() ? "backing_off" : "idle";
  }

  private async haltIntake(code: string): Promise<void> {
    this.intakeHaltedCode = code;
    this.intakeBlockedUntilMs = 0;
    this.intakeBlockedCode = null;
    await this.updateStatus({
      state: "halted",
      lastErrorCode: code
    });
    this.dependencies.logger.event("narrative_intake_halted", { code });
  }

  private async blockIntake(code: string): Promise<void> {
    if (this.intakeHalted()) {
      await this.updateStatus({
        state: "halted",
        lastErrorCode: this.intakeHaltedCode
      });
      return;
    }
    this.intakeBlockedUntilMs = Math.max(
      this.intakeBlockedUntilMs,
      this.dependencies.now().getTime() +
        Math.max(this.config.modelBackoffMs, this.config.preflightIntervalMs)
    );
    this.intakeBlockedCode = code;
    await this.updateStatus({
      state: "backing_off",
      lastErrorCode: code
    });
    this.dependencies.logger.event("narrative_intake_circuit_opened", { code });
  }

  private async blockModelIntake(code: string): Promise<void> {
    this.modelReadyUntilMs = 0;
    await this.blockIntake(code);
  }

  private async handleCallbackFailure(failure: RunnerFailure): Promise<void> {
    const persistent =
      failure.disposition === "terminal" ||
      [
        "result_submit_auth",
        "result_submit_http_terminal",
        "result_submit_identity_mismatch",
        "result_submit_response_invalid",
        "terminal_submission_invalid"
      ].includes(failure.code);
    if (persistent) {
      await this.haltIntake(failure.code);
    } else {
      await this.blockIntake(failure.code);
    }
  }

  private async handleSettlementFailure(failure: RunnerFailure): Promise<void> {
    const persistent =
      failure.disposition === "terminal" ||
      ["queue_api_auth", "queue_api_http_terminal"].includes(failure.code);
    if (persistent) {
      await this.haltIntake(failure.code);
    } else {
      await this.blockIntake(failure.code);
    }
  }

  private idleDelayMs(emptyPullCount: number): number {
    const exponent = Math.min(20, Math.max(0, emptyPullCount - 1));
    const ceiling = Math.min(
      this.config.idleMaxMs,
      this.config.pollIntervalMs * 2 ** exponent
    );
    const random = Math.min(1, Math.max(0, this.dependencies.random()));
    return Math.min(
      this.config.idleMaxMs,
      Math.max(1, Math.round(ceiling * (0.8 + random * 0.4)))
    );
  }

  private async ack(
    message: PulledQueueMessage,
    job: NarrativeJob | null,
    code: string,
    disposition: NarrativeResultDisposition | null = null
  ): Promise<MessageOutcome> {
    await this.dependencies.queue.ack(message.lease_id);
    await this.updateStatus({
      ackedDelta: 1,
      terminalDelta: 1,
      lastOutcome: code
    });
    this.dependencies.logger.event("narrative_message_acked", {
      messageId: message.id,
      jobId: job?.jobId ?? null,
      domain: job?.domain ?? null,
      code,
      disposition
    });
    return {
      messageId: message.id,
      jobId: job?.jobId ?? null,
      domain: job?.domain ?? null,
      action: "ack",
      code,
      disposition,
      retryDelaySeconds: null
    };
  }

  private async retry(
    message: PulledQueueMessage,
    job: NarrativeJob | null,
    code: string
  ): Promise<MessageOutcome> {
    const delaySeconds = this.retryDelaySeconds(message.attempts);
    await this.dependencies.queue.retry(message.lease_id, delaySeconds);
    await this.updateStatus({
      retriedDelta: 1,
      lastOutcome: "retry",
      lastErrorCode: this.intakeHaltedCode ?? code
    });
    this.dependencies.logger.event("narrative_message_retried", {
      messageId: message.id,
      jobId: job?.jobId ?? null,
      domain: job?.domain ?? null,
      code,
      delaySeconds
    });
    return {
      messageId: message.id,
      jobId: job?.jobId ?? null,
      domain: job?.domain ?? null,
      action: "retry",
      code,
      disposition: null,
      retryDelaySeconds: delaySeconds
    };
  }

  private async reportTerminal(
    message: PulledQueueMessage,
    job: NarrativeJob,
    terminal: RunnerTerminalReport,
    code: string,
    leaseStartedMs: number
  ): Promise<MessageOutcome> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const timeoutMs = Math.min(
          this.config.resultTimeoutMs,
          Math.max(
            1,
            this.leaseRemainingMs(leaseStartedMs) -
              this.config.queueTimeoutMs -
              NarrativeRunner.RESULT_SUBMISSION_MARGIN_MS
          )
        );
        const result = await this.dependencies.results.submitTerminal(
          job,
          terminal,
          timeoutMs
        );
        return this.ack(message, job, code, result.disposition);
      } catch (error) {
        const failure = runnerFailure(error, "terminal_submit_failed", "transient");
        if (
          attempt === 0 &&
          failure.disposition === "transient" &&
          await this.waitForLocalRetry({
            operation: "terminal_result",
            code: failure.code,
            job,
            leaseStartedMs,
            leaseReserveMs:
              this.config.queueTimeoutMs +
              NarrativeRunner.RESULT_SUBMISSION_MARGIN_MS +
              1
          })
        ) {
          continue;
        }
        await this.handleCallbackFailure(failure);
        return this.retry(message, job, `terminal_${failure.code}`);
      }
    }
    throw new RunnerFailure("terminal_submit_retry_exhausted", "transient");
  }

  private async process(message: PulledQueueMessage): Promise<MessageOutcome> {
    const leaseStartedMs = this.dependencies.now().getTime();
    let job: NarrativeJob;
    try {
      job = decodeNarrativeJob(message);
    } catch (error) {
      const failure = runnerFailure(error, "narrative_job_decode_failed", "terminal");
      return failure.disposition === "terminal"
        ? this.ack(message, null, failure.code)
        : this.retry(message, null, failure.code);
    }

    if (this.expired(job)) {
      return this.reportTerminal(
        message,
        job,
        { status: "expired", reasonCode: "job_expired" },
        "deadline_expired_before_inference",
        leaseStartedMs
      );
    }
    if (!this.dependencies.results.hasTarget(job.result.target)) {
      await this.haltIntake("result_target_unknown");
      return this.retry(message, job, "result_target_unknown");
    }

    const submissionReserveMs =
      this.config.resultTimeoutMs + NarrativeRunner.RESULT_SUBMISSION_MARGIN_MS;
    const remainingBeforeInferenceMs = this.remainingMs(job);
    if (remainingBeforeInferenceMs <= submissionReserveMs) {
      return this.reportTerminal(
        message,
        job,
        { status: "rejected", reasonCode: "deadline_budget_insufficient" },
        "deadline_insufficient_for_inference",
        leaseStartedMs
      );
    }

    let output;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        output = await this.dependencies.omlx.generate(
          job,
          Math.min(
            this.config.omlx.timeoutMs,
            this.remainingMs(job) - submissionReserveMs,
            this.leaseRemainingMs(leaseStartedMs) -
              this.config.resultTimeoutMs -
              this.config.queueTimeoutMs -
              NarrativeRunner.RESULT_SUBMISSION_MARGIN_MS
          )
        );
        break;
      } catch (error) {
        const failure = runnerFailure(error, "omlx_inference_failed", "transient");
        if (failure.code === "omlx_inference_auth") {
          await this.haltIntake(failure.code);
          return this.retry(message, job, failure.code);
        }
        const retryableInference =
          failure.disposition === "transient" &&
          [
            "omlx_inference_network",
            "omlx_inference_http_transient",
            "omlx_inference_response_invalid"
          ].includes(failure.code);
        if (
          attempt === 0 &&
          retryableInference &&
          await this.waitForLocalRetry({
            operation: "inference",
            code: failure.code,
            job,
            leaseStartedMs,
            deadlineReserveMs: submissionReserveMs + 1,
            leaseReserveMs:
              this.config.resultTimeoutMs +
              this.config.queueTimeoutMs +
              NarrativeRunner.RESULT_SUBMISSION_MARGIN_MS +
              1
          })
        ) {
          continue;
        }
        if (retryableInference) await this.blockModelIntake(failure.code);
        if (failure.disposition === "terminal") {
          return this.reportTerminal(
            message,
            job,
            {
              status: "rejected",
              reasonCode:
                failure.code === "omlx_output_invalid"
                  ? "inference_output_invalid"
                  : "inference_request_rejected"
            },
            failure.code,
            leaseStartedMs
          );
        }
        return this.retry(message, job, failure.code);
      }
    }
    if (output === undefined) {
      return this.retry(message, job, "omlx_inference_retry_exhausted");
    }

    if (this.expired(job)) {
      return this.reportTerminal(
        message,
        job,
        { status: "expired", reasonCode: "job_expired" },
        "deadline_expired_before_submission",
        leaseStartedMs
      );
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.dependencies.results.submit(
          job,
          this.config.omlx.modelId,
          output,
          Math.min(
            this.config.resultTimeoutMs,
            this.remainingMs(job),
            this.leaseRemainingMs(leaseStartedMs) -
              this.config.queueTimeoutMs -
              NarrativeRunner.RESULT_SUBMISSION_MARGIN_MS
          )
        );
        return this.ack(message, job, `result_${result.disposition}`, result.disposition);
      } catch (error) {
        const failure = runnerFailure(error, "result_submit_failed", "transient");
        if (failure.code === "result_submission_invalid") {
          return this.reportTerminal(
            message,
            job,
            { status: "rejected", reasonCode: "inference_output_invalid" },
            failure.code,
            leaseStartedMs
          );
        }
        if (
          attempt === 0 &&
          failure.disposition === "transient" &&
          await this.waitForLocalRetry({
            operation: "generated_result",
            code: failure.code,
            job,
            leaseStartedMs,
            deadlineReserveMs: 1,
            leaseReserveMs:
              this.config.queueTimeoutMs +
              NarrativeRunner.RESULT_SUBMISSION_MARGIN_MS +
              1
          })
        ) {
          continue;
        }
        await this.handleCallbackFailure(failure);
        return this.retry(message, job, failure.code);
      }
    }
    throw new RunnerFailure("result_submit_retry_exhausted", "transient");
  }

  private launch(message: PulledQueueMessage): Promise<MessageOutcome> {
    let task: Promise<MessageOutcome>;
    task = this.process(message)
      .catch(async (error): Promise<MessageOutcome> => {
        const failure = runnerFailure(error, "message_unsettled", "transient");
        if (failure.code.startsWith("queue_")) {
          await this.handleSettlementFailure(failure);
        } else {
          await this.blockIntake(failure.code);
        }
        await this.updateStatus({
          lastOutcome: "unsettled",
          lastErrorCode: this.intakeHaltedCode ?? failure.code
        });
        this.dependencies.logger.event("narrative_message_unsettled", {
          messageId: message.id,
          code: failure.code
        });
        return {
          messageId: message.id,
          jobId: null,
          domain: null,
          action: "unsettled",
          code: failure.code,
          disposition: null,
          retryDelaySeconds: null
        };
      })
      .finally(() => {
        this.inFlight.delete(task);
        void this.updateStatus({
          state:
            this.intakeHalted()
              ? "halted"
              : this.inFlight.size === 0
                ? this.inactiveState()
                : "processing",
          inFlight: this.inFlight.size,
          lastErrorCode:
            this.intakeHaltedCode ??
            (this.intakeBlocked() ? this.intakeBlockedCode : null)
        });
      });
    this.inFlight.add(task);
    return task;
  }

  async poll(): Promise<PollResult> {
    if (this.intakeHalted()) {
      const failure = new RunnerFailure(this.intakeHaltedCode!, "terminal");
      await this.updateStatus({
        state: "halted",
        lastErrorCode: failure.code
      });
      throw failure;
    }
    const capacity = this.availableCapacity();
    if (capacity === 0) return { pulled: 0, tasks: [] };
    if (this.intakeBlocked()) {
      const failure = new RunnerFailure("intake_backoff_active", "transient");
      await this.updateStatus({
        state: "backing_off",
        lastErrorCode: this.intakeBlockedCode ?? failure.code
      });
      throw failure;
    }
    this.intakeBlockedUntilMs = 0;
    this.intakeBlockedCode = null;

    try {
      await this.ensureModelReady();
    } catch (error) {
      const failure = runnerFailure(error, "omlx_preflight_failed", "transient");
      if (failure.code === "omlx_inference_auth") {
        await this.haltIntake(failure.code);
        throw failure;
      }
      await this.updateStatus({
        state: "backing_off",
        lastErrorCode: failure.code
      });
      this.dependencies.logger.event("narrative_preflight_failed", { code: failure.code });
      throw failure;
    }

    let pulled;
    try {
      pulled = await this.dependencies.queue.pull(capacity);
    } catch (error) {
      const failure = runnerFailure(error, "queue_pull_failed", "transient");
      if (failure.disposition === "terminal") {
        await this.haltIntake(failure.code);
      } else {
        await this.blockIntake(failure.code);
      }
      throw failure;
    }
    const tasks = pulled.messages.map((message) => this.launch(message));
    await this.updateStatus({
      state:
        this.intakeHalted()
          ? "halted"
          : this.intakeBlocked()
            ? "backing_off"
            : this.inFlight.size > 0
              ? "processing"
              : "idle",
      inFlight: this.inFlight.size,
      pulledDelta: tasks.length,
      backlogCount: pulled.backlogCount,
      lastErrorCode:
        this.intakeHaltedCode ??
        (this.intakeBlocked() ? this.intakeBlockedCode : null)
    });
    return { pulled: tasks.length, tasks };
  }

  async runOnce(): Promise<MessageOutcome[]> {
    const result = await this.poll();
    return Promise.all(result.tasks);
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  private async waitForProgressOrHeartbeat(signal?: AbortSignal): Promise<void> {
    const sleepController = new AbortController();
    const relayAbort = () => sleepController.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      await Promise.race([
        Promise.race([...this.inFlight]),
        this.dependencies.sleep(
          this.config.heartbeatIntervalMs,
          sleepController.signal
        )
      ]);
    } finally {
      sleepController.abort();
      signal?.removeEventListener("abort", relayAbort);
    }
    if (this.inFlight.size > 0) {
      await this.updateStatus({
        state:
          this.intakeHalted()
            ? "halted"
            : this.intakeBlocked()
              ? "backing_off"
              : "processing",
        inFlight: this.inFlight.size,
        lastErrorCode:
          this.intakeHaltedCode ??
          (this.intakeBlocked() ? this.intakeBlockedCode : null)
      });
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    await this.updateStatus({ state: "starting", inFlight: 0 });
    this.dependencies.logger.event("narrative_runner_started", {
      runnerId: this.config.runnerId,
      concurrency: this.config.concurrency,
      modelId: this.config.omlx.modelId
    });

    let emptyPullCount = 0;
    while (!signal?.aborted) {
      try {
        const result = await this.poll();
        if (this.inFlight.size > 0 && this.availableCapacity() === 0) {
          emptyPullCount = 0;
          await this.waitForProgressOrHeartbeat(signal);
        } else if (result.pulled === 0) {
          emptyPullCount += 1;
          await this.dependencies.sleep(this.idleDelayMs(emptyPullCount), signal);
        } else {
          emptyPullCount = 0;
        }
      } catch (error) {
        const failure = runnerFailure(error, "runner_poll_failed", "transient");
        if (failure.disposition === "terminal" && this.intakeHalted()) {
          await this.updateStatus({
            state: "halted",
            lastErrorCode: this.intakeHaltedCode
          });
          await this.dependencies.sleep(this.config.heartbeatIntervalMs, signal);
          continue;
        }
        if (failure.disposition === "terminal") throw failure;
        await this.updateStatus({
          state: "backing_off",
          lastErrorCode: this.intakeBlockedCode ?? failure.code
        });
        this.dependencies.logger.event("narrative_poll_backoff", { code: failure.code });
        await this.dependencies.sleep(this.config.modelBackoffMs, signal);
      }
    }

    await this.drain();
    await this.updateStatus({ state: "stopped", inFlight: 0 });
    this.dependencies.logger.event("narrative_runner_stopped", {
      runnerId: this.config.runnerId
    });
  }
}

export function createNarrativeRunner(
  config: RunnerConfig,
  overrides: Partial<RunnerDependencies> = {}
): NarrativeRunner {
  const now = overrides.now ?? (() => new Date());
  const status =
    overrides.status ??
    new StatusTracker(
      config.runnerId,
      config.omlx.modelId,
      new FileStatusStore(config.statusFile),
      now
    );
  return new NarrativeRunner(config, {
    queue:
      overrides.queue ??
      new CloudflareQueueClient(
        config.queue,
        config.visibilityTimeoutMs,
        config.queueTimeoutMs
      ),
    omlx: overrides.omlx ?? new OpenAiCompatibleOmlxClient(config.omlx),
    results: overrides.results ?? createResultClient(config),
    status,
    logger: overrides.logger ?? new JsonLineLogger(),
    now,
    random: overrides.random ?? Math.random,
    sleep: overrides.sleep ?? defaultSleep
  });
}
