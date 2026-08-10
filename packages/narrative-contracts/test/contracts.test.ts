import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertNarrativeJobSize,
  NARRATIVE_JOB_MAX_BYTES,
  NarrativeFallbackWatchdogSchema,
  NarrativeGeneratedResultSubmissionSchema,
  NarrativeJobSchema,
  NarrativeTerminalResultSubmissionSchema,
  type NarrativeJob
} from "../src/index";

const fingerprint = createHash("sha256").update("fixture").digest("hex");

function fixture(domain: string): NarrativeJob {
  return NarrativeJobSchema.parse({
    schemaVersion: 1,
    jobId: `${domain}.job`,
    domain,
    entity: { id: `${domain}.entity`, localDate: "2026-08-09" },
    factFingerprint: fingerprint,
    materialFingerprint: fingerprint,
    generationFingerprint: fingerprint,
    promptVersion: "narrative-v1",
    outputSchemaVersion: 1,
    deadlineAt: "2026-08-10T00:00:00.000Z",
    capability: {
      protocol: "openai-chat-completions",
      structuredOutput: "json-schema"
    },
    result: { target: `${domain}.result`, submissionId: `${domain}.submission` },
    inference: {
      messages: [
        { role: "system", content: "Return grounded JSON." },
        { role: "user", content: "Use only supplied facts." }
      ],
      responseSchema: { type: "object" },
      maxOutputTokens: 800,
      temperature: 0.2
    }
  });
}

describe("NarrativeJob", () => {
  it.each(["surf", "ski", "mtb"])("accepts the domain-neutral %s fixture", (domain) => {
    expect(assertNarrativeJobSize(fixture(domain)).domain).toBe(domain);
  });

  it("rejects arbitrary callback URLs and unknown envelope fields", () => {
    expect(() =>
      NarrativeJobSchema.parse({
        ...fixture("surf"),
        result: { target: "https://example.com/result", submissionId: "submission" }
      })
    ).toThrow();
    expect(() => NarrativeJobSchema.parse({ ...fixture("surf"), surfSpotId: "bolinas" })).toThrow();
  });

  it("requires canonical millisecond UTC deadlines for D1 ordering", () => {
    const canonical = fixture("surf");
    expect(canonical.deadlineAt).toBe("2026-08-10T00:00:00.000Z");
    expect(() =>
      NarrativeJobSchema.parse({
        ...canonical,
        deadlineAt: "2026-08-09T17:00:00.000-07:00"
      })
    ).toThrow();
    expect(() =>
      NarrativeJobSchema.parse({
        ...canonical,
        deadlineAt: "2026-08-10T00:00:00Z"
      })
    ).toThrow();
  });

  it("rejects oversized jobs before Queue publication", () => {
    const job = fixture("surf");
    job.inference.responseSchema = {
      type: "object",
      description: "x".repeat(NARRATIVE_JOB_MAX_BYTES)
    };
    expect(() => assertNarrativeJobSize(job)).toThrow();
  });

  it("accepts only semantically valid terminal status and reason pairs", () => {
    expect(
      NarrativeTerminalResultSubmissionSchema.parse({
        schemaVersion: 1,
        jobId: "surf.job",
        submissionId: "surf.submission",
        terminal: { status: "expired", reasonCode: "job_expired" }
      }).terminal.status
    ).toBe("expired");
    expect(() =>
      NarrativeTerminalResultSubmissionSchema.parse({
        schemaVersion: 1,
        jobId: "surf.job",
        submissionId: "surf.submission",
        terminal: { status: "expired", reasonCode: "inference_request_rejected" }
      })
    ).toThrow();
  });

  it("requires exact inference provenance on generated results", () => {
    const result = NarrativeGeneratedResultSubmissionSchema.parse({
      schemaVersion: 1,
      jobId: "surf.job",
      submissionId: "surf.submission",
      providerId: "omlx",
      route: "primary",
      modelId: "qwen3.6-27b",
      output: { paragraphs: {} }
    });
    expect(result).toMatchObject({ providerId: "omlx", route: "primary" });
    expect(() =>
      NarrativeGeneratedResultSubmissionSchema.parse({
        ...result,
        providerId: "omlx",
        route: "unknown"
      })
    ).toThrow();
  });

  it("keeps fallback watchdogs identity-bound and URL-free", () => {
    const watchdog = NarrativeFallbackWatchdogSchema.parse({
      schemaVersion: 1,
      job: "narrative-fallback-watchdog",
      jobId: "surf.job",
      submissionId: "surf.submission",
      eligibleAt: "2026-08-10T00:10:00.000Z",
      trigger: "delayed_watchdog",
      preclaimRetryCount: 0
    });
    expect(watchdog.jobId).toBe("surf.job");
    expect(() =>
      NarrativeFallbackWatchdogSchema.parse({
        ...watchdog,
        callbackUrl: "https://example.com/callback"
      })
    ).toThrow();
    expect(() =>
      NarrativeFallbackWatchdogSchema.parse({
        ...watchdog,
        preclaimRetryCount: 2
      })
    ).toThrow();
  });
});
