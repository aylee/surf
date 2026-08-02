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
  buildForecastFactBundle,
  buildUnavailableForecastBriefResponse
} from "./brief";
import { buildForecastResponse } from "./forecast";
import { ingestRequiresRetry, normalizeIngestMessage, runNorcalIngest } from "./ingest";
import { localDateForTime } from "./time";

export type Env = Omit<
  CloudflareBindings,
  | "ENVIRONMENT"
  | "SURF_REGION"
  | "SURF_USER_AGENT"
  | "FORECAST_BRIEF_AGENT"
  | "FORECAST_BRIEF_ENABLED"
  | "GEMINI_API_KEY"
> & {
  ENVIRONMENT: string;
  SURF_REGION: "norcal";
  SURF_USER_AGENT: string;
  INGEST_TOKEN?: string;
  FORECAST_BRIEF_AGENT?: DurableObjectNamespace<ForecastBriefAgent>;
  FORECAST_BRIEF_ENABLED?: string;
  GEMINI_API_KEY?: string;
};

const app = new Hono<{ Bindings: Env }>();

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

app.use("/api/*", cors());

app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    service: "surf",
    environment: c.env.ENVIRONMENT,
    region: c.env.SURF_REGION,
    generatedAt: new Date().toISOString()
  })
);

app.get("/api/spots", (c) => c.json(spotsResponse));

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

async function signalForecastBriefAgents(env: Env): Promise<void> {
  const namespace = env.FORECAST_BRIEF_AGENT;
  if (!namespace || !forecastBriefEnabled(env)) return;
  const generatedAt = new Date();
  const results = await Promise.allSettled(
    NORCAL_SPOTS.map(async (spot) => {
      const forecast = await buildForecastResponse(env, spot.id, generatedAt, "3h");
      const bundle = await buildForecastFactBundle(forecast);
      return namespace.getByName(spot.id).signal(bundle);
    })
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            spotId: NORCAL_SPOTS[index]!.id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason)
          }
        ]
      : []
  );
  if (failures.length > 0) {
    console.error(
      JSON.stringify({
        message: "forecast brief agent signaling completed with failures",
        failures
      })
    );
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
      const forecast = await buildForecastResponse(c.env, spotId, now, "3h");
      const bundle = await buildForecastFactBundle(forecast, { localDate: date });
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
    return c.json(await buildForecastResponse(c.env, spotId, new Date(), interval));
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
  const summary = await runNorcalIngest(c.env, {
    kind: "manual-ingest",
    requestedAt,
    region: c.env.SURF_REGION
  });

  if (!ingestRequiresRetry(summary)) {
    await signalForecastBriefAgents(c.env);
  }

  return c.json(summary);
});

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller, env) {
    await env.INGEST_QUEUE.send({
      kind: "scheduled-ingest",
      requestedAt: new Date().toISOString(),
      region: env.SURF_REGION
    });
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const body = normalizeIngestMessage(message.body, env.SURF_REGION);
        const summary = await runNorcalIngest(env, {
          kind: "queued-ingest",
          requestedAt: body.requestedAt,
          region: body.region
        });
        if (ingestRequiresRetry(summary)) {
          throw new Error(`ingest completed with ${summary.status}: ${summary.errors.join("; ")}`);
        }
        if (summary.status === "partial") {
          console.warn(
            JSON.stringify({
              message: "ingest queue message completed with source caveats",
              messageId: message.id,
              caveatCount: summary.caveats.length,
              partialSources: summary.sourceRuns
                .filter((run) => run.status === "partial")
                .map((run) => run.sourceId)
            })
          );
        }
        await signalForecastBriefAgents(env);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "ingest queue message failed",
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error)
          })
        );
        message.retry();
      }
    }
  }
} satisfies ExportedHandler<Env>;

export { ForecastBriefAgent } from "./agents";
