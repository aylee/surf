import { Agent, type AgentContext } from "agents";
import { createGeminiBriefGenerator } from "../brief/gemini";
import { persistValidatedForecastBrief } from "../brief/repository";
import {
  ForecastFactBundleSchema,
  type ForecastBriefDraft,
  type ForecastFactBundle
} from "../brief/types";
import { validateForecastBriefDraft } from "../brief/validator";
import { retryDelaySecondsAfterFailure } from "./retry-policy";

export type ForecastBriefAgentEnv = Cloudflare.Env;

type BriefJobStatus =
  | "queued"
  | "generating"
  | "retry_wait"
  | "published"
  | "disabled"
  | "exhausted";

type BriefJobRow = {
  local_date: string;
  spot_id: string;
  last_seen_fingerprint: string;
  material_fingerprint: string;
  published_fingerprint: string | null;
  generation_token: string;
  status: BriefJobStatus;
  attempt_count: number;
  bundle_json: string;
  last_error: string | null;
  updated_at: string;
};

export type ForecastBriefSignalResult = {
  status: "accepted" | "duplicate" | "ignored_non_material" | "disabled" | "exhausted";
  inputFingerprint: string;
  materialFingerprint: string;
};

export type ForecastBriefCoordinationState = {
  localDate: string;
  spotId: string;
  status: BriefJobStatus;
  attemptCount: number;
  lastSeenFingerprint: string;
  materialFingerprint: string;
  publishedFingerprint: string | null;
  updatedAt: string;
} | null;

type ProcessPayload = {
  localDate: string;
  generationToken: string;
};

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function parseBundle(value: string): ForecastFactBundle {
  try {
    return ForecastFactBundleSchema.parse(JSON.parse(value));
  } catch (error) {
    throw new Error(
      `Stored forecast fact bundle is invalid: ${error instanceof Error ? error.message : "parse error"}`
    );
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]").slice(0, 500);
}

export class ForecastBriefAgent extends Agent<ForecastBriefAgentEnv> {
  private readonly objectName: string | undefined;

  constructor(ctx: AgentContext, env: ForecastBriefAgentEnv) {
    super(ctx, env);
    this.objectName = ctx.id.name;
    void ctx.blockConcurrencyWhile(async () => {
      this.sql`
        create table if not exists forecast_brief_jobs (
          local_date text primary key,
          spot_id text not null,
          last_seen_fingerprint text not null,
          material_fingerprint text not null,
          published_fingerprint text,
          generation_token text not null,
          status text not null,
          attempt_count integer not null,
          bundle_json text not null,
          last_error text,
          updated_at text not null
        )
      `;
    });
  }

  private job(localDate: string): BriefJobRow | null {
    return this.sql<BriefJobRow>`
      select local_date, spot_id, last_seen_fingerprint, material_fingerprint,
             published_fingerprint, generation_token, status, attempt_count,
             bundle_json, last_error, updated_at
      from forecast_brief_jobs
      where local_date = ${localDate}
      limit 1
    `[0] ?? null;
  }

  protected async generateDraft(bundle: ForecastFactBundle): Promise<ForecastBriefDraft> {
    return createGeminiBriefGenerator({ apiKey: this.env.GEMINI_API_KEY }).generate(bundle);
  }

  async signal(value: ForecastFactBundle): Promise<ForecastBriefSignalResult> {
    const bundle = ForecastFactBundleSchema.parse(value);
    if (this.objectName && this.objectName !== bundle.input.spotId) {
      throw new Error(
        `Forecast brief agent ${this.objectName} cannot coordinate spot ${bundle.input.spotId}`
      );
    }
    if (!enabled(this.env.FORECAST_BRIEF_ENABLED) || !this.env.GEMINI_API_KEY?.trim()) {
      return {
        status: "disabled",
        inputFingerprint: bundle.inputFingerprint,
        materialFingerprint: bundle.materialFingerprint
      };
    }

    const existing = this.job(bundle.input.localDate);
    if (existing?.published_fingerprint === bundle.inputFingerprint) {
      return {
        status: "duplicate",
        inputFingerprint: bundle.inputFingerprint,
        materialFingerprint: bundle.materialFingerprint
      };
    }
    if (
      existing?.material_fingerprint === bundle.materialFingerprint &&
      existing.status !== "disabled"
    ) {
      return {
        status:
          existing.status === "published"
            ? "ignored_non_material"
            : existing.status === "exhausted"
              ? "exhausted"
              : "duplicate",
        inputFingerprint: bundle.inputFingerprint,
        materialFingerprint: bundle.materialFingerprint
      };
    }

    const generationToken = crypto.randomUUID();
    const updatedAt = new Date().toISOString();
    this.sql`
      insert into forecast_brief_jobs (
        local_date, spot_id, last_seen_fingerprint, material_fingerprint,
        published_fingerprint, generation_token, status, attempt_count,
        bundle_json, last_error, updated_at
      ) values (
        ${bundle.input.localDate}, ${bundle.input.spotId}, ${bundle.inputFingerprint},
        ${bundle.materialFingerprint}, null, ${generationToken}, 'queued', 0,
        ${JSON.stringify(bundle)}, null, ${updatedAt}
      )
      on conflict(local_date) do update set
        spot_id = excluded.spot_id,
        last_seen_fingerprint = excluded.last_seen_fingerprint,
        material_fingerprint = excluded.material_fingerprint,
        generation_token = excluded.generation_token,
        status = 'queued',
        attempt_count = 0,
        bundle_json = excluded.bundle_json,
        last_error = null,
        updated_at = excluded.updated_at
    `;
    await this.queue("processPending", {
      localDate: bundle.input.localDate,
      generationToken
    } satisfies ProcessPayload);
    return {
      status: "accepted",
      inputFingerprint: bundle.inputFingerprint,
      materialFingerprint: bundle.materialFingerprint
    };
  }

