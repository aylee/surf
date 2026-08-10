import {
  JsonValueSchema,
  type JsonValue,
  type NarrativeJob
} from "@surf/narrative-contracts";
import { z } from "zod";
import { readBoundedJson } from "./bounded-json";
import type { RunnerConfig } from "./config";
import { RunnerFailure } from "./errors";
import type { Fetcher } from "./queue-client";

const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough())
}).passthrough();

const ChatCompletionSchema = z.object({
  model: z.string().min(1).optional(),
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().min(1) }).passthrough()
    }).passthrough()
  ).min(1)
}).passthrough();

export const OMLX_MODELS_RESPONSE_MAX_BYTES = 256 * 1_024;
export const OMLX_COMPLETION_RESPONSE_MAX_BYTES = 256 * 1_024;

export type OmlxGeneration = {
  output: JsonValue;
  modelId: string;
};

export interface OmlxClient {
  preflight(): Promise<void>;
  generate(job: NarrativeJob, timeoutMs?: number): Promise<OmlxGeneration>;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
}

export class OpenAiCompatibleOmlxClient implements OmlxClient {
  constructor(
    private readonly config: RunnerConfig["omlx"],
    private readonly fetcher: Fetcher = fetch
  ) {}

  private headers(): HeadersInit {
    return {
      Accept: "application/json",
      ...(this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {})
    };
  }

  async preflight(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}/models`, {
        method: "GET",
        headers: this.headers(),
        signal: timeoutSignal(Math.min(this.config.timeoutMs, 30_000))
      });
    } catch {
      throw new RunnerFailure("omlx_preflight_network", "transient");
    }
    if ([401, 403].includes(response.status)) {
      throw new RunnerFailure("omlx_inference_auth", "terminal");
    }
    if (!response.ok) {
      const transient = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
      throw new RunnerFailure(
        transient ? "omlx_preflight_http_transient" : "omlx_preflight_http_terminal",
        transient ? "transient" : "terminal"
      );
    }
    try {
      const models = ModelListSchema.parse(
        await readBoundedJson(response, OMLX_MODELS_RESPONSE_MAX_BYTES)
      );
      if (!models.data.some(({ id }) => id === this.config.modelId)) {
        throw new RunnerFailure("omlx_model_unavailable", "transient");
      }
    } catch (error) {
      if (error instanceof RunnerFailure) throw error;
      throw new RunnerFailure("omlx_preflight_response_invalid", "transient");
    }
  }

  async generate(job: NarrativeJob, timeoutMs = this.config.timeoutMs): Promise<OmlxGeneration> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          ...this.headers(),
          "Content-Type": "application/json"
        },
        signal: timeoutSignal(Math.min(this.config.timeoutMs, timeoutMs)),
        body: JSON.stringify({
          model: this.config.modelId,
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
          temperature: job.inference.temperature,
          chat_template_kwargs: {
            enable_thinking: this.config.enableThinking
          },
          stream: false
        })
      });
    } catch {
      throw new RunnerFailure("omlx_inference_network", "transient");
    }

    if (!response.ok) {
      if ([401, 403].includes(response.status)) {
        throw new RunnerFailure("omlx_inference_auth", "terminal");
      }
      const transient = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
      throw new RunnerFailure(
        transient ? "omlx_inference_http_transient" : "omlx_inference_http_terminal",
        transient ? "transient" : "terminal"
      );
    }

    let completion: z.infer<typeof ChatCompletionSchema>;
    try {
      completion = ChatCompletionSchema.parse(
        await readBoundedJson(response, OMLX_COMPLETION_RESPONSE_MAX_BYTES)
      );
    } catch {
      throw new RunnerFailure("omlx_inference_response_invalid", "transient");
    }
    if (completion.model === undefined) {
      throw new RunnerFailure("omlx_inference_model_identity_missing", "terminal");
    }
    if (completion.model !== this.config.modelId) {
      throw new RunnerFailure("omlx_inference_model_identity_mismatch", "terminal");
    }
    const content = completion.choices[0]!.message.content;
    try {
      return {
        output: JsonValueSchema.parse(JSON.parse(content)),
        modelId: completion.model
      };
    } catch {
      throw new RunnerFailure("omlx_output_invalid", "terminal");
    }
  }
}
