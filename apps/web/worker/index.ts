import { zValidator } from "@hono/zod-validator";
import {
  getOperationalObservedWaveSources,
  isNorcalSpotId,
  NORCAL_SPOTS
} from "@surf/forecast-core";
import { ForecastIntervalSchema, SpotIdSchema, SpotsResponseSchema } from "@surf/contracts";
import { Hono } from "hono";
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
import {
  ingestRequiresRetry,
  runNorcalIngest,
  type ForecastMaterializationQueueMessage
} from "./ingest";
import { processIngestQueueMessage } from "./ingest/queue";
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
const INGEST_RETRY_DELAYS_SECONDS = [15, 30, 60, 300] as const;

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
  generatedAt = new Date()
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
    console.error(
      JSON.stringify({
        message: "forecast brief agent signaling failed",
        spotId,
        error: error instanceof Error ? error.message : String(error)
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

app.post("/api/ingest/once", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  const isLocalRequest = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  if (!isLocalRequest) {
    if (!(await bearerTokenMatches(c.req.header("Authorization"), c.env.INGEST_TOKEN))) {
      return c.json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": "Bearer"
      });
    }
  }

  const requestedAt = new Date().toISOString();
  const ingestId = crypto.randomUUID();
  if (!isLocalRequest) {
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
