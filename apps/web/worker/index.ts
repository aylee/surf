import { zValidator } from "@hono/zod-validator";
import { buildFixtureForecast, NORCAL_SPOTS } from "@surf/forecast-core";
import { SpotIdSchema } from "@surf/contracts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

export type Env = {
  ASSETS: Fetcher;
  DB: D1Database;
  RAW_ARTIFACTS: R2Bucket;
  CACHE: KVNamespace;
  INGEST_QUEUE: Queue;
  ENVIRONMENT: string;
  SURF_REGION: string;
  REPORT_AGENT_ENABLED: string;
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
    sourceNote: "Cold-start spot registry. CDIP/MOP mapping is a v1 task."
  })
);

app.get(
  "/api/forecast/:spotId",
  zValidator("param", z.object({ spotId: SpotIdSchema })),
  (c) => {
    const { spotId } = c.req.valid("param");
    return c.json(buildFixtureForecast(spotId));
  }
);

app.get("/api/reports/today", (c) => {
  const enabled = c.env.REPORT_AGENT_ENABLED === "true" && Boolean(c.env.OPENAI_API_KEY);
  if (!enabled) {
    return c.json({
      enabled: false,
      generatedAt: null,
      reportMarkdown: null,
      reason: "Report agent disabled until REPORT_AGENT_ENABLED=true and OPENAI_API_KEY is configured."
    });
  }

  return c.json({
    enabled: true,
    generatedAt: new Date().toISOString(),
    reportMarkdown:
      "Report generation is wired as a v1 task. Numeric forecast facts must come from deterministic scoring.",
    reason: null
  });
});

app.post("/api/ingest/once", async (c) => {
  await c.env.INGEST_QUEUE.send({
    kind: "manual-ingest",
    requestedAt: new Date().toISOString(),
    region: c.env.SURF_REGION
  });

  return c.json({ enqueued: true });
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
  async queue(batch, _env) {
    for (const message of batch.messages) {
      message.ack();
    }
  }
} satisfies ExportedHandler<Env>;
