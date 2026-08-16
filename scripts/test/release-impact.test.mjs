import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSETS_ONLY_TRUSTED_FINGERPRINT_KEYS,
  RELEASE_CLASSIFICATION_REASON_CODES,
  RELEASE_FINGERPRINT_KEYS,
  RELEASE_LANES,
  assertReleaseClassification,
  classifyReleaseImpact,
  createTrustedActiveReleaseReceipt,
  fingerprintCanonicalReleaseValue,
  fingerprintReleaseFiles,
  forceConservativeReleaseClassification,
  isNarrowUiReleasePath
} from "../lib/release-impact.mjs";

const workerVersionId = "11111111-1111-4111-8111-111111111111";

function fingerprints(seed = "a") {
  return Object.fromEntries(
    RELEASE_FINGERPRINT_KEYS.map((key, index) => [
      key,
      fingerprintCanonicalReleaseValue(`${seed}:${index}:${key}`)
    ])
  );
}

function trustedReceipt(activeFingerprints = fingerprints()) {
  return createTrustedActiveReleaseReceipt({
    schemaVersion: 1,
    releaseId: "release-active",
    targetGitSha: "a".repeat(40),
    workerVersionId,
    journalSha256: "b".repeat(64),
    state: "complete",
    fingerprints: activeFingerprints
  });
}

test("release file fingerprints are order-independent and boundary-safe", () => {
  const left = fingerprintReleaseFiles([
    { path: "apps/web/src/App.tsx", contents: "alpha" },
    { path: "apps/web/src/styles.css", contents: Buffer.from("beta") }
  ]);
  const right = fingerprintReleaseFiles([
    { path: "apps/web/src/styles.css", contents: new TextEncoder().encode("beta") },
    { path: "apps/web/src/App.tsx", contents: "alpha" }
  ]);
  assert.equal(left, right);
  assert.notEqual(
    left,
    fingerprintReleaseFiles([
      { path: "apps/web/src/App.tsx", contents: "alph" },
      { path: "apps/web/src/styles.css", contents: "abeta" }
    ])
  );
  assert.throws(
    () =>
      fingerprintReleaseFiles([
        { path: "apps/web/src/App.tsx", contents: "one" },
        { path: "apps/web/src/App.tsx", contents: "two" }
      ]),
    /Duplicate release fingerprint path/
  );
});

test("the assets-only lane requires narrow UI paths and matching trusted receipts", () => {
  const activeFingerprints = fingerprints();
  const targetFingerprints = {
    ...activeFingerprints,
    workerAssets: fingerprintCanonicalReleaseValue("new-assets")
  };
  const classification = classifyReleaseImpact({
    changedPaths: [
      "apps/web/src/styles.css",
      "apps/web/public/favicon.svg",
      "apps/web/index.html"
    ],
    targetFingerprints,
    activeReceipt: trustedReceipt(activeFingerprints)
  });

  assert.equal(classification.lane, RELEASE_LANES.ASSETS_ONLY);
  assert.deepEqual(classification.impact, {
    workerAssets: true,
    workerRuntime: false,
    materialization: false,
    migrations: false,
    seed: false,
    queueTopology: false,
    triggerTopology: false,
    runner: false,
    narrativeContract: false,
    secrets: false
  });
  assert.deepEqual(
    classification.comparedFingerprintKeys,
    [...ASSETS_ONLY_TRUSTED_FINGERPRINT_KEYS].sort()
  );
  assert.deepEqual(classification.mismatchKeys, []);
  assert.doesNotThrow(() => assertReleaseClassification(classification));
});

