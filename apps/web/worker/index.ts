import { zValidator } from "@hono/zod-validator";
import {
  getOperationalObservedWaveSources,
  isNorcalSpotId,
  NORCAL_SPOTS
} from "@surf/forecast-core";
import { ForecastIntervalSchema, SpotIdSchema, SpotsResponseSchema } from "@surf/contracts";
import {
  NARRATIVE_RESULT_MAX_BYTES,
  NarrativeFallbackWatchdogSchema,
  NarrativeResultResponseSchema,
  NarrativeResultSubmissionSchema,
  assertNarrativeResultSize
} from "@surf/narrative-contracts";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { ForecastBriefAgent } from "./agents";
import {
  acceptSurfAnalysisResult,
  buildSurfAnalysisSnapshot,
  buildSurfAnalysisResponse,
  unavailableSurfAnalysisResponse
} from "./analysis";
import { bearerTokenMatches } from "./auth";
import {
  getActiveMaterializedForecastFactBundlesForGeneration,
  getMaterializedForecastFactBundle,
  getMaterializedForecastJson
} from "./forecast-read-model";
import { getForecastReadiness } from "./forecast-readiness";
import {
  runNorcalIngest,
  type ForecastMaterializationQueueMessage
} from "./ingest";
import {
  boundedPipelineErrorName,
  dispatchSurfAnalysisSignal,
  logInlineIngestTerminalOutcomes,
  logSourceIngestTerminalOutcome,
  processIngestQueueMessage,
  signalInlineForecastBriefs,
  type ForecastBriefSignalContext
} from "./ingest/queue";
import {
  acceptNarrativeTerminalResult,
  enqueueNarrativeFallbackWatchdog,
  enqueueSurfAnalysisBundles,
  getNarrativeJob,
  narrativeEnabled,
  narrativeFallbackConfig,
  processNarrativeFallbackWatchdog,
  reconcileNarrativeEnqueues,
  replayGeneratedNarrativeFallbacks,
  selectSurfAnalysisBundlesForSignal,
  SURF_ANALYSIS_FUTURE_CADENCE_HOURS
} from "./narrative";
import { localDateForTime } from "./time";

export type Env = Omit<
  CloudflareBindings,
  | "ENVIRONMENT"
  | "SURF_REGION"
  | "SURF_USER_AGENT"
  | "FORECAST_BRIEF_AGENT"
  | "FORECAST_BRIEF_ENABLED"
  | "NARRATIVE_ENABLED"
  | "NARRATIVE_QUEUE"
  | "NARRATIVE_FALLBACK_QUEUE"
  | "NARRATIVE_RESULT_TOKEN"
  | "NARRATIVE_FALLBACK_MODEL"
  | "NARRATIVE_FALLBACK_DELAY_SECONDS"
  | "NARRATIVE_FALLBACK_DAILY_CAP"
  | "NARRATIVE_FALLBACK_ROLLING_31_DAY_CAP"
  | "CF_VERSION_METADATA"
  | "GEMINI_API_KEY"
> & {
  ENVIRONMENT: string;
  SURF_REGION: "norcal";
  SURF_USER_AGENT: string;
  INGEST_TOKEN?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  FORECAST_BRIEF_AGENT?: DurableObjectNamespace<ForecastBriefAgent>;
  FORECAST_BRIEF_ENABLED?: string;
  GEMINI_API_KEY?: string;
  NARRATIVE_ENABLED?: string;
  NARRATIVE_QUEUE?: Queue;
  NARRATIVE_FALLBACK_QUEUE?: Queue;
  NARRATIVE_RESULT_TOKEN?: string;
  NARRATIVE_FALLBACK_MODEL?: string;
  NARRATIVE_FALLBACK_DELAY_SECONDS?: string;
  NARRATIVE_FALLBACK_DAILY_CAP?: string;
  NARRATIVE_FALLBACK_ROLLING_31_DAY_CAP?: string;
};

const app = new Hono<{ Bindings: Env }>();
type AppContext = Context<{ Bindings: Env }>;
const INGEST_RETRY_DELAYS_SECONDS = [15, 30, 60, 300] as const;

