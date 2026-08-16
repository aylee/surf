import { describe, expect, it, vi } from "vitest";
import {
  CloudflareQueueClient,
  decodeNarrativeJob
} from "../src/queue-client";
import { makeConfig, makeJob, queueMessage } from "./fakes";

function queueSettlement(body: string | undefined) {
  const request = JSON.parse(body ?? "{}") as {
    acks?: unknown[];
    retries?: unknown[];
  };
  return {
    success: true,
    result: {
      ackCount: request.acks?.length ?? 0,
      retryCount: request.retries?.length ?? 0,
      warnings: {}
    }
  };
}

function queueMetadata(
  queueName = "surf-narrative",
  consumer: unknown = {
    type: "http_pull",
    dead_letter_queue: "surf-narrative-dlq",
    settings: {
      batch_size: 1,
      max_retries: 0,
      retry_delay: 30,
      visibility_timeout_ms: 180_000
    }
  }
) {
  return {
    success: true,
    result: {
      queue_id: "queue-test",
      queue_name: queueName,
      consumers_total_count: 1,
      consumers: [consumer]
    }
  };
}

function withQueueMetadata(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  queueName = "surf-narrative"
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    init?.method === "GET"
      ? Response.json(queueMetadata(queueName))
      : handler(input, init)) as typeof fetch;
}

