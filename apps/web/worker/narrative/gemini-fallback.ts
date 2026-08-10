import {
  JsonValueSchema,
  type JsonValue,
  type NarrativeJob
} from "@surf/narrative-contracts";
import { z } from "zod";

const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_RESPONSE_MAX_BYTES = 256 * 1024;

const ChatCompletionSchema = z
  .object({
    model: z.string().min(1).optional(),
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().min(1) }).passthrough()
          })
          .passthrough()
      )
      .min(1)
  })
  .passthrough();

export class GeminiFallbackError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = "GeminiFallbackError";
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("response_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("response_body_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

export type GeminiNarrativeGenerator = (
  job: NarrativeJob,
  options: { apiKey: string; modelId: string; timeoutMs: number }
) => Promise<{ output: JsonValue; modelId: string }>;

export function createGeminiNarrativeGenerator(
  fetcher: typeof fetch = fetch
): GeminiNarrativeGenerator {
  return async (job, options) => {
    let response: Response;
    try {
      response = await fetcher(`${GEMINI_OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs, 90_000))),
        body: JSON.stringify({
          model: options.modelId,
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
        })
      });
    } catch {
      throw new GeminiFallbackError("gemini_fallback_network", false);
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new GeminiFallbackError("gemini_fallback_auth", false);
      }
      const transient =
        [408, 409, 425, 429].includes(response.status) || response.status >= 500;
      throw new GeminiFallbackError(
        transient ? "gemini_fallback_http_transient" : "gemini_fallback_http_terminal",
        transient
      );
    }

    let completion: z.infer<typeof ChatCompletionSchema>;
    try {
      completion = ChatCompletionSchema.parse(
        await readBoundedJson(response, GEMINI_RESPONSE_MAX_BYTES)
      );
    } catch {
      throw new GeminiFallbackError("gemini_fallback_response_invalid", false);
    }
    if (completion.model === undefined) {
      throw new GeminiFallbackError("gemini_fallback_model_identity_missing", false);
    }
    if (completion.model !== options.modelId) {
      throw new GeminiFallbackError("gemini_fallback_model_identity_mismatch", false);
    }
    const content = completion.choices[0]!.message.content;
    try {
      return {
        output: JsonValueSchema.parse(JSON.parse(content)),
        modelId: completion.model
      };
    } catch {
      throw new GeminiFallbackError("gemini_fallback_output_invalid", false);
    }
  };
}