test("lockfiles, shared packages, release tooling, and unknown paths fail closed", () => {
  const candidates = [
    "pnpm-lock.yaml",
    "packages/contracts/src/index.ts",
    "scripts/lib/something-new.mjs",
    "some-new-runtime/config.toml"
  ];
  for (const path of candidates) {
    const classification = classifyReleaseImpact({
      changedPaths: [path],
      targetFingerprints: fingerprints(),
      activeReceipt: trustedReceipt()
    });
    assert.equal(classification.lane, RELEASE_LANES.CONSERVATIVE_FULL);
    assert.ok(Object.values(classification.impact).every(Boolean));
    assert.ok(
      classification.reasonCodes.includes(
        RELEASE_CLASSIFICATION_REASON_CODES.NON_UI_PATH
      )
    );
  }
});

test("UI-looking changes fail closed without an authenticated baseline", () => {
  const paths = ["apps/web/src/App.tsx"];
  const targetFingerprints = fingerprints();
  const missing = classifyReleaseImpact({
    changedPaths: paths,
    targetFingerprints,
    activeReceipt: null
  });
  assert.equal(missing.lane, RELEASE_LANES.CONSERVATIVE_FULL);
  assert.ok(
    missing.reasonCodes.includes(
      RELEASE_CLASSIFICATION_REASON_CODES.ACTIVE_RECEIPT_MISSING
    )
  );

  const unchecked = classifyReleaseImpact({
    changedPaths: paths,
    targetFingerprints,
    activeReceipt: {
      schemaVersion: 1,
      state: "complete",
      fingerprints: targetFingerprints
    }
  });
  assert.ok(
    unchecked.reasonCodes.includes(
      RELEASE_CLASSIFICATION_REASON_CODES.ACTIVE_RECEIPT_UNTRUSTED
    )
  );
});

test("a sensitive fingerprint mismatch escalates UI paths to the full lane", () => {
  const activeFingerprints = fingerprints();
  const targetFingerprints = {
    ...activeFingerprints,
    workerAssets: fingerprintCanonicalReleaseValue("new-assets"),
    narrativeContract: fingerprintCanonicalReleaseValue("changed-contract")
  };
  const classification = classifyReleaseImpact({
    changedPaths: ["apps/web/src/App.tsx"],
    targetFingerprints,
    activeReceipt: trustedReceipt(activeFingerprints)
  });
  assert.equal(classification.lane, RELEASE_LANES.CONSERVATIVE_FULL);
  assert.deepEqual(classification.mismatchKeys, [
    "narrativeContract",
    "workerAssets"
  ]);
  assert.deepEqual(classification.impact, {
    workerAssets: true,
    workerRuntime: false,
    materialization: false,
    migrations: false,
    seed: false,
    queueTopology: false,
    triggerTopology: false,
    runner: false,
    narrativeContract: true,
    secrets: false
  });
  assert.ok(
    classification.reasonCodes.includes(
      RELEASE_CLASSIFICATION_REASON_CODES.FINGERPRINT_MISMATCH
    )
  );
});

