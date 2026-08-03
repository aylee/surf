/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildForecastFactBundle } from "../brief/facts";
import { briefForecastFixture, validDraftFor } from "../brief/test-helpers";
import type { ForecastFactBundle } from "../brief/types";
import {
  FORECAST_BRIEF_FINAL_RECOVERY_COOLDOWN_MS,
  FORECAST_BRIEF_GENERATION_LEASE_MS,
  ForecastBriefAgent
} from "./forecast-brief-agent";

type CallbackRetryOptions = { retry?: { maxAttempts?: number }; idempotent?: boolean };
type QueueCall = readonly [method: string, payload: unknown, options?: CallbackRetryOptions];
type ProcessPayload = { localDate: string; generationToken: string };
type RetryPayload = ProcessPayload & { attemptCount: number };
type ScheduleCall = readonly [
  delaySeconds: number,
  method: string,
  payload: RetryPayload,
  options: CallbackRetryOptions
];

async function withSuppressedQueue<T>(
  stub: DurableObjectStub<ForecastBriefAgent>,
  callback: (instance: ForecastBriefAgent, queued: QueueCall[]) => Promise<T>
): Promise<T> {
  return runInDurableObject(stub, async (instance: ForecastBriefAgent) => {
    const queued: QueueCall[] = [];
    Object.defineProperty(instance, "queue", {
      configurable: true,
      value: async (method: string, payload: unknown, options?: CallbackRetryOptions) => {
        queued.push([method, payload, options]);
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

async function refreshedBundleFor(
  bundle: ForecastFactBundle
): Promise<ForecastFactBundle> {
  const forecast = briefForecastFixture();
  forecast.spot = {
    ...forecast.spot,
    id: bundle.input.spotId,
    name: bundle.input.spotName
  };
  forecast.generatedAt = new Date(
    new Date(forecast.generatedAt).getTime() + 60 * 1000
  ).toISOString();
  return buildForecastFactBundle(forecast, {
    localDate: bundle.input.localDate,
    recommendationWindowIds: bundle.input.recommendationWindowIds
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
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
      expect(queued[0]?.[2]).toEqual({ retry: { maxAttempts: 1 } });
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

  it("rolls back an unsubmitted job so an identical signal can recover", async () => {
    const bundle = await bundleForSpot("linda-mar", "Linda Mar");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("linda-mar");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withSuppressedQueue(stub, async (instance, queued) => {
      let submissionCount = 0;
      Object.defineProperty(instance, "queue", {
        configurable: true,
        value: async (
          method: string,
          payload: unknown,
          options?: CallbackRetryOptions
        ): Promise<string> => {
          submissionCount += 1;
          if (submissionCount === 1) throw new Error("queue storage unavailable");
          queued.push([method, payload, options]);
          return "queued-after-recovery";
        }
      });

      await expect(instance.signal(bundle)).rejects.toThrow("queue storage unavailable");
      expect(await instance.getCoordinationState(bundle.input.localDate)).toBeNull();

      await expect(instance.signal(bundle)).resolves.toMatchObject({ status: "accepted" });
      expect(submissionCount).toBe(2);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.[2]).toEqual({ retry: { maxAttempts: 1 } });
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "queued",
        attemptCount: 0
      });
    });

    expect(errorLog).toHaveBeenCalledOnce();
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
        const scheduled: ScheduleCall[] = [];
        Object.defineProperty(instance, "generateDraft", {
          configurable: true,
          value: async () => {
            throw new Error("provider quota exhausted");
          }
        });
        Object.defineProperty(instance, "schedule", {
          configurable: true,
          value: async (
            delaySeconds: number,
            method: string,
            payload: RetryPayload,
            options: CallbackRetryOptions
          ) => {
            scheduled.push([delaySeconds, method, payload, options]);
          }
        });

        await instance.signal(bundle);
        const payload = queued[0]?.[1] as ProcessPayload;
        await instance.processPending(payload);
        await instance.retryPending(scheduled[0]![2]);
        await instance.retryPending(scheduled[1]![2]);
        await instance.retryPending(scheduled[2]![2]);

        expect(scheduled.map(([delay]) => delay)).toEqual([5 * 60, 30 * 60, 2 * 60 * 60]);
        expect(scheduled.map(([, method]) => method)).toEqual([
          "retryPending",
          "retryPending",
          "retryPending"
        ]);
        expect(scheduled.map(([, , retryPayload]) => retryPayload.attemptCount)).toEqual([
          1,
          2,
          3
        ]);
        expect(
          new Set(scheduled.map(([, , retryPayload]) => JSON.stringify(retryPayload))).size
        ).toBe(3);
        expect(scheduled.map(([, , , options]) => options)).toEqual([
          { idempotent: true, retry: { maxAttempts: 1 } },
          { idempotent: true, retry: { maxAttempts: 1 } },
          { idempotent: true, retry: { maxAttempts: 1 } }
        ]);
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

  it("suppresses exact terminal duplicates but recovers a later input after cooldown", async () => {
    const bundle = await bundleForSpot("bolinas", "Bolinas");
    const refreshed = await refreshedBundleFor(bundle);
    expect(refreshed.materialFingerprint).toBe(bundle.materialFingerprint);
    expect(refreshed.inputFingerprint).not.toBe(bundle.inputFingerprint);
    const stub = env.FORECAST_BRIEF_AGENT.getByName("bolinas");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withSuppressedQueue(stub, async (instance, queued) => {
      let generationCalls = 0;
      let scheduleCalls = 0;
      Object.defineProperty(instance, "generateDraft", {
        configurable: true,
        value: async () => {
          generationCalls += 1;
          throw Object.assign(new Error("provider rejected credentials"), { statusCode: 401 });
        }
      });
      Object.defineProperty(instance, "schedule", {
        configurable: true,
        value: async () => {
          scheduleCalls += 1;
        }
      });

      await instance.signal(bundle);
      const payload = queued[0]?.[1] as ProcessPayload;
      await instance.processPending(payload);
      await instance.processPending(payload);
      await instance.retryPending({ ...payload, attemptCount: 1 });

      expect(generationCalls).toBe(1);
      expect(scheduleCalls).toBe(0);
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "terminal",
        attemptCount: 1,
        publishedFingerprint: null
      });
      await expect(instance.signal(bundle)).resolves.toMatchObject({ status: "terminal" });
      expect(queued).toHaveLength(1);

      await expect(instance.signal(refreshed)).resolves.toMatchObject({ status: "terminal" });
      instance.sql`
        update forecast_brief_jobs
        set updated_at = ${new Date(
          Date.now() - FORECAST_BRIEF_FINAL_RECOVERY_COOLDOWN_MS - 1
        ).toISOString()}
        where local_date = ${bundle.input.localDate}
      `;

      // Even after the cooldown, the exact failed input stays suppressed.
      await expect(instance.signal(bundle)).resolves.toMatchObject({ status: "terminal" });
      expect(queued).toHaveLength(1);

      Object.defineProperty(instance, "generateDraft", {
        configurable: true,
        value: async () => {
          generationCalls += 1;
          return validDraftFor(refreshed);
        }
      });
      await expect(instance.signal(refreshed)).resolves.toMatchObject({ status: "accepted" });
      expect(queued).toHaveLength(2);
      await instance.processPending(queued[1]![1] as ProcessPayload);
      expect(generationCalls).toBe(2);
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "published",
        attemptCount: 0,
        publishedFingerprint: refreshed.inputFingerprint
      });
    });

    expect(errorLog).toHaveBeenCalledOnce();
  });

  it("reclaims an interrupted generating lease and invalidates the old callback token", async () => {
    const bundle = await bundleForSpot("bolinas", "Bolinas");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("bolinas");

    await withSuppressedQueue(stub, async (instance, queued) => {
      let generationCalls = 0;
      Object.defineProperty(instance, "generateDraft", {
        configurable: true,
        value: async () => {
          generationCalls += 1;
          return validDraftFor(bundle);
        }
      });

      await expect(instance.signal(bundle)).resolves.toMatchObject({ status: "accepted" });
      const interruptedPayload = queued[0]![1] as ProcessPayload;
      instance.sql`
        update forecast_brief_jobs
        set status = 'generating', updated_at = ${new Date().toISOString()}
        where local_date = ${bundle.input.localDate}
      `;

      await expect(instance.signal(bundle)).resolves.toMatchObject({ status: "duplicate" });
      expect(queued).toHaveLength(1);

      instance.sql`
        update forecast_brief_jobs
        set updated_at = ${new Date(
          Date.now() - FORECAST_BRIEF_GENERATION_LEASE_MS - 1
        ).toISOString()}
        where local_date = ${bundle.input.localDate}
      `;
      await expect(instance.signal(bundle)).resolves.toMatchObject({ status: "accepted" });
      expect(queued).toHaveLength(2);

      // A delayed callback from the interrupted claim cannot publish after the
      // replacement signal rotates the generation token.
      await instance.processPending(interruptedPayload);
      expect(generationCalls).toBe(0);

      await instance.processPending(queued[1]![1] as ProcessPayload);
      expect(generationCalls).toBe(1);
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "published",
        publishedFingerprint: bundle.inputFingerprint
      });
    });
  });

  it("allows a policy-quality failure only one delayed regeneration", async () => {
    const bundle = await bundleForSpot("bolinas", "Bolinas");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("bolinas");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withSuppressedQueue(stub, async (instance, queued) => {
      const scheduled: ScheduleCall[] = [];
      let generationCalls = 0;
      Object.defineProperty(instance, "generateDraft", {
        configurable: true,
        value: async () => {
          generationCalls += 1;
          const draft = validDraftFor(bundle);
          draft.summary.text = "The model invented 3 feet of surf.";
          return draft;
        }
      });
      Object.defineProperty(instance, "schedule", {
        configurable: true,
        value: async (
          delaySeconds: number,
          method: string,
          payload: RetryPayload,
          options: CallbackRetryOptions
        ) => {
          scheduled.push([delaySeconds, method, payload, options]);
        }
      });

      await instance.signal(bundle);
      const payload = queued[0]?.[1] as ProcessPayload;
      await instance.processPending(payload);
      await instance.processPending(payload);
      expect(generationCalls).toBe(1);

      await instance.retryPending(scheduled[0]![2]);
      await instance.retryPending(scheduled[0]![2]);

      expect(generationCalls).toBe(2);
      expect(scheduled.map(([delay]) => delay)).toEqual([5 * 60]);
      expect(scheduled[0]?.[2]).toMatchObject({ attemptCount: 1 });
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "terminal",
        attemptCount: 2,
        publishedFingerprint: null
      });
    });
  });

  it("treats a corrupt stored fact bundle as terminal before model invocation", async () => {
    const bundle = await bundleForSpot("bolinas", "Bolinas");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("bolinas");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withSuppressedQueue(stub, async (instance, queued) => {
      let generationCalls = 0;
      let scheduleCalls = 0;
      Object.defineProperty(instance, "generateDraft", {
        configurable: true,
        value: async () => {
          generationCalls += 1;
          return validDraftFor(bundle);
        }
      });
      Object.defineProperty(instance, "schedule", {
        configurable: true,
        value: async () => {
          scheduleCalls += 1;
        }
      });

      await instance.signal(bundle);
      const payload = queued[0]?.[1] as ProcessPayload;
      instance.sql`
        update forecast_brief_jobs
        set bundle_json = ${"{"}
        where local_date = ${bundle.input.localDate}
      `;
      await instance.processPending(payload);

      expect(generationCalls).toBe(0);
      expect(scheduleCalls).toBe(0);
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "terminal",
        attemptCount: 1,
        publishedFingerprint: null
      });
    });
  });

  it("fails closed when retry scheduling throws and never collapses the backoff", async () => {
    const bundle = await bundleForSpot("bolinas", "Bolinas");
    const stub = env.FORECAST_BRIEF_AGENT.getByName("bolinas");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withSuppressedQueue(stub, async (instance, queued) => {
      let generationCalls = 0;
      let scheduleCalls = 0;
      Object.defineProperty(instance, "generateDraft", {
        configurable: true,
        value: async () => {
          generationCalls += 1;
          throw Object.assign(new Error("provider unavailable"), { statusCode: 503 });
        }
      });
      Object.defineProperty(instance, "schedule", {
        configurable: true,
        value: async () => {
          scheduleCalls += 1;
          throw new Error("alarm storage unavailable");
        }
      });

      await instance.signal(bundle);
      const payload = queued[0]?.[1] as ProcessPayload;
      await expect(instance.processPending(payload)).resolves.toBeUndefined();
      await instance.processPending(payload);
      await instance.retryPending({ ...payload, attemptCount: 1 });

      expect(generationCalls).toBe(1);
      expect(scheduleCalls).toBe(1);
      expect(await instance.getCoordinationState(bundle.input.localDate)).toMatchObject({
        status: "terminal",
        attemptCount: 1,
        publishedFingerprint: null
      });
    });

    expect(errorLog).toHaveBeenCalledTimes(2);
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
