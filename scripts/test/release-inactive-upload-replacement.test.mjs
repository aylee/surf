import assert from "node:assert/strict";
import test from "node:test";
import {
  RELEASE_FINGERPRINT_KEYS,
  classifyReleaseImpact,
  fingerprintCanonicalReleaseValue
} from "../lib/release-impact.mjs";
import {
  RELEASE_FAILURE_CODES,
  RELEASE_JOURNAL_STATES,
  assertInactiveUploadReplacementEvidence,
  assertReleaseJournal,
  assertReleaseReplacement,
  createReleaseJournal,
  predecessorForReleaseReplacement,
  recordReleaseJournalFailure,
  transitionReleaseJournal
} from "../lib/release-journal.mjs";
import {
  attestTaggedInactiveWorkerUpload,
  commitInactiveUploadReplacement,
  previewInactiveUploadReplacement
} from "../lib/release-inactive-upload-replacement.mjs";

const predecessorWorkerVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const predecessorDeploymentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const inactiveWorkerVersionId = "11111111-1111-4111-8111-111111111111";
const preparedReceipts = Object.freeze({
  profileSha256: "1".repeat(64),
  operatorEnvironmentFingerprint: "2".repeat(64),
  wranglerConfigSha256: "3".repeat(64),
  workerSecretsFingerprint: "4".repeat(64)
});

function fingerprints(seed = "inactive") {
  return Object.fromEntries(
    RELEASE_FINGERPRINT_KEYS.map((key, index) => [
      key,
      fingerprintCanonicalReleaseValue(`${seed}:${index}:${key}`)
    ])
  );
}

function failedJournal() {
  const targetFingerprints = fingerprints();
  const initial = createReleaseJournal({
    releaseId: "release-inactive-upload",
    targetGitSha: "d".repeat(40),
    classification: classifyReleaseImpact({
      changedPaths: ["pnpm-lock.yaml"],
      targetFingerprints,
      activeReceipt: null
    }),
    targetFingerprints,
    predecessor: {
      releaseId: "previous-release",
      journalSha256: "5".repeat(64),
      workerVersionId: predecessorWorkerVersionId,
      deploymentId: predecessorDeploymentId,
      runnerActivationId: "runner-old-r1"
    },
    createdAt: "2026-08-16T05:38:00.000Z"
  });
  const verified = transitionReleaseJournal(
    initial,
    RELEASE_JOURNAL_STATES.VERIFIED,
    { at: "2026-08-16T05:38:01.000Z" }
  );
  const prepared = transitionReleaseJournal(
    verified,
    RELEASE_JOURNAL_STATES.PREPARED,
    { at: "2026-08-16T05:38:02.000Z", receipts: preparedReceipts }
  );
  return recordReleaseJournalFailure(prepared, {
    code: RELEASE_FAILURE_CODES.UPLOAD_FAILED,
    at: "2026-08-16T05:38:03.000Z"
  });
}

function inactiveEvidence(failed = failedJournal()) {
  return {
    liveWorkerVersionId: predecessorWorkerVersionId,
    liveDeploymentId: predecessorDeploymentId,
    liveDeploymentCreatedOn: "2026-08-15T22:19:38.127688Z",
    liveRunnerActivationId: "runner-old-r1",
    failedConfigSha256: preparedReceipts.wranglerConfigSha256,
    failedQueueTopologyFingerprint:
      failed.targetFingerprints.queueTopology,
    uploadArtifactAbsent: true,
    backupArtifactAbsent: true,
    rollbackArtifactAbsent: true,
    queueEvidence: {
      expectedQueueNames: ["surf-ingest", "surf-narrative"],
      queues: [
        {
          name: "surf-ingest",
          createdOn: "2026-08-10T04:58:17.532408Z"
        },
        {
          name: "surf-narrative",
          createdOn: "2026-08-10T15:18:13.808657Z"
        }
      ]
    },
    remoteUploadEvidence: {
      schemaVersion: 1,
      workerName: "surf-prod",
      releaseTag: failed.releaseId,
      releaseMessage: `surf release ${failed.releaseId}`,
      inactiveWorkerVersionId,
      inactiveWorkerVersionNumber: 33,
      inactiveWorkerCreatedOn: "2026-08-16T05:39:12.268696Z",
      sourceRevision: failed.targetGitSha,
      workerRuntimeDigest: failed.targetFingerprints.workerRuntime,
      clientBuildDigest: failed.targetFingerprints.workerAssets,
      runtimeCpuMs: 2_000,
      remoteVersionCount: 33,
      remoteVersionInventorySha256: "6".repeat(64),
      inactiveWorkerVersionDetailSha256: "7".repeat(64),
      predecessorWorkerVersionDetailSha256: "8".repeat(64)
    }
  };
}

