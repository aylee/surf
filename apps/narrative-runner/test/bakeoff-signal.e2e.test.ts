import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSurfAnalysisSnapshot } from "../../web/worker/analysis/snapshot";
import type {
  SurfAnalysisPlanV5,
  SurfAnalysisValidationSnapshot
} from "../../web/worker/analysis/types";
import { buildForecastFactBundle } from "../../web/worker/brief/facts";
import { briefForecastFixture } from "../../web/worker/brief/test-helpers";

function goldenPlan(snapshot: SurfAnalysisValidationSnapshot): SurfAnalysisPlanV5 {
  const cards = (placement: SurfAnalysisValidationSnapshot["cards"][number]["placement"]) =>
    snapshot.cards.filter((candidate) => candidate.placement === placement);
  const outlook = cards("outlook");
  const support = cards("primary_support")[0];
  const tradeoff = cards("primary_tradeoff")[0];
  const alternate = cards("alternate")[0];
  const watch = cards("watch")[0];
  if (outlook.length < 2 || !support || !watch) throw new Error("Incomplete fixture");
  return {
    schemaVersion: 1,
    outlook: {
      leadCardId: outlook[0]!.id,
      supportingCardId: outlook[1]!.id
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

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function exited(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal, stdout, stderr }));
  });
}

describe("Analysis bakeoff OS signal handling", () => {
  it(
    "persists an interrupted manifest after SIGINT at the current inference boundary",
    async () => {
      const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const packageRoot = resolve(repositoryRoot, "apps/narrative-runner");
      const temporaryRoot = await mkdtemp(resolve(tmpdir(), "surf-bakeoff-signal-"));
      const outputRelative = `.analysis-bakeoff/signal-${basename(temporaryRoot)}`;
      const outputDirectory = resolve(repositoryRoot, outputRelative);
      const server = createServer();
      let child: ChildProcess | null = null;
      let releaseInference!: () => void;
      const inferenceGate = new Promise<void>((resolveGate) => {
        releaseInference = resolveGate;
      });
      let firstInference!: () => void;
      const firstInferenceStarted = new Promise<void>((resolveStarted) => {
        firstInference = resolveStarted;
      });

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
          );
        `);
        database
          .prepare(
            "insert into forecast_read_models (spot_id, interval, generation_id) values (?, '3h', ?)"
          )
          .run(bundle.input.spotId, "generation.signal");
        database
          .prepare(
            "insert into forecast_fact_bundles (spot_id, local_date, generation_id, generated_at, input_fingerprint, material_fingerprint, schema_version, fact_bundle_json) values (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            bundle.input.spotId,
            bundle.input.localDate,
            "generation.signal",
            bundle.input.generatedAt,
            bundle.inputFingerprint,
            bundle.materialFingerprint,
            bundle.schemaVersion,
            JSON.stringify(bundle)
          );
        database.close();

        server.on("request", async (request, response) => {
          const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
          if (path === "/v1/models") {
            json(response, {
              data: [{ id: "model/a" }, { id: "model/b" }, { id: "model/judge" }]
            });
            return;
          }
          const requestBody = await body(request);
          firstInference();
          await inferenceGate;
          json(response, {
            model: requestBody.model,
            choices: [{ message: { content: JSON.stringify(goldenPlan(snapshot)) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          });
        });
        await new Promise<void>((resolveListen, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolveListen);
        });
        const port = (server.address() as AddressInfo).port;
        const configPath = resolve(temporaryRoot, "bakeoff.json");
        await writeFile(
          configPath,
          `${JSON.stringify(
            {
              databasePath,
              expectedBundleCount: 1,
              caseLimit: 1,
              outputDirectory: outputRelative,
              endpoints: { local: { baseUrl: `http://127.0.0.1:${port}/v1` } },
              generators: [
                { id: "generator-a", endpoint: "local", modelId: "model/a" },
                { id: "generator-b", endpoint: "local", modelId: "model/b" }
              ],
              judges: [{ id: "judge-a", endpoint: "local", modelId: "model/judge" }],
              seeds: [17],
              judgeSeeds: [43],
              concurrency: 1,
              timeoutMs: 30_000
            },
            null,
            2
          )}\n`
        );

        child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/bakeoff-cli.ts",
            "run",
            "--config",
            configPath,
            "--max-calls",
            "4",
            "--runner-isolation",
            "dedicated-endpoint"
          ],
          {
            cwd: packageRoot,
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        const exit = exited(child);
        const started = await Promise.race([
          firstInferenceStarted.then(() => true),
          exit.then((outcome) => {
            throw new Error(
              `Bakeoff CLI exited before inference: code=${outcome.code} stderr=${outcome.stderr}`
            );
          })
        ]);
        expect(started).toBe(true);
        expect(child.kill("SIGINT")).toBe(true);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        releaseInference();

        const outcome = await exit;
        expect(outcome).toMatchObject({ code: 130, signal: null, stdout: "" });
        expect(outcome.stderr).toContain("interrupted at an inference boundary");

        const runs = await readdir(outputDirectory);
        expect(runs).toHaveLength(1);
        const runDirectory = resolve(outputDirectory, runs[0]!);
        const manifest = JSON.parse(
          await readFile(resolve(runDirectory, "manifest.json"), "utf8")
        ) as Record<string, unknown>;
        expect(manifest).toMatchObject({
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
        expect(manifest).not.toHaveProperty("error");
        const candidate = await readFile(
          resolve(runDirectory, "candidate-results.ndjson"),
          "utf8"
        );
        expect(candidate.trim().split("\n")).toHaveLength(1);
        expect(candidate).not.toContain("rawContent");
      } finally {
        releaseInference();
        if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        await rm(outputDirectory, { recursive: true, force: true });
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    30_000
  );
});
