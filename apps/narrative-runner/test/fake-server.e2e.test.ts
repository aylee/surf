import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLogger } from "../src/logger";
import { OpenAiCompatibleOmlxClient } from "../src/omlx-client";
import { CloudflareQueueClient } from "../src/queue-client";
import { MappedResultClient } from "../src/result-client";
import { NarrativeRunner } from "../src/runner";
import { MemoryStatusStore, StatusTracker } from "../src/status";
import {
  makeConfig,
  makeJob,
  queueMessage,
  TestClock
} from "./fakes";

type CapturedRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
};

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("domain-neutral runner fake-server e2e", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve()))
      )
    );
  });

  it("pulls base64 jobs, uses JSON-schema chat completion, submits, and ACKs", async () => {
    const jobs = [
      makeJob({
        domain: "surf",
        jobId: "surf-job",
        target: "surf.analysis.v5",
        submissionId: "surf-submission"
      }),
      makeJob({
        domain: "ski",
        jobId: "ski-job",
        target: "ski.summary.v1",
        submissionId: "ski-submission"
      }),
      makeJob({
        domain: "mtb",
        jobId: "mtb-job",
        target: "mtb.summary.v1",
        submissionId: "mtb-submission"
      }),
      makeJob({
        domain: "ski",
        jobId: "deadline-job",
        target: "ski.summary.v1",
        submissionId: "deadline-submission",
        deadlineAt: "2026-08-09T18:00:15.000Z"
      })
    ];
    const pending = jobs.map((job) => queueMessage(job));
    const requests: CapturedRequest[] = [];
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const body = await readJson(request);
      requests.push({
        method: request.method ?? "",
        path,
        authorization: request.headers.authorization,
        body
      });

      if (path.endsWith("/queues/queue-test") && request.method === "GET") {
        json(response, {
          success: true,
          result: {
            queue_id: "queue-test",
            queue_name: "surf-narrative",
            consumers_total_count: 1,
            consumers: [
              {
                type: "http_pull",
                dead_letter_queue: "surf-narrative-dlq",
                settings: {
                  batch_size: 1,
                  max_retries: 0,
                  retry_delay: 30,
                  visibility_timeout_ms: 180_000
                }
              }
            ]
          }
        });
        return;
      }
      if (path.endsWith("/messages/pull")) {
        const batchSize = Number((body as { batch_size: number }).batch_size);
        json(response, {
          success: true,
          result: {
            message_backlog_count: Math.max(0, pending.length - batchSize),
            messages: pending.splice(0, batchSize)
          }
        });
        return;
      }
      if (path.endsWith("/messages/ack")) {
        const settlement = body as { acks: unknown[]; retries: unknown[] };
        json(response, {
          success: true,
          result: {
            ackCount: settlement.acks.length,
            retryCount: settlement.retries.length,
            warnings: {}
          }
        });
        return;
      }
      if (path === "/v1/models") {
        json(response, { data: [{ id: "local-model" }] });
        return;
      }
      if (path === "/v1/chat/completions") {
        json(response, {
          model: "local-model",
          choices: [{ message: { content: JSON.stringify({ summary: "generated locally" }) } }]
        });
        return;
      }
      if (path === "/api/internal/narratives/results") {
        const submission = body as {
          jobId: string;
          terminal?: { status: "rejected" | "expired" };
        };
        const jobId = submission.jobId;
        json(response, {
          disposition:
            submission.terminal?.status ??
            (jobId === "mtb-job" ? "duplicate" : "published"),
          jobId
        });
        return;
      }
      json(response, { error: "not_found" }, 404);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const targets = new Map(
      ["surf.analysis.v5", "ski.summary.v1", "mtb.summary.v1"].map((target) => [
        target,
        {
          url: `${origin}/api/internal/narratives/results`,
          token: "result-secret"
        }
      ])
    );
    const config = makeConfig({
      concurrency: 4,
      queue: { apiBaseUrl: `${origin}/client/v4` },
      omlx: { baseUrl: `${origin}/v1` },
      targets
    });
    const clock = new TestClock();
    const status = new StatusTracker(
      config.runnerId,
      config.omlx.modelId,
      config.releaseSha,
      config.runtimeFingerprint,
      new MemoryStatusStore(),
      clock.now
    );
    const runner = new NarrativeRunner(config, {
      queue: new CloudflareQueueClient(
        config.queue,
        config.visibilityTimeoutMs,
        config.queueTimeoutMs
      ),
      omlx: new OpenAiCompatibleOmlxClient(config.omlx),
      results: new MappedResultClient(config.targets, config.resultTimeoutMs),
      status,
      logger: new MemoryLogger(),
      now: clock.now,
      random: () => 0.5,
      sleep: async () => undefined
    });

    const outcomes = await runner.runOnce();
    expect(outcomes.map(({ jobId, action, disposition }) => ({
      jobId,
      action,
      disposition
    }))).toEqual([
      { jobId: "surf-job", action: "ack", disposition: "published" },
      { jobId: "ski-job", action: "ack", disposition: "published" },
      { jobId: "mtb-job", action: "ack", disposition: "duplicate" },
      { jobId: "deadline-job", action: "ack", disposition: "rejected" }
    ]);

    const modelIndex = requests.findIndex(({ path }) => path === "/v1/models");
    const queueIdentityIndex = requests.findIndex(({ path }) =>
      path.endsWith("/queues/queue-test")
    );
    const pullIndex = requests.findIndex(({ path }) => path.endsWith("/messages/pull"));
    expect(queueIdentityIndex).toBeGreaterThanOrEqual(0);
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeGreaterThan(queueIdentityIndex);
    expect(pullIndex).toBeGreaterThan(modelIndex);
    const pull = requests[pullIndex]!;
    expect(pull.authorization).toBe("Bearer queue-secret");
    expect(pull.body).toEqual({
      visibility_timeout_ms: 180_000,
      batch_size: 4
    });

    const chats = requests.filter(({ path }) => path === "/v1/chat/completions");
    expect(chats).toHaveLength(3);
    for (const chat of chats) {
      expect(chat.body).toMatchObject({
        model: "local-model",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "narrative_output_v1",
            strict: true,
            schema: jobs[0]!.inference.responseSchema
          }
        },
        max_tokens: 256,
        temperature: 0,
        stream: false,
        chat_template_kwargs: {
          enable_thinking: false
        }
      });
    }

    const submissions = requests.filter(
      ({ path }) => path === "/api/internal/narratives/results"
    );
    expect(submissions.map(({ authorization }) => authorization)).toEqual(
      Array.from({ length: 4 }, () => "Bearer result-secret")
    );
    expect(
      submissions.map(({ body }) => (body as { jobId: string }).jobId).sort()
    ).toEqual(["deadline-job", "mtb-job", "ski-job", "surf-job"]);
    for (const submission of submissions.filter(
      ({ body }) => !(body as { terminal?: unknown }).terminal
    )) {
      expect(Object.keys(submission.body as object).sort()).toEqual([
        "jobId",
        "modelId",
        "output",
        "providerId",
        "route",
        "schemaVersion",
        "submissionId"
      ]);
      expect(submission.body).toMatchObject({
        providerId: "omlx",
        route: "primary"
      });
    }
    expect(
      submissions.find(
        ({ body }) => (body as { jobId: string }).jobId === "deadline-job"
      )?.body
    ).toEqual({
      schemaVersion: 1,
      jobId: "deadline-job",
      submissionId: "deadline-submission",
      terminal: {
        status: "rejected",
        reasonCode: "deadline_budget_insufficient"
      }
    });

    const settlements = requests.filter(({ path }) => path.endsWith("/messages/ack"));
    expect(settlements).toHaveLength(4);
    expect(
      settlements.flatMap(({ body }) =>
        (body as { acks: Array<{ lease_id: string }> }).acks.map(({ lease_id }) => lease_id)
      ).sort()
    ).toEqual([
      "lease-deadline-job",
      "lease-mtb-job",
      "lease-ski-job",
      "lease-surf-job"
    ]);
    expect(settlements.every(({ body }) =>
      (body as { retries: unknown[] }).retries.length === 0
    )).toBe(true);
  });
});