test("inactive-upload replacement double-attests and linked retry makes no mutable reads", async () => {
  const failed = failedJournal();
  const evidence = inactiveEvidence(failed);
  assert.deepEqual(
    assertInactiveUploadReplacementEvidence(failed, evidence),
    evidence
  );
  let attestationCalls = 0;
  const attest = async (source) => {
    assert.equal(source.releaseId, failed.releaseId);
    attestationCalls += 1;
    return evidence;
  };
  assert.deepEqual(
    await previewInactiveUploadReplacement(failed, attest),
    evidence
  );
  const committed = await commitInactiveUploadReplacement(failed, {
    releaseId: "release-replacement",
    targetGitSha: "f".repeat(40),
    at: "2026-08-16T05:40:00.000Z",
    attest
  });
  assert.equal(attestationCalls, 2);
  assert.equal(committed.journal.state, RELEASE_JOURNAL_STATES.REPLACED);
  assert.equal(
    committed.journal.supersededBy.inactiveUploadAttestation
      .remoteUploadEvidence.inactiveWorkerVersionId,
    inactiveWorkerVersionId
  );
  assert.doesNotThrow(() => assertReleaseJournal(committed.journal));

  assert.equal(
    await previewInactiveUploadReplacement(committed.journal, attest),
    null
  );
  const retry = await commitInactiveUploadReplacement(committed.journal, {
    releaseId: committed.journal.supersededBy.releaseId,
    targetGitSha: committed.journal.supersededBy.targetGitSha,
    at: "2026-08-16T05:41:00.000Z",
    attest
  });
  assert.deepEqual(retry, { journal: committed.journal, evidence: null });
  assert.equal(attestationCalls, 2);

  const replacementFingerprints = fingerprints("replacement");
  const replacement = createReleaseJournal({
    releaseId: committed.journal.supersededBy.releaseId,
    targetGitSha: committed.journal.supersededBy.targetGitSha,
    classification: classifyReleaseImpact({
      changedPaths: ["pnpm-lock.yaml"],
      targetFingerprints: replacementFingerprints,
      activeReceipt: null
    }),
    targetFingerprints: replacementFingerprints,
    predecessor: predecessorForReleaseReplacement(committed.journal),
    createdAt: "2026-08-16T05:42:00.000Z"
  });
  assert.doesNotThrow(() =>
    assertReleaseReplacement(committed.journal, replacement)
  );
});

test("inactive-upload evidence rejects stateful artifacts, active tags, and identity drift", () => {
  const failed = failedJournal();
  const evidence = inactiveEvidence(failed);
  for (const patch of [
    { uploadArtifactAbsent: false },
    { backupArtifactAbsent: false },
    { rollbackArtifactAbsent: false }
  ]) {
    assert.throws(
      () =>
        assertInactiveUploadReplacementEvidence(failed, {
          ...evidence,
          ...patch
        }),
      /upload, backup, or rollback artifact/
    );
  }
  assert.throws(
    () =>
      assertInactiveUploadReplacementEvidence(failed, {
        ...evidence,
        remoteUploadEvidence: {
          ...evidence.remoteUploadEvidence,
          inactiveWorkerVersionId: predecessorWorkerVersionId
        }
      }),
    /active, not inactive/
  );
  assert.throws(
    () =>
      assertInactiveUploadReplacementEvidence(failed, {
        ...evidence,
        remoteUploadEvidence: {
          ...evidence.remoteUploadEvidence,
          workerRuntimeDigest: "9".repeat(64)
        }
      }),
    /does not match the failed release identity/
  );
});

