import type { SourceCapability } from "@surf/contracts";

export type SourceFetch = typeof fetch;

export type AdapterStatus = "success" | "partial" | "failure";

export type SourceCaveat = {
  code: string;
  message: string;
};

export type AdapterOutcome<Row, Metadata = Record<string, unknown>> = {
  sourceId: string;
  provider: string;
  capabilities: SourceCapability[];
  status: AdapterStatus;
  rows: Row[];
  caveats: SourceCaveat[];
  errors: string[];
  fetchedAt: string;
  metadata: Metadata;
};

export function combineStatus(statuses: AdapterStatus[]): AdapterStatus {
  if (statuses.length === 0) return "failure";
  if (statuses.every((status) => status === "success")) return "success";
  if (statuses.every((status) => status === "failure")) return "failure";
  return "partial";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
