import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

function exactlyOne(collection, binding, kind, failures) {
  const matches = (collection ?? []).filter((entry) => entry.binding === binding);
  if (matches.length !== 1) failures.push(`Expected exactly one ${kind} binding named ${binding}.`);
  return matches[0] ?? {};
}

export function wranglerStructureFailures(config, configPath) {
  const failures = [];
  const configDirectory = dirname(configPath);
  const name = config?.name;

  if (typeof name !== "string" || name.length === 0) failures.push("Worker name is required.");
  if (typeof config?.main !== "string" || !existsSync(resolve(configDirectory, config.main))) {
    failures.push("Worker main entry must resolve to an existing file.");
  }
  if (typeof config?.$schema !== "string" || !existsSync(resolve(configDirectory, config.$schema))) {
    failures.push("Wrangler schema must resolve to an existing file.");
  }

  const db = exactlyOne(config?.d1_databases, "DB", "D1", failures);
  if (db.database_name !== name) {
    failures.push("D1 database_name must match the Worker name.");
  }
  if (
    typeof db.migrations_dir !== "string" ||
    !existsSync(resolve(configDirectory, db.migrations_dir))
  ) {
    failures.push("DB migrations_dir must resolve to an existing directory.");
  }

  const rawArtifacts = exactlyOne(config?.r2_buckets, "RAW_ARTIFACTS", "R2", failures);
  if (
    rawArtifacts.bucket_name !== undefined &&
    rawArtifacts.bucket_name !== `${name}-raw-artifacts`
  ) {
    failures.push(`Manual RAW_ARTIFACTS bucket_name must be ${name}-raw-artifacts.`);
  }

  const producers = config?.queues?.producers ?? [];
  const consumers = config?.queues?.consumers ?? [];
  const ingestQueue = `${name}-ingest`;
  const deadLetterQueue = `${name}-ingest-dlq`;
  if (
    producers.length !== 1 ||
    producers[0]?.binding !== "INGEST_QUEUE" ||
    producers[0]?.queue !== ingestQueue
  ) {
    failures.push(`INGEST_QUEUE must produce to ${ingestQueue}.`);
  }
  if (
    consumers.length !== 1 ||
    consumers[0]?.queue !== ingestQueue ||
    consumers[0]?.dead_letter_queue !== deadLetterQueue
  ) {
    failures.push(`Queue consumer must read ${ingestQueue} and dead-letter to ${deadLetterQueue}.`);
  }

  if (config?.assets?.binding !== "ASSETS") failures.push("Static assets binding must be ASSETS.");
  if (config?.vars?.SURF_REGION !== "norcal") {
    failures.push("SURF_REGION must remain norcal until another runtime catalog is implemented.");
  }
  if (
    typeof config?.vars?.SURF_USER_AGENT !== "string" ||
    config.vars.SURF_USER_AGENT.trim().length < 10
  ) {
    failures.push("SURF_USER_AGENT must identify the instance with an operator contact.");
  }
  if (config?.observability?.logs?.enabled !== true) {
    failures.push("Worker observability logs must be enabled.");
  }

  return failures;
}
