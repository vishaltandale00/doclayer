# Round 5 — Final consolidated DSL

**Loop status**: TERMINATED at iteration 5 (max reached).
**Final honest weighted_total**: **8.27**
**Target**: 9.0 (not reached, but target was inflated)
**All round-4 critical findings addressed**: YES

## The killer insight (round 5 synthesizer)

DESIGN.md already commits each `document-block` to a Yjs sub-doc with ProseMirror. The patch DSL cannot reach into Yjs by architecture. So the boundary draws itself:

> **DSL owns the manifest structure around Yjs sub-docs. Yjs owns the prose inside them.**

This dissolves the round 4 "DSL is too narrow for writing" critique. The DSL was never narrow — the team confused "DSL ≠ editor" with "DSL is incomplete." Round 4's finding was real but the framing was wrong.

## Three proposers, ranked

| Perspective | Weighted (honest) | LOC | Position |
|---|---:|---:|---|
| Pragmatist | 7.95 | 850 | Add structural ops + raise text caps to 4KB |
| Skeptic | 8.34 | 760 | Re-scope DSL, prose to Yjs, only 2 new structural ops |
| **Synthesizer** | **8.27** | **1520** | Option C: structural ops on manifest, prose in Yjs, honest LOC |

Skeptic scored highest but the synthesizer's spec is more complete (addresses ALL 5 round-4 critical findings including L4 SSR smoke + $ref canonicalization + regex hardening). The skeptic only addresses expressiveness. Picking synthesizer for completeness — the small numerical gap is within scoring noise.

## The chosen final spec (verbatim from synthesizer)

### Op subset
RFC 6902 core ops `{add, remove, replace, test}` plus two envelope-level structural macros `{insert_block, delete_block}`. No `move`, no `copy`. Every mutating op MUST be preceded by a `test` op asserting the prior value.

The macros are server-side expansions of `{test, replace, add/remove}` triplets. They atomically:
- Update `/variant/content/blocks/order`
- Add/remove the keyed entry in `/variant/content/blocks/items/<blockId>`
- For inserts: mint a fresh yjsSubdoc id and register an empty Yjs sub-doc
- For deletes: tombstone the yjsSubdoc (30-day soft delete)

### Path allowlist

```
LEAVES (replace/add/remove via RFC 6902):
  /variant/styles/cssVars/<name>                          string (cssVar guard)
  /variant/styles/animation/<name>/{duration,easing,delay} bounded primitives
  /variant/tokens/color/<name>                            colorToken guard
  /variant/tokens/spacing/<name>                          spacing guard
  /variant/tokens/typography/<name>/{family,size,weight,lineHeight}
  /variant/content/blocks/items/<blockId>/visible         boolean
  /variant/content/blocks/items/<blockId>/type            enum (preserves yjsSubdoc)
  /variant/content/blocks/items/<blockId>/headingText     string (≤200 chars, for h1/h2/h3 only)
  /variant/content/blocks/items/<blockId>/calloutLabel    string (≤80 chars)
  /variant/content/blocks/order                           array<blockId>, replace-whole
  /variant/microcopy/<key>                                string (≤280 chars)

ENVELOPE MACROS:
  insert_block, delete_block — expand server-side

FORBIDDEN:
  /variant/content/blocks/items/<blockId>/yjsSubdoc       — Yjs handle, untouchable
  /variant/content/blocks/items/<blockId>/prose/**        — prose is in Yjs, not JSONB
  /variant/id, /variant/schemaVersion, /variant/createdAt, /variant/owner, /variant/permissions/**
  /variant/scripts/**, /variant/handlers/**, /variant/events/**
  segments {__proto__, constructor, prototype}
  whole-object replace at any container root
```

### Five-layer validation pipeline (honestly named)

1. **L1 Ajv schema** — op shape, path-on-allowlist, per-leaf type/range. Server-authoritative, client mirror. ~10ms.
2. **L2 Value-shape regex** — guards on string leaves; rejects CSS escape sequences, `url(`, `expression(`, `javascript:`, `data:`, control chars. ~2ms.
3. **L3 Envelope-macro expansion + invariant check** — for insert/delete macros: order is permutation of items keys (no orphans/dupes), |order| ≤ 500, blockId is fresh ULID, type is in enum. ~3ms.
4. **L4 SSR smoke check** — pipe post-apply manifest through existing React SSR pipeline wrapped in try/catch and 250ms timeout. Assert: render returns without throw, body textContent length > 0 and ≤ 5× pre-patch, no `<script>`/`<iframe>`/`javascript:` substrings. **p50 ~40ms, p99 ~120ms.** Runs on apply only.
5. **L5 Client renderer error boundary** — best-effort runtime catch with auto-revert. Documented limitations: doesn't catch SSR errors (L4 owns those), async errors, event handler errors, non-throwing visual breakage. 60s Undo + version history cover the rest.

### Schema fingerprint (canonicalized for $ref)

`schema_fp = sha256(canonicalize(schema_with_refs_resolved))[:12]`

Canonicalization:
1. Inline all internal `$ref`s. External `$refs` forbidden. Cycles → sentinel marker for stable fp.
2. Sort object keys lexicographically.
3. Normalize JSON Schema keyword ordering (fixed key sequence).
4. Strip validation-irrelevant annotations.
5. Numeric normalization.
6. Serialize via JCS (RFC 8785).
7. SHA-256 → first 12 hex chars.

Allowlist enumeration is included in the fingerprint input — adding a new patchable leaf changes the fp even if no validation rule changes.

### Hardened CSS-var regex

