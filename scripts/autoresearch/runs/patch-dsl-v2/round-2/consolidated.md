# Round 2 — Schema evolvability gap resolution

**Top gap addressed**: schema evolvability / versioning
**Winning perspective**: SKEPTIC
**Weighted total estimate**: 8.72 → recomputed below

## Why skeptic wins this round

Three proposers were tasked with the same gap. Estimated weighted totals (proposer self-estimates): pragmatist 8.80, skeptic 8.72, synthesizer 8.78.

**But the rubric weights `implementation_simplicity` at 0.12** (second-highest weight after `safety_blast_radius` at 0.22). Recomputing with skeptic's claimed +2 on implementation_simplicity (8 → 10):

- Skeptic delta: schema_evolvability +1 (×0.10) + implementation_simplicity +2 (×0.12) = +0.10 + +0.24 = **+0.34**
- Pragmatist delta: schema_evolvability +2 (×0.10) + implementation_simplicity -1 (×0.12) = +0.20 + -0.12 = **+0.08**
- Synthesizer delta: schema_evolvability +3 (×0.10) + implementation_simplicity -1 (×0.12) = +0.30 + -0.12 = **+0.18**

Skeptic wins by ~0.16-0.26 on rubric-weighted score. Base 8.60 + skeptic delta 0.34 = **8.94**.

This contradicts the proposers' self-estimates because they undervalued `implementation_simplicity`'s weight in the rubric.

## The chosen mechanism

**Schema fingerprint, not schema version.**

- Single mutable `variant.schema.json` in the repo.
- At server boot: `schema_fp = sha256(canonicalized(schema + allowlist))[:12]`.
- Architect system prompt includes the full schema + the fingerprint verbatim.
- Every patch carries one field: `"schema_fp": "a1b2c3d4e5f6"`.
- Server compares to current fp on receipt; mismatch → HTTP 409 with code `SCHEMA_STALE`.
- No semver, no version negotiation, no compat matrix, no upcaster chain.

## Migration story

There is no migration. When the schema changes, the fingerprint changes. Every unapplied patch in the pending queue is auto-marked `stale` by a single SQL update:

```sql
UPDATE variant_patches SET status = 'stale'
WHERE status = 'proposed' AND schema_fp != $1;
```

The harness UI shows a "Schema updated — regenerate?" button on each stale patch. Click → re-invokes architect with the original viewer comment + new schema → produces a fresh patch.

Already-applied patches are immutable history and unaffected.

## Architect-side discovery

System prompt is templated at session start with `{schema_json, allowlist, schema_fp}` inlined verbatim. No discovery RPC, no version negotiation tool. The fingerprint is in the prompt; the architect echoes it into every patch. If the model hallucinates a stale fp, server rejects — same path as any other stale patch.

## Expired patch rejection

```json
HTTP 409
{
  "code": "SCHEMA_STALE",
  "got_fp": "<from patch>",
  "expected_fp": "<server's current>",
  "hint": "regenerate from source comment"
}
```

Harness UI: yellow "Stale" badge on the patch card, disabled Apply button, one-click "Regenerate" that re-runs architect against originating comment. No auto-regen server-side (keeps human in loop, avoids runaway Claude calls). Audit log records both the rejected patch and any regenerated successor with `replaces: <stale_patch_id>`.

## Implementation cost

~60 lines of code total:
- fingerprint computation: ~10 LOC
- patch schema field + server check: ~15 LOC
- stale-mark SQL + UI badge: ~25 LOC
- regenerate handler: ~10 LOC

## What we didn't pick

**Pragmatist (semver + path_map + ETag, est. weighted 8.68 recomputed)** — well-understood patterns but pays ~300 LOC for migration logic we don't need at this scale. The `path_map` maintenance burden makes schema bumps a real chore.

**Synthesizer (upcaster chain + dual identifier + 3-state UX, est. weighted 8.78 recomputed)** — covers more migration cases but the upcaster chain is significant maintenance. The grace window of 5 versions is arbitrary and untested.

Both lose to skeptic on rubric-weighted total. The right move when v1 has 2 authors and ~100 patchable leaves is to refuse the migration logic. **"Refusing to write migration logic is the feature."**

## Gaps remaining (carry into next round)

1. **Array handling** — `add`/`remove` on arrays is technically permitted but the proposal treats animation as a named map. If real variants need ordered arrays (timeline keyframes), we need keyed maps or explicit array-index ops with bounds checks. **Critical** if any patchable target is array-shaped.

2. **Dry-render cost** — unbounded for complex variants. Need a fast-path for CSS-vars-only patches (validated without re-render) and caching strategy. **Critical** for latency.

3. **Schema fingerprint two-coexistence edge case** (introduced by skeptic) — if the project ever needs two fingerprints in flight simultaneously (long-running review across a breaking change), there's no graceful path. Mitigation is operational (don't bump schema mid-review), not architectural. **Non-critical** for v1.

## State after round 2

- Running weighted_total: **8.94**
- Target: 9.0
- Gap to target: 0.06
- Critical gaps remaining: 2 (array handling, dry-render cost)
- Iterations completed: 2 (round 1 + round 2)
- Max iterations: 5
- Continue: YES — target not yet met, gaps remain critical
