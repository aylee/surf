/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildForecastFactBundle } from "../brief/facts";
import { briefForecastFixture, validDraftFor } from "../brief/test-helpers";
import type { ForecastFactBundle } from "../brief/types";
import { ForecastBriefAgent } from "./forecast-brief-agent";

type QueueCall = readonly [method: string, payload: unknown];
type ProcessPayload = { localDate: string; generationToken: string };

async function withSuppressedQueue<T>(
  stub: DurableObjectStub<ForecastBriefAgent>,
  callback: (instance: ForecastBriefAgent, queued: QueueCall[]) => Promise<T>
): Promise<T> {
  return runInDurableObject(stub, async (instance: ForecastBriefAgent) => {
    const queued: QueueCall[] = [];
    Object.defineProperty(instance, "queue", {
      configurable: true,
      value: async (method: string, payload: unknown) => {
        queued.push([method, payload]);
      }
    });
    return callback(instance, queued);
  });
}

async function bundleForSpot(
  spotId: string,
  spotName: string
): Promise<ForecastFactBundle> {
  const forecast = briefForecastFixture();
  forecast.spot = { ...forecast.spot, id: spotId, name: spotName };
  return buildForecastFactBundle(forecast);
}

afterEach(async () => {
  await reset();
});

describe("ForecastBriefAgent in workerd", () => {
  it("initializes SQLite state, deduplicates signals, and survives eviction", async () => {
    const bundle = await bundleForSpot("linda-mar", "Linda Mar");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("linda-mar");

    await withSuppressedQueue(stub, async (instance, queued) => {
      const accepted = await instance.signal(bundle);
      const duplicate = await instance.signal(bundle);

      expect(accepted.status).toBe("accepted");
      expect(duplicate.status).toBe("duplicate");
      expect(queued).toHaveLength(1);
      expect(queued[0]?.[0]).toBe("processPending");
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        spotId: "linda-mar",
        status: "queued",
        attemptCount: 0,
        lastSeenFingerprint: bundle.inputFingerprint
      });
    });

    await evictDurableObject(stub);
    await expect(stub.getCoordinationState(bundle.input.localDate)).resolves.toMatchObject({
      spotId: "linda-mar",
      status: "queued",
      materialFingerprint: bundle.materialFingerprint
    });
  });

  it("isolates spot instances and rejects a cross-spot bundle", async () => {
    const lindaBundle = await bundleForSpot("linda-mar", "Linda Mar");
    const linda = env.FORECAST_BRIEF_AGENT.getByName("linda-mar");
    const bolinas = env.FORECAST_BRIEF_AGENT.getByName("bolinas", {
      locationHint: "wnam"
    });

    await withSuppressedQueue(linda, async (instance) => {
      await instance.signal(lindaBundle);
    });

    await expect(bolinas.getCoordinationState(lindaBundle.input.localDate)).resolves.toBeNull();
    await runInDurableObject(bolinas, async (instance: ForecastBriefAgent) => {
      await expect(instance.signal(lindaBundle)).rejects.toThrow(/cannot coordinate spot/i);
    });
  });

  it("coalesces concurrent identical signals but queues a material revision", async () => {
    const first = await bundleForSpot("bolinas", "Bolinas");
    const changedForecast = briefForecastFixture();
    changedForecast.spot = { ...changedForecast.spot, id: "bolinas", name: "Bolinas" };
    changedForecast.windows[0] = {
      ...changedForecast.windows[0]!,
      qualityLabel: "poor"
    };
    const changed = await buildForecastFactBundle(changedForecast);
    const stub = env.FORECAST_BRIEF_AGENT.getByName("bolinas");

    await withSuppressedQueue(stub, async (instance, queued) => {
      const results = await Promise.all([instance.signal(first), instance.signal(first)]);
      expect(results.map((result) => result.status).sort()).toEqual(["accepted", "duplicate"]);

      const revision = await instance.signal(changed);
      expect(revision.status).toBe("accepted");
      expect(revision.materialFingerprint).not.toBe(first.materialFingerprint);
      expect(queued).toHaveLength(2);
      expect(await instance.getCoordinationState(first.input.localDate)).toMatchObject({
        materialFingerprint: changed.materialFingerprint,
        status: "queued"
      });
    });
  });

  it("validates and publishes a generated revision to D1", async () => {
    const bundle = await bundleForSpot("linda-mar", "Linda Mar");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("linda-mar");

    await withSuppressedQueue(stub, async (instance, queued) => {
      Object.defineProperty(instance, "generateDraft", {
        configurable: true,
        value: async () => validDraftFor(bundle)
      });
      await instance.signal(bundle);
      const payload = queued[0]?.[1] as ProcessPayload;
      await instance.processPending(payload);

      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "published",
        attemptCount: 0,
        publishedFingerprint: bundle.inputFingerprint
      });
    });

    const row = await env.DB.prepare(
      `select status, provider, model_id, input_fingerprint
       from forecast_brief_revisions
       where spot_id = ? and local_date = ?`
    )
      .bind("linda-mar", bundle.input.localDate)
      .first<{
        status: string;
        provider: string;
        model_id: string;
        input_fingerprint: string;
      }>();
    expect(row).toEqual({
      status: "validated",
      provider: "google",
      model_id: "gemini-3.6-flash",
      input_fingerprint: bundle.inputFingerprint
    });
  });

  it("records quota-style failures with 5m/30m/2h retries, then exhausts", async () => {
    const bundle = await bundleForSpot("bolinas", "Bolinas");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("bolinas");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await withSuppressedQueue(stub, async (instance, queued) => {
        const scheduled: number[] = [];
        Object.defineProperty(instance, "generateDraft", {
          configurable: true,
          value: async () => {
            throw new Error("provider quota exhausted");
          }
        });
        Object.defineProperty(instance, "schedule", {
          configurable: true,
          value: async (delaySeconds: number) => {
            scheduled.push(delaySeconds);
          }
        });

        await instance.signal(bundle);
        const payload = queued[0]?.[1] as ProcessPayload;
        await instance.processPending(payload);
        await instance.processPending(payload);
        await instance.processPending(payload);
        await instance.processPending(payload);

        expect(scheduled).toEqual([5 * 60, 30 * 60, 2 * 60 * 60]);
        expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
          status: "exhausted",
          attemptCount: 4,
          publishedFingerprint: null
        });
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("fails closed before creating job state when generation is disabled", async () => {
    const bundle = await bundleForSpot("linda-mar", "Linda Mar");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("linda-mar");

    await runInDurableObject(stub, async (instance: ForecastBriefAgent) => {
      Object.defineProperty(instance, "env", {
        configurable: true,
        value: {
          DB: env.DB,
          FORECAST_BRIEF_ENABLED: "false",
          GEMINI_API_KEY: "worker-pool-test-key"
        }
      });
      const result = await instance.signal(bundle);
      expect(result.status).toBe("disabled");
      expect(await instance.getCoordinationState(bundle.input.localDate)).toBeNull();
    });
  });

  it("re-queues the same material bundle after a disabled job is re-enabled", async () => {
    const bundle = await bundleForSpot("linda-mar", "Linda Mar");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("linda-mar");

    await withSuppressedQueue(stub, async (instance, queued) => {
      const accepted = await instance.signal(bundle);
      expect(accepted.status).toBe("accepted");
      const payload = queued[0]![1] as ProcessPayload;

      Object.defineProperty(instance, "env", {
        configurable: true,
        value: {
          DB: env.DB,
          FORECAST_BRIEF_ENABLED: "false",
          GEMINI_API_KEY: "worker-pool-test-key"
        }
      });
      await instance.processPending(payload);
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "disabled"
      });

      Object.defineProperty(instance, "env", {
        configurable: true,
        value: {
          DB: env.DB,
          FORECAST_BRIEF_ENABLED: "true",
          GEMINI_API_KEY: "worker-pool-test-key"
        }
      });
      const resumed = await instance.signal(bundle);
      expect(resumed.status).toBe("accepted");
      expect(queued).toHaveLength(2);
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "queued",
        attemptCount: 0
      });
    });
  });
});
