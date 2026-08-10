import { describe, expect, it, vi } from "vitest";
import { buildForecastFactBundle } from "../brief/facts";
import { briefForecastFixture } from "../brief/test-helpers";
import { buildSurfAnalysisSnapshot, buildSurfNarrativeJob } from "../analysis";
import { createGeminiNarrativeGenerator, GeminiFallbackError } from "./gemini-fallback";

async function fixtureJob() {
  const bundle = await buildForecastFactBundle(briefForecastFixture());
  return buildSurfNarrativeJob(await buildSurfAnalysisSnapshot(bundle));
}

describe("Gemini narrative fallback", () => {
  it("uses the existing OpenAI-compatible JSON Schema job contract", async () => {
    const job = await fixtureJob();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({
        model: "gemini-3.6-flash",
        messages: job.inference.messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: `narrative_output_v${job.outputSchemaVersion}`,
            strict: true,
            schema: job.inference.responseSchema
          }
        },
        max_tokens: job.inference.maxOutputTokens,
        reasoning_effort: "low",
        stream: false
      });
      expect(request).not.toHaveProperty("temperature");
      expect(request).not.toHaveProperty("top_p");
      expect(request).not.toHaveProperty("top_k");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
      return Response.json({
        model: "gemini-3.6-flash",
        choices: [{ message: { content: JSON.stringify({ paragraphs: {} }) } }]
      });
    });
    await expect(
      createGeminiNarrativeGenerator(fetcher)(job, {
        apiKey: "secret",
        modelId: "gemini-3.6-flash",
        timeoutMs: 1_000
      })
    ).resolves.toEqual({
      output: { paragraphs: {} },
      modelId: "gemini-3.6-flash"
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("classifies provider auth without exposing a response body", async () => {
    const generator = createGeminiNarrativeGenerator(async () =>
      new Response("sensitive provider detail", { status: 401 })
    );
    await expect(
      generator(await fixtureJob(), {
        apiKey: "secret",
        modelId: "gemini-3.6-flash",
        timeoutMs: 1_000
      })
    ).rejects.toEqual(new GeminiFallbackError("gemini_fallback_auth", false));
  });

  it.each([
    {
      label: "missing",
      responseModel: undefined,
      code: "gemini_fallback_model_identity_missing"
    },
    {
      label: "mismatched",
      responseModel: "gemini-other",
      code: "gemini_fallback_model_identity_mismatch"
    }
  ])("rejects a $label provider model identity", async ({ responseModel, code }) => {
    const generator = createGeminiNarrativeGenerator(async () =>
      Response.json({
        ...(responseModel ? { model: responseModel } : {}),
        choices: [{ message: { content: JSON.stringify({ paragraphs: {} }) } }]
      })
    );
    await expect(
      generator(await fixtureJob(), {
        apiKey: "secret",
        modelId: "gemini-3.6-flash",
        timeoutMs: 1_000
      })
    ).rejects.toEqual(new GeminiFallbackError(code, false));
  });
});
