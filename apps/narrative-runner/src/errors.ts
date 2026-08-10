export type FailureDisposition = "terminal" | "transient";

/**
 * A bounded, secret-safe failure. Callers log only `code` and `disposition`;
 * provider bodies, prompts, outputs, URLs, and bearer tokens never travel in
 * the error message.
 */
export class RunnerFailure extends Error {
  readonly code: string;
  readonly disposition: FailureDisposition;

  constructor(code: string, disposition: FailureDisposition) {
    super(code);
    this.name = "RunnerFailure";
    this.code = code;
    this.disposition = disposition;
  }
}

export function runnerFailure(
  error: unknown,
  fallbackCode: string,
  fallbackDisposition: FailureDisposition
): RunnerFailure {
  return error instanceof RunnerFailure
    ? error
    : new RunnerFailure(fallbackCode, fallbackDisposition);
}
