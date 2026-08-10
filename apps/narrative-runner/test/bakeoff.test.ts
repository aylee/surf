import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  SURF_ANALYSIS_RESPONSE_JSON_SCHEMA,
  buildSurfAnalysisSnapshot
} from "../../web/worker/analysis/snapshot";
import type {
  SurfAnalysisPlanV5,
  SurfAnalysisValidationSnapshot
} from "../../web/worker/analysis/types";
import { buildForecastFactBundle } from "../../web/worker/brief/facts";
import { briefForecastFixture } from "../../web/worker/brief/test-helpers";
import { parseBakeoffConfig, redactedBakeoffConfig } from "../src/bakeoff-config";
import {
  BAKEOFF_THINKING_ENABLED,
  BakeoffInterruptedError,
  assertBakeoffCallBudget,
  buildBakeoffCallPlan,
  buildJudgeTasks,
  evaluateGenerator,
  parseBakeoffJudgeDecision,
  prepareBakeoffCorpus,
  prepareBakeoffCases,
  productionGeneratorRequestBody,
  runBakeoff,
  scheduleByEndpointModel,
  summarizeBakeoff,
  type CandidateResult,
  type JudgeResult,
  type JudgeTask
} from "../src/bakeoff";

function goldenPlan(snapshot: SurfAnalysisValidationSnapshot): SurfAnalysisPlanV5 {
  const cards = (placement: SurfAnalysisValidationSnapshot["cards"][number]["placement"]) =>
    snapshot.cards.filter((candidate) => candidate.placement === placement);
  const outlook = cards("outlook");
  const support = cards("primary_support")[0];
  const tradeoff = cards("primary_tradeoff")[0];
  const alternate = cards("alternate")[0];
  const watch = cards("watch")[0];
  if (outlook.length < 2 || !support || !watch) throw new Error("Incomplete Analysis fixture");
  const surfaceOutlook = outlook.find(({ domains }) =>
    domains.some((domain) => domain === "surface" || domain === "wind")
  )!;
  const waveOutlook = outlook.find(({ domains }) => domains.includes("wave"))!;
  return {
    schemaVersion: 1,
    outlook: {
      leadCardId: surfaceOutlook.id,
      supportingCardId: waveOutlook.id
    },
    call: {
      primarySupportCardId: support.id,
      primaryTradeoffCardId: tradeoff?.id ?? null,
      alternateCardId:
        snapshot.callMode === "primary_and_alternate" ? alternate?.id ?? null : null
    },
    close: { watchCardId: watch.id }
  };
}

function config() {
  return parseBakeoffConfig(
    {
      expectedBundleCount: 55,
      caseLimit: 55,
      endpoints: {
        local: {
          baseUrl: "http://127.0.0.1:8000/v1",
          tokenEnv: "ANALYSIS_BAKEOFF_OMLX_TEST_TOKEN"
        }
      },
      generators: [
        { id: "generator-a", endpoint: "local", modelId: "model/a" },
        { id: "generator-b", endpoint: "local", modelId: "model/b" }
      ],
      judges: [{ id: "judge-a", endpoint: "local", modelId: "model/judge" }],
      seeds: [17, 29],
      judgeSeeds: [43],
      enableThinking: false,
      concurrency: 1,
      timeoutMs: 30_000,
      responseMaxBytes: 64 * 1_024
    },
    { repositoryRoot: "/repo" }
  );
}

function generatorOnlyConfig() {
  return parseBakeoffConfig(
    {
      evaluationMode: "generator_only",
      expectedBundleCount: 55,
      caseLimit: 55,
      endpoints: {
        local: {
          baseUrl: "http://127.0.0.1:8000/v1",
          tokenEnv: "ANALYSIS_BAKEOFF_OMLX_TEST_TOKEN"
        }
      },
      generators: [{ id: "generator-a", endpoint: "local", modelId: "model/a" }],
      judges: [],
      seeds: [17],
      enableThinking: false,
      concurrency: 1,
      timeoutMs: 30_000,
      responseMaxBytes: 64 * 1_024
    },
    { repositoryRoot: "/repo" }
  );
}

