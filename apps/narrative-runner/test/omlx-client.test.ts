import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  OMLX_COMPLETION_RESPONSE_MAX_BYTES,
  OMLX_MODELS_RESPONSE_MAX_BYTES,
  OpenAiCompatibleOmlxClient
} from "../src/omlx-client";
import { makeConfig, makeJob } from "./fakes";

describe("bounded oMLX transport", () => {
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

  it("keeps LaunchAgent arguments mapped to pnpm run and the daemon script", () => {
    const plist = readFileSync(
      new URL(
        "../examples/ai.alex.narrative-runner.plist.example",
        import.meta.url
      ),
      "utf8"
    );
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts: Record<string, string> };
    const argumentsBlock = plist.match(
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/
    )?.[1];
    const argumentsList = [
      ...(argumentsBlock ?? "").matchAll(/<string>(.*?)<\/string>/g)
    ].map((match) => match[1]);

    expect(argumentsList.slice(-2)).toEqual(["run", "run"]);
    expect(packageJson.scripts.run).toMatch(/src\/cli\.ts run$/);
  });
});
