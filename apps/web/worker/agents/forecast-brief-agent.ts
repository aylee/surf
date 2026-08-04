import { Agent, type AgentContext } from "agents";
import { createGeminiBriefGenerator } from "../brief/gemini";
import { persistValidatedForecastBrief } from "../brief/repository";
import {
  ForecastFactBundleSchema,
  type ForecastBriefDraft,
  type ForecastFactBundle
} from "../brief/types";
import { validateForecastBriefDraft } from "../brief/validator";
import { boundedErrorName } from "../logging";
import {
  classifyForecastBriefFailure,
  retryDelaySecondsAfterFailure,
  StoredForecastFactBundleError
} from "./retry-policy";

export type ForecastBriefAgentEnv = Cloudflare.Env;

type BriefJobStatus =
  | "queued"
  | "generating"
  | "retry_wait"
  | "published"
  | "disabled"
  | "terminal"
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

type BriefGenerationHighWaterRow = {
  local_date: string;
  generated_at: string;
  updated_at: string;
};

export type ForecastBriefSignalResult = {
  status:
    | "accepted"
    | "duplicate"
    | "ignored_non_material"
    | "superseded"
    | "disabled"
    | "terminal"
    | "exhausted";
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

type RetryPayload = ProcessPayload & {
  attemptCount: number;
};

// Final failures should not hot-loop when a key or provider configuration is
// wrong, but a later ingest must be able to recover after the operator fixes
// it. A new input fingerprint proves this is a later signal; the cooldown
// bounds retries while the underlying material forecast remains unchanged.
export const FORECAST_BRIEF_FINAL_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;

// `generating` is a lease rather than a permanent lock. If a Worker is
// interrupted after claiming a queued item, a later signal can reclaim it
// after this interval. Generation tokens keep a late callback from publishing.
export const FORECAST_BRIEF_GENERATION_LEASE_MS = 10 * 60 * 1000;

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function parseStoredBundle(job: BriefJobRow): ForecastFactBundle {
  try {
    const bundle = ForecastFactBundleSchema.parse(JSON.parse(job.bundle_json));
    if (
      bundle.input.localDate !== job.local_date ||
      bundle.input.spotId !== job.spot_id ||
      bundle.inputFingerprint !== job.last_seen_fingerprint ||
      bundle.materialFingerprint !== job.material_fingerprint
    ) {
      throw new Error("stored bundle identity mismatch");
    }
    return bundle;
  } catch {
    // Stored coordination state is an integrity boundary. Keep the error fixed
    // so malformed JSON, schema diagnostics, and persisted values cannot reach
    // console output or the durable last_error field.
    throw new StoredForecastFactBundleError("Stored forecast fact bundle is invalid");
  }
}

export type ForecastBriefGenerationOrder = "older" | "equal" | "newer";

export function compareForecastBriefGeneratedAt(
  candidateGeneratedAt: string,
  currentGeneratedAt: string
): ForecastBriefGenerationOrder {
  const candidateTimestamp = Date.parse(candidateGeneratedAt);
  const currentTimestamp = Date.parse(currentGeneratedAt);
  if (!Number.isFinite(candidateTimestamp) || !Number.isFinite(currentTimestamp)) {
    throw new StoredForecastFactBundleError("Stored forecast fact bundle is invalid");
  }
  if (candidateTimestamp < currentTimestamp) return "older";
  if (candidateTimestamp > currentTimestamp) return "newer";
  return "equal";
}

function canonicalForecastBriefGeneratedAt(generatedAt: string): string {
  const timestamp = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp)) {
    throw new StoredForecastFactBundleError("Stored forecast fact bundle is invalid");
  }
  return new Date(timestamp).toISOString();
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]").slice(0, 500);
}

