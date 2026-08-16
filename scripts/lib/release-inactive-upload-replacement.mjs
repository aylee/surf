import { createHash } from "node:crypto";
import {
  RELEASE_JOURNAL_STATES,
  assertInactiveUploadReplacementEvidence,
  assertReleaseJournal,
  replaceInactiveUploadReleaseJournal
} from "./release-journal.mjs";
import { fingerprintCanonicalReleaseValue } from "./release-impact.mjs";
import { readBoundedResponseJson } from "./bounded-http-response.mjs";
import {
  assertWorkerVersionReleaseIdentity,
  resolveWorkerDurableObjectNamespaceIds
} from "./release-worker.mjs";
import { parseWorkerRuntime } from "./worker-runtime.mjs";

const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const WORKER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const WORKER_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const INVENTORY_MAX_BYTES = 2 * 1024 * 1024;
const INVENTORY_PAGE_SIZE = 100;
const INVENTORY_MAX_PAGES = 100;
const INVENTORY_MAX_COUNT = INVENTORY_PAGE_SIZE * INVENTORY_MAX_PAGES;
const INVENTORY_TIMEOUT_MS = 30_000;
const VERSION_DETAIL_MAX_BYTES = 2 * 1024 * 1024;

function boundedString(value, label, maximumBytes = 256) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactUtcTimestamp(value, label) {
  const match =
    typeof value === "string"
      ? value.match(
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/
        )
      : null;
  if (!match) throw new Error(`${label} is invalid`);
  const wholeSecond = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  const milliseconds = Date.parse(`${wholeSecond}.000Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== `${wholeSecond}.000Z`
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactVersionDetailOutput(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > VERSION_DETAIL_MAX_BYTES
  ) {
    throw new Error(`${label} is invalid or unbounded`);
  }
  return value;
}

function exactPage(payload, expectedPage) {
  const items = payload?.result?.items;
  const page = payload?.result_info;
  if (
    payload?.success !== true ||
    !Array.isArray(items) ||
    !page ||
    typeof page !== "object" ||
    Array.isArray(page) ||
    page.page !== expectedPage ||
    page.per_page !== INVENTORY_PAGE_SIZE ||
    !Number.isInteger(page.count) ||
    !Number.isInteger(page.total_count) ||
    page.count !== items.length ||
    page.total_count < 1 ||
    page.total_count > INVENTORY_MAX_COUNT ||
    items.length > INVENTORY_PAGE_SIZE
  ) {
    throw new Error(
      "Cloudflare Worker-version inventory page is incomplete or unbounded"
    );
  }
  return Object.freeze({ items, totalCount: page.total_count });
}

function normalizedInventory(items, { workerName, releaseTag, totalCount }) {
  if (items.length !== totalCount) {
    throw new Error("Cloudflare Worker-version inventory is incomplete");
  }
  const ids = new Set();
  const numbers = new Set();
  const versions = items.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !WORKER_VERSION_ID_PATTERN.test(item.id ?? "") ||
      !Number.isSafeInteger(item.number) ||
      item.number < 1 ||
      ids.has(item.id) ||
      numbers.has(item.number)
    ) {
      throw new Error("Cloudflare Worker-version identity is invalid");
    }
    ids.add(item.id);
    numbers.add(item.number);
    const createdOn = exactUtcTimestamp(
      item.metadata?.created_on,
      "Cloudflare Worker-version creation time"
    );
    const annotations = item.annotations ?? {};
    if (
      !annotations ||
      typeof annotations !== "object" ||
      Array.isArray(annotations)
    ) {
      throw new Error("Cloudflare Worker-version annotations are invalid");
    }
    const optionalAnnotation = (name, maximumBytes) => {
      const value = annotations[name] ?? null;
      if (value === null) return null;
      return boundedString(
        value,
        `Cloudflare Worker-version annotation ${name}`,
        maximumBytes
      );
    };
    return Object.freeze({
      id: item.id,
      number: item.number,
      createdOn,
      tag: optionalAnnotation("workers/tag", 100),
      message: optionalAnnotation("workers/message", 256)
    });
  });
  versions.sort((left, right) =>
    left.number === right.number
      ? left.id.localeCompare(right.id)
      : left.number - right.number
  );
  const matches = versions.filter((version) => version.tag === releaseTag);
  if (matches.length !== 1) {
    throw new Error(
      `Failed release tag must resolve to exactly one Worker version; found ${matches.length}`
    );
  }
  return Object.freeze({
    version: matches[0],
    count: versions.length,
    sha256: fingerprintCanonicalReleaseValue({
      schemaVersion: 1,
      workerName,
      releaseTag,
      versions
    })
  });
}

async function readCompleteInventory({
  accountId,
  apiToken,
  workerName,
  releaseTag,
  guard,
  fetcher,
  signal
}) {
  const items = [];
  let totalCount = null;
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    if (page > INVENTORY_MAX_PAGES) {
      throw new Error("Cloudflare Worker-version inventory exceeded its page bound");
    }
    const endpoint = new URL(
      `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(
        workerName
      )}/versions`,
      CLOUDFLARE_API_ORIGIN
    );
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("per_page", String(INVENTORY_PAGE_SIZE));
    guard();
    let response;
    let payload;
    try {
      response = await fetcher(endpoint, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiToken}`
        }
      });
      payload = await readBoundedResponseJson(response, {
        maxBytes: INVENTORY_MAX_BYTES,
        label: "Cloudflare Worker-version inventory"
      });
    } finally {
      guard();
    }
    if (!response.ok) {
      throw new Error(
        `Cloudflare Worker-version inventory failed with HTTP ${response.status}`
      );
    }
    const remotePage = exactPage(payload, page);
    totalCount ??= remotePage.totalCount;
    if (remotePage.totalCount !== totalCount) {
      throw new Error("Cloudflare Worker-version inventory changed while reading");
    }
    totalPages = Math.ceil(totalCount / INVENTORY_PAGE_SIZE);
    items.push(...remotePage.items);
  }
  return normalizedInventory(items, { workerName, releaseTag, totalCount });
}

