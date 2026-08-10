import {
  assertNarrativeResultSize,
  NarrativeGeneratedResultSubmissionSchema,
  NarrativeResultResponseSchema,
  NarrativeTerminalResultSubmissionSchema,
  type JsonValue,
  type NarrativeJob,
  type NarrativeResultResponse,
  type NarrativeResultSubmission,
  type NarrativeTerminalReasonCode
} from "@surf/narrative-contracts";
import type { ResultTargetConfig, RunnerConfig } from "./config";
import { readBoundedJson } from "./bounded-json";
import { RunnerFailure } from "./errors";
import type { Fetcher } from "./queue-client";

export interface ResultClient {
  hasTarget(targetId: string): boolean;
  submit(
    job: NarrativeJob,
    modelId: string,
    output: JsonValue,
    timeoutMs?: number
  ): Promise<NarrativeResultResponse>;
  submitTerminal(
    job: NarrativeJob,
    terminal: RunnerTerminalReport,
    timeoutMs?: number
  ): Promise<NarrativeResultResponse>;
}

type RunnerRejectedReason = Extract<
  NarrativeTerminalReasonCode,
  | "deadline_budget_insufficient"
  | "inference_output_invalid"
  | "inference_request_rejected"
>;

export type RunnerTerminalReport =
  | { status: "expired"; reasonCode: "job_expired" }
  | { status: "rejected"; reasonCode: RunnerRejectedReason };

const RESULT_RESPONSE_MAX_BYTES = 16_384;

export class MappedResultClient implements ResultClient {
  constructor(
    private readonly targets: ReadonlyMap<string, ResultTargetConfig>,
    private readonly defaultTimeoutMs: number,
    private readonly fetcher: Fetcher = fetch
  ) {}

  hasTarget(targetId: string): boolean {
    return this.targets.has(targetId);
  }

  async submit(
    job: NarrativeJob,
    modelId: string,
    output: JsonValue,
    timeoutMs = this.defaultTimeoutMs
  ): Promise<NarrativeResultResponse> {
    const target = this.targets.get(job.result.target);
    if (!target) throw new RunnerFailure("result_target_unknown", "terminal");
    let submission: NarrativeResultSubmission;
    try {
      submission = assertNarrativeResultSize(
        NarrativeGeneratedResultSubmissionSchema.parse({
          schemaVersion: 1,
          jobId: job.jobId,
          submissionId: job.result.submissionId,
          providerId: "omlx",
          route: "primary",
          modelId,
          output
        })
      );
    } catch {
      throw new RunnerFailure("result_submission_invalid", "terminal");
    }
    return this.post(job, target, submission, timeoutMs);
  }

  async submitTerminal(
    job: NarrativeJob,
    terminal: RunnerTerminalReport,
    timeoutMs = this.defaultTimeoutMs
  ): Promise<NarrativeResultResponse> {
    const target = this.targets.get(job.result.target);
    if (!target) throw new RunnerFailure("result_target_unknown", "terminal");
    let submission: NarrativeResultSubmission;
    try {
      submission = assertNarrativeResultSize(
        NarrativeTerminalResultSubmissionSchema.parse({
          schemaVersion: 1,
          jobId: job.jobId,
          submissionId: job.result.submissionId,
          terminal
        })
      );
    } catch {
      throw new RunnerFailure("terminal_submission_invalid", "terminal");
    }
    return this.post(job, target, submission, timeoutMs);
  }

  private async post(
    job: NarrativeJob,
    target: ResultTargetConfig,
    submission: NarrativeResultSubmission,
    timeoutMs: number
  ): Promise<NarrativeResultResponse> {
    let response: Response;
    try {
      response = await this.fetcher(target.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.token}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(submission),
        signal: AbortSignal.timeout(Math.max(1, Math.min(this.defaultTimeoutMs, timeoutMs)))
      });
    } catch {
      throw new RunnerFailure("result_submit_network", "transient");
    }

    if (response.status !== 200) {
      if (response.status === 401 || response.status === 403) {
        throw new RunnerFailure("result_submit_auth", "terminal");
      }
      const transient = response.status === 429 || response.status >= 500;
      throw new RunnerFailure(
        transient ? "result_submit_http_transient" : "result_submit_http_terminal",
        transient ? "transient" : "terminal"
      );
    }

    try {
      const parsed = NarrativeResultResponseSchema.parse(
        await readBoundedJson(response, RESULT_RESPONSE_MAX_BYTES)
      );
      if (parsed.jobId !== job.jobId) {
        throw new RunnerFailure("result_submit_identity_mismatch", "terminal");
      }
      return parsed;
    } catch (error) {
      if (error instanceof RunnerFailure) throw error;
      throw new RunnerFailure("result_submit_response_invalid", "terminal");
    }
  }
}

export function createResultClient(
  config: RunnerConfig,
  fetcher: Fetcher = fetch
): MappedResultClient {
  return new MappedResultClient(config.targets, config.resultTimeoutMs, fetcher);
}
