import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  RELEASE_JOURNAL_STATES,
  assertReleaseJournal,
  replaceBeforeUploadReleaseJournal
} from "./release-journal.mjs";
import { fingerprintCanonicalReleaseValue } from "./release-impact.mjs";
import { readBoundedResponseJson } from "./bounded-http-response.mjs";

const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const WORKER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const WORKER_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const REMOTE_VERSION_INSPECTION_MAX_BYTES = 2 * 1024 * 1024;
const REMOTE_VERSION_INSPECTION_PAGE_SIZE = 100;
const REMOTE_VERSION_INSPECTION_MAX_PAGES = 100;
const REMOTE_VERSION_INSPECTION_MAX_COUNT =
  REMOTE_VERSION_INSPECTION_PAGE_SIZE * REMOTE_VERSION_INSPECTION_MAX_PAGES;
const REMOTE_VERSION_INSPECTION_TIMEOUT_MS = 30_000;

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
  if (!match) {
    throw new Error(`${label} is invalid`);
  }
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

function exactRemoteVersionPage(payload, expectedPage) {
  const items = payload?.result?.items;
  const page = payload?.result_info;
  if (
    payload?.success !== true ||
    !Array.isArray(items) ||
    !page ||
    typeof page !== "object" ||
    Array.isArray(page) ||
    !Number.isInteger(page.page) ||
    page.page !== expectedPage ||
    !Number.isInteger(page.per_page) ||
    page.per_page !== REMOTE_VERSION_INSPECTION_PAGE_SIZE ||
    !Number.isInteger(page.count) ||
    !Number.isInteger(page.total_count) ||
    page.count !== items.length ||
    page.total_count < 0 ||
    page.total_count > REMOTE_VERSION_INSPECTION_MAX_COUNT ||
    items.length > REMOTE_VERSION_INSPECTION_PAGE_SIZE
  ) {
    throw new Error(
      "Cloudflare Worker-version inventory page is incomplete or unbounded"
    );
  }
  return Object.freeze({ items, totalCount: page.total_count });
}

function exactRemoteVersionInventory(
  items,
  { workerName, releaseTag, totalCount }
) {
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
    if (
      item.annotations !== undefined &&
      (!item.annotations ||
        typeof item.annotations !== "object" ||
        Array.isArray(item.annotations))
    ) {
      throw new Error("Cloudflare Worker-version annotations are invalid");
    }
    const tag = item.annotations?.["workers/tag"] ?? null;
    if (
      tag !== null &&
      (typeof tag !== "string" ||
        Buffer.byteLength(tag, "utf8") > 100 ||
        /[\x00-\x1f\x7f]/.test(tag))
    ) {
      throw new Error("Cloudflare Worker-version tag is invalid");
    }
    if (tag === releaseTag) {
      throw new Error(
        "Failed release has a tagged remote Worker upload; resume that exact release"
      );
    }
    return Object.freeze({ id: item.id, number: item.number, createdOn, tag });
  });
  versions.sort((left, right) =>
    left.number === right.number
      ? left.id.localeCompare(right.id)
      : left.number - right.number
  );
  return Object.freeze({
    schemaVersion: 1,
    workerName,
    releaseTag,
    remoteVersionCount: versions.length,
    remoteVersionInventorySha256: fingerprintCanonicalReleaseValue({
      schemaVersion: 1,
      workerName,
      releaseTag,
      versions
    }),
    taggedUploadAbsent: true
  });
}