test("trusted fingerprints derive a composable component impact table", () => {
  const activeFingerprints = fingerprints("component-active");
  const cases = [
    {
      name: "Worker runtime",
      path: "apps/web/worker/auth.ts",
      fingerprintKeys: ["workerRuntime"],
      impactKeys: ["workerRuntime"]
    },
    {
      name: "materialization",
      path: "apps/web/worker/ingest/queue.ts",
      fingerprintKeys: ["materialization"],
      impactKeys: ["materialization"]
    },
    {
      name: "materialization dispatch entrypoint",
      path: "apps/web/worker/index.ts",
      fingerprintKeys: ["workerRuntime", "materialization"],
      impactKeys: ["workerRuntime", "materialization"]
    },
    {
      name: "materialization time semantics",
      path: "apps/web/worker/time.ts",
      fingerprintKeys: ["workerRuntime", "materialization"],
      impactKeys: ["workerRuntime", "materialization"]
    },
    {
      name: "materialized fact bundle",
      path: "apps/web/worker/brief/facts.ts",
      fingerprintKeys: ["workerRuntime", "materialization"],
      impactKeys: ["workerRuntime", "materialization"]
    },
    {
      name: "migration",
      path: "packages/db/migrations/0006_example.sql",
      fingerprintKeys: ["migrations"],
      impactKeys: ["migrations"]
    },
    {
      name: "seed",
      paths: [
        "packages/db/seeds/0000_v1_norcal.sql",
        "packages/db/src/norcal-seed-config.ts"
      ],
      fingerprintKeys: ["seed"],
      impactKeys: ["seed"]
    },
    {
      name: "Queue topology",
      path: "apps/web/wrangler.jsonc",
      fingerprintKeys: ["queueTopology"],
      impactKeys: ["queueTopology"]
    },
    {
      name: "trigger topology",
      path: "apps/web/wrangler.jsonc",
      fingerprintKeys: ["triggerTopology"],
      impactKeys: ["triggerTopology"]
    },
    {
      name: "runner artifact",
      path: "apps/narrative-runner/src/runner.ts",
      fingerprintKeys: ["runnerArtifact"],
      impactKeys: ["runner"]
    },
    {
      name: "runner runtime",
      path: "apps/narrative-runner/.env.example",
      fingerprintKeys: ["runnerRuntime"],
      impactKeys: ["runner"]
    },
    {
      name: "narrative protocol",
      path: "packages/narrative-contracts/src/index.ts",
      fingerprintKeys: ["narrativeContract"],
      impactKeys: ["narrativeContract"]
    },
    {
      name: "Worker secrets",
      path: "docs/production-releases.md",
      fingerprintKeys: ["workerSecrets"],
      impactKeys: ["secrets"]
    },
    {
      name: "documentation only",
      path: "docs/architecture.md",
      fingerprintKeys: [],
      impactKeys: []
    },
    {
      name: "test only",
      path: "apps/narrative-runner/test/runner.test.ts",
      fingerprintKeys: [],
      impactKeys: []
    }
  ];

  for (const value of cases) {
    const targetFingerprints = { ...activeFingerprints };
    for (const key of value.fingerprintKeys) {
      targetFingerprints[key] = fingerprintCanonicalReleaseValue(
        `${value.name}:${key}`
      );
    }
    const classification = classifyReleaseImpact({
      changedPaths: value.paths ?? [value.path],
      targetFingerprints,
      activeReceipt: trustedReceipt(activeFingerprints)
    });

    assert.equal(
      classification.lane,
      RELEASE_LANES.CONSERVATIVE_FULL,
      value.name
    );
    assert.deepEqual(
      classification.mismatchKeys,
      [...value.fingerprintKeys].sort(),
      value.name
    );
    assert.deepEqual(
      Object.keys(classification.impact).filter(
        (key) => classification.impact[key]
      ),
      value.impactKeys,
      value.name
    );
    assert.doesNotThrow(
      () => assertReleaseClassification(classification),
      value.name
    );
  }
});

test("shared, release-tooling, config, and lock deltas force every impact", () => {
  const activeFingerprints = fingerprints("fail-closed-active");
  const cases = [
    ["pnpm-lock.yaml", "dependencyLock"],
    ["packages/contracts/src/index.ts", "sharedWorkspace"],
    ["scripts/lib/release-impact.mjs", "releaseTooling"],
    ["apps/web/wrangler.jsonc", "logicalConfig"]
  ];

  for (const [path, fingerprintKey] of cases) {
    const classification = classifyReleaseImpact({
      changedPaths: [path],
      targetFingerprints: {
        ...activeFingerprints,
        [fingerprintKey]: fingerprintCanonicalReleaseValue(
          `changed:${fingerprintKey}`
        )
      },
      activeReceipt: trustedReceipt(activeFingerprints)
    });
    assert.equal(classification.lane, RELEASE_LANES.CONSERVATIVE_FULL);
    assert.ok(Object.values(classification.impact).every(Boolean));
    assert.doesNotThrow(() => assertReleaseClassification(classification));
  }
});