async function preparedCase() {
  const bundle = await buildForecastFactBundle(briefForecastFixture());
  return (await prepareBakeoffCases([bundle]))[0]!;
}

function completion(draft: SurfAnalysisPlanV5, modelId = "model/a"): Response {
  return new Response(
    JSON.stringify({
      model: modelId,
      choices: [{ message: { content: JSON.stringify(draft) } }],
      usage: { prompt_tokens: 101, completion_tokens: 37, total_tokens: 138 }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function rubric(score: number) {
  return {
    actionableSessionCall: score,
    daylightEvolutionClarity: score,
    reasonAndTradeoff: score,
    primaryAlternateDistinction: score,
    uncertaintyCalibration: score,
    naturalForecasterVoice: score,
    concisionAndNonRepetition: score,
    factualFidelity: score
  };
}

it("fails closed when judge winner and reason codes disagree", () => {
  const base = {
    scores: { A: rubric(4), B: rubric(4) },
    rationale: "Bounded editorial comparison."
  };
  expect(() =>
    parseBakeoffJudgeDecision({
      ...base,
      winner: "B",
      reasonCodes: ["tie_equivalent"]
    })
  ).toThrow(/requires non-tie reason codes/);
  expect(() =>
    parseBakeoffJudgeDecision({
      ...base,
      winner: "tie",
      reasonCodes: ["more_useful"]
    })
  ).toThrow(/tie winner requires only tie_equivalent/);
  expect(() =>
    parseBakeoffJudgeDecision({
      ...base,
      winner: "tie",
      reasonCodes: ["tie_equivalent", "more_natural"]
    })
  ).toThrow(/tie winner requires only tie_equivalent/);
  expect(() =>
    parseBakeoffJudgeDecision({
      ...base,
      winner: "A",
      reasonCodes: ["more_useful", "more_useful"]
    })
  ).toThrow(/reason codes must be unique/);
  expect(() =>
    parseBakeoffJudgeDecision({
      ...base,
      rationale: "Candidate A begins a claim but then truncates",
      winner: "A",
      reasonCodes: ["more_useful"]
    })
  ).toThrow(/complete sentence/);
  expect(() =>
    parseBakeoffJudgeDecision({
      ...base,
      rationale: "!",
      winner: "A",
      reasonCodes: ["more_useful"]
    })
  ).toThrow(/explanatory word/);
  expect(
    parseBakeoffJudgeDecision({
      ...base,
      winner: "A",
      reasonCodes: ["more_useful", "clearer_call"]
    })
  ).toMatchObject({ winner: "A" });
});

function judgedResult(
  task: JudgeTask,
  outcome: "generator-a" | "generator-b" | "tie" | null,
  score = 4
): JudgeResult {
  const reasonCode: NonNullable<JudgeResult["decision"]>["reasonCodes"][number] =
    outcome === "tie" ? "tie_equivalent" : "more_useful";
  const decision =
    outcome === null
      ? null
      : {
          winner:
            outcome === "tie"
              ? ("tie" as const)
              : task.candidateA.generatorId === outcome
                ? ("A" as const)
                : ("B" as const),
          reasonCodes: [reasonCode],
          scores: { A: rubric(score), B: rubric(score) },
          rationale: outcome === "tie" ? "Equivalent." : "One report is more useful."
        };
  return {
    callIndex: task.callIndex,
    matchupId: task.matchupId,
    comparisonId: task.comparisonId,
    order: task.order,
    caseId: task.case.caseId,
    judgeId: task.judge.id,
    modelId: task.judge.modelId,
    judgeSeed: task.judgeSeed,
    startedAt: "2026-08-10T12:00:00.000Z",
    latencyMs: 100,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    reportedModel: task.judge.modelId,
    schemaPass: decision !== null,
    errorCode: decision === null ? "judge_schema_invalid" : null,
    errorMessage: null,
    outputSha256: "a".repeat(64),
    outputBytes: 100,
    decision
  };
}

describe("Analysis v5 local bakeoff", () => {
  it("plans the bounded full 55-case two-model, two-seed, swapped-judge run", () => {
    const plan = buildBakeoffCallPlan(config(), 55);
    expect(plan).toEqual({
      cases: 55,
      preflightRequests: 1,
      generatorCalls: 220,
      candidatePairs: 110,
      judgeCallsUpperBound: 220,
      totalCallsUpperBound: 440,
      totalHttpRequestsUpperBound: 441
    });
    expect(() => assertBakeoffCallBudget(plan, 439)).toThrow(/exceeding --max-calls 439/);
    expect(() => assertBakeoffCallBudget(plan, 440)).not.toThrow();
  });

  it("makes validator-only evaluation an explicit, tightly bounded mode", () => {
    const generatorOnly = generatorOnlyConfig();
    expect(generatorOnly.evaluationMode).toBe("generator_only");
    expect(redactedBakeoffConfig(generatorOnly)).toMatchObject({
      evaluationMode: "generator_only",
      judges: []
    });
    expect(buildBakeoffCallPlan(generatorOnly, 55)).toEqual({
      cases: 55,
      preflightRequests: 1,
      generatorCalls: 55,
      candidatePairs: 0,
      judgeCallsUpperBound: 0,
      totalCallsUpperBound: 55,
      totalHttpRequestsUpperBound: 56
    });

    const base = {
      expectedBundleCount: 1,
      caseLimit: 1,
      endpoints: { local: { baseUrl: "http://127.0.0.1:8000/v1" } },
      generators: [{ id: "a", endpoint: "local", modelId: "model/a" }],
      seeds: [17]
    };
    expect(() =>
      parseBakeoffConfig(base, { repositoryRoot: "/repo" })
    ).toThrow(/full evaluationMode requires at least one judge/);
    expect(() =>
      parseBakeoffConfig(
        {
          ...base,
          evaluationMode: "generator_only",
          generators: [
            ...base.generators,
            { id: "b", endpoint: "local", modelId: "model/b" }
          ]
        },
        { repositoryRoot: "/repo" }
      )
    ).toThrow(/exactly one generator and zero judges/);
    expect(() =>
      parseBakeoffConfig(
        {
          ...base,
          evaluationMode: "generator_only",
          judges: [{ id: "judge", endpoint: "local", modelId: "model/judge" }]
        },
        { repositoryRoot: "/repo" }
      )
    ).toThrow(/exactly one generator and zero judges/);
  });

  it("groups execution by endpoint/model without changing canonical task identities", () => {
    const canonical = [
      { callIndex: 0, caseId: "case-a", model: { endpoint: "local", modelId: "model/a" } },
      { callIndex: 1, caseId: "case-a", model: { endpoint: "local", modelId: "model/b" } },
      { callIndex: 2, caseId: "case-b", model: { endpoint: "local", modelId: "model/a" } },
      { callIndex: 3, caseId: "case-b", model: { endpoint: "local", modelId: "model/b" } }
    ];
    const scheduled = scheduleByEndpointModel(canonical, ({ model }) => model);
    expect(scheduled.map(({ callIndex }) => callIndex)).toEqual([0, 2, 1, 3]);
    expect([...scheduled].sort((left, right) => left.callIndex - right.callIndex)).toEqual(
      canonical
    );
    expect(buildBakeoffCallPlan(config(), 55)).toEqual({
      cases: 55,
      preflightRequests: 1,
      generatorCalls: 220,
      candidatePairs: 110,
      judgeCallsUpperBound: 220,
      totalCallsUpperBound: 440,
      totalHttpRequestsUpperBound: 441
    });
  });

  it("uses the exact production job schema and disables thinking", async () => {
    const prepared = await preparedCase();
    const body = productionGeneratorRequestBody({
      preparedCase: prepared,
      modelId: "model/a",
      seed: 17
    });
    expect(body.messages).toEqual(prepared.job.inference.messages);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: `narrative_output_v${prepared.job.outputSchemaVersion}`,
        strict: true,
        schema: prepared.job.inference.responseSchema
      }
    });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(BAKEOFF_THINKING_ENABLED).toBe(false);
  });

  it("runs the real validator and renderer while keeping credentials out of results", async () => {
    const prepared = await preparedCase();
    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer super-secret");
      expect(init?.redirect).toBe("error");
      return completion(goldenPlan(prepared.snapshot));
    }) as unknown as typeof fetch;

    const result = await evaluateGenerator({
      callIndex: 0,
      preparedCase: prepared,
      model: config().generators[0]!,
      config: config(),
      seed: 17,
      env: { ANALYSIS_BAKEOFF_OMLX_TEST_TOKEN: "super-secret" },
      fetcher,
      now: () => new Date("2026-08-10T12:00:00.000Z")
    });

    expect(result.hardPass).toBe(true);
    expect(result.validatorPass).toBe(true);
    expect(result.rendererPass).toBe(true);
    expect(result.report?.paragraphs).toHaveLength(3);
    expect(result.usage).toEqual({
      promptTokens: 101,
      completionTokens: 37,
      totalTokens: 138
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(capturedBodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(capturedBodies[0]?.seed).toBe(17);
    expect(capturedBodies[0]).toEqual(
      productionGeneratorRequestBody({
        preparedCase: prepared,
        modelId: "model/a",
        seed: 17
      })
    );
  });

  it("keeps a production-validator rejection out of the hard-pass pool", async () => {
    const prepared = await preparedCase();
    const invalid = goldenPlan(prepared.snapshot);
    invalid.outlook.supportingCardId = invalid.outlook.leadCardId;
    const fetcher = vi.fn(async () => completion(invalid)) as unknown as typeof fetch;
    const result = await evaluateGenerator({
      callIndex: 0,
      preparedCase: prepared,
      model: config().generators[0]!,
      config: config(),
      seed: 17,
      env: { ANALYSIS_BAKEOFF_OMLX_TEST_TOKEN: "secret" },
      fetcher,
      now: () => new Date("2026-08-10T12:00:00.000Z")
    });

    expect(result.schemaPass).toBe(true);
    expect(result.validatorPass).toBe(false);
    expect(result.hardPass).toBe(false);
    expect(result.errorCode).toBe("candidate_validator_rejected");
    expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.outputBytes).toBeGreaterThan(0);
    expect(result.planSignatureSha256).toBeNull();
    expect(result).not.toHaveProperty("rawContent");
    expect(result).not.toHaveProperty("draft");
  });

  it("rejects a completion attributed to a different model ID", async () => {
    const prepared = await preparedCase();
    const fetcher = vi.fn(async () =>
      completion(goldenPlan(prepared.snapshot), "model/other")
    ) as unknown as typeof fetch;
    const result = await evaluateGenerator({
      callIndex: 0,
      preparedCase: prepared,
      model: config().generators[0]!,
      config: config(),
      seed: 17,
      env: { ANALYSIS_BAKEOFF_OMLX_TEST_TOKEN: "secret" },
      fetcher,
      now: () => new Date("2026-08-10T12:00:00.000Z")
    });
    expect(result.hardPass).toBe(false);
    expect(result.errorCode).toBe("candidate_model_identity_mismatch");
    expect(result.reportedModel).toBe("model/other");
  });

  it("blinds generator identity and judges both candidate orders", async () => {
    const prepared = await preparedCase();
    const fetcher = vi.fn(async () => completion(goldenPlan(prepared.snapshot))) as unknown as typeof fetch;
    const base = await evaluateGenerator({
      callIndex: 0,
      preparedCase: prepared,
      model: config().generators[0]!,
      config: config(),
      seed: 17,
      env: { ANALYSIS_BAKEOFF_OMLX_TEST_TOKEN: "secret" },
      fetcher,
      now: () => new Date("2026-08-10T12:00:00.000Z")
    });
    const candidateA: CandidateResult = {
      ...base,
      candidateId: "candidate.left",
      generatorId: "generator-a",
      modelId: "model/a",
      report: { ...base.report!, paragraphs: ["LEFT", ...base.report!.paragraphs.slice(1)] }
    };
    const candidateB: CandidateResult = {
      ...base,
      candidateId: "candidate.right",
      generatorId: "generator-b",
      modelId: "model/b",
      report: { ...base.report!, paragraphs: ["RIGHT", ...base.report!.paragraphs.slice(1)] }
    };
    const tasks = buildJudgeTasks({
      cases: [prepared],
      candidates: [candidateA, candidateB],
      config: { ...config(), seeds: [17] }
    });

    expect(tasks).toHaveLength(2);
    const first = JSON.parse(tasks[0]!.messages[1]!.content) as {
      authority: string;
      authoritativeFrame: {
        callMode: string;
        recommendationOrder: string[];
        immutableValues: SurfAnalysisValidationSnapshot["slots"];
        cards: Array<SurfAnalysisValidationSnapshot["cards"][number] & { evidence: string[] }>;
      };
      candidateA: { paragraphs: string[] };
      candidateB: { paragraphs: string[] };
    };
    const second = JSON.parse(tasks[1]!.messages[1]!.content) as typeof first;
    expect(new Set([first.candidateA.paragraphs[0], first.candidateB.paragraphs[0]])).toEqual(
      new Set(["LEFT", "RIGHT"])
    );
    expect(second.candidateA.paragraphs[0]).toBe(first.candidateB.paragraphs[0]);
    expect(second.candidateB.paragraphs[0]).toBe(first.candidateA.paragraphs[0]);
    expect(first.authority).toContain("code-owned ground truth");
    expect(first.authoritativeFrame.callMode).toBe(prepared.snapshot.callMode);
    expect(first.authoritativeFrame.recommendationOrder).toEqual(
      prepared.snapshot.recommendationWindowIds
    );
    expect(first.authoritativeFrame.immutableValues).toEqual(prepared.snapshot.slots);
    expect(first.authoritativeFrame.cards.map(({ preview }) => preview)).toEqual(
      prepared.snapshot.cards.map(({ preview }) => preview)
    );
    expect(first.authoritativeFrame.cards.every(({ evidence }) => evidence.length > 0)).toBe(
      true
    );
    const judgeVisible = JSON.stringify(tasks.map(({ messages }) => messages));
    expect(judgeVisible).not.toContain("generator-a");
    expect(judgeVisible).not.toContain("generator-b");
    expect(judgeVisible).not.toContain("model/a");
    expect(judgeVisible).not.toContain("model/b");
  });

  it("requires strict tie-aware consensus and excludes unstable rubric rows", async () => {
    const prepared = await preparedCase();
    const fetcher = vi.fn(async () =>
      completion(goldenPlan(prepared.snapshot))
    ) as unknown as typeof fetch;
    const base = await evaluateGenerator({
      callIndex: 0,
      preparedCase: prepared,
      model: config().generators[0]!,
      config: config(),
      seed: 17,
      env: { ANALYSIS_BAKEOFF_OMLX_TEST_TOKEN: "secret" },
      fetcher,
      now: () => new Date("2026-08-10T12:00:00.000Z")
    });
    const candidates: CandidateResult[] = [
      { ...base, candidateId: "candidate.left", generatorId: "generator-a", modelId: "model/a" },
      { ...base, candidateId: "candidate.right", generatorId: "generator-b", modelId: "model/b" }
    ];
    const mixedConfig = {
      ...config(),
      seeds: [17],
      judges: [
        { id: "judge-a", endpoint: "local", modelId: "model/judge-a" },
        { id: "judge-b", endpoint: "local", modelId: "model/judge-b" }
      ]
    };
    const mixedTasks = buildJudgeTasks({
      cases: [prepared],
      candidates,
      config: mixedConfig
    });
    const mixedSummary = summarizeBakeoff(
      mixedConfig,
      buildBakeoffCallPlan(mixedConfig, 1),
      candidates,
      mixedTasks,
      mixedTasks.map((task) =>
        judgedResult(task, task.judge.id === "judge-a" ? "generator-a" : "tie")
      )
    );
    expect(mixedSummary.pairwise).toMatchObject({
      judgeConsensus: { winners: 0, ties: 0, disagreements: 1, needsCalibration: 0 }
    });

    const unstableConfig = { ...config(), seeds: [17] };
    const unstableTasks = buildJudgeTasks({
      cases: [prepared],
      candidates,
      config: unstableConfig
    });
    const unstableSummary = summarizeBakeoff(
      unstableConfig,
      buildBakeoffCallPlan(unstableConfig, 1),
      candidates,
      unstableTasks,
      unstableTasks.map((task) =>
        judgedResult(task, task.order === 0 ? "generator-a" : null)
      )
    );
    expect(unstableSummary.pairwise).toMatchObject({
      invalid: 1,
      swappedOrderConsistencyRate: 0,
      judgeConsensus: { needsCalibration: 1 }
    });
    expect(unstableSummary.generators[0]).toMatchObject({ rubricObservations: 0 });
    expect(unstableSummary.generators[1]).toMatchObject({ rubricObservations: 0 });
  });

  it("redacts token values and resolves local artifact paths from repository root", () => {
    const parsed = config();
    expect(parsed.outputDirectory).toBe(resolve("/repo", ".analysis-bakeoff"));
    const redacted = redactedBakeoffConfig(parsed);
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
    expect(JSON.stringify(redacted)).toContain("ANALYSIS_BAKEOFF_OMLX_TEST_TOKEN");
    expect(() =>
      parseBakeoffConfig(
        {
          evaluationMode: "generator_only",
          expectedBundleCount: 1,
          caseLimit: 1,
          outputDirectory: "tracked-results",
          endpoints: { local: { baseUrl: "http://127.0.0.1:8000/v1" } },
          generators: [{ id: "a", endpoint: "local", modelId: "model/a" }],
          seeds: [1]
        },
        { repositoryRoot: "/repo" }
      )
    ).toThrow(/outputDirectory must be \.analysis-bakeoff/);
    expect(() =>
      parseBakeoffConfig(
        {
          expectedBundleCount: 1,
          caseLimit: 1,
          endpoints: {
            remote: {
              baseUrl: "https://models.example/v1",
              tokenEnv: "ANALYSIS_BAKEOFF_OMLX_REMOTE_TOKEN"
            }
          },
          generators: [{ id: "a", endpoint: "remote", modelId: "model/a" }],
          seeds: [1]
        },
        { repositoryRoot: "/repo" }
      )
    ).toThrow(/requires allowRemote=true/);
    expect(() =>
      parseBakeoffConfig(
        {
          expectedBundleCount: 1,
          caseLimit: 1,
          endpoints: { local: { baseUrl: "http://127.0.0.1:8000/v1" } },
          generators: [
            { id: "a", endpoint: "local", modelId: "same-model" },
            { id: "b", endpoint: "local", modelId: "same-model" }
          ],
          seeds: [1]
        },
        { repositoryRoot: "/repo" }
      )
    ).toThrow(/generator endpoint\/model pairs/);
  });

  it("constructs snapshots compatible with the current production builder", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const direct = await buildSurfAnalysisSnapshot(bundle);
    const prepared = await prepareBakeoffCases([bundle]);
    expect(prepared[0]!.snapshot).toEqual(direct);
    expect(prepared[0]!.job.inference.responseSchema).toEqual(
      SURF_ANALYSIS_RESPONSE_JSON_SCHEMA
    );
  });

  it("records production no-recommendation bundles without synthesizing a model job", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    bundle.input.recommendationWindowIds = [];
    bundle.input.recommendations = [];
    const corpus = await prepareBakeoffCorpus([bundle]);
    expect(corpus.cases).toEqual([]);
    expect(corpus.unavailable).toMatchObject([
      {
        sequence: 0,
        spotId: bundle.input.spotId,
        localDate: bundle.input.localDate,
        reasonCode: "analysis_no_recommendation"
      }
    ]);
  });

  it("writes a complete ignored local artifact set without any publication path", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "surf-bakeoff-test-"));
    try {
      const bundle = await buildForecastFactBundle(briefForecastFixture());
      const snapshot = await buildSurfAnalysisSnapshot(bundle);
      const databasePath = resolve(temporaryRoot, "local.sqlite");
      const database = new DatabaseSync(databasePath);
      database.exec(`
        create table forecast_read_models (
          spot_id text not null,
          interval text not null,
          generation_id text not null
        );
        create table forecast_fact_bundles (
          spot_id text not null,
          local_date text not null,
          generation_id text not null,
          generated_at text not null,
          input_fingerprint text not null,
          material_fingerprint text not null,
          schema_version integer not null,
          fact_bundle_json text not null
        )
      `);
      database
        .prepare(
          "insert into forecast_read_models (spot_id, interval, generation_id) values (?, '3h', ?)"
        )
        .run(bundle.input.spotId, "generation.fixture");
      database
        .prepare(
          "insert into forecast_fact_bundles (spot_id, local_date, generation_id, generated_at, input_fingerprint, material_fingerprint, schema_version, fact_bundle_json) values (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          bundle.input.spotId,
          bundle.input.localDate,
          "generation.fixture",
          bundle.input.generatedAt,
          bundle.inputFingerprint,
          bundle.materialFingerprint,
          bundle.schemaVersion,
          JSON.stringify(bundle)
        );
      database.close();

      const localConfig = parseBakeoffConfig(
        {
          databasePath,
          expectedBundleCount: 1,
          caseLimit: 1,
          endpoints: { local: { baseUrl: "http://127.0.0.1:8000/v1" } },
          generators: [
            { id: "generator-a", endpoint: "local", modelId: "model/a" },
            { id: "generator-b", endpoint: "local", modelId: "model/b" }
          ],
          judges: [{ id: "judge-a", endpoint: "local", modelId: "model/judge" }],
          seeds: [17],
          judgeSeeds: [43],
          concurrency: 1
        },
        { repositoryRoot: temporaryRoot }
      );
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({
              data: [
                { id: "model/a" },
                { id: "model/b" },
                { id: "model/judge" }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          response_format: { json_schema: { name: string } };
        };
        if (body.response_format.json_schema.name.startsWith("narrative_output_")) {
          return completion(goldenPlan(snapshot), body.model);
        }
        return new Response(
          JSON.stringify({
            model: "model/judge",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    winner: "tie",
                    reasonCodes: ["tie_equivalent"],
                    scores: { A: rubric(4), B: rubric(4) },
                    rationale: "The two validated reports are editorially equivalent."
                  })
                }
              }
            ],
            usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as unknown as typeof fetch;

      const result = await runBakeoff(localConfig, {
        repositoryRoot: temporaryRoot,
        maxCalls: 4,
        runnerIsolation: "dedicated-endpoint",
        fetcher,
        env: {},
        now: () => new Date("2026-08-10T12:00:00.000Z")
      });
      expect(result.runDirectory.startsWith(resolve(temporaryRoot, ".analysis-bakeoff"))).toBe(
        true
      );
      expect(result.summary.actualCalls).toEqual({
        preflight: 1,
        generators: 2,
        judges: 2,
        totalInference: 4,
        totalHttp: 5
      });
      expect(result.summary.generators[0]).toMatchObject({
        firstPassHardValidRate: 1,
        planSelection: {
          uniqueSignatures: 1,
          dominantSignature: { calls: 1, rate: 1 },
          inputSensitivity: { evaluatedCases: 1 }
        },
        rubricScores: {
          actionableSessionCall: 4,
          naturalForecasterVoice: 4,
          factualFidelity: 4
        }
      });
      expect(result.summary.pairwise).toMatchObject({
        swappedOrderConsistencyRate: 1,
        judgeConsensus: { matchups: 1, ties: 1, needsCalibration: 0 }
      });
      expect(fetcher).toHaveBeenCalledTimes(5);
      const manifest = JSON.parse(
        await readFile(resolve(result.runDirectory, "manifest.json"), "utf8")
      ) as { status: string; judgeCanPublish: boolean; thinkingEnabled: boolean };
      expect(manifest).toMatchObject({
        status: "complete",
        evaluationMode: "full",
        completionGate: "hard_validator_plus_advisory_pairwise",
        judgeCanPublish: false,
        thinkingEnabled: false
      });
      const inputs = (await readFile(resolve(result.runDirectory, "inputs.ndjson"), "utf8"))
        .trim()
        .split("\n");
      expect(inputs).toHaveLength(1);
      expect(JSON.parse(inputs[0]!)).toMatchObject({ status: "eligible", selected: true });
      const judgeInputs = (
        await readFile(resolve(result.runDirectory, "judge-inputs.ndjson"), "utf8")
      )
        .trim()
        .split("\n");
      expect(judgeInputs).toHaveLength(2);

      const generatorOnlyOutput = resolve(
        temporaryRoot,
        ".analysis-bakeoff/generator-only"
      );
      const generatorOnlyResult = await runBakeoff(
        {
          ...localConfig,
          evaluationMode: "generator_only",
          outputDirectory: generatorOnlyOutput,
          generators: [localConfig.generators[0]!],
          judges: []
        },
        {
          repositoryRoot: temporaryRoot,
          maxCalls: 1,
          runnerIsolation: "dedicated-endpoint",
          fetcher,
          env: {},
          now: () => new Date("2026-08-10T12:00:30.000Z")
        }
      );
      expect(generatorOnlyResult.summary).toMatchObject({
        evaluationMode: "generator_only",
        completionGate: "hard_validator_only",
        judgeCanPublish: false,
        actualCalls: {
          preflight: 1,
          generators: 1,
          judges: 0,
          totalInference: 1,
          totalHttp: 2
        },
        judges: [],
        pairwise: { comparisonsEligible: 0, orderSwappedCalls: 0 }
      });
      const generatorOnlyManifest = JSON.parse(
        await readFile(resolve(generatorOnlyResult.runDirectory, "manifest.json"), "utf8")
      ) as Record<string, unknown>;
      expect(generatorOnlyManifest).toMatchObject({
        status: "complete",
        evaluationMode: "generator_only",
        completionGate: "hard_validator_only",
        judgeCanPublish: false
      });
      expect(await readdir(generatorOnlyResult.runDirectory)).not.toEqual(
        expect.arrayContaining(["judge-inputs.ndjson", "judge-results.ndjson"])
      );

      const controller = new AbortController();
      const interruptedOutput = resolve(
        temporaryRoot,
        ".analysis-bakeoff/interrupted"
      );
      let generatorCalls = 0;
      const interruptingFetcher = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "GET") {
            return new Response(
              JSON.stringify({
                data: [
                  { id: "model/a" },
                  { id: "model/b" },
                  { id: "model/judge" }
                ]
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
          const body = JSON.parse(String(init?.body)) as {
            model: string;
            response_format: { json_schema: { name: string } };
          };
          generatorCalls += 1;
          controller.abort();
          return completion(goldenPlan(snapshot), body.model);
        }
      ) as unknown as typeof fetch;
      await expect(
        runBakeoff(
          { ...localConfig, outputDirectory: interruptedOutput },
          {
            repositoryRoot: temporaryRoot,
            maxCalls: 4,
            runnerIsolation: "dedicated-endpoint",
            fetcher: interruptingFetcher,
            env: {},
            signal: controller.signal,
            now: () => new Date("2026-08-10T12:01:00.000Z")
          }
        )
      ).rejects.toBeInstanceOf(BakeoffInterruptedError);
      expect(generatorCalls).toBe(1);
      const interruptedRuns = await readdir(interruptedOutput);
      expect(interruptedRuns).toHaveLength(1);
      const interruptedManifest = JSON.parse(
        await readFile(
          resolve(interruptedOutput, interruptedRuns[0]!, "manifest.json"),
          "utf8"
        )
      ) as Record<string, unknown>;
      expect(interruptedManifest).toMatchObject({
        status: "interrupted",
        runnerIsolation: "dedicated-endpoint",
        actualCalls: {
          preflight: 1,
          generators: 1,
          judges: 0,
          totalInference: 1,
          totalHttp: 2
        }
      });
      expect(interruptedManifest).not.toHaveProperty("error");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
