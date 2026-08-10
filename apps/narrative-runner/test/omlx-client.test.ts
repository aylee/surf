import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  OMLX_COMPLETION_RESPONSE_MAX_BYTES,
  OMLX_MODELS_RESPONSE_MAX_BYTES,
  OpenAiCompatibleOmlxClient
} from "../src/omlx-client";
import { makeConfig, makeJob } from "./fakes";

describe("bounded oMLX transport", () => {
  it("disables model thinking in the oMLX chat template unless explicitly enabled", async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        model: "local-model",
        choices: [{ message: { content: JSON.stringify({ summary: "ok" }) } }]
      });
    });
    const disabled = new OpenAiCompatibleOmlxClient(
      makeConfig().omlx,
      fetcher as unknown as typeof fetch
    );
    const enabled = new OpenAiCompatibleOmlxClient(
      makeConfig({ omlx: { enableThinking: true } }).omlx,
      fetcher as unknown as typeof fetch
    );

    await disabled.generate(makeJob());
    await enabled.generate(makeJob());

    expect(bodies).toEqual([
      expect.objectContaining({
        chat_template_kwargs: { enable_thinking: false }
      }),
      expect.objectContaining({
        chat_template_kwargs: { enable_thinking: true }
      })
    ]);
  });

  it.each([
    {
      label: "missing",
      responseModel: undefined,
      code: "omlx_inference_model_identity_missing"
    },
    {
      label: "mismatched",
      responseModel: "different-model",
      code: "omlx_inference_model_identity_mismatch"
    }
  ])("rejects a $label completion model identity", async ({ responseModel, code }) => {
    const fetcher = vi.fn(async () =>
      Response.json({
        ...(responseModel ? { model: responseModel } : {}),
        choices: [{ message: { content: JSON.stringify({ summary: "ok" }) } }]
      })
    );
    const client = new OpenAiCompatibleOmlxClient(
      makeConfig().omlx,
      fetcher as unknown as typeof fetch
    );

    await expect(client.generate(makeJob())).rejects.toMatchObject({
      code,
      disposition: "terminal"
    });
  });

  it.each(["/models", "/chat/completions"])(
    "classifies %s authentication rejection as a persistent auth fault",
    async (path) => {
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toContain(path);
        return new Response(null, { status: 401 });
      });
      const client = new OpenAiCompatibleOmlxClient(
        makeConfig().omlx,
        fetcher as unknown as typeof fetch
      );

      const operation = path === "/models"
        ? client.preflight()
        : client.generate(makeJob());
      await expect(operation).rejects.toMatchObject({
        code: "omlx_inference_auth",
        disposition: "terminal"
      });
    }
  );

  it.each([
    { status: 422, code: "omlx_preflight_http_terminal", disposition: "terminal" },
    { status: 503, code: "omlx_preflight_http_transient", disposition: "transient" }
  ] as const)(
    "classifies model-list HTTP $status as $disposition",
    async ({ status, code, disposition }) => {
      const client = new OpenAiCompatibleOmlxClient(
        makeConfig().omlx,
        vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch
      );
      await expect(client.preflight()).rejects.toMatchObject({ code, disposition });
    }
  );

  it("rejects a declared oversized model list before JSON parsing", async () => {
    const fetcher = vi.fn(async () =>
      new Response('{"data":[]}', {
        headers: { "Content-Length": String(OMLX_MODELS_RESPONSE_MAX_BYTES + 1) }
      })
    );
    const client = new OpenAiCompatibleOmlxClient(
      makeConfig().omlx,
      fetcher as unknown as typeof fetch
    );

    await expect(client.preflight()).rejects.toMatchObject({
      code: "omlx_preflight_response_invalid",
      disposition: "transient"
    });
  });

  it("cancels a chunked completion response as soon as the byte limit is crossed", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(OMLX_COMPLETION_RESPONSE_MAX_BYTES / 2 + 1);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls >= 3) controller.close();
      },
      cancel
    });
    const fetcher = vi.fn(async () => new Response(body));
    const client = new OpenAiCompatibleOmlxClient(
      makeConfig().omlx,
      fetcher as unknown as typeof fetch
    );

    await expect(client.generate(makeJob())).rejects.toMatchObject({
      code: "omlx_inference_response_invalid",
      disposition: "transient"
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("runs through the activation verifier instead of ambient daemon configuration", () => {
    const plist = readFileSync(
      new URL(
        "../examples/ai.alex.narrative-runner.plist.example",
        import.meta.url
      ),
      "utf8"
    );
    const argumentsBlock = plist.match(
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/
    )?.[1];
    const argumentsList = [
      ...(argumentsBlock ?? "").matchAll(/<string>(.*?)<\/string>/g)
    ].map((match) => match[1]);

    expect(argumentsList).toEqual([
      "/usr/bin/env",
      "-i",
      "HOME=__HOME_ABSOLUTE_PATH__",
      "LANG=en_US.UTF-8",
      "PATH=__NODE_BIN_ABSOLUTE_DIRECTORY__:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "__NODE_ABSOLUTE_PATH__",
      "__RUNNER_GUARD_ABSOLUTE_PATH__",
      "--record",
      "__ACTIVATION_RECORD_ABSOLUTE_PATH__",
      "--command",
      "run"
    ]);
  });
});