  async processPending(payload: ProcessPayload): Promise<void> {
    const job = this.job(payload.localDate);
    if (
      !job ||
      job.generation_token !== payload.generationToken ||
      job.status === "published" ||
      job.status === "exhausted" ||
      job.status === "disabled"
    ) {
      return;
    }
    if (!enabled(this.env.FORECAST_BRIEF_ENABLED) || !this.env.GEMINI_API_KEY?.trim()) {
      this.sql`
        update forecast_brief_jobs
        set status = 'disabled', updated_at = ${new Date().toISOString()}
        where local_date = ${payload.localDate} and generation_token = ${payload.generationToken}
      `;
      return;
    }

    this.sql`
      update forecast_brief_jobs
      set status = 'generating', updated_at = ${new Date().toISOString()}
      where local_date = ${payload.localDate} and generation_token = ${payload.generationToken}
    `;
    try {
      const bundle = parseBundle(job.bundle_json);

      // External model I/O happens outside blockConcurrencyWhile. The durable token
      // is checked again before and after the D1 publication boundary.
      const generated = await this.generateDraft(bundle);
      const beforePublish = this.job(payload.localDate);
      if (!beforePublish || beforePublish.generation_token !== payload.generationToken) return;

      const { draft, validation } = validateForecastBriefDraft(generated, bundle);
      const persisted = await persistValidatedForecastBrief({
        db: this.env.DB,
        bundle,
        draft,
        validation
      });
      const afterPublish = this.job(payload.localDate);
      if (!afterPublish || afterPublish.generation_token !== payload.generationToken) return;
      this.sql`
        update forecast_brief_jobs
        set status = 'published',
            published_fingerprint = ${persisted.brief.inputFingerprint},
            last_error = null,
            updated_at = ${new Date().toISOString()}
        where local_date = ${payload.localDate} and generation_token = ${payload.generationToken}
      `;
    } catch (error) {
      await this.recordFailureAndScheduleRetry(payload, error);
    }
  }

  async retryPending(payload: ProcessPayload): Promise<void> {
    const job = this.job(payload.localDate);
    if (
      !job ||
      job.generation_token !== payload.generationToken ||
      job.status !== "retry_wait"
    ) {
      return;
    }
    await this.processPending(payload);
  }

  private async recordFailureAndScheduleRetry(
    payload: ProcessPayload,
    error: unknown
  ): Promise<void> {
    const current = this.job(payload.localDate);
    if (!current || current.generation_token !== payload.generationToken) return;
    const attemptCount = current.attempt_count + 1;
    const delaySeconds = retryDelaySecondsAfterFailure(attemptCount);
    const status: BriefJobStatus = delaySeconds === null ? "exhausted" : "retry_wait";
    this.sql`
      update forecast_brief_jobs
      set status = ${status}, attempt_count = ${attemptCount}, last_error = ${safeError(error)},
          updated_at = ${new Date().toISOString()}
      where local_date = ${payload.localDate} and generation_token = ${payload.generationToken}
    `;
    console.error(
      JSON.stringify({
        message: "forecast brief generation failed",
        spotId: current.spot_id,
        localDate: current.local_date,
        attemptCount,
        retryInSeconds: delaySeconds,
        error: safeError(error)
      })
    );
    if (delaySeconds !== null) {
      await this.schedule(delaySeconds, "retryPending", payload, { idempotent: true });
    }
  }

  async getCoordinationState(localDate: string): Promise<ForecastBriefCoordinationState> {
    const job = this.job(localDate);
    return job
      ? {
          localDate: job.local_date,
          spotId: job.spot_id,
          status: job.status,
          attemptCount: job.attempt_count,
          lastSeenFingerprint: job.last_seen_fingerprint,
          materialFingerprint: job.material_fingerprint,
          publishedFingerprint: job.published_fingerprint,
          updatedAt: job.updated_at
        }
      : null;
  }
}