function declaresSurfAnalysisSignal(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).job === "analysis-signal"
  );
}

const EXPECTED_WORKER_VERSION_HEADER = "X-Surf-Expected-Worker-Version";
const WORKER_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const spotsResponse = SpotsResponseSchema.parse({
  spots: NORCAL_SPOTS.map((spot) => ({
    ...spot,
    sourceMap: {
      ...spot.sourceMap,
      observedWave: getOperationalObservedWaveSources(spot)
    }
  })),
  sourceNote:
    "NorCal spot registry with verified NWS MTR coastal-wave grids and transparent cold-start breaking-height scales."
});

app.use("/api/*", async (c, next) => {
  await next();
  const versionId = c.env.CF_VERSION_METADATA?.id;
  if (versionId) c.res.headers.set("X-Surf-Worker-Version", versionId);
});
app.use("/api/*", cors());
app.use("/api/*", async (c, next) => {
  await next();
  if (/^\/api\/forecast\/[^/]+\/brief$/.test(new URL(c.req.url).pathname)) {
    c.res.headers.set("Cache-Control", "no-store");
    return;
  }
  if (c.res.headers.has("Cache-Control")) return;
  c.res.headers.set("Cache-Control", "no-store");
});

app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    service: "surf",
    environment: c.env.ENVIRONMENT,
    region: c.env.SURF_REGION,
    generatedAt: new Date().toISOString()
  })
);

app.get("/api/spots", (c) =>
  c.json(spotsResponse, 200, {
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400"
  })
);

app.get("/api/forecast-readiness", async (c) => {
  try {
    return c.json(await getForecastReadiness(c.env.DB, c.env.SURF_REGION));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "forecast_readiness_lookup_failed",
        message: "forecast readiness lookup failed",
        reasonCode: "readiness_lookup_failed",
        errorName: boundedPipelineErrorName(error)
      })
    );
    return c.json(
      {
        error: "forecast_readiness_unavailable",
        message: "Forecast readiness is temporarily unavailable.",
        retryable: true
      },
      503,
      { "Retry-After": "5" }
    );
  }
});