export async function attestNoTaggedWorkerUpload({
  accountId,
  apiToken,
  workerName,
  releaseTag,
  guard = () => undefined,
  fetcher = fetch,
  signal = AbortSignal.timeout(REMOTE_VERSION_INSPECTION_TIMEOUT_MS)
}) {
  if (!ACCOUNT_ID_PATTERN.test(accountId ?? "")) {
    throw new Error("Remote Worker-upload attestation requires an exact account ID");
  }
  if (
    typeof apiToken !== "string" ||
    apiToken.length < 20 ||
    apiToken.length > 512 ||
    apiToken !== apiToken.trim() ||
    /[\x00-\x1f\x7f]/.test(apiToken)
  ) {
    throw new Error("Remote Worker-upload attestation requires a bounded API token");
  }
  boundedString(workerName, "Remote Worker-upload Worker name");
  if (!WORKER_NAME_PATTERN.test(workerName)) {
    throw new Error("Remote Worker-upload Worker name is invalid");
  }
  if (!RELEASE_ID_PATTERN.test(releaseTag ?? "")) {
    throw new Error("Remote Worker-upload attestation requires an exact release tag");
  }
  if (typeof guard !== "function" || typeof fetcher !== "function") {
    throw new Error("Remote Worker-upload attestation requires callable guards");
  }
  const items = [];
  let totalCount = null;
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    if (page > REMOTE_VERSION_INSPECTION_MAX_PAGES) {
      throw new Error("Cloudflare Worker-version inventory exceeded its page bound");
    }
    const endpoint = new URL(
      `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(
        workerName
      )}/versions`,
      CLOUDFLARE_API_ORIGIN
    );
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set(
      "per_page",
      String(REMOTE_VERSION_INSPECTION_PAGE_SIZE)
    );
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
        maxBytes: REMOTE_VERSION_INSPECTION_MAX_BYTES,
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
    const remotePage = exactRemoteVersionPage(payload, page);
    totalCount ??= remotePage.totalCount;
    if (remotePage.totalCount !== totalCount) {
      throw new Error("Cloudflare Worker-version inventory changed while reading");
    }
    totalPages = Math.max(
      1,
      Math.ceil(totalCount / REMOTE_VERSION_INSPECTION_PAGE_SIZE)
    );
    items.push(...remotePage.items);
  }
  return exactRemoteVersionInventory(items, {
    workerName,
    releaseTag,
    totalCount
  });
}

function assertAbsent(path, label) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must be absent before replacement`);
}

export function assertBeforeUploadReplacementArtifactsAbsent({
  attemptDirectory,
  serviceRoot,
  releaseId
}) {
  if (
    !isAbsolute(attemptDirectory ?? "") ||
    !isAbsolute(serviceRoot ?? "") ||
    !RELEASE_ID_PATTERN.test(releaseId ?? "")
  ) {
    throw new Error("Before-upload artifact guard requires exact absolute inputs");
  }
  assertAbsent(
    resolve(attemptDirectory, "worker-upload.json"),
    "Failed release Worker upload artifact"
  );
  assertAbsent(
    resolve(attemptDirectory, "d1-backup.json"),
    "Failed release D1 backup artifact"
  );
  assertAbsent(
    resolve(serviceRoot, "rollbacks", releaseId),
    "Failed release rollback artifact directory"
  );
  return Object.freeze({
    uploadArtifactAbsent: true,
    backupArtifactAbsent: true,
    rollbackArtifactAbsent: true
  });
}

function beforeUploadSource(journal) {
  const current = assertReleaseJournal(journal);
  if (
    ![
      RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
      RELEASE_JOURNAL_STATES.REPLACED
    ].includes(current.state) ||
    ![
      RELEASE_JOURNAL_STATES.VERIFIED,
      RELEASE_JOURNAL_STATES.PREPARED
    ].includes(current.resumeFrom)
  ) {
    throw new Error(
      "Before-upload recovery requires its exact verified or prepared source"
    );
  }
  return current;
}

function attestor(value) {
  if (typeof value !== "function") {
    throw new Error("Before-upload recovery requires a callable attestor");
  }
  return value;
}

export async function previewBeforeUploadReplacement(journal, attest) {
  const current = beforeUploadSource(journal);
  if (current.state === RELEASE_JOURNAL_STATES.REPLACED) return null;
  return attestor(attest)(current);
}

export async function commitBeforeUploadReplacement(
  journal,
  { releaseId, targetGitSha, at, attest } = {}
) {
  const current = beforeUploadSource(journal);
  if (current.state === RELEASE_JOURNAL_STATES.REPLACED) {
    if (
      current.supersededBy.releaseId !== releaseId ||
      current.supersededBy.targetGitSha !== targetGitSha
    ) {
      throw new Error(
        "Linked before-upload replacement identity changed before journal creation"
      );
    }
    return Object.freeze({ journal: current, evidence: null });
  }
  const evidence = await attestor(attest)(current);
  const replaced = replaceBeforeUploadReleaseJournal(current, {
    releaseId,
    targetGitSha,
    evidence,
    at
  });
  return Object.freeze({ journal: replaced, evidence });
}
