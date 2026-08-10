import { describe, expect, it } from "vitest";
import { heartbeatIsFresh } from "../src/cli";
import { RunnerFailure } from "../src/errors";
import {
  FakeOmlxClient,
  FakeQueueClient,
  FakeResultClient,
  makeConfig,
  makeJob,
  makeRunnerHarness,
  queueMessage,
  TestClock
} from "./fakes";

describe("NarrativeRunner", () => {
  it("submits a structured result then terminally acknowledges every 200 disposition", async () => {
    for (const disposition of [
      "published",
      "duplicate",
      "rejected",
      "expired",
      "superseded",
      "fallback_requested",
      "fallback_failed"
    ] as const) {
      const job = makeJob({ jobId: `job-${disposition}` });
      const queue = new FakeQueueClient([queueMessage(job)]);
      const results = new FakeResultClient();
      results.submitHandler = async () => ({ disposition, jobId: job.jobId });
      const harness = makeRunnerHarness({ queue, results });

      await expect(harness.runner.runOnce()).resolves.toEqual([
        expect.objectContaining({
          action: "ack",
          code: `result_${disposition}`,
          disposition
        })
      ]);
      expect(queue.acked).toEqual([`lease-${job.jobId}`]);
      expect(queue.retried).toEqual([]);
    }
  });

  it("submits the verified provider-reported model identity", async () => {
    const job = makeJob();
    const queue = new FakeQueueClient([queueMessage(job)]);
    const omlx = new FakeOmlxClient();
    omlx.generateHandler = async () => ({
      output: { summary: "verified" },
      modelId: "provider-reported-model"
    });
    const results = new FakeResultClient();
    const harness = makeRunnerHarness({ queue, omlx, results });

    await harness.runner.runOnce();

    expect(results.submitCalls).toEqual([
      expect.objectContaining({
        modelId: "provider-reported-model",
        output: { summary: "verified" }
      })
    ]);
  });

  it("reports identifiable expiry, retries unknown targets, and ACKs unidentifiable malformed work", async () => {
    const expired = makeJob({
      jobId: "job-expired",
      deadlineAt: "2026-08-09T18:00:00.000Z"
    });
    const unknown = makeJob({ jobId: "job-unknown", target: "unknown.target" });
    const invalid = {
      ...queueMessage(makeJob({ jobId: "job-invalid" })),
      body: "not-base64"
    };
    const queue = new FakeQueueClient([
      queueMessage(expired),
      queueMessage(unknown),
      invalid
    ]);
    const config = makeConfig({ concurrency: 3 });
    const omlx = new FakeOmlxClient();
    const results = new FakeResultClient();
    const harness = makeRunnerHarness({ config, queue, omlx, results });

    const outcomes = await harness.runner.runOnce();
    expect(outcomes.map(({ action, code, disposition }) => ({
      action,
      code,
      disposition
    }))).toEqual([
      {
        action: "ack",
        code: "deadline_expired_before_inference",
        disposition: "expired"
      },
      { action: "retry", code: "result_target_unknown", disposition: null },
      { action: "ack", code: "queue_body_base64_invalid", disposition: null }
    ]);
    expect([...queue.acked].sort()).toEqual([
      "lease-job-expired",
      "lease-job-invalid"
    ]);
    expect(queue.retried).toEqual([
      { leaseId: "lease-job-unknown", delaySeconds: 30 }
    ]);
    expect(results.terminalCalls).toEqual([
      expect.objectContaining({
        job: expect.objectContaining({ jobId: "job-expired" }),
        terminal: { status: "expired", reasonCode: "job_expired" }
      })
    ]);
    expect(omlx.generateCalls).toEqual([]);
    expect(results.submitCalls).toEqual([]);
  });

  it("reserves submission time and caps inference to the remaining safe budget", async () => {
    const boundaryClock = new TestClock();
    const atBoundary = makeJob({
      deadlineAt: new Date(boundaryClock.milliseconds + 15_000).toISOString()
    });
    const boundary = makeRunnerHarness({
      clock: boundaryClock,
      queue: new FakeQueueClient([queueMessage(atBoundary)])
    });
    await expect(boundary.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({
        action: "ack",
        code: "deadline_insufficient_for_inference"
      })
    ]);
    expect(boundary.omlx.generateCalls).toEqual([]);
    expect(boundary.results.submitCalls).toEqual([]);
    expect(boundary.results.terminalCalls).toEqual([
      expect.objectContaining({
        terminal: {
          status: "rejected",
          reasonCode: "deadline_budget_insufficient"
        }
      })
    ]);

    const oneMillisecondClock = new TestClock();
    const justEnough = makeJob({
      deadlineAt: new Date(oneMillisecondClock.milliseconds + 15_001).toISOString()
    });
    const justEnoughHarness = makeRunnerHarness({
      clock: oneMillisecondClock,
      queue: new FakeQueueClient([queueMessage(justEnough)])
    });
    await justEnoughHarness.runner.runOnce();
    expect(justEnoughHarness.omlx.generateCalls[0]?.timeoutMs).toBe(1);
    expect(justEnoughHarness.results.submitCalls).toHaveLength(1);
  });

  it.each([
    "result_submit_auth",
    "result_submit_identity_mismatch"
  ] as const)("persistently halts intake after generated callback %s", async (code) => {
    const jobs = [makeJob({ jobId: "job-one" }), makeJob({ jobId: "job-two" })];
    const queue = new FakeQueueClient(jobs.map((job) => queueMessage(job)));
    const results = new FakeResultClient();
    results.submitHandler = async () => {
      throw new RunnerFailure(code, "terminal");
    };
    const harness = makeRunnerHarness({ queue, results });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({ action: "retry", code })
    ]);
    expect(queue.retried).toEqual([{ leaseId: "lease-job-one", delaySeconds: 30 }]);
    await expect(harness.runner.runOnce()).rejects.toMatchObject({
      code,
      disposition: "terminal"
    });
    expect(queue.pullCalls).toEqual([1]);

    harness.clock.advance(10_000);
    await expect(harness.runner.runOnce()).rejects.toMatchObject({
      code,
      disposition: "terminal"
    });
    expect(queue.pullCalls).toEqual([1]);
    expect(harness.omlx.generateCalls).toHaveLength(1);
  });

  it("bounds generated callback network/429/5xx failures before pulling again", async () => {
    const jobs = [makeJob({ jobId: "job-one" }), makeJob({ jobId: "job-two" })];
    const queue = new FakeQueueClient(jobs.map((job) => queueMessage(job)));
    const results = new FakeResultClient();
    results.submitHandler = async () => {
      throw new RunnerFailure("result_submit_http_transient", "transient");
    };
    const harness = makeRunnerHarness({ queue, results });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({
        action: "retry",
        code: "result_submit_http_transient"
      })
    ]);
    await expect(harness.runner.runOnce()).rejects.toMatchObject({
      code: "intake_backoff_active",
      disposition: "transient"
    });
    expect(queue.pullCalls).toEqual([1]);
    expect(harness.omlx.generateCalls).toHaveLength(1);

    harness.clock.advance(10_000);
    results.submitHandler = async (job) => ({
      disposition: "published",
      jobId: job.jobId
    });
    await harness.runner.runOnce();
    expect(queue.pullCalls).toEqual([1, 1]);
  });

  it.each([
    "omlx_inference_network",
    "omlx_inference_response_invalid"
  ] as const)("invalidates model readiness and blocks another pull after %s", async (code) => {
    const jobs = [makeJob({ jobId: "job-one" }), makeJob({ jobId: "job-two" })];
    const queue = new FakeQueueClient(jobs.map((job) => queueMessage(job)));
    const omlx = new FakeOmlxClient();
    omlx.generateHandler = async () => {
      throw new RunnerFailure(code, "transient");
    };
    const harness = makeRunnerHarness({ queue, omlx });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({ action: "retry", code })
    ]);
    expect(omlx.preflightCalls).toBe(1);
    await expect(harness.runner.runOnce()).rejects.toMatchObject({
      code: "intake_backoff_active",
      disposition: "transient"
    });
    expect(queue.pullCalls).toEqual([1]);

    harness.clock.advance(10_000);
    omlx.generateHandler = async () => ({
      output: { summary: "recovered" },
      modelId: "local-model"
    });
    await harness.runner.runOnce();
    expect(omlx.preflightCalls).toBe(2);
    expect(queue.pullCalls).toEqual([1, 1]);
  });

  it("recovers one transient oMLX failure inside the active lease", async () => {
    const queue = new FakeQueueClient([queueMessage(makeJob())]);
    const omlx = new FakeOmlxClient();
    let attempts = 0;
    omlx.generateHandler = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new RunnerFailure("omlx_inference_network", "transient");
      }
      return {
        output: { summary: "recovered locally" },
        modelId: "local-model"
      };
    };
    const harness = makeRunnerHarness({ queue, omlx });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({ action: "ack", code: "result_published" })
    ]);
    expect(omlx.generateCalls).toHaveLength(2);
    expect(queue.acked).toEqual(["lease-job-1"]);
    expect(queue.retried).toEqual([]);
  });

  it("recovers one transient generated-result callback inside the active lease", async () => {
    const queue = new FakeQueueClient([queueMessage(makeJob())]);
    const results = new FakeResultClient();
    let attempts = 0;
    results.submitHandler = async (job) => {
      attempts += 1;
      if (attempts === 1) {
        throw new RunnerFailure("result_submit_network", "transient");
      }
      return { disposition: "published", jobId: job.jobId };
    };
    const harness = makeRunnerHarness({ queue, results });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({ action: "ack", code: "result_published" })
    ]);
    expect(results.submitCalls).toHaveLength(2);
    expect(queue.acked).toEqual(["lease-job-1"]);
    expect(queue.retried).toEqual([]);
  });

  it("recovers one transient terminal callback inside the active lease", async () => {
    const expired = makeJob({ deadlineAt: "2026-08-09T18:00:00.000Z" });
    const queue = new FakeQueueClient([queueMessage(expired)]);
    const results = new FakeResultClient();
    let attempts = 0;
    results.terminalHandler = async (job, terminal) => {
      attempts += 1;
      if (attempts === 1) {
        throw new RunnerFailure("result_submit_network", "transient");
      }
      return { disposition: terminal.status, jobId: job.jobId };
    };
    const harness = makeRunnerHarness({ queue, results });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({
        action: "ack",
        code: "deadline_expired_before_inference"
      })
    ]);
    expect(results.terminalCalls).toHaveLength(2);
    expect(queue.acked).toEqual(["lease-job-1"]);
    expect(queue.retried).toEqual([]);
  });

  it("does not start a local inference retry that cannot fit before the deadline", async () => {
    const clock = new TestClock();
    const job = makeJob({
      deadlineAt: new Date(clock.milliseconds + 15_001).toISOString()
    });
    const queue = new FakeQueueClient([queueMessage(job)]);
    const omlx = new FakeOmlxClient();
    omlx.generateHandler = async () => {
      throw new RunnerFailure("omlx_inference_network", "transient");
    };
    const harness = makeRunnerHarness({ clock, queue, omlx });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({ action: "retry", code: "omlx_inference_network" })
    ]);
    expect(omlx.generateCalls).toHaveLength(1);
    expect(queue.retried).toEqual([{ leaseId: "lease-job-1", delaySeconds: 30 }]);
  });

  it.each([
    "omlx_inference_auth",
    "omlx_inference_http_terminal",
    "omlx_inference_model_identity_missing",
    "omlx_inference_model_identity_mismatch"
  ] as const)("retries the active lease and persistently halts after %s", async (code) => {
    const controller = new AbortController();
    const queue = new FakeQueueClient([
      queueMessage(makeJob({ jobId: "job-one" })),
      queueMessage(makeJob({ jobId: "job-two" }))
    ]);
    const omlx = new FakeOmlxClient();
    omlx.generateHandler = async () => {
      throw new RunnerFailure(code, "terminal");
    };
    let harness!: ReturnType<typeof makeRunnerHarness>;
    harness = makeRunnerHarness({
      queue,
      omlx,
      sleep: async () => {
        if (harness.status.current().state === "halted") controller.abort();
      }
    });

    await harness.runner.run(controller.signal);
    expect(queue.pullCalls).toEqual([1]);
    expect(queue.retried).toEqual([{ leaseId: "lease-job-one", delaySeconds: 30 }]);
    expect(queue.acked).toEqual([]);
    expect(harness.results.terminalCalls).toEqual([]);
    expect(harness.results.submitCalls).toEqual([]);
    expect(harness.store.writes).toContainEqual(
      expect.objectContaining({
        state: "halted",
        lastErrorCode: code
      })
    );
    expect(harness.status.current()).toMatchObject({
      state: "stopped",
      lastErrorCode: code
    });
  });

  it.each([
    "omlx_inference_auth",
    "omlx_preflight_http_terminal"
  ] as const)("persistently halts before pulling when oMLX preflight fails with %s", async (code) => {
    const controller = new AbortController();
    const queue = new FakeQueueClient([queueMessage(makeJob())]);
    const omlx = new FakeOmlxClient();
    omlx.preflightHandler = async () => {
      throw new RunnerFailure(code, "terminal");
    };
    let harness!: ReturnType<typeof makeRunnerHarness>;
    harness = makeRunnerHarness({
      queue,
      omlx,
      sleep: async () => {
        if (harness.status.current().state === "halted") controller.abort();
      }
    });

    await harness.runner.run(controller.signal);
    expect(queue.pullCalls).toEqual([]);
    expect(queue.retried).toEqual([]);
    expect(harness.results.terminalCalls).toEqual([]);
    expect(harness.store.writes).toContainEqual(
      expect.objectContaining({
        state: "halted",
        lastErrorCode: code
      })
    );
    expect(harness.status.current()).toMatchObject({
      state: "stopped",
      lastErrorCode: code
    });
  });

  it.each([
    "queue_api_auth",
    "queue_preflight_http_terminal",
    "queue_preflight_response_invalid",
    "queue_identity_mismatch",
    "queue_consumer_topology_mismatch",
    "queue_consumer_settings_mismatch"
  ] as const)("persistently halts before model preflight or pull when Queue identity proof fails with %s", async (code) => {
    const queue = new FakeQueueClient([queueMessage(makeJob())]);
    queue.preflightError = new RunnerFailure(code, "terminal");
    const harness = makeRunnerHarness({ queue });

    await expect(harness.runner.runOnce()).rejects.toMatchObject({
      code,
      disposition: "terminal"
    });
    expect(queue.preflightCalls).toBe(1);
    expect(queue.pullCalls).toEqual([]);
    expect(harness.omlx.preflightCalls).toBe(0);
    expect(harness.status.current()).toMatchObject({
      state: "halted",
      lastErrorCode: code
    });
  });

  it("backs off without pulling when Queue identity preflight fails transiently", async () => {
    const queue = new FakeQueueClient([queueMessage(makeJob())]);
    queue.preflightError = new RunnerFailure("queue_preflight_network", "transient");
    const harness = makeRunnerHarness({ queue });

    await expect(harness.runner.runOnce()).rejects.toMatchObject({
      code: "queue_preflight_network",
      disposition: "transient"
    });
    expect(queue.pullCalls).toEqual([]);
    expect(harness.omlx.preflightCalls).toBe(0);
    expect(harness.status.current()).toMatchObject({
      state: "backing_off",
      lastErrorCode: "queue_preflight_network"
    });
  });

  it("leaves the cloud watchdog eligible after invalid local model output", async () => {
    const code = "omlx_output_invalid";
    const job = makeJob();
    const queue = new FakeQueueClient([queueMessage(job)]);
    const omlx = new FakeOmlxClient();
    omlx.generateHandler = async () => {
      throw new RunnerFailure(code, "terminal");
    };
    const results = new FakeResultClient();
    const harness = makeRunnerHarness({ queue, omlx, results });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({
        action: "ack",
        code,
        disposition: "fallback_requested"
      })
    ]);
    expect(results.terminalCalls).toEqual([]);
    expect(queue.acked).toEqual(["lease-job-1"]);
  });

  it("leaves the watchdog eligible when the generated callback cannot encode output", async () => {
    const job = makeJob();
    const queue = new FakeQueueClient([queueMessage(job)]);
    const results = new FakeResultClient();
    results.submitHandler = async () => {
      throw new RunnerFailure("result_submission_invalid", "terminal");
    };
    const harness = makeRunnerHarness({ queue, results });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({
        action: "ack",
        code: "result_submission_invalid",
        disposition: "fallback_requested"
      })
    ]);
    expect(results.terminalCalls).toEqual([]);
    expect(queue.acked).toEqual(["lease-job-1"]);
  });

  it("does not ACK when the cloud cannot record a terminal disposition", async () => {
    const jobs = [
      makeJob({ jobId: "job-one", deadlineAt: "2026-08-09T18:00:00.000Z" }),
      makeJob({ jobId: "job-two", deadlineAt: "2026-08-09T18:00:00.000Z" })
    ];
    const queue = new FakeQueueClient(jobs.map((job) => queueMessage(job)));
    const results = new FakeResultClient();
    results.terminalHandler = async () => {
      throw new RunnerFailure("result_submit_network", "transient");
    };
    const harness = makeRunnerHarness({ queue, results });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({
        action: "retry",
        code: "terminal_result_submit_network"
      })
    ]);
    expect(queue.acked).toEqual([]);
    expect(queue.retried).toEqual([{ leaseId: "lease-job-one", delaySeconds: 30 }]);
    await expect(harness.runner.runOnce()).rejects.toMatchObject({
      code: "intake_backoff_active",
      disposition: "transient"
    });
    expect(queue.pullCalls).toEqual([1]);
    harness.clock.advance(10_000);
    results.terminalHandler = async (job, terminal) => ({
      disposition: terminal.status,
      jobId: job.jobId
    });
    await harness.runner.runOnce();
    expect(queue.pullCalls).toEqual([1, 1]);
  });

  it("persistently halts when a terminal callback returns an invalid 200 contract", async () => {
    const jobs = [
      makeJob({ jobId: "job-one", deadlineAt: "2026-08-09T18:00:00.000Z" }),
      makeJob({ jobId: "job-two", deadlineAt: "2026-08-09T18:00:00.000Z" })
    ];
    const queue = new FakeQueueClient(jobs.map((job) => queueMessage(job)));
    const results = new FakeResultClient();
    results.terminalHandler = async () => {
      throw new RunnerFailure("result_submit_response_invalid", "terminal");
    };
    const harness = makeRunnerHarness({ queue, results });

    await expect(harness.runner.runOnce()).resolves.toEqual([
      expect.objectContaining({
        action: "retry",
        code: "terminal_result_submit_response_invalid"
      })
    ]);
    await expect(harness.runner.runOnce()).rejects.toMatchObject({
      code: "result_submit_response_invalid",
      disposition: "terminal"
    });
    harness.clock.advance(60_000);
    await expect(harness.runner.runOnce()).rejects.toMatchObject({
      code: "result_submit_response_invalid",
      disposition: "terminal"
    });
    expect(queue.pullCalls).toEqual([1]);
    expect(results.terminalCalls).toHaveLength(1);
    expect(harness.omlx.generateCalls).toHaveLength(0);
  });

  it.each([
    ["ack", "queue_api_http_transient", "transient"],
    ["retry", "queue_api_network", "transient"]
  ] as const)(
    "opens a transient intake circuit when Queue %s settlement fails",
    async (operation, code, disposition) => {
      const jobs = [makeJob({ jobId: "job-one" }), makeJob({ jobId: "job-two" })];
      const queue = new FakeQueueClient(jobs.map((job) => queueMessage(job)));
      const results = new FakeResultClient();
      if (operation === "ack") {
        queue.ackError = new RunnerFailure(code, disposition);
      } else {
        results.submitHandler = async () => {
          throw new RunnerFailure("result_submit_network", "transient");
        };
        queue.retryError = new RunnerFailure(code, disposition);
      }
      const harness = makeRunnerHarness({ queue, results });

      await expect(harness.runner.runOnce()).resolves.toEqual([
        expect.objectContaining({ action: "unsettled", code })
      ]);
      await expect(harness.runner.runOnce()).rejects.toMatchObject({
        code: "intake_backoff_active",
        disposition: "transient"
      });
      expect(queue.pullCalls).toEqual([1]);
    }
  );

  it.each(["ack", "retry"] as const)(
    "persistently halts when Queue %s settlement returns terminal 4xx",
    async (operation) => {
      const jobs = [makeJob({ jobId: "job-one" }), makeJob({ jobId: "job-two" })];
      const queue = new FakeQueueClient(jobs.map((job) => queueMessage(job)));
      const results = new FakeResultClient();
      const terminal = new RunnerFailure("queue_api_http_terminal", "terminal");
      if (operation === "ack") {
        queue.ackError = terminal;
      } else {
        results.submitHandler = async () => {
          throw new RunnerFailure("result_submit_network", "transient");
        };
        queue.retryError = terminal;
      }
      const harness = makeRunnerHarness({ queue, results });

      await expect(harness.runner.runOnce()).resolves.toEqual([
        expect.objectContaining({
          action: "unsettled",
          code: "queue_api_http_terminal"
        })
      ]);
      await expect(harness.runner.runOnce()).rejects.toMatchObject({
        code: "queue_api_http_terminal",
        disposition: "terminal"
      });
      harness.clock.advance(60_000);
      await expect(harness.runner.runOnce()).rejects.toMatchObject({
        code: "queue_api_http_terminal",
        disposition: "terminal"
      });
      expect(queue.pullCalls).toEqual([1]);
      expect(harness.status.current()).toMatchObject({
        state: "halted",
        lastErrorCode: "queue_api_http_terminal"
      });
    }
  );

  it("pulls only currently free concurrency slots", async () => {
    const first = makeJob({ jobId: "job-one" });
    const queue = new FakeQueueClient([queueMessage(first)]);
    const omlx = new FakeOmlxClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    omlx.generateHandler = async () => {
      await gate;
      return { output: { summary: "ok" }, modelId: "local-model" };
    };
    const harness = makeRunnerHarness({
      config: makeConfig({ concurrency: 2 }),
      queue,
      omlx
    });

    const firstPoll = await harness.runner.poll();
    queue.messages.push(
      queueMessage(makeJob({ jobId: "job-two" })),
      queueMessage(makeJob({ jobId: "job-three" }))
    );
    const secondPoll = await harness.runner.poll();
    const atCapacity = await harness.runner.poll();
    expect(firstPoll.pulled).toBe(1);
    expect(secondPoll.pulled).toBe(1);
    expect(atCapacity).toEqual({ pulled: 0, tasks: [] });
    expect(queue.pullCalls).toEqual([2, 1]);

    release();
    await Promise.all([...firstPoll.tasks, ...secondPoll.tasks]);
  });

  it("stops intake on abort, drains the active lease, and records stopped", async () => {
    const controller = new AbortController();
    const first = makeJob({ jobId: "job-one" });
    const second = makeJob({ jobId: "job-two" });
    const queue = new FakeQueueClient([queueMessage(first), queueMessage(second)]);
    const omlx = new FakeOmlxClient();
    let release!: () => void;
    let inferenceStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      inferenceStarted = resolve;
    });
    omlx.generateHandler = async () => {
      inferenceStarted();
      await gate;
      return { output: { summary: "drained" }, modelId: "local-model" };
    };
    const harness = makeRunnerHarness({ queue, omlx });
    let settled = false;
    const running = harness.runner.run(controller.signal).finally(() => {
      settled = true;
    });

    await started;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(queue.pullCalls).toEqual([1]);
    expect(queue.messages).toHaveLength(1);

    release();
    await running;
    expect(queue.acked).toEqual(["lease-job-one"]);
    expect(queue.messages).toHaveLength(1);
    expect(harness.status.current()).toMatchObject({ state: "stopped", inFlight: 0 });
  });

  it("continuous run persistently halts on Queue pull authentication failure", async () => {
    const controller = new AbortController();
    const queue = new FakeQueueClient();
    queue.pullError = new RunnerFailure("queue_api_auth", "terminal");
    let harness!: ReturnType<typeof makeRunnerHarness>;
    harness = makeRunnerHarness({
      queue,
      sleep: async () => {
        if (harness.status.current().state === "halted") controller.abort();
      }
    });

    await harness.runner.run(controller.signal);
    expect(queue.pullCalls).toEqual([1]);
    expect(harness.store.writes).toContainEqual(
      expect.objectContaining({
        state: "halted",
        lastErrorCode: "queue_api_auth"
      })
    );
  });

  it("continuous run does not pull again after transient ACK settlement failure", async () => {
    const controller = new AbortController();
    const queue = new FakeQueueClient([
      queueMessage(makeJob({ jobId: "job-one" })),
      queueMessage(makeJob({ jobId: "job-two" }))
    ]);
    queue.ackError = new RunnerFailure("queue_api_http_transient", "transient");
    let harness!: ReturnType<typeof makeRunnerHarness>;
    harness = makeRunnerHarness({
      queue,
      sleep: async () => {
        if (harness.status.current().state === "backing_off") controller.abort();
      }
    });

    await harness.runner.run(controller.signal);
    expect(queue.pullCalls).toEqual([1]);
    expect(harness.store.writes).toContainEqual(
      expect.objectContaining({
        state: "backing_off",
        lastErrorCode: "queue_api_http_transient"
      })
    );
  });

  it("continuous run stays alive but halted after terminal callback contract failure", async () => {
    const controller = new AbortController();
    const queue = new FakeQueueClient([
      queueMessage(
        makeJob({
          jobId: "job-one",
          deadlineAt: "2026-08-09T18:00:00.000Z"
        })
      ),
      queueMessage(makeJob({ jobId: "job-two" }))
    ]);
    const results = new FakeResultClient();
    results.terminalHandler = async () => {
      throw new RunnerFailure("result_submit_identity_mismatch", "terminal");
    };
    let harness!: ReturnType<typeof makeRunnerHarness>;
    harness = makeRunnerHarness({
      queue,
      results,
      sleep: async () => {
        if (harness.status.current().state === "halted") controller.abort();
      }
    });

    await harness.runner.run(controller.signal);
    expect(queue.pullCalls).toEqual([1]);
    expect(results.terminalCalls).toHaveLength(1);
    expect(harness.omlx.generateCalls).toHaveLength(0);
    expect(harness.store.writes).toContainEqual(
      expect.objectContaining({
        state: "halted",
        lastErrorCode: "result_submit_identity_mismatch"
      })
    );
  });

  it("backs off empty short polls adaptively with jitter, clamps the max, and resets on work", async () => {
    const queue = new FakeQueueClient();
    const sleeps: number[] = [];
    const controller = new AbortController();
    const config = makeConfig({ pollIntervalMs: 1_000, idleMaxMs: 2_500 });
    const harness = makeRunnerHarness({
      config,
      queue,
      random: () => 1,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        if (sleeps.length === 3) {
          queue.messages.push(queueMessage(makeJob({ jobId: "job-arrived" })));
        }
        if (milliseconds === config.heartbeatIntervalMs) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (
          milliseconds === 1_200 &&
          queue.acked.includes("lease-job-arrived")
        ) {
          controller.abort();
        }
      }
    });

    await harness.runner.run(controller.signal);
    expect(sleeps.filter((milliseconds) => milliseconds !== 5_000)).toEqual([
      1_200,
      2_400,
      2_500,
      1_200
    ]);
    expect(queue.acked).toEqual(["lease-job-arrived"]);
  });

  it("keeps a legitimate inference longer than the idle health threshold fresh", async () => {
    const clock = new TestClock();
    const controller = new AbortController();
    const queue = new FakeQueueClient([queueMessage(makeJob())]);
    const omlx = new FakeOmlxClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    omlx.generateHandler = async () => {
      await gate;
      return {
        output: { summary: "completed after a long local inference" },
        modelId: "local-model"
      };
    };
    const results = new FakeResultClient();
    results.submitHandler = async (job) => {
      controller.abort();
      return { disposition: "published", jobId: job.jobId };
    };
    const config = makeConfig({ heartbeatIntervalMs: 15_000 });
    const heartbeatSleeps: number[] = [];
    const harness = makeRunnerHarness({
      config,
      queue,
      omlx,
      results,
      clock,
      sleep: async (milliseconds, signal) => {
        heartbeatSleeps.push(milliseconds);
        clock.advance(milliseconds);
        if (heartbeatSleeps.length === 5) {
          release();
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        }
      }
    });

    await harness.runner.run(controller.signal);
    expect(heartbeatSleeps).toEqual(Array.from({ length: 5 }, () => 15_000));
    const processing = harness.store.writes.filter(({ state }) => state === "processing");
    const lastProcessing = processing.at(-1);
    expect(lastProcessing?.updatedAt).toBe("2026-08-09T18:01:15.000Z");
    expect(
      heartbeatIsFresh(lastProcessing ?? null, config, clock.milliseconds)
    ).toBe(true);
  });
});