async function signalSurfAnalysis(
  env: Env,
  spotId: ForecastMaterializationQueueMessage["spotId"],
  _generatedAt: Date,
  context: ForecastBriefSignalContext
): Promise<void> {
  const queue = env.NARRATIVE_QUEUE;
  const fallbackQueue = env.NARRATIVE_FALLBACK_QUEUE;
  if (!queue || !fallbackQueue || !narrativeEnabled(env)) return;
  const fallback = narrativeFallbackConfig(env);
  const spot = NORCAL_SPOTS.find((candidate) => candidate.id === spotId);
  if (!spot) return;
  try {
    const active = await getActiveMaterializedForecastFactBundlesForGeneration(
      env.DB,
      spot.id,
      context.generationId
    );
    if (active.length === 0) {
      console.info(
        JSON.stringify({
          event: "surf_analysis_signal_superseded",
          message: "Analysis signal superseded before Queue publication",
          phase: "analysis_signal",
          ingestId: context.ingestId,
          spotId,
          generationId: context.generationId,
          generatedAt: context.generatedAt,
          materializedAt: context.materializedAt,
          outcome: "supersede",
          reasonCode: "forecast_generation_no_longer_active",
          retryable: false
        })
      );
      return;
    }
    const selected = selectSurfAnalysisBundlesForSignal({
      bundles: active.map((candidate) => candidate.bundle),
      generatedAt: context.generatedAt,
      timeZone: spot.timezone
    });
    if (selected.deferredLocalDates.length > 0) {
      console.info(
        JSON.stringify({
          event: "surf_analysis_future_dates_deferred",
          message: "Future Analysis refreshes follow the spot-local cadence",
          phase: "analysis_signal",
          ingestId: context.ingestId,
          spotId,
          generationId: context.generationId,
          localDates: selected.deferredLocalDates,
          cadenceHours: SURF_ANALYSIS_FUTURE_CADENCE_HOURS,
          reasonCode: "analysis_future_cadence_deferred"
        })
      );
    }
    const outcomes = await enqueueSurfAnalysisBundles({
      db: env.DB,
      queue,
      fallbackQueue,
      bundles: selected.bundles,
      fallbackDelaySeconds: fallback.delaySeconds
    });
    let failed = 0;
    for (const result of outcomes) {
      if (result.status === "unavailable") {
        console.info(
          JSON.stringify({
            event: "surf_analysis_enqueue_unavailable",
            message: "Analysis is unavailable because no planning window was recommended",
            phase: "analysis_signal",
            ingestId: context.ingestId,
            spotId,
            localDate: result.localDate,
            generationId: context.generationId,
            outcome: "unavailable",
            reasonCode: result.reasonCode
          })
        );
      } else if (result.status !== "failed") {
        console.info(
          JSON.stringify({
            event: "surf_analysis_enqueue_completed",
            message: "Analysis enqueue completed after forecast publication",
            phase: "analysis_signal",
            ingestId: context.ingestId,
            spotId,
            localDate: result.localDate,
            generationId: context.generationId,
            jobId: result.jobId,
            outcome: result.status,
            reasonCode:
              result.status === "enqueued"
                ? "analysis_job_enqueued"
                : "analysis_job_duplicate"
          })
        );
      } else {
        failed += 1;
        console.error(
          JSON.stringify({
            event: "surf_analysis_signal_failed",
            message: "One Analysis date failed after materialization publication",
            phase: "analysis_signal",
            ingestId: context.ingestId,
            spotId,
            localDate: result.localDate,
            generationId: context.generationId,
            reasonCode: "analysis_date_signal_failed",
            errorName: boundedPipelineErrorName(result.error)
          })
        );
      }
    }
    if (failed > 0) {
      console.warn(
        JSON.stringify({
          event: "surf_analysis_signal_deferred",
          message: "Analysis signaling deferred to ledger reconciliation or the next forecast generation",
          phase: "analysis_signal",
          ingestId: context.ingestId,
          spotId,
          generationId: context.generationId,
          failedDates: failed,
          reasonCode: "analysis_signal_advisory_failure"
        })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "surf_analysis_signal_failed",
        message: "Analysis signaling failed after materialization publication",
        phase: "analysis_signal",
        ingestId: context.ingestId,
        spotId,
        generationId: context.generationId,
        generatedAt: context.generatedAt,
        materializedAt: context.materializedAt,
        reasonCode: "analysis_signal_failed",
        errorName: boundedPipelineErrorName(error)
      })
    );
    // This advisory signal is ACK-only. Forecast/source jobs retain the
    // ingest Queue's configured retry policy; Analysis recovery comes from
    // the hourly ledger reconciler or the next exact generation signal.
  }
}