export async function attestTaggedInactiveWorkerUpload({
  accountId,
  apiToken,
  workerName,
  releaseTag,
  activeWorkerVersionId,
  predecessorWorkerVersionId,
  sourceRevision,
  workerRuntimeDigest,
  clientBuildDigest,
  expectedBindings,
  inspectVersion,
  guard = () => undefined,
  fetcher = fetch,
  signal = AbortSignal.timeout(INVENTORY_TIMEOUT_MS),
  resolveDurableObjectNamespaceIds = resolveWorkerDurableObjectNamespaceIds,
  assertReleaseIdentity = assertWorkerVersionReleaseIdentity,
  parseRuntime = parseWorkerRuntime
}) {
  if (!ACCOUNT_ID_PATTERN.test(accountId ?? "")) {
    throw new Error("Inactive Worker-upload attestation requires an exact account ID");
  }
  if (
    typeof apiToken !== "string" ||
    apiToken.length < 20 ||
    apiToken.length > 512 ||
    apiToken !== apiToken.trim() ||
    /[\x00-\x1f\x7f]/.test(apiToken)
  ) {
    throw new Error("Inactive Worker-upload attestation requires a bounded API token");
  }
  boundedString(workerName, "Inactive Worker-upload Worker name");
  if (
    !WORKER_NAME_PATTERN.test(workerName) ||
    !RELEASE_ID_PATTERN.test(releaseTag ?? "") ||
    !WORKER_VERSION_ID_PATTERN.test(activeWorkerVersionId ?? "") ||
    predecessorWorkerVersionId !== activeWorkerVersionId ||
    !SHA_PATTERN.test(sourceRevision ?? "") ||
    !SHA256_PATTERN.test(workerRuntimeDigest ?? "") ||
    !SHA256_PATTERN.test(clientBuildDigest ?? "") ||
    !Array.isArray(expectedBindings) ||
    expectedBindings.length > 256 ||
    typeof inspectVersion !== "function" ||
    typeof guard !== "function" ||
    typeof fetcher !== "function" ||
    typeof resolveDurableObjectNamespaceIds !== "function" ||
    typeof assertReleaseIdentity !== "function" ||
    typeof parseRuntime !== "function"
  ) {
    throw new Error("Inactive Worker-upload attestation inputs are invalid");
  }
  const inventory = await readCompleteInventory({
    accountId,
    apiToken,
    workerName,
    releaseTag,
    guard,
    fetcher,
    signal
  });
  const tagged = inventory.version;
  const expectedMessage = `surf release ${releaseTag}`;
  if (tagged.message !== expectedMessage) {
    throw new Error("Tagged inactive Worker version has an unexpected release message");
  }
  if (tagged.id === activeWorkerVersionId) {
    throw new Error("Tagged Worker version is active, not inactive");
  }

  guard();
  const predecessorOutput = exactVersionDetailOutput(
    inspectVersion(predecessorWorkerVersionId),
    "Predecessor Worker version detail"
  );
  guard();
  const expectedDurableObjectNamespaceIds =
    resolveDurableObjectNamespaceIds(
      predecessorOutput,
      predecessorWorkerVersionId,
      expectedBindings
    );
  const inactiveOutput = exactVersionDetailOutput(
    inspectVersion(tagged.id),
    "Inactive Worker version detail"
  );
  guard();
  assertReleaseIdentity(
    inactiveOutput,
    {
      versionId: tagged.id,
      sourceRevision,
      workerRuntimeDigest,
      clientBuildDigest
    },
    expectedBindings,
    expectedDurableObjectNamespaceIds
  );
  const runtime = parseRuntime(inactiveOutput, {
    expectedVersionId: tagged.id,
    requireCpuLimit: true
  });
  const confirmedInventory = await readCompleteInventory({
    accountId,
    apiToken,
    workerName,
    releaseTag,
    guard,
    fetcher,
    signal
  });
  if (
    confirmedInventory.count !== inventory.count ||
    confirmedInventory.sha256 !== inventory.sha256 ||
    fingerprintCanonicalReleaseValue(confirmedInventory.version) !==
      fingerprintCanonicalReleaseValue(inventory.version)
  ) {
    throw new Error(
      "Cloudflare Worker-version inventory changed during inactive-upload attestation"
    );
  }
  guard();
  return Object.freeze({
    schemaVersion: 1,
    workerName,
    releaseTag,
    releaseMessage: expectedMessage,
    inactiveWorkerVersionId: tagged.id,
    inactiveWorkerVersionNumber: tagged.number,
    inactiveWorkerCreatedOn: tagged.createdOn,
    sourceRevision,
    workerRuntimeDigest,
    clientBuildDigest,
    runtimeCpuMs: runtime.cpuMs,
    remoteVersionCount: inventory.count,
    remoteVersionInventorySha256: inventory.sha256,
    inactiveWorkerVersionDetailSha256: createHash("sha256")
      .update(inactiveOutput)
      .digest("hex"),
    predecessorWorkerVersionDetailSha256: createHash("sha256")
      .update(predecessorOutput)
      .digest("hex")
  });
}

