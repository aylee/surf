import { zValidator } from "@hono/zod-validator";
import {
  getOperationalObservedWaveSources,
  isNorcalSpotId,
  NORCAL_SPOTS
} from "@surf/forecast-core";
import { SpotIdSchema, SpotsResponseSchema } from "@surf/contracts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { bearerTokenMatches } from "./auth";
import { buildForecastResponse } from "./forecast";
import { ingestRequiresRetry, normalizeIngestMessage, runNorcalIngest } from "./ingest";

export type Env = Omit<
  CloudflareBindings,
  "ENVIRONMENT" | "SURF_REGION" | "SURF_USER_AGENT"
> & {
  ENVIRONMENT: string;
  SURF_REGION: "norcal";
  SURF_USER_AGENT: string;
  INGEST_TOKEN?: string;
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

app.get(
  "/api/forecast/:spotId",
  zValidator(
    "param",
    z.object({
      spotId: SpotIdSchema.refine(isNorcalSpotId, "Spot is not present in the NorCal reference config")
    })
  ),
  async (c) => {
    const { spotId } = c.req.valid("param");
    return c.json(await buildForecastResponse(c.env, spotId));
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
