import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { SCHEDULED_INGEST_CRON } from "./ingest-schedule.mjs";

const OVERRIDE_ADDRESSABLE_WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function exactlyOne(collection, binding, kind, failures) {
  const matches = (collection ?? []).filter((entry) => entry.binding === binding);
  if (matches.length !== 1) failures.push(`Expected exactly one ${kind} binding named ${binding}.`);
  return matches[0] ?? {};
}

export function wranglerStructureFailures(config, configPath) {
  const failures = [];
  const configDirectory = dirname(configPath);
  const name = config?.name;

  if (typeof name !== "string" || name.length === 0) {
    failures.push("Worker name is required.");
  } else if (!OVERRIDE_ADDRESSABLE_WORKER_NAME_PATTERN.test(name)) {
    failures.push(
      "Worker name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens so exact version overrides remain addressable."
    );
  }
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
  const narrativeQueue = `${name}-narrative`;
  const ingestProducers = producers.filter((producer) => producer.binding === "INGEST_QUEUE");
  const narrativeProducers = producers.filter(
    (producer) => producer.binding === "NARRATIVE_QUEUE"
  );
  if (
    producers.length !== 2 ||
    ingestProducers.length !== 1 ||
    ingestProducers[0]?.queue !== ingestQueue
  ) {
    failures.push(`INGEST_QUEUE must produce to ${ingestQueue}.`);
  }
  if (narrativeProducers.length !== 1 || narrativeProducers[0]?.queue !== narrativeQueue) {
    failures.push(`NARRATIVE_QUEUE must produce to ${narrativeQueue}.`);
  }
  if (
    consumers.length !== 1 ||
    consumers[0]?.queue !== ingestQueue ||
    consumers[0]?.dead_letter_queue !== deadLetterQueue
  ) {
    failures.push(`Queue consumer must read ${ingestQueue} and dead-letter to ${deadLetterQueue}.`);
  }
  if (consumers[0]?.max_batch_size !== 1 || consumers[0]?.max_concurrency !== 1) {
    failures.push("Ingest queue consumption must be serialized one message at a time.");
  }
  if (consumers.some((consumer) => consumer.queue === narrativeQueue)) {
    failures.push("The narrative queue must use an out-of-band HTTP pull consumer, not a Worker consumer.");
  }
  if (
    !Array.isArray(config?.triggers?.crons) ||
    config.triggers.crons.length !== 1 ||
    config.triggers.crons[0] !== SCHEDULED_INGEST_CRON
  ) {
    failures.push(
      `Scheduled ingest must use exactly ${SCHEDULED_INGEST_CRON} so deploy cron-safety remains valid.`
    );
  }

  if (config?.assets?.binding !== "ASSETS") failures.push("Static assets binding must be ASSETS.");
  const versionMetadata = config?.version_metadata;
  if (
    versionMetadata?.binding !== "CF_VERSION_METADATA" ||
    Object.keys(versionMetadata ?? {}).length !== 1
  ) {
    failures.push("Worker version metadata must bind exactly as CF_VERSION_METADATA.");
  }
  const briefBindings = config?.durable_objects?.bindings ?? [];
  const briefBinding = briefBindings.filter(
    (entry) => entry.name === "FORECAST_BRIEF_AGENT"
  );
  if (
    briefBinding.length !== 1 ||
    briefBinding[0]?.class_name !== "ForecastBriefAgent"
  ) {
    failures.push(
      "FORECAST_BRIEF_AGENT must bind exactly once to ForecastBriefAgent."
    );
  }
  const briefExport = config?.exports?.ForecastBriefAgent;
  if (
    briefExport?.type !== "durable-object" ||
    briefExport?.storage !== "sqlite"
  ) {
    failures.push(
      "ForecastBriefAgent must be declared as a live SQLite durable-object export."
    );
  }
  if (config?.vars?.SURF_REGION !== "norcal") {
    failures.push("SURF_REGION must remain norcal until another runtime catalog is implemented.");
  }
  if (
    typeof config?.vars?.SURF_USER_AGENT !== "string" ||
    config.vars.SURF_USER_AGENT.trim().length < 10
  ) {
    failures.push("SURF_USER_AGENT must identify the instance with an operator contact.");
  }
  const isTrackedCanonicalConfig = basename(configPath) === "wrangler.jsonc";
  const briefEnabled = config?.vars?.FORECAST_BRIEF_ENABLED;
  if (briefEnabled !== "false") {
    failures.push(
      "FORECAST_BRIEF_ENABLED must remain false; ForecastBriefAgent is dormant rollback compatibility, not the active Analysis path."
    );
  }
  if (config?.vars?.GEMINI_API_KEY !== undefined) {
    failures.push("GEMINI_API_KEY must be a Wrangler secret, never a tracked Worker var.");
  }
  const narrativeEnabled = config?.vars?.NARRATIVE_ENABLED;
  if (isTrackedCanonicalConfig && narrativeEnabled !== "false") {
    failures.push("The tracked config must keep NARRATIVE_ENABLED=false until pull infrastructure exists.");
  } else if (
    !isTrackedCanonicalConfig &&
    narrativeEnabled !== "false" &&
    narrativeEnabled !== "true"
  ) {
    failures.push("NARRATIVE_ENABLED must be either 'true' or 'false'.");
  }
  if (config?.vars?.NARRATIVE_RESULT_TOKEN !== undefined) {
    failures.push("NARRATIVE_RESULT_TOKEN must be a Wrangler secret, never a tracked Worker var.");
  }
  if (config?.observability?.enabled !== true) {
    failures.push("Worker observability must be enabled at the top level.");
  }
  const logs = config?.observability?.logs;
  if (
    logs?.enabled !== true ||
    logs?.head_sampling_rate !== 1 ||
    logs?.invocation_logs !== true ||
    logs?.persist !== true
  ) {
    failures.push(
      "Worker observability logs must be enabled, persisted, invocation-complete, and sampled at 100%."
    );
  }
  const traces = config?.observability?.traces;
  if (
    traces?.enabled !== true ||
    traces?.head_sampling_rate !== 1 ||
    traces?.persist !== true
  ) {
    failures.push("Worker automatic traces must be enabled, persisted, and sampled at 100%.");
  }
  if (
    isTrackedCanonicalConfig &&
    ((logs?.destinations?.length ?? 0) > 0 || (traces?.destinations?.length ?? 0) > 0)
  ) {
    failures.push(
      "The tracked Wrangler config must remain destination-neutral; account-scoped telemetry destination names belong only in the ignored instance overlay."
    );
  }
  if (config?.cache?.enabled !== true || config?.cache?.cross_version_cache !== false) {
    failures.push("Worker response caching must be enabled with version-scoped cache keys.");
  }

  return failures;
}

export function wranglerEnvironmentFailures(config, environment = process.env) {
  const failures = [];
  const configuredName = config?.name;
  const ciOverrideName = environment.WRANGLER_CI_OVERRIDE_NAME?.trim();
  if (ciOverrideName && ciOverrideName !== configuredName) {
    failures.push(
      `WRANGLER_CI_OVERRIDE_NAME (${ciOverrideName}) must match the active config Worker name (${configuredName}) so exact version overrides target the deployed Worker.`
    );
  }
  if (environment.CLOUDFLARE_ENV?.trim()) {
    failures.push(
      "CLOUDFLARE_ENV must be unset; the supported deploy path selects instances with SURF_WRANGLER_CONFIG and rejects ambient Wrangler environment suffixes."
    );
  }
  return failures;
}