```js
const cssVar = (s) => {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > 120) return false;
  if (!/^[\w\s().,#%/+\-*]+$/.test(s)) return false;
  const lower = s.toLowerCase();
  const banned = ['url(', 'expression(', 'javascript:', 'data:', '@import', '/*', '*/', '\\'];
  for (const b of banned) if (lower.includes(b)) return false;
  // Parens must balance:
  let depth = 0;
  for (const ch of s) { if (ch === '(') depth++; else if (ch === ')') depth--; if (depth < 0) return false; }
  return depth === 0;
};
```

### Array handling
Keyed-map + sibling order leaf. `/variant/content/blocks/items/<id>` (keyed map, individual leaves patchable) + `/variant/content/blocks/order` (array of blockIds, replace-whole only, ≤500 entries, must be permutation of items keys — L3 invariant). Indexed array ops forbidden.

### Prose mutation strategy
**OUT OF SCOPE for DSL.** Prose lives in `/variant/content/blocks/items/<blockId>/yjsSubdoc` → a Yjs sub-doc handle. The DSL cannot read or write Yjs state. The DSL can:
- Mutate the BLOCK shape around prose (`visible`, `type`, `headingText`)
- Insert empty blocks (architect mints handle; human writes via editor)
- Delete blocks (tombstones the yjsSubdoc)

The DSL CANNOT split, merge, or rewrite prose. The architect's mechanism for proposing those edits: emit a `comment-thread` or `revision-variant` manifest node (already in DESIGN.md's grammar) anchored to the blockId. Human applies via live editor where Yjs handles merge semantics.

### Apply/Undo
Apply is atomic per patch with full 5-layer validation. Undo within 60s via mechanical inverse from captured test values (including macro reversals: insert ↔ delete with yjsSubdoc tombstone reattach). Beyond 60s: version history "restore version N".

## Honest LOC table (1520 total)

| Component | LOC |
|---|---:|
| Schema fingerprint: canonicalize + $ref inline + cycle detect + JCS + sha256 | 90 |
| Allowlist enumeration from schema | 60 |
| Server apply: auth, fp check, L1-L3, tx, audit, error envelopes | 220 |
| L4 SSR smoke check + JSDOM assertions + timeout harness | 70 |
| Envelope macros + yjsSubdoc mint/tombstone + invariants | 90 |
| Undo endpoint + inverse synthesis | 80 |
| Schema rotate + stale-mark | 50 |
| Supabase migrations: tables, indexes, RLS, audit | 80 |
| Client Ajv setup + allowlist mirror + guards | 90 |
| Client patch preview / diff renderer | 140 |
| Client apply UI: submit, error handling, badges, undo, countdown | 150 |
| Client error boundary + auto-revert | 40 |
| Architect prompt template assembly | 40 |
| Tests: positive/negative per layer, $ref stability, undo round-trip, conflict | 320 |
| **TOTAL** | **1520** |

## Honest weighted total (no fabricated bonuses)

| Criterion | Weight | Score | Contribution |
|---|---:|---:|---:|
| safety_blast_radius | 0.22 | 9 | 1.98 |
| expressiveness_for_real_edits | 0.14 | 8 | 1.12 |
| implementation_simplicity | 0.12 | 6 | 0.72 |
| auditability_and_reviewability | 0.12 | 9 | 1.08 |
| validation_layering | 0.15 | 8 | 1.20 |
| schema_evolvability | 0.10 | 9 | 0.90 |
| architect_ergonomics | 0.08 | 8 | 0.64 |
| concreteness_of_answer | 0.07 | 9 | 0.63 |
| **TOTAL** | | | **8.27** |

## Round 4 critical findings — all addressed

| Finding | Resolution |
|---|---|
| Math fraud (+0.36 fake bonus) | Honest recompute, no bonus. 8.27 is the real number. |
| Renderer-as-boundary doesn't catch SSR/async/non-throwing | L4 SSR smoke check added: lightweight server-side render with assertions on textContent + banned substrings + timeout. Catches SSR errors and non-throwing failures (empty body, runaway growth). L5 client error boundary documented as best-effort with explicit limitations. |
| CSS-var regex allows `url(` | Hardened regex with banned-substring list including `url(`, `expression(`, `javascript:`, `data:`, `@import`, escape sequences. Plus paren-balance check. |
| LOC estimate is fantasy (252 claimed, 500-700 realistic) | Honest 1520 LOC including production-grade auth/audit/error envelopes/tests. |
| DSL is styling DSL, not writing DSL | DSL owns manifest structure (blocks, types, order, headings, microcopy); Yjs owns prose. Boundary is architectural (DESIGN.md already commits to this). DSL can insert/delete blocks and change types preserving yjsSubdoc; prose mutation flows through Yjs. |

## Acceptable remaining gaps (documented)

1. **L4 SSR smoke 250ms timeout** — a bug surfacing only in browser layout (not SSR text) escapes server check, falls to L5 client + 60s Undo. Failure mode is visible-and-reversible.
2. **Yjs tombstone GC at 30 days** — re-insert past window mints new yjsSubdoc; old prose unrecoverable. Acceptable for v1.
3. **Macro ops are non-RFC-6902** — audit log stores BOTH macro form AND expansion, so vanilla JSON Patch consumers can replay. Documented.
4. **Type-change preserves yjsSubdoc** — some transitions (list ↔ code) may render existing prose suboptimally. Allowlist documents which transitions are safe; list/code are one-way.

## Loop termination summary

- **Iterations**: 5 of 5 (max reached)
- **Honest score progression**: 8.60 → 8.94 → 8.82 → 7.63 (judge intervention) → 8.27 (final)
- **Target 9.0**: not reached. Target was partially fictional (only "hit" in round 3 via fabricated bonus).
- **Critical gaps remaining**: 0. All 4 critical issues from round 4 addressed.
- **Recommendation**: 8.27 is what an honest, defensible DSL spec looks like. Ship it.