function elapsed(timestamp: string, durationMs: number, nowMs = Date.now()): boolean {
  const updatedAtMs = new Date(timestamp).getTime();
  return !Number.isFinite(updatedAtMs) || nowMs - updatedAtMs >= durationMs;
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
      this.sql`
        create table if not exists forecast_brief_generation_high_water (
          local_date text primary key,
          generated_at text not null,
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

  private generationHighWater(localDate: string): BriefGenerationHighWaterRow | null {
    return this.sql<BriefGenerationHighWaterRow>`
      select local_date, generated_at, updated_at
      from forecast_brief_generation_high_water
      where local_date = ${localDate}
      limit 1
    `[0] ?? null;
  }

  private recordGenerationHighWater(localDate: string, generatedAt: string): void {
    const canonicalGeneratedAt = canonicalForecastBriefGeneratedAt(generatedAt);
    this.sql`
      insert into forecast_brief_generation_high_water (local_date, generated_at, updated_at)
      values (${localDate}, ${canonicalGeneratedAt}, ${new Date().toISOString()})
      on conflict(local_date) do update set
        generated_at = excluded.generated_at,
        updated_at = excluded.updated_at
    `;
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
    let highWater = this.generationHighWater(bundle.input.localDate);
    if (!highWater && existing) {
      // Existing deployments bootstrap the new monotonic guard from the
      // integrity-checked job bundle. From then on the dedicated row remains
      // authoritative even when queue submission cleanup removes the job.
      const existingBundle = parseStoredBundle(existing);
      this.recordGenerationHighWater(
        bundle.input.localDate,
        existingBundle.input.generatedAt
      );
      highWater = this.generationHighWater(bundle.input.localDate);
    }
    if (
      highWater &&
      compareForecastBriefGeneratedAt(
        bundle.input.generatedAt,
        highWater.generated_at
      ) === "older"
    ) {
      return {
        status: "superseded",
        inputFingerprint: bundle.inputFingerprint,
        materialFingerprint: bundle.materialFingerprint
      };
    }

    // Advance before every enabled non-older early return. A newer same-
    // material signal may coalesce with the current job, but intermediate old
    // material must never regain write authority. This row intentionally
    // survives queue-submission cleanup so the same generation can retry while
    // older generations remain superseded.
    this.recordGenerationHighWater(bundle.input.localDate, bundle.input.generatedAt);

    if (existing?.published_fingerprint === bundle.inputFingerprint) {
      return {
        status: "duplicate",
        inputFingerprint: bundle.inputFingerprint,
        materialFingerprint: bundle.materialFingerprint
      };
    }
    const sameMaterial =
      existing !== null && existing.material_fingerprint === bundle.materialFingerprint;
    const recoverStaleGeneration =
      existing !== null &&
      sameMaterial &&
      existing.status === "generating" &&
      elapsed(existing.updated_at, FORECAST_BRIEF_GENERATION_LEASE_MS);
    const recoverFinalFailure =
      existing !== null &&
      sameMaterial &&
      (existing.status === "terminal" || existing.status === "exhausted") &&
      existing.last_seen_fingerprint !== bundle.inputFingerprint &&
      elapsed(existing.updated_at, FORECAST_BRIEF_FINAL_RECOVERY_COOLDOWN_MS);
    if (
      existing !== null &&
      sameMaterial &&
      existing.status !== "disabled" &&
      !recoverStaleGeneration &&
      !recoverFinalFailure
    ) {
      return {
        status:
          existing.status === "published"
            ? "ignored_non_material"
            : existing.status === "exhausted"
              ? "exhausted"
              : existing.status === "terminal"
                ? "terminal"
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
    try {
      await this.queue(
        "processPending",
        {
          localDate: bundle.input.localDate,
          generationToken
        } satisfies ProcessPayload,
        { retry: { maxAttempts: 1 } }
      );
    } catch (error) {
      // The job row is coordination state, not product history. Remove the
      // unsubmitted job so a later identical ingest can safely try again.
      this.sql`
        delete from forecast_brief_jobs
        where local_date = ${bundle.input.localDate} and generation_token = ${generationToken}
      `;
      console.error(
        JSON.stringify({
          event: "forecast_brief_queue_submission_failed",
          message: "forecast brief queue submission failed",
          spotId: bundle.input.spotId,
          localDate: bundle.input.localDate,
          reasonCode: "brief_queue_submission_failed",
          errorName: boundedErrorName(error)
        })
      );
      throw error;
    }
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
      job.status !== "queued"
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
      const bundle = parseStoredBundle(job);

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

  async retryPending(payload: RetryPayload): Promise<void> {
    const job = this.job(payload.localDate);
    if (
      !job ||
      job.generation_token !== payload.generationToken ||
      job.status !== "retry_wait" ||
      job.attempt_count !== payload.attemptCount
    ) {
      return;
    }
    this.sql`
      update forecast_brief_jobs
      set status = 'queued', updated_at = ${new Date().toISOString()}
      where local_date = ${payload.localDate}
        and generation_token = ${payload.generationToken}
        and status = 'retry_wait'
    `;
    await this.processPending(payload);
  }

  private async recordFailureAndScheduleRetry(
    payload: ProcessPayload,
    error: unknown
  ): Promise<void> {
    const current = this.job(payload.localDate);
    if (!current || current.generation_token !== payload.generationToken) return;
    const attemptCount = current.attempt_count + 1;
    const disposition = classifyForecastBriefFailure(error);
    const delaySeconds = retryDelaySecondsAfterFailure(attemptCount, disposition);
    const status: BriefJobStatus =
      delaySeconds === null
        ? disposition === "transient"
          ? "exhausted"
          : "terminal"
        : "retry_wait";
    this.sql`
      update forecast_brief_jobs
      set status = ${status}, attempt_count = ${attemptCount}, last_error = ${safeError(error)},
          updated_at = ${new Date().toISOString()}
      where local_date = ${payload.localDate} and generation_token = ${payload.generationToken}
    `;
    console.error(
      JSON.stringify({
        event: "forecast_brief_generation_failed",
        message: "forecast brief generation failed",
        spotId: current.spot_id,
        localDate: current.local_date,
        attemptCount,
        disposition,
        retryInSeconds: delaySeconds,
        reasonCode: "brief_generation_failed",
        errorName: boundedErrorName(error)
      })
    );
    if (delaySeconds !== null) {
      try {
        const retryPayload: RetryPayload = {
          ...payload,
          attemptCount
        };
        await this.schedule(delaySeconds, "retryPending", retryPayload, {
          idempotent: true,
          retry: { maxAttempts: 1 }
        });
      } catch (scheduleError) {
        const schedulingFailure = `Retry scheduling failed: ${safeError(scheduleError)}`;
        this.sql`
          update forecast_brief_jobs
          set status = 'terminal', last_error = ${schedulingFailure},
              updated_at = ${new Date().toISOString()}
          where local_date = ${payload.localDate}
            and generation_token = ${payload.generationToken}
            and status = 'retry_wait'
        `;
        console.error(
          JSON.stringify({
            event: "forecast_brief_retry_scheduling_failed",
            message: "forecast brief retry scheduling failed",
            spotId: current.spot_id,
            localDate: current.local_date,
            attemptCount,
            disposition,
            reasonCode: "brief_retry_scheduling_failed",
            errorName: boundedErrorName(scheduleError)
          })
        );
      }
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
