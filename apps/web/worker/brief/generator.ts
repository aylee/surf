import type { ForecastBriefDraft, ForecastFactBundle } from "./types";

export interface BriefGenerator {
  readonly provider: "google";
  readonly modelId: string;
  readonly promptVersion: string;
  generate(bundle: ForecastFactBundle): Promise<ForecastBriefDraft>;
}