describe("Cloudflare Queue pull transport", () => {
  it.each(["json", "text", "bytes"] as const)(
    "decodes %s using CF-Content-Type",
    (contentType) => {
      const job = makeJob();
      expect(decodeNarrativeJob(queueMessage(job, { contentType }))).toEqual(job);
    }
  );

  it("retains base64 compatibility for JSON pull messages", () => {
    const job = makeJob();
    expect(decodeNarrativeJob({
      ...queueMessage(job, { contentType: "json" }),
      body: Buffer.from(JSON.stringify(job), "utf8").toString("base64")
    })).toEqual(job);
  });

  it("rejects unsupported encodings and invalid base64 as terminal messages", () => {
    const message = queueMessage(makeJob(), { contentType: "bytes" });
    expect(() =>
      decodeNarrativeJob({
        ...message,
        metadata: { "CF-Content-Type": "v8" }
      })
    ).toThrowError(expect.objectContaining({
      code: "queue_content_type_unsupported",
      disposition: "terminal"
    }));
    expect(() => decodeNarrativeJob({ ...message, body: "%%%=" })).toThrowError(
      expect.objectContaining({
        code: "queue_body_base64_invalid",
        disposition: "terminal"
      })
    );
  });

  it("enforces the shared serialized 60,000-byte job boundary before parsing", () => {
    const oversized = makeJob({
      responseSchema: {
        type: "object",
        description: "x".repeat(70_000)
      }
    });
    expect(() => decodeNarrativeJob(queueMessage(oversized))).toThrowError(
      expect.objectContaining({
        code: "queue_body_oversized",
        disposition: "terminal"
      })
    );
  });

  it("rejects oversized encoded and text bodies before decoding or parsing", () => {
    const message = queueMessage(makeJob(), { contentType: "bytes" });
    expect(() =>
      decodeNarrativeJob({ ...message, body: "A".repeat(81_000) })
    ).toThrowError(expect.objectContaining({
      code: "queue_body_oversized",
      disposition: "terminal"
    }));
    expect(() =>
      decodeNarrativeJob({
        ...message,
        body: "x".repeat(60_001),
        metadata: { "CF-Content-Type": "text" }
      })
    ).toThrowError(expect.objectContaining({
      code: "queue_body_oversized",
      disposition: "terminal"
    }));
  });

  it("uses the documented pull and lease ack/retry request bodies", async () => {
    const message = queueMessage(makeJob());
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET") return Response.json(queueMetadata());
      return Response.json(
        url.endsWith("/pull")
          ? {
              success: true,
              result: {
                message_backlog_count: 4,
                messages: [message]
              }
            }
          : queueSettlement(String(init?.body))
      );
    });
    const config = makeConfig();
    const client = new CloudflareQueueClient(
      config.queue,
      config.visibilityTimeoutMs,
      config.queueTimeoutMs,
      fetcher as unknown as typeof fetch
    );

    await expect(client.pull(3)).resolves.toEqual({ messages: [message], backlogCount: 4 });
    await client.ack("lease-ack");
    await client.retry("lease-retry", 45);

    const calls = fetcher.mock.calls as unknown as Array<
      [
        string,
        RequestInit & { headers: Record<string, string>; body: string }
      ]
    >;
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account-test/queues/queue-test",
      "https://api.cloudflare.com/client/v4/accounts/account-test/queues/queue-test/messages/pull",
      "https://api.cloudflare.com/client/v4/accounts/account-test/queues/queue-test/messages/ack",
      "https://api.cloudflare.com/client/v4/accounts/account-test/queues/queue-test/messages/ack"
    ]);
    expect(calls.map(([, init]) => init.redirect)).toEqual([
      "error",
      "error",
      "error",
      "error"
    ]);
    expect(calls[0]![1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer queue-secret" }
    });
    expect(JSON.parse(calls[1]![1].body)).toEqual({
      visibility_timeout_ms: 180_000,
      batch_size: 3
    });
    expect(JSON.parse(calls[2]![1].body)).toEqual({
      acks: [{ lease_id: "lease-ack" }],
      retries: []
    });
    expect(JSON.parse(calls[3]![1].body)).toEqual({
      acks: [],
      retries: [{ lease_id: "lease-retry", delay_seconds: 45 }]
    });
    expect(calls[1]![1].headers).toMatchObject({
      Authorization: "Bearer queue-secret",
      "Content-Type": "application/json"
    });
  });

  it("requires the Queue ID metadata to report the exact configured name", async () => {
    const missing = new CloudflareQueueClient(
      makeConfig().queue,
      180_000,
      30_000,
      (async () => Response.json({ success: true, result: {} })) as typeof fetch
    );
    await expect(missing.preflight()).rejects.toMatchObject({
      code: "queue_preflight_response_invalid",
      disposition: "terminal"
    });

    const mismatch = new CloudflareQueueClient(
      makeConfig().queue,
      180_000,
      30_000,
      (async () => Response.json(queueMetadata("surf-ingest"))) as typeof fetch
    );
    await expect(mismatch.preflight()).rejects.toMatchObject({
      code: "queue_identity_mismatch",
      disposition: "terminal"
    });
  });

  it("requires exactly one HTTP pull consumer with the configured DLQ and lease settings", async () => {
    const cases: Array<{ metadata: unknown; code: string }> = [
      {
        metadata: {
          ...queueMetadata(),
          result: { ...queueMetadata().result, consumers_total_count: 0, consumers: [] }
        },
        code: "queue_consumer_topology_mismatch"
      },
      {
        metadata: queueMetadata("surf-narrative", {
          type: "worker",
          dead_letter_queue: "surf-narrative-dlq",
          settings: {}
        }),
        code: "queue_consumer_topology_mismatch"
      },
      {
        metadata: queueMetadata("surf-narrative", {
          type: "http_pull",
          dead_letter_queue: "wrong-dlq",
          settings: {
            batch_size: 1,
            max_retries: 0,
            retry_delay: 30,
            visibility_timeout_ms: 180_000
          }
        }),
        code: "queue_consumer_settings_mismatch"
      },
      {
        metadata: queueMetadata("surf-narrative", {
          type: "http_pull",
          dead_letter_queue: "surf-narrative-dlq",
          settings: {
            batch_size: 1,
            max_retries: 1,
            retry_delay: 60,
            visibility_timeout_ms: 30_000
          }
        }),
        code: "queue_consumer_settings_mismatch"
      }
    ];

    for (const { metadata, code } of cases) {
      const client = new CloudflareQueueClient(
        makeConfig().queue,
        180_000,
        30_000,
        (async () => Response.json(metadata)) as typeof fetch
      );
      await expect(client.preflight()).rejects.toMatchObject({
        code,
        disposition: "terminal"
      });
    }
  });

  it("never accepts an invalid free-capacity batch size", async () => {
    const client = new CloudflareQueueClient(
      makeConfig().queue,
      180_000,
      30_000,
      vi.fn() as unknown as typeof fetch
    );
    await expect(client.pull(0)).rejects.toMatchObject({
      code: "queue_pull_capacity_invalid",
      disposition: "terminal"
    });
  });

  it("rejects a pull response that exceeds the requested batch capacity", async () => {
    const message = queueMessage(makeJob());
    const client = new CloudflareQueueClient(
      makeConfig().queue,
      180_000,
      30_000,
      withQueueMetadata(async () => Response.json({
        success: true,
        result: { messages: [message, message] }
      }))
    );
    await expect(client.pull(1)).rejects.toMatchObject({
      code: "queue_pull_response_invalid",
      disposition: "transient"
    });
  });

  it("bounds declared and chunked successful Queue responses", async () => {
    const declared = new CloudflareQueueClient(
      makeConfig().queue,
      180_000,
      30_000,
      withQueueMetadata(async () => new Response("{}", {
        headers: { "Content-Length": "1000000" }
      }))
    );
    await expect(declared.pull(1)).rejects.toMatchObject({
      code: "queue_api_response_invalid",
      disposition: "transient"
    });

    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10_000));
      },
      cancel
    });
    const chunked = new CloudflareQueueClient(
      makeConfig().queue,
      180_000,
      30_000,
      withQueueMetadata(async () => new Response(body))
    );
    await expect(chunked.ack("lease-1")).rejects.toMatchObject({
      code: "queue_api_response_invalid",
      disposition: "transient"
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("requires an exact one-message settlement with no warnings", async () => {
    for (const result of [
      { ackCount: 0, retryCount: 0, warnings: {} },
      { ackCount: 1, retryCount: 0, warnings: { "lease-1": "not acknowledged" } }
    ]) {
      const client = new CloudflareQueueClient(
        makeConfig().queue,
        180_000,
        30_000,
        withQueueMetadata(async () => Response.json({ success: true, result }))
      );
      await expect(client.ack("lease-1")).rejects.toMatchObject({
        code: "queue_ack_response_invalid",
        disposition: "transient"
      });
    }
  });

  it.each([
    [401, "queue_api_auth", "terminal"],
    [403, "queue_api_auth", "terminal"],
    [408, "queue_preflight_http_transient", "transient"],
    [429, "queue_preflight_http_transient", "transient"],
    [503, "queue_preflight_http_transient", "transient"],
    [400, "queue_preflight_http_terminal", "terminal"]
  ] as const)("classifies Queue metadata HTTP %i as %s", async (status, code, disposition) => {
    const client = new CloudflareQueueClient(
      makeConfig().queue,
      180_000,
      30_000,
      (async () => new Response(null, { status })) as typeof fetch
    );
    await expect(client.preflight()).rejects.toMatchObject({ code, disposition });
  });

  it.each([
    [429, "queue_api_http_transient", "transient"],
    [503, "queue_api_http_transient", "transient"],
    [400, "queue_api_http_terminal", "terminal"]
  ] as const)("classifies Queue message HTTP %i as %s", async (status, code, disposition) => {
    const client = new CloudflareQueueClient(
      makeConfig().queue,
      180_000,
      30_000,
      withQueueMetadata(async () => new Response(null, { status }))
    );
    await expect(client.pull(1)).rejects.toMatchObject({ code, disposition });
  });

  it("bounds a stalled Queue request with its own timeout", async () => {
    const stalled = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true
        });
      })) as typeof fetch;
    const bounded = new CloudflareQueueClient(
      makeConfig().queue,
      180_000,
      5,
      withQueueMetadata(stalled)
    );
    await expect(bounded.pull(1)).rejects.toMatchObject({
      code: "queue_api_network",
      disposition: "transient"
    });
  });
});
