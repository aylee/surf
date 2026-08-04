import { zValidator } from "@hono/zod-validator";
import {
  getOperationalObservedWaveSources,
  isNorcalSpotId,
  NORCAL_SPOTS
} from "@surf/forecast-core";
import { ForecastIntervalSchema, SpotIdSchema, SpotsResponseSchema } from "@surf/contracts";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { ForecastBriefAgent } from "./agents";
import { bearerTokenMatches } from "./auth";
import {
  buildDisabledForecastBriefResponse,
  buildForecastBriefResponse,
  buildUnavailableForecastBriefResponse
} from "./brief";
import {
  getMaterializedForecastFactBundle,
  getMaterializedForecastJson
} from "./forecast-read-model";
import { getForecastReadiness } from "./forecast-readiness";
import {
  ingestRequiresRetry,
  runNorcalIngest,
  type ForecastMaterializationQueueMessage
} from "./ingest";
import {
  processIngestQueueMessage,
  type ForecastBriefSignalContext
} from "./ingest/queue";
import { localDateForTime } from "./time";

export type Env = Omit<
  CloudflareBindings,
  | "ENVIRONMENT"
  | "SURF_REGION"
  | "SURF_USER_AGENT"
  | "FORECAST_BRIEF_AGENT"
  | "FORECAST_BRIEF_ENABLED"
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
};

const app = new Hono<{ Bindings: Env }>();
type AppContext = Context<{ Bindings: Env }>;
const INGEST_RETRY_DELAYS_SECONDS = [15, 30, 60, 300] as const;
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
  if (c.res.headers.has("Cache-Control")) return;
  const isBrief = /^\/api\/forecast\/[^/]+\/brief$/.test(new URL(c.req.url).pathname);
  c.res.headers.set(
    "Cache-Control",
    isBrief && c.res.status === 200
      ? "public, max-age=60, stale-while-revalidate=300"
      : "no-store"
  );
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
        message: "forecast readiness lookup failed",
        ...briefAssemblyDiagnostic(error)
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

function forecastBriefEnabled(env: Env): boolean {
  return (
    env.FORECAST_BRIEF_ENABLED?.trim().toLowerCase() === "true" &&
    Boolean(env.GEMINI_API_KEY?.trim())
  );
}

function briefAssemblyDiagnostic(error: unknown): { errorName: string; errorMessage: string } {
  const errorName = error instanceof Error && error.name ? error.name : "UnknownError";
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    errorName,
    errorMessage: rawMessage.replace(/\s+/g, " ").slice(0, 240)
  };
}

async function signalForecastBriefAgent(
  env: Env,
  spotId: ForecastMaterializationQueueMessage["spotId"],
  generatedAt = new Date(),
  context?: ForecastBriefSignalContext
): Promise<void> {
  const namespace = env.FORECAST_BRIEF_AGENT;
  if (!namespace || !forecastBriefEnabled(env)) return;
  const spot = NORCAL_SPOTS.find((candidate) => candidate.id === spotId);
  if (!spot) return;
  try {
    const localDate = localDateForTime(generatedAt.toISOString(), spot.timezone);
    const bundle = await getMaterializedForecastFactBundle(env.DB, spot.id, localDate);
    if (!bundle) {
      throw new Error(`Materialized forecast facts are unavailable for ${spot.id} on ${localDate}`);
    }
    await namespace.getByName(spot.id).signal(bundle);
  } catch (error) {
    const { errorName, errorMessage } = briefAssemblyDiagnostic(error);
    const fallbackGeneratedAt = Number.isNaN(generatedAt.getTime())
      ? undefined
      : generatedAt.toISOString();
    console.error(
      JSON.stringify({
        event: "forecast_brief_signal_failed",
        message: "forecast brief signaling failed after materialization publication",
        phase: "brief_signal",
        ...(context ? { ingestId: context.ingestId } : {}),
        spotId,
        generatedAt: context?.generatedAt ?? fallbackGeneratedAt,
        ...(context ? { materializedAt: context.materializedAt } : {}),
        errorName,
        error: errorMessage
      })
    );
  }
}

async function signalForecastBriefAgents(env: Env, generatedAt = new Date()): Promise<void> {
  await Promise.all(
    NORCAL_SPOTS.map((spot) => signalForecastBriefAgent(env, spot.id, generatedAt))
  );
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
    let spotName = "This spot";
    let localDate = date ?? now.toISOString().slice(0, 10);
    try {
      // This GET is intentionally read-only. Agent signaling and model calls
      // happen only after ingest; a page request may read a published revision
      // but must never trigger generation.
      const spot = NORCAL_SPOTS.find((candidate) => candidate.id === spotId);
      if (!spot) throw new Error("Validated spot metadata is unavailable");
      spotName = spot.name;
      localDate = date ?? localDateForTime(now.toISOString(), spot.timezone);
      const bundle = await getMaterializedForecastFactBundle(c.env.DB, spotId, localDate);
      if (!bundle) {
        console.warn(
          JSON.stringify({
            message: "forecast brief response used the safe summary",
            spotId,
            localDate,
            reason: "requested_date_unavailable"
          })
        );
        return c.json(
          buildUnavailableForecastBriefResponse({
            spotId,
            spotName,
            localDate,
            generatedAt: now.toISOString()
          })
        );
      }
      if (!forecastBriefEnabled(c.env)) {
        return c.json(buildDisabledForecastBriefResponse(bundle));
      }
      return c.json(await buildForecastBriefResponse(c.env.DB, bundle, now));
    } catch (error) {
      const reason =
        error instanceof Error && error.message.startsWith("Forecast has no windows for")
          ? "requested_date_unavailable"
          : "brief_assembly_failed";
      console.warn(
        JSON.stringify({
          message: "forecast brief response used the safe summary",
          spotId,
          localDate,
          reason,
          ...(reason === "brief_assembly_failed" ? briefAssemblyDiagnostic(error) : {})
        })
      );
      return c.json(
        buildUnavailableForecastBriefResponse({
          spotId,
          spotName,
          localDate,
          generatedAt: now.toISOString()
        })
      );
    }
  }
);

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
          message: "forecast read model lookup failed",
          spotId,
          interval,
          ...briefAssemblyDiagnostic(error)
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

  const summary = await runNorcalIngest(c.env, {
    kind: "manual-ingest",
    ingestId,
    idSuffix: ingestId,
    requestedAt,
    region: c.env.SURF_REGION
  });

  if (!ingestRequiresRetry(summary)) {
    await signalForecastBriefAgents(c.env, new Date(summary.publication.generatedAt));
  }

  return c.json(summary);
});

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller, env) {
    const requestedAt = new Date().toISOString();
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
    for (const message of batch.messages) {
      try {
        await processIngestQueueMessage(env, message.body, signalForecastBriefAgent);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "ingest queue message failed",
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error)
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
