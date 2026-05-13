# Round 4 — Independent judge tears round 3 apart

**Stability verdict**: REGRESSED.
**Honest weighted_total of round 3 answer**: **7.63** (not the claimed 9.18).

## What the judge found

### 1. Math fraud
Round 3's claimed 9.18 includes a +0.36 "gap removed" bonus that the rubric does not define. The honest per-criterion sum from round 3's own scores is **8.82**. The skeptic invented the bonus.

### 2. Renderer-as-error-boundary is leaky
React error boundaries don't catch:
- SSR-time errors (server rendering)
- Async errors (Promise rejections in render-adjacent code)
- Event handler errors
- **Non-throwing failures** — e.g., `spacing: -9999px` passes the regex, breaks layout invisibly. No auto-revert fires.

The "third validation layer" claim is overstated. It's two solid layers + a leaky third.

### 3. CSS-var regex permits `url()`
`/^[\w\s().,#%/+\-*]{1,120}$/` blocks `;{}<>:` but allows parens + slash + asterisk. `url(/relative-path)` survives. If downstream consumers concatenate custom properties into URL or content properties, this is non-zero risk. Not catastrophic. Worth a re-look.

### 4. LOC estimate is fantasy
252 LOC is 2-3× under realistic.
- Apply endpoint (70 LOC claimed) needs: auth + audit + RFC 6902 test-op enforcement + 412 conflict response + prior_version_id chaining + error envelopes. **Easily 150-200 LOC.**
- Client UI (90 LOC claimed) needs: diff render + 60s countdown + stale badges + Ajv setup + error-boundary wiring. **Easily 200+ LOC.**
- **Realistic total: 500-700 LOC.**

The "10/10 implementation_simplicity" leaned on the 252 number.

### 5. The DSL has become a styling DSL, not a writing DSL
**This is the killer finding.** doclayer's v1 wedge is Vishal+Akhil collaboratively writing an article series. The DSL currently allows:
- Tweaking CSS variables ✅
- Toggling visibility ✅
- Changing ≤280 chars of text ✅
- Reordering animation tokens ✅

It does NOT allow:
- Rewriting a paragraph longer than 280 chars
- Inserting a new section
- Restructuring a list into prose
- Splitting one block into two
- Joining two blocks
- Adding a heading

**These are the actual operations the architect would want to propose during collaborative writing.** The DSL was hardened into safety so far that it can't express what doclayer is for.

## Judge's rescored weighted total

| Criterion | Weight | Round 3 self-score | Judge re-score | Δ |
|---|---:|---:|---:|---:|
| safety_blast_radius | 0.22 | 9 | 8 | -0.22 |
| expressiveness_for_real_edits | 0.14 | 9 | **7** | -0.28 |
| implementation_simplicity | 0.12 | 10 | 7 | -0.36 |
| auditability_and_reviewability | 0.12 | 9 | 9 | 0 |
| validation_layering | 0.15 | 7 | 6 | -0.15 |
| schema_evolvability | 0.10 | 9 | 8 | -0.10 |
| architect_ergonomics | 0.08 | 9 | 8 | -0.08 |
| concreteness_of_answer | 0.07 | 9 | 9 | 0 |
| **Honest sum** | | | | **8.82 - 1.19 = 7.63** |

Plus removing the fabricated +0.36 bonus → judge confirms 7.63.

## Array handling resolution (non-critical)

Separately, the array-handling proposer returned a clean answer: **keyed-map-of-items + sibling `order` leaf** (option c). All ordered collections schema-declare two leaves: `/variant/<coll>/items/<id>/...` (keyed map) and `/variant/<coll>/order` (array of stable IDs, patchable). Reordering = `replace` on order leaf. Adding/removing requires custom envelope ops `create_item`/`delete_item` that maintain the items↔order invariant atomically.

**LOC delta: +35.** Non-blocking for v1 since current schema has no ordered collections.

## Recommendation

Run round 5 with explicit focus on:
1. **Expressiveness for writing** — raise text caps, allow block-level structural ops, OR re-scope the DSL honestly.
2. **Realistic LOC** — drop the fantasy 252; estimate honestly.
3. **The renderer-as-boundary leak** — either accept it and document, OR add a lightweight server-side syntax check (not full headless render) for non-throwing safety issues.
4. **Regex hardening** — tighten cssVar to reject `url(`.