app.get(
  "/api/forecast/:spotId/brief",
  zValidator(
    "param",
    z.object({
      spotId: SpotIdSchema.refine(isNorcalSpotId, "Spot is not present in the NorCal reference config")
    })
  ),
  zValidator(
    "query",
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").optional()
    })
  ),
  async (c) => {
    const { spotId } = c.req.valid("param");
    const { date } = c.req.valid("query");
    const now = new Date();
    let localDate = date ?? now.toISOString().slice(0, 10);
    try {
      // This GET is intentionally read-only. Queue signaling and model calls
      // happen only after ingest; a page request may read a published revision
      // but must never trigger generation.
      const spot = NORCAL_SPOTS.find((candidate) => candidate.id === spotId);
      if (!spot) throw new Error("Validated spot metadata is unavailable");
      localDate = date ?? localDateForTime(now.toISOString(), spot.timezone);
      const bundle = await getMaterializedForecastFactBundle(c.env.DB, spotId, localDate);
      if (!bundle) {
        console.warn(
          JSON.stringify({
            event: "surf_analysis_unavailable",
            message: "Analysis is unavailable for the requested date",
            spotId,
            localDate,
            reasonCode: "requested_date_unavailable"
          })
        );
        return c.json(
          unavailableSurfAnalysisResponse(),
          200,
          { "Cache-Control": "no-store" }
        );
      }
      const response = await buildSurfAnalysisResponse(
        c.env.DB,
        bundle,
        now,
        narrativeEnabled(c.env)
      );
      return c.json(response, 200, {
        "Cache-Control": "no-store"
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.message.startsWith("Forecast has no windows for")
          ? "requested_date_unavailable"
          : "brief_assembly_failed";
      console.warn(
        JSON.stringify({
          event: "surf_analysis_unavailable",
          message: "Analysis assembly failed closed",
          spotId,
          localDate,
          reasonCode: reason,
          ...(reason === "brief_assembly_failed"
            ? { errorName: boundedPipelineErrorName(error) }
            : {})
        })
      );
      return c.json(
        unavailableSurfAnalysisResponse(),
        200,
        { "Cache-Control": "no-store" }
      );
    }
  }
);

async function requireNarrativeResultAuthorization(c: AppContext) {
  if (
    await bearerTokenMatches(
      c.req.header("Authorization"),
      c.env.NARRATIVE_RESULT_TOKEN
    )
  ) {
    return null;
  }
  return c.json({ error: "Unauthorized" }, 401, {
    "WWW-Authenticate": "Bearer",
    "Cache-Control": "no-store"
  });
}

class NarrativeResultTooLargeError extends Error {}

async function readBoundedNarrativeResult(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > NARRATIVE_RESULT_MAX_BYTES) {
      throw new NarrativeResultTooLargeError("Narrative result exceeds the request limit");
    }
  }
  if (!request.body) throw new SyntaxError("Narrative result body is missing");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > NARRATIVE_RESULT_MAX_BYTES) {
      await reader.cancel();
      throw new NarrativeResultTooLargeError("Narrative result exceeds the request limit");
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

app.post("/api/internal/narratives/results", async (c) => {
  const authorizationFailure = await requireNarrativeResultAuthorization(c);
  if (authorizationFailure) return authorizationFailure;

  let payload: unknown;
  try {
    payload = await readBoundedNarrativeResult(c.req.raw);
  } catch (error) {
    if (error instanceof NarrativeResultTooLargeError) {
      return c.json({ error: "narrative_result_too_large" }, 413);
    }
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = NarrativeResultSubmissionSchema.safeParse(payload);
  if (!parsed.success) return c.json({ error: "invalid_narrative_result" }, 400);
  const submission = assertNarrativeResultSize(parsed.data);

  try {
    if ("terminal" in submission) {
      const result = NarrativeResultResponseSchema.parse(
        await acceptNarrativeTerminalResult({ db: c.env.DB, submission })
      );
      console.info(
        JSON.stringify({
          event: "narrative_result_completed",
          message: "Narrative runner terminal outcome was recorded",
          jobId: result.jobId,
          disposition: result.disposition,
          reasonCode: `narrative_result_${result.disposition}`
        })
      );
      return c.json(result, 200, { "Cache-Control": "no-store" });
    }
    if (submission.providerId !== "omlx" || submission.route !== "primary") {
      return c.json({ error: "invalid_narrative_result_route" }, 400, {
        "Cache-Control": "no-store"
      });
    }
    const stored = await getNarrativeJob(c.env.DB, submission.jobId);
    let factFingerprint: string | null = null;
    if (stored?.job.domain === "surf") {
      const current = await getMaterializedForecastFactBundle(
        c.env.DB,
        stored.job.entity.id,
        stored.job.entity.localDate
      );
      factFingerprint =
        current && current.input.recommendationWindowIds.length > 0
          ? (await buildSurfAnalysisSnapshot(current)).factFingerprint
          : null;
    }
    const accepted = await acceptSurfAnalysisResult({
      db: c.env.DB,
      submission,
      currentFactFingerprint: factFingerprint
    });
    if (accepted.disposition === "fallback_requested") {
      const fallbackQueue = c.env.NARRATIVE_FALLBACK_QUEUE;
      if (!fallbackQueue || !narrativeEnabled(c.env)) {
        throw new Error("Narrative fallback infrastructure is unavailable");
      }
      await enqueueNarrativeFallbackWatchdog({
        queue: fallbackQueue,
        jobId: submission.jobId,
        submissionId: submission.submissionId,
        delaySeconds: 0,
        trigger: "primary_validation_failed"
      });
    }
    const result = NarrativeResultResponseSchema.parse(accepted);
    console.info(
      JSON.stringify({
        event: "narrative_result_completed",
        message: "Narrative result reached a cloud disposition",
        jobId: result.jobId,
        disposition: result.disposition,
        reasonCode: `narrative_result_${result.disposition}`
      })
    );
    return c.json(result, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "narrative_result_failed",
        message: "Narrative result processing failed",
        jobId: submission.jobId,
        reasonCode: "narrative_result_storage_failed",
        errorName: boundedPipelineErrorName(error)
      })
    );
    return c.json(
      { error: "narrative_result_temporarily_unavailable", retryable: true },
      503,
      { "Retry-After": "30", "Cache-Control": "no-store" }
    );
  }
});

