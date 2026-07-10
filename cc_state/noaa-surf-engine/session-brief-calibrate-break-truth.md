---
status: ready
type: session-brief
mission: calibrate-break-truth
created: 2026-07-09
workstream: cc_state/noaa-surf-engine/WORKSTREAM.md
supersedes: brief-one-shot-v1.md
---

# Calibrate Actual Break Truth - Session Brief

## Mission

Establish a legal, timestamped actual-break label path and evaluate the frozen
production height/surface baseline before changing any transform or weights.

## Done State (demo-as-done)

- A runnable label capture/import path records spot, time, breaking-face band,
  surface class, provenance, and label confidence without scraping a paywall.
- At least one real labeled session can be joined to the exact issued
  `forecast_issues`/`forecast_snapshots` row that preceded it.
- A chronological evaluator reports band accuracy, adjacent-band accuracy,
  bias/MAE, surface confusion metrics, and baselines from the frozen production
  versions.
- Results state whether the current MOP-Hs headline remains baseline; no
  transform is promoted without satisfying the documented gates.

## Ratified Scope (do not relitigate)

**This scope encodes OD-3, OD-5, OD-6, OD-8, and OD-9.**

- Numeric forecasting stays deterministic and source/provenance complete.
- MOP nowcast and Surf Captain/Surfline are proxies/peers, not breaking truth.
- The production breaker transform is diagnostic-only until labels prove it.
- Use the existing 400-day issued-history dataset and `session_feedback` shape
  where it fits; add the minimum schema needed for trustworthy labels.
- Out of scope: broadening geography, skill/board personalization, or enabling
  an LLM report agent.

## Plan of Attack

1. Resume from `WORKSTREAM.md` -> ledger -> this brief.
2. Choose the first label source with Alex: structured post-session entry or an
   explicitly authorized camera/manual review path.
3. Freeze the current engine/presentation versions as the baseline.
4. Implement the smallest provenance-rich capture/import and join it to the
   last issue available before the label time.
5. Add chronological evaluation with persistence/raw-MOP/current-product
   baselines and the promotion gates from `docs/accuracy-evaluation.md`.
6. Run the full repo gate and an adversarial leakage/reproducibility review.

## Guardrails / Boundaries

- **Protect:** no LLM wave physics; no future-issued forecast matched to a
  label; no silent source or spot-geometry changes.
- Do not bypass Surfline/Surf Captain subscriptions, access controls, or terms.
- Keep size and surface labels separate.
- Preserve raw label provenance and confidence; uncertain labels stay
  uncertain rather than becoming precise training truth.
- Do not promote a new transform on the training set or one weather event.

## Verification

```bash
pnpm check
pnpm test
uv run --project services/extractor pytest
pnpm build
```

Also prove the temporal join is no-lookahead, reruns are deterministic, and a
frozen holdout remains untouched by fitting.

## On Completion (closeout)

- Flip this brief to `executed` and fill its receipt.
- Close-loop OI-5 and mint any transform decision in the ledger.
- Update the workstream verification/session log.
- Mint the next mission brief before ending.

---

## Receipt (filled on execution)

_Status: PENDING_
