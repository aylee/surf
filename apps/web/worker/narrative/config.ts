export type NarrativeFeatureBindings = {
  NARRATIVE_ENABLED?: string;
  NARRATIVE_QUEUE?: Queue;
  NARRATIVE_RESULT_TOKEN?: string;
};

export function narrativeEnabled(env: NarrativeFeatureBindings): boolean {
  return (
    env.NARRATIVE_ENABLED?.trim().toLowerCase() === "true" &&
    Boolean(env.NARRATIVE_QUEUE) &&
    Boolean(env.NARRATIVE_RESULT_TOKEN?.trim())
  );
}