app.get(
  "/api/forecast/:spotId",
  zValidator(
    "param",
    z.object({
      spotId: SpotIdSchema.refine(isNorcalSpotId, "Spot is not present in the NorCal reference config")
    })
  ),
  zValidator(
    "query",
    z.object({
      interval: ForecastIntervalSchema.default("3h")
    })
  ),
  async (c) => {
    const { spotId } = c.req.valid("param");
    const { interval } = c.req.valid("query");
    try {
      const materialized = await getMaterializedForecastJson(c.env.DB, spotId, interval);
      if (!materialized) {
        console.error(
          JSON.stringify({
            event: "forecast_read_model_missing",
            message: "forecast read model missing",
            spotId,
            interval,
            reasonCode: "read_model_missing"
          })
        );
        return c.json(
          {
            error: "forecast_temporarily_unavailable",
            message: "Forecast data is being refreshed. Please retry shortly.",
            retryable: true,
            spotId,
            interval
          },
          503,
          { "Retry-After": "300" }
        );
      }
      const etag = `"${materialized.generationId}"`;
      const responseHeaders = {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        ETag: etag,
        "X-Surf-Forecast-Generated-At": materialized.generatedAt,
        "X-Surf-Forecast-Materialized-At": materialized.materializedAt,
        ...(materialized.ingestId
          ? { "X-Surf-Ingest-Id": materialized.ingestId }
          : {})
      };
      if (c.req.header("If-None-Match") === etag) {
        return c.body(null, 304, responseHeaders);
      }
      return c.body(materialized.forecastJson, 200, {
        "Content-Type": "application/json; charset=UTF-8",
        ...responseHeaders
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "forecast_read_model_lookup_failed",
          message: "forecast read model lookup failed",
          spotId,
          interval,
          reasonCode: "read_model_lookup_failed",
          errorName: boundedPipelineErrorName(error)
        })
      );
      return c.json(
        {
          error: "forecast_temporarily_unavailable",
          message: "Forecast data is being refreshed. Please retry shortly.",
          retryable: true,
          spotId,
          interval
        },
        503,
        { "Retry-After": "300" }
      );
    }
  }
);

async function queueRemoteIngest(
  c: AppContext,
  identity: { ingestId: string } | null = null
) {
  const requestedAt = new Date().toISOString();
  const ingestId = identity?.ingestId ?? crypto.randomUUID();
  await c.env.INGEST_QUEUE.send({
    job: "source-ingest",
    kind: "manual-ingest",
    ingestId,
    requestedAt,
    forecastGeneratedAt: requestedAt,
    region: c.env.SURF_REGION
  });
  return c.json(
    {
      status: "accepted",
      ingestId,
      requestedAt,
      forecastGeneratedAt: requestedAt,
      region: c.env.SURF_REGION
    },
    202
  );
}

async function requireIngestAuthorization(c: AppContext) {
  if (await bearerTokenMatches(c.req.header("Authorization"), c.env.INGEST_TOKEN)) {
    return null;
  }
  return c.json({ error: "Unauthorized" }, 401, {
    "WWW-Authenticate": "Bearer"
  });
}