function responseFor(items, resultInfo = {}) {
  return new Response(
    JSON.stringify({
      success: true,
      result: { items },
      result_info: {
        page: 1,
        per_page: 100,
        count: items.length,
        total_count: items.length,
        ...resultInfo
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function remoteVersion({
  id = inactiveWorkerVersionId,
  number = 33,
  tag = "release-inactive-upload",
  message = `surf release ${tag}`
} = {}) {
  return {
    id,
    number,
    metadata: { created_on: "2026-08-16T05:39:12.268696Z" },
    annotations: {
      "workers/tag": tag,
      "workers/message": message
    }
  };
}

function attestationOptions(overrides = {}) {
  const inspections = [];
  return {
    accountId: "a".repeat(32),
    apiToken: "token".repeat(8),
    workerName: "surf-prod",
    releaseTag: "release-inactive-upload",
    activeWorkerVersionId: predecessorWorkerVersionId,
    predecessorWorkerVersionId,
    sourceRevision: "d".repeat(40),
    workerRuntimeDigest: "1".repeat(64),
    clientBuildDigest: "2".repeat(64),
    expectedBindings: [
      {
        name: "FORECAST_BRIEF_AGENT",
        type: "durable_object_namespace",
        class_name: "ForecastBriefAgent"
      }
    ],
    inspectVersion: (versionId) => {
      inspections.push(versionId);
      return JSON.stringify({ id: versionId });
    },
    resolveDurableObjectNamespaceIds: (
      output,
      versionId,
      expectedBindings
    ) => {
      assert.equal(JSON.parse(output).id, predecessorWorkerVersionId);
      assert.equal(versionId, predecessorWorkerVersionId);
      assert.equal(expectedBindings.length, 1);
      return { FORECAST_BRIEF_AGENT: "f".repeat(32) };
    },
    assertReleaseIdentity: (output, expected, bindings, namespaceIds) => {
      assert.equal(JSON.parse(output).id, inactiveWorkerVersionId);
      assert.equal(expected.versionId, inactiveWorkerVersionId);
      assert.equal(expected.sourceRevision, "d".repeat(40));
      assert.equal(bindings.length, 1);
      assert.deepEqual(namespaceIds, {
        FORECAST_BRIEF_AGENT: "f".repeat(32)
      });
    },
    parseRuntime: (output, options) => {
      assert.equal(JSON.parse(output).id, inactiveWorkerVersionId);
      assert.equal(options.expectedVersionId, inactiveWorkerVersionId);
      assert.equal(options.requireCpuLimit, true);
      return { cpuMs: 2_000, usageModel: "standard" };
    },
    fetcher: async () => responseFor([remoteVersion()]),
    _inspections: inspections,
    ...overrides
  };
}

test("inactive upload attestation proves unique tag, message, runtime, and predecessor namespace identity", async () => {
  const options = attestationOptions();
  const { _inspections: inspections, ...inputs } = options;
  const evidence = await attestTaggedInactiveWorkerUpload(inputs);
  assert.deepEqual(inspections, [
    predecessorWorkerVersionId,
    inactiveWorkerVersionId
  ]);
  assert.equal(evidence.inactiveWorkerVersionId, inactiveWorkerVersionId);
  assert.equal(evidence.releaseMessage, "surf release release-inactive-upload");
  assert.equal(evidence.runtimeCpuMs, 2_000);
  assert.match(evidence.remoteVersionInventorySha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.inactiveWorkerVersionDetailSha256, /^[0-9a-f]{64}$/);

  for (const [fetcher, pattern] of [
    [
      async () => responseFor([]),
      /page is incomplete or unbounded/
    ],
    [
      async () =>
        responseFor([
          remoteVersion(),
          remoteVersion({
            id: "22222222-2222-4222-8222-222222222222",
            number: 34
          })
        ]),
      /exactly one Worker version/
    ],
    [
      async () =>
        responseFor([
          remoteVersion({ message: "unexpected release message" })
        ]),
      /unexpected release message/
    ]
  ]) {
    const { _inspections, ...rejected } = attestationOptions({ fetcher });
    await assert.rejects(
      attestTaggedInactiveWorkerUpload(rejected),
      pattern
    );
  }

  const { _inspections, ...activeTag } = attestationOptions({
    fetcher: async () =>
      responseFor([
        remoteVersion({
          id: predecessorWorkerVersionId
        })
      ])
  });
  await assert.rejects(
    attestTaggedInactiveWorkerUpload(activeTag),
    /active, not inactive/
  );
});

test("inactive upload inventory rejects pagination drift and duplicate identities", async () => {
  const versions = Array.from({ length: 101 }, (_unused, index) =>
    remoteVersion({
      id:
        index === 100
          ? inactiveWorkerVersionId
          : `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      number: index + 1,
      tag: index === 100 ? "release-inactive-upload" : `other-${index}`
    })
  );
  for (const [fetcher, pattern] of [
    [
      async (url) => {
        const page = Number(url.searchParams.get("page"));
        return responseFor(
          versions.slice((page - 1) * 100, page * 100),
          {
            page,
            total_count: page === 1 ? 101 : 102
          }
        );
      },
      /inventory changed while reading/
    ],
    [
      async (url) => {
        const page = Number(url.searchParams.get("page"));
        const items = page === 1 ? versions.slice(0, 100) : [versions[99]];
        return responseFor(items, { page, total_count: 101 });
      },
      /Worker-version identity is invalid/
    ]
  ]) {
    const { _inspections, ...options } = attestationOptions({ fetcher });
    await assert.rejects(attestTaggedInactiveWorkerUpload(options), pattern);
  }

  let pageCalls = 0;
  const inserted = remoteVersion({
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    number: 999,
    tag: "concurrent-upload"
  });
  const sameCountUniqueShift = async (url) => {
    const page = Number(url.searchParams.get("page"));
    const scan = Math.floor(pageCalls / 2);
    pageCalls += 1;
    const items =
      scan === 0
        ? versions.slice((page - 1) * 100, page * 100)
        : page === 1
          ? [inserted, ...versions.slice(0, 99)]
          : [versions[100]];
    return responseFor(items, { page, total_count: versions.length });
  };
  const { _inspections, ...shiftedOptions } = attestationOptions({
    fetcher: sameCountUniqueShift
  });
  await assert.rejects(
    attestTaggedInactiveWorkerUpload(shiftedOptions),
    /inventory changed during inactive-upload attestation/
  );
});
