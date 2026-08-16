import { describe, expect, it, vi } from "vitest";
import { MappedResultClient } from "../src/result-client";
import { makeJob } from "./fakes";

describe("result callback client", () => {
  it("submits only the contracted result body with runtime-owned authorization", async () => {
    const job = makeJob();
    const fetcher = vi.fn(async () =>
      Response.json({ disposition: "published", jobId: job.jobId })
    );
    const client = new MappedResultClient(
      new Map([
        [
          "weather.summary.v1",
          { url: "https://result.example/api/internal/narratives/results", token: "secret" }
        ]
      ]),
      10_000,
      fetcher as unknown as typeof fetch
    );

    await expect(client.submit(job, "local-model", { summary: "ok" })).resolves.toEqual({
      disposition: "published",
      jobId: job.jobId
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://result.example/api/internal/narratives/results");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret",
      "Content-Type": "application/json"
    });
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: 1,
      jobId: job.jobId,
      submissionId: "submission-1",
      providerId: "omlx",
      route: "primary",
      modelId: "local-model",
      output: { summary: "ok" }
    });
    expect(String(init.body)).not.toContain("weather.summary.v1");
    expect(String(init.body)).not.toContain("secret");
  });

  it("posts the discriminated terminal result to the same protected endpoint", async () => {
    const job = makeJob();
    const fetcher = vi.fn(async () =>
      Response.json({ disposition: "expired", jobId: job.jobId })
    );
    const client = new MappedResultClient(
      new Map([
        [
          "weather.summary.v1",
          { url: "https://result.example/api/internal/narratives/results", token: "secret" }
        ]
      ]),
      10_000,
      fetcher as unknown as typeof fetch
    );

    await expect(
      client.submitTerminal(job, { status: "expired", reasonCode: "job_expired" })
    ).resolves.toEqual({ disposition: "expired", jobId: job.jobId });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: 1,
      jobId: job.jobId,
      submissionId: "submission-1",
      terminal: { status: "expired", reasonCode: "job_expired" }
    });
  });

  it.each([
    [401, "result_submit_auth", "terminal"],
    [403, "result_submit_auth", "terminal"],
    [429, "result_submit_http_transient", "transient"],
    [503, "result_submit_http_transient", "transient"],
    [400, "result_submit_http_terminal", "terminal"],
    [404, "result_submit_http_terminal", "terminal"],
    [409, "result_submit_http_terminal", "terminal"]
  ] as const)(
    "classifies HTTP %i as %s",
    async (status, code, disposition) => {
      const client = new MappedResultClient(
        new Map([
          [
            "weather.summary.v1",
            { url: "https://result.example/results", token: "secret" }
          ]
        ]),
        10_000,
        (async () => new Response(null, { status })) as typeof fetch
      );
      await expect(
        client.submit(makeJob(), "local-model", { summary: "ok" })
      ).rejects.toMatchObject({ code, disposition });
    }
  );

  it.each([
    [
      { disposition: "published", jobId: "different-job" },
      "result_submit_identity_mismatch"
    ],
    [{ disposition: "not-a-disposition", jobId: "job-1" }, "result_submit_response_invalid"]
  ] as const)("treats an invalid 200 callback as persistent %s", async (body, code) => {
    const client = new MappedResultClient(
      new Map([
        [
          "weather.summary.v1",
          { url: "https://result.example/results", token: "secret" }
        ]
      ]),
      10_000,
      (async () => Response.json(body)) as typeof fetch
    );
    await expect(
      client.submit(makeJob(), "local-model", { summary: "ok" })
    ).rejects.toMatchObject({ code, disposition: "terminal" });
  });

  it("bounds declared and chunked successful callback responses", async () => {
    const job = makeJob();
    const targets = new Map([
      [
        "weather.summary.v1",
        { url: "https://result.example/results", token: "secret" }
      ]
    ]);
    const declared = new MappedResultClient(
      targets,
      10_000,
      (async () => new Response("{}", {
        headers: { "Content-Length": "20000" }
      })) as typeof fetch
    );
    await expect(declared.submit(job, "local-model", { summary: "ok" }))
      .rejects.toMatchObject({
        code: "result_submit_response_invalid",
        disposition: "terminal"
      });

    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(9_000));
      },
      cancel
    });
    const chunked = new MappedResultClient(
      targets,
      10_000,
      (async () => new Response(body)) as typeof fetch
    );
    await expect(chunked.submit(job, "local-model", { summary: "ok" }))
      .rejects.toMatchObject({
        code: "result_submit_response_invalid",
        disposition: "terminal"
      });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