// Supported deployments deliberately use a predecessor-absent method on the
// established ingest path. Keep this PATCH preconditioned forever: older
// Workers know only POST and therefore fail closed before Queue.send, while
// every Worker from this version onward rejects a stale expected UUID before
// mutation. Do not alias or fall back to POST from the deploy client.
app.patch("/api/ingest/once", async (c) => {
  const authorizationFailure = await requireIngestAuthorization(c);
  if (authorizationFailure) return authorizationFailure;

  const expectedWorkerVersion = c.req
    .header(EXPECTED_WORKER_VERSION_HEADER)
    ?.trim();
  if (!expectedWorkerVersion) {
    return c.json({ error: "worker_version_precondition_required" }, 428);
  }
  if (!WORKER_VERSION_ID_PATTERN.test(expectedWorkerVersion)) {
    return c.json({ error: "worker_version_precondition_invalid" }, 400);
  }
  const actualWorkerVersion = c.env.CF_VERSION_METADATA?.id?.trim();
  if (!actualWorkerVersion) {
    return c.json(
      {
        error: "worker_version_unavailable",
        expectedWorkerVersion
      },
      503
    );
  }
  if (actualWorkerVersion !== expectedWorkerVersion) {
    return c.json(
      {
        error: "worker_version_mismatch",
        expectedWorkerVersion,
        actualWorkerVersion
      },
      409
    );
  }
  // A replay of the same deployment PATCH carries one logical lineage even if
  // a noncompliant intermediary duplicates the unsafe request after an
  // ambiguous connection failure. Serialized Queue work and persistence
  // converge on the same ingestId/run_key rather than publishing two lineages.
  return queueRemoteIngest(c, {
    ingestId: actualWorkerVersion
  });
});

