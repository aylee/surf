import { zValidator } from "@hono/zod-validator";
import { buildDeterministicReport, NORCAL_SPOTS } from "@surf/forecast-core";
import { SpotIdSchema } from "@surf/contracts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { buildForecastResponse } from "./forecast";
import { normalizeIngestMessage, runNorcalIngest } from "./ingest";

export type Env = {
  ASSETS: Fetcher;
  DB: D1Database;
  RAW_ARTIFACTS: R2Bucket;
  CACHE: KVNamespace;
  INGEST_QUEUE: Queue;
  ENVIRONMENT: string;
  SURF_REGION: string;
  REPORT_AGENT_ENABLED: string;
  INGEST_TOKEN?: string;
  OPENAI_API_KEY?: string;
};

const app = new Hono<{ Bindings: Env }>();

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

app.get("/api/spots", (c) =>
  c.json({
    spots: NORCAL_SPOTS,
    sourceNote:
      "NorCal spot registry with verified NWS MTR coastal-wave grids and transparent cold-start breaking-height scales."
  })
);

app.get(
  "/api/forecast/:spotId",
  zValidator("param", z.object({ spotId: SpotIdSchema })),
  async (c) => {
    const { spotId } = c.req.valid("param");
    return c.json(await buildForecastResponse(c.env, spotId));
  }
);

app.get("/api/reports/today", async (c) => {
  const enabled = c.env.REPORT_AGENT_ENABLED === "true" && Boolean(c.env.OPENAI_API_KEY);
  if (!enabled) {
    return c.json({
      enabled: false,
      generatedAt: null,
      reportMarkdown: null,
      reason: "Report agent disabled until REPORT_AGENT_ENABLED=true and OPENAI_API_KEY is configured.",
      sourceRunIds: [],
      caveats: ["Disabled report path does not call an LLM or create numeric forecast facts."]
    });
  }

  const forecasts = await Promise.all(NORCAL_SPOTS.map((spot) => buildForecastResponse(c.env, spot.id)));
  const generatedAt = new Date();
  const sourceRunIds = forecasts
    .flatMap((forecast) => forecast.windows.flatMap((window) => window.sourceRunIds))
    .filter((id, index, all) => all.indexOf(id) === index);
  const caveats = forecasts
    .flatMap((forecast) => forecast.windows.flatMap((window) => window.caveats))
    .filter((caveat, index, all) => all.indexOf(caveat) === index);

  return c.json({
    enabled: true,
    generatedAt: generatedAt.toISOString(),
    reportMarkdown: buildDeterministicReport(forecasts, generatedAt),
    reason: null,
    sourceRunIds,
    caveats
  });
});

app.post("/api/ingest/once", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  const isLocalRequest = hostname === "127.0.0.1" || hostname === "localhost";
  if (c.env.ENVIRONMENT === "production" && !isLocalRequest) {
    const expected = c.env.INGEST_TOKEN;
    const supplied = c.req.header("Authorization");
    if (!expected || supplied !== `Bearer ${expected}`) {
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
        if (summary.status !== "success") {
          throw new Error(`ingest completed with ${summary.status}: ${summary.errors.join("; ")}`);
        }
        message.ack();
      } catch (error) {
        console.error("ingest queue message failed", error);
        message.retry();
      }
    }
  }
} satisfies ExportedHandler<Env>;
