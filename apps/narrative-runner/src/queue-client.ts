import { Buffer } from "node:buffer";
import {
  assertNarrativeJobSize,
  NARRATIVE_JOB_MAX_BYTES,
  NarrativeJobSchema,
  type NarrativeJob
} from "@surf/narrative-contracts";
import { z } from "zod";
import { readBoundedJson } from "./bounded-json";
import type { RunnerConfig } from "./config";
import { RunnerFailure } from "./errors";

export type Fetcher = typeof fetch;

const PulledMessageSchema = z
  .object({
    id: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    body: z.string(),
    lease_id: z.string().min(1),
    timestamp_ms: z.number().nonnegative(),
    metadata: z.record(z.string(), z.unknown())
  })
  .passthrough();

const PullResponseSchema = z
  .object({
    success: z.literal(true),
    result: z.object({
      message_backlog_count: z.number().int().nonnegative().optional(),
      messages: z.array(PulledMessageSchema)
    })
  })
  .passthrough();

const MutationResponseSchema = z
  .object({
    success: z.literal(true),
    result: z.object({
      ackCount: z.number().int().nonnegative(),
      retryCount: z.number().int().nonnegative(),
      warnings: z.record(z.string(), z.string()).optional()
    })
  })
  .passthrough();

const ENCODED_JOB_MAX_BYTES = Math.ceil(NARRATIVE_JOB_MAX_BYTES / 3) * 4 + 4;
const QUEUE_RESPONSE_BASE_MAX_BYTES = 16_384;
const QUEUE_MESSAGE_WIRE_MAX_BYTES = ENCODED_JOB_MAX_BYTES + 4_096;
const QUEUE_MUTATION_RESPONSE_MAX_BYTES = 16_384;

export type PulledQueueMessage = z.infer<typeof PulledMessageSchema>;

export type QueuePullResult = {
  messages: PulledQueueMessage[];
  backlogCount: number | null;
};

function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new RunnerFailure("queue_body_base64_invalid", "terminal");
  }
  const decoded = Buffer.from(compact, "base64");
  const inputCanonical = compact.replace(/=+$/, "");
  const decodedCanonical = decoded.toString("base64").replace(/=+$/, "");
  if (inputCanonical !== decodedCanonical) {
    throw new RunnerFailure("queue_body_base64_invalid", "terminal");
  }
  return decoded;
}

function utf8(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new RunnerFailure("queue_body_utf8_invalid", "terminal");
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new RunnerFailure("queue_body_json_invalid", "terminal");
  }
}

/** Decode exactly as Cloudflare's HTTP pull API documents. */
export function decodeNarrativeJob(message: PulledQueueMessage): NarrativeJob {
  const contentType = message.metadata["CF-Content-Type"];
  if (typeof contentType !== "string") {
    throw new RunnerFailure("queue_content_type_missing", "terminal");
  }

  const bodyBytes = new TextEncoder().encode(message.body).byteLength;
  const maximumBodyBytes =
    contentType === "text" ? NARRATIVE_JOB_MAX_BYTES : ENCODED_JOB_MAX_BYTES;
  if (bodyBytes > maximumBodyBytes) {
    throw new RunnerFailure("queue_body_oversized", "terminal");
  }

  let json: unknown;
  if (contentType === "json" || contentType === "bytes") {
    json = parseJson(utf8(decodeBase64(message.body)));
  } else if (contentType === "text") {
    json = parseJson(message.body);
  } else {
    throw new RunnerFailure("queue_content_type_unsupported", "terminal");
  }

  try {
    return assertNarrativeJobSize(NarrativeJobSchema.parse(json));
  } catch {
    throw new RunnerFailure("narrative_job_invalid", "terminal");
  }
}

export interface QueueClient {
  pull(batchSize: number): Promise<QueuePullResult>;
  ack(leaseId: string): Promise<void>;
  retry(leaseId: string, delaySeconds: number): Promise<void>;
}

export class CloudflareQueueClient implements QueueClient {
  private readonly messagesUrl: string;

  constructor(
    private readonly config: RunnerConfig["queue"],
    private readonly visibilityTimeoutMs: number,
    private readonly requestTimeoutMs: number,
    private readonly fetcher: Fetcher = fetch
  ) {
    const base = config.apiBaseUrl.replace(/\/$/, "");
    this.messagesUrl = `${base}/accounts/${encodeURIComponent(config.accountId)}/queues/${encodeURIComponent(config.queueId)}/messages`;
  }

  private async request(
    path: "pull" | "ack",
    body: unknown,
    maximumResponseBytes: number
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.messagesUrl}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch {
      throw new RunnerFailure("queue_api_network", "transient");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new RunnerFailure("queue_api_auth", "terminal");
      }
      const transient = response.status === 429 || response.status >= 500;
      throw new RunnerFailure(
        transient ? "queue_api_http_transient" : "queue_api_http_terminal",
        transient ? "transient" : "terminal"
      );
    }
    try {
      return await readBoundedJson(response, maximumResponseBytes);
    } catch {
      throw new RunnerFailure("queue_api_response_invalid", "transient");
    }
  }

  async pull(batchSize: number): Promise<QueuePullResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new RunnerFailure("queue_pull_capacity_invalid", "terminal");
    }
    let parsed: z.infer<typeof PullResponseSchema>;
    try {
      parsed = PullResponseSchema.parse(
        await this.request("pull", {
          visibility_timeout_ms: this.visibilityTimeoutMs,
          batch_size: batchSize
        }, QUEUE_RESPONSE_BASE_MAX_BYTES + batchSize * QUEUE_MESSAGE_WIRE_MAX_BYTES)
      );
      if (parsed.result.messages.length > batchSize) {
        throw new RunnerFailure("queue_pull_response_invalid", "transient");
      }
    } catch (error) {
      if (error instanceof RunnerFailure) throw error;
      throw new RunnerFailure("queue_pull_response_invalid", "transient");
    }
    return {
      messages: parsed.result.messages,
      backlogCount: parsed.result.message_backlog_count ?? null
    };
  }

  async ack(leaseId: string): Promise<void> {
    await this.mutate(
      { acks: [{ lease_id: leaseId }], retries: [] },
      { ackCount: 1, retryCount: 0 }
    );
  }

  async retry(leaseId: string, delaySeconds: number): Promise<void> {
    await this.mutate(
      {
        acks: [],
        retries: [{ lease_id: leaseId, delay_seconds: delaySeconds }]
      },
      { ackCount: 0, retryCount: 1 }
    );
  }

  private async mutate(
    body: unknown,
    expected: { ackCount: number; retryCount: number }
  ): Promise<void> {
    try {
      const parsed = MutationResponseSchema.parse(
        await this.request("ack", body, QUEUE_MUTATION_RESPONSE_MAX_BYTES)
      );
      if (
        parsed.result.ackCount !== expected.ackCount ||
        parsed.result.retryCount !== expected.retryCount ||
        Object.keys(parsed.result.warnings ?? {}).length > 0
      ) {
        throw new RunnerFailure("queue_ack_response_invalid", "transient");
      }
    } catch (error) {
      if (error instanceof RunnerFailure) throw error;
      throw new RunnerFailure("queue_ack_response_invalid", "transient");
    }
  }
}