app.post("/api/ingest/once", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  const isLocalRequest = ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  if (!isLocalRequest) {
    const authorizationFailure = await requireIngestAuthorization(c);
    if (authorizationFailure) return authorizationFailure;
    return queueRemoteIngest(c);
  }

  const requestedAt = new Date().toISOString();
  const ingestId = crypto.randomUUID();

  let summary: Awaited<ReturnType<typeof runNorcalIngest>>;
  try {
    summary = await runNorcalIngest(c.env, {
      kind: "manual-ingest",
      ingestId,
      idSuffix: ingestId,
      requestedAt,
      region: c.env.SURF_REGION
    });
  } catch (error) {
    logSourceIngestTerminalOutcome({
      ingestId,
      generatedAt: requestedAt,
      outcome: "failure",
      reasonCode: "source_ingest_threw",
      errorName: boundedPipelineErrorName(error)
    });
    throw error;
  }
  const briefSignals = logInlineIngestTerminalOutcomes(summary);
  await signalInlineForecastBriefs(c.env, briefSignals, dispatchSurfAnalysisSignal);

  return c.json(summary);
});

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller, env) {
    const requestedAt = new Date().toISOString();
    if (
      narrativeEnabled(env) &&
      env.NARRATIVE_QUEUE &&
      env.NARRATIVE_FALLBACK_QUEUE
    ) {
      try {
        const fallback = narrativeFallbackConfig(env);
        await replayGeneratedNarrativeFallbacks({
          db: env.DB,
          now: new Date(requestedAt)
        });
        await reconcileNarrativeEnqueues({
          db: env.DB,
          queue: env.NARRATIVE_QUEUE,
          fallbackQueue: env.NARRATIVE_FALLBACK_QUEUE,
          fallbackDelaySeconds: fallback.delaySeconds,
          now: new Date(requestedAt)
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "narrative_reconciliation_failed",
            message: "Narrative outbox reconciliation failed without blocking ingest scheduling",
            reasonCode: "narrative_reconciliation_failed",
            errorName: boundedPipelineErrorName(error)
          })
        );
      }
    }
    await env.INGEST_QUEUE.send({
      job: "source-ingest",
      kind: "scheduled-ingest",
      ingestId: crypto.randomUUID(),
      requestedAt,
      forecastGeneratedAt: requestedAt,
      region: env.SURF_REGION
    });
  },
  async queue(batch, env) {
    if (batch.queue.endsWith("-narrative-fallback")) {
      for (const message of batch.messages) {
        const parsed = NarrativeFallbackWatchdogSchema.safeParse(message.body);
        if (!parsed.success) {
          console.error(
            JSON.stringify({
              event: "narrative_fallback_watchdog_discarded",
              message: "Malformed narrative fallback watchdog was acknowledged",
              queue: batch.queue,
              messageId: message.id,
              reasonCode: "fallback_watchdog_invalid"
            })
          );
          message.ack();
          continue;
        }
        const fallbackQueue = env.NARRATIVE_FALLBACK_QUEUE;
        if (
          !narrativeEnabled(env) ||
          !env.GEMINI_API_KEY?.trim() ||
          !fallbackQueue
        ) {
          console.info(
            JSON.stringify({
              event: "narrative_fallback_watchdog_discarded",
              message: "Narrative fallback is disabled",
              queue: batch.queue,
              messageId: message.id,
              jobId: parsed.data.jobId,
              reasonCode: "narrative_fallback_disabled"
            })
          );
          message.ack();
          continue;
        }
        try {
          const outcome = await processNarrativeFallbackWatchdog({
            db: env.DB,
            watchdog: parsed.data,
            config: narrativeFallbackConfig(env),
            geminiApiKey: env.GEMINI_API_KEY
          });
          if (
            outcome.reasonCode === "fallback_preclaim_retryable" &&
            parsed.data.preclaimRetryCount < 1
          ) {
            await enqueueNarrativeFallbackWatchdog({
              queue: fallbackQueue,
              jobId: parsed.data.jobId,
              submissionId: parsed.data.submissionId,
              delaySeconds: 60,
              trigger: parsed.data.trigger,
              preclaimRetryCount: parsed.data.preclaimRetryCount + 1
            });
          }
          console.info(
            JSON.stringify({
              event: "narrative_fallback_watchdog_completed",
              message: "Narrative fallback watchdog reached a bounded outcome",
              queue: batch.queue,
              messageId: message.id,
              jobId: outcome.jobId,
              action: outcome.action,
              disposition: outcome.disposition ?? null,
              reasonCode: outcome.reasonCode
            })
          );
        } catch (error) {
          // The fallback attempt ledger is the recovery authority. Queue-level
          // retries are intentionally disabled so a crashed external call can
          // never spend twice; generated outputs replay from D1 on cron.
          console.error(
            JSON.stringify({
              event: "narrative_fallback_watchdog_failed",
              message: "Narrative fallback watchdog failed and was acknowledged",
              queue: batch.queue,
              messageId: message.id,
              jobId: parsed.data.jobId,
              reasonCode: "fallback_watchdog_processing_failed",
              errorName: boundedPipelineErrorName(error)
            })
          );
        }
        message.ack();
      }
      return;
    }
    for (const message of batch.messages) {
      try {
        await processIngestQueueMessage(env, message.body, signalSurfAnalysis);
        message.ack();
      } catch (error) {
        if (declaresSurfAnalysisSignal(message.body)) {
          // Analysis signals are advisory and explicitly excluded from the
          // source Queue retry/DLQ budget. This also ACKs version-skewed or
          // malformed signal envelopes at the raw boundary.
          console.error(
            JSON.stringify({
              event: "surf_analysis_signal_discarded",
              message: "Analysis signal failed and was acknowledged without redelivery",
              messageId: message.id,
              attempts: message.attempts,
              reasonCode: "analysis_signal_invalid_or_failed",
              errorName: boundedPipelineErrorName(error)
            })
          );
          message.ack();
          continue;
        }
        console.error(
          JSON.stringify({
            event: "ingest_queue_retry_scheduled",
            message: "ingest queue message failed",
            messageId: message.id,
            attempts: message.attempts,
            reasonCode: "queue_message_processing_failed",
            errorName: boundedPipelineErrorName(error)
          })
        );
        message.retry({
          delaySeconds:
            INGEST_RETRY_DELAYS_SECONDS[
              Math.min(Math.max(message.attempts - 1, 0), INGEST_RETRY_DELAYS_SECONDS.length - 1)
            ]
        });
      }
    }
  }
} satisfies ExportedHandler<Env>;

export { ForecastBriefAgent } from "./agents";