test("classification validation rejects a forged partial component vector", () => {
  const activeFingerprints = fingerprints("validation-active");
  const classification = classifyReleaseImpact({
    changedPaths: ["packages/db/migrations/0006_example.sql"],
    targetFingerprints: {
      ...activeFingerprints,
      migrations: fingerprintCanonicalReleaseValue("changed-migration")
    },
    activeReceipt: trustedReceipt(activeFingerprints)
  });

  assert.throws(
    () =>
      assertReleaseClassification({
        ...classification,
        impact: { ...classification.impact, migrations: false }
      }),
    /unverified component impact/
  );
});

test("unsafe, empty, or incomplete classifier inputs are conservative", () => {
  for (const changedPaths of [[], ["../apps/web/src/App.tsx"], ["/apps/web/src/App.tsx"]]) {
    const classification = classifyReleaseImpact({
      changedPaths,
      targetFingerprints: fingerprints(),
      activeReceipt: trustedReceipt()
    });
    assert.equal(classification.lane, RELEASE_LANES.CONSERVATIVE_FULL);
  }

  const incomplete = fingerprints();
  delete incomplete.workerSecrets;
  const classification = classifyReleaseImpact({
    changedPaths: ["apps/web/src/App.tsx"],
    targetFingerprints: incomplete,
    activeReceipt: trustedReceipt()
  });
  assert.ok(
    classification.reasonCodes.includes(
      RELEASE_CLASSIFICATION_REASON_CODES.FINGERPRINT_SET_INVALID
    )
  );
});

test("the UI allowlist excludes executable and configuration side doors", () => {
  assert.equal(isNarrowUiReleasePath("apps/web/src/App.tsx"), true);
  assert.equal(isNarrowUiReleasePath("apps/web/public/favicon.svg"), true);
  assert.equal(isNarrowUiReleasePath("apps/web/index.html"), true);
  assert.equal(isNarrowUiReleasePath("apps/web/src/release.sh"), false);
  assert.equal(isNarrowUiReleasePath("apps/web/.dev.vars"), false);
  assert.equal(isNarrowUiReleasePath("apps/web/vite.config.ts"), false);
  assert.equal(isNarrowUiReleasePath("apps/web/worker/index.ts"), false);
  assert.equal(isNarrowUiReleasePath("apps/web/src/App.test.tsx"), true);
});

test("a UI change and its colocated test qualify for assets-only", () => {
  const targetFingerprints = fingerprints("spot-ordering-target");
  const classification = classifyReleaseImpact({
    changedPaths: [
      "apps/web/src/App.test.tsx",
      "apps/web/src/App.tsx",
      "apps/web/src/styles.css"
    ],
    targetFingerprints,
    activeReceipt: trustedReceipt({
      ...targetFingerprints,
      workerAssets: fingerprintCanonicalReleaseValue("spot-ordering-predecessor")
    })
  });
  assert.equal(classification.lane, RELEASE_LANES.ASSETS_ONLY);
  assert.deepEqual(classification.impact, {
    workerAssets: true,
    workerRuntime: false,
    materialization: false,
    migrations: false,
    seed: false,
    queueTopology: false,
    triggerTopology: false,
    runner: false,
    narrativeContract: false,
    secrets: false
  });
});

test("an operator may force a more conservative lane but never a narrower one", () => {
  const targetFingerprints = fingerprints("forced");
  const classification = classifyReleaseImpact({
    changedPaths: ["apps/web/src/App.tsx"],
    targetFingerprints,
    activeReceipt: trustedReceipt({
      ...targetFingerprints,
      workerAssets: fingerprintCanonicalReleaseValue("old-assets")
    })
  });
  const forced = forceConservativeReleaseClassification(classification);
  assert.equal(forced.lane, RELEASE_LANES.CONSERVATIVE_FULL);
  assert.ok(forced.reasonCodes.includes("operator_forced_full"));
  assert.throws(
    () =>
      forceConservativeReleaseClassification(
        forced,
        RELEASE_CLASSIFICATION_REASON_CODES.ASSETS_ONLY_VERIFIED
      ),
    /reason is invalid/
  );
});