function source(journal) {
  const current = assertReleaseJournal(journal);
  if (
    ![
      RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
      RELEASE_JOURNAL_STATES.REPLACED
    ].includes(current.state) ||
    current.resumeFrom !== RELEASE_JOURNAL_STATES.PREPARED
  ) {
    throw new Error(
      "Inactive-upload recovery requires its exact prepared source"
    );
  }
  return current;
}

function attestor(value) {
  if (typeof value !== "function") {
    throw new Error("Inactive-upload recovery requires a callable attestor");
  }
  return value;
}

export async function previewInactiveUploadReplacement(journal, attest) {
  const current = source(journal);
  if (current.state === RELEASE_JOURNAL_STATES.REPLACED) return null;
  return attestor(attest)(current);
}

export async function commitInactiveUploadReplacement(
  journal,
  { releaseId, targetGitSha, at, attest } = {}
) {
  const current = source(journal);
  if (current.state === RELEASE_JOURNAL_STATES.REPLACED) {
    if (
      current.supersededBy.releaseId !== releaseId ||
      current.supersededBy.targetGitSha !== targetGitSha ||
      current.supersededBy.inactiveUploadAttestation === undefined
    ) {
      throw new Error(
        "Linked inactive-upload replacement identity changed before journal creation"
      );
    }
    return Object.freeze({ journal: current, evidence: null });
  }
  const evidence = await attestor(attest)(current);
  const replaced = replaceInactiveUploadReleaseJournal(current, {
    releaseId,
    targetGitSha,
    evidence,
    at
  });
  return Object.freeze({ journal: replaced, evidence });
}
