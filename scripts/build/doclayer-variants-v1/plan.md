# doclayer variants v1 — build plan

Source-of-truth DSL design: `scripts/autoresearch/runs/patch-dsl-v2/patch-dsl-final.md`.

Conflict model: **same-user only**. Model B (explicit supersession). No cross-user merging, no shared variants.

Auth: **magic-link email** via Supabase Auth.

Test coverage: **required** (Phase 7).

---

## Phase 0 — Patchable surface audit (PRE-REQ)

**Goal:** Mark `data-patchable="<schema-path-tail>"` attributes on every patchable element across all 11 scenarios. Document which CSS variables and microcopy strings are mutable. This locks the schema.

**Why first:** the schema fingerprint depends on the allowlist enumeration. Once the schema fp is committed, changing patchable surface requires a schema rotation + stale-mark migration. Get this right before any migrations.

**Deliverables:**
- `scripts/build/doclayer-variants-v1/patchable-surface.md` — exhaustive list per scenario: element selectors, schema path tails, type (css-var / microcopy / visibility / animation-scale / block-order)
- HTML edits across `mocks/00-flow.html` through `mocks/09-review-loop.html` + `mocks/index.html` adding `data-patchable` attributes
- CSS audit: identify the ~20-30 patchable CSS variables, document them in the file above

**Exit criteria:**
- Every scenario has 5-15 patchable points
- All `data-patchable` keys are unique within their scenario scope, lowercase-kebab
- No `data-patchable` on prose-bearing elements (those are `data-prose` instead, per spec section g)
- Adversarial reviewer: "is this allowlist minimal? does it cover the things viewers will want to mutate? are there any unsafe surfaces?" ≥ 9.0/10

---

## Phase 1 — Supabase foundation

**Deliverables:**
- Supabase migrations: `variants`, `comments`, `patches`, `variant_doc_versions`, `variant_patches_audit` tables with indexes
- RLS policies: owner can write own variant; signed-in users can read all public variants
- Magic-link email auth wired via Supabase Auth (`@supabase/supabase-js` client)
- Replace `mocks/identity.js`'s localStorage handle with Supabase session (preserve API: `window.doclayerIdentity.ensure()` returns the session user; falls back to anonymous-localStorage if Supabase env is missing)
- Settings panel: "signed in as `<email>` · sign out"
- Onboarding modal: replace handle field with email field + "send magic link" button

**Exit criteria:**
- Schema migrations applied successfully on doclayer Supabase project
- RLS policies tested with 2 mock users
- Sign-in flow works end-to-end on localhost + deploy
- Adversarial: "could a malicious user read/write another user's variant?" → no. ≥ 9.0/10

---

## Phase 2 — Manifest + schema fingerprint

**Deliverables:**
- Canonical variant manifest JSON Schema at `lib/variant-schema.json` (per spec section c, allowlist paths)
- Schema fingerprint canonicalization at `lib/schema-fp.ts` (per spec section b: $ref inline, key sort, JCS RFC 8785, SHA-256 12 hex)
- Allowlist enumeration at `lib/allowlist.ts` (read schema annotations, produce path list with per-leaf guards)
- CSS-var registry at `lib/css-vars.ts` mapping `--var-name` → `{scenario, schema-path, validator}`
- Tag patchable elements from Phase 0 with concrete schema-path values

**Exit criteria:**
- Schema fp is stable across reorderings of the schema source file (key sort + JCS verified)
- Schema fp changes when allowlist enum changes (test: add a leaf, fp differs)
- `lib/allowlist.ts` returns same list whether enumerated from schema or from `data-patchable` scan (cross-check)
- Adversarial: "is the canonicalization robust to whitespace/key-order/comment changes? does the fp change predictably?" ≥ 9.0/10

---

## Phase 3 — Apply / Undo / Regenerate endpoints

**Deliverables:**
- `/api/variants/apply.ts` (~220 LOC): auth, RLS, schema_fp check (409 SCHEMA_STALE), L1 Ajv, L2 regex guards (cssVar etc.), L3 envelope-macro expansion, L4 DOM smoke check (~50 LOC adapted from spec's SSR check — uses JSDOM, applies manifest to a snapshot, asserts harness-strip+topbar+statusbar still resolve, no script/iframe injection), transaction with `test` op precondition (412 PRECONDITION_FAILED), version insert, audit log
- `/api/variants/undo.ts` (~80 LOC): inverse synthesis from captured test values, 60s window
- `/api/variants/regenerate.ts` (~30 LOC): re-invokes architect with current schema + viewer's prior context; returns fresh patch with current fp
- Updated `/api/draft-feedback.ts`: architect prompt per spec section (j) — includes schema + fp + viewer's prior patches as context; outputs strict JSON with `schema_fp`, `viewer_comment_id`, `intent`, `ops[]`

**Exit criteria:**
- Apply happy path works: comment → architect → patch → apply → row in `variant_doc_versions`
- 409 path: stale fp returns 409 with `regenerate_endpoint` field
- 412 path: test op asserting wrong prior value returns 412
- 422 path: each L1/L2/L3/L4 failure returns structured error
- Undo within 60s reverses the patch; beyond 60s returns 410 GONE
- Adversarial: "can a hostile architect output break L4? can a viewer race conditions to corrupt the variant doc?" ≥ 9.0/10

---

## Phase 4 — Client patch flow

**Deliverables:**
- `mocks/patch-renderer.js` (~80 LOC): on scenario load, fetch current user's variant doc, apply patches to live DOM (set CSS vars, swap microcopy on `data-patchable` elements, toggle visibility, scale animations)
- Updated `mocks/comments.js`: after architect response arrives, parse `patch` field if present, render diff/preview in the response bubble with an "apply" button
- Apply button POSTs to `/api/variants/apply`, handles 409/412/422 with specific UX:
  - 409 SCHEMA_STALE → "this patch references an old schema · regenerate"
  - 412 PRECONDITION_FAILED → "your variant has changed · refresh + retry"
  - 422 validation → "couldn't apply: <specific reason>"
- 60-second undo countdown bar with "undo" button after apply
- Patch-stack popover on hover over `[data-patchable]` elements: shows applied patches in chronological order with superseded ones strikethrough (Model B visible)
- Settings panel adds: "your patches (N applied, M superseded) · view all"

**Exit criteria:**
- End-to-end: leave comment on `03-drafting` → "make typing slower" → architect drafts response + patch → click apply → typing speed visibly changes → 60s undo countdown ticks → click undo → reverts
- Stale-schema regenerate flow works: artificially bump schema_fp, apply old patch → 409 → click regenerate → fresh patch arrives → applies
- Cross-scenario: apply patches on 3 scenarios, reload entire site, all apply correctly on respective scenarios
- Adversarial: "does the patch preview show enough to make an informed accept/reject? is undo discoverable? are error states clear?" ≥ 9.0/10

---

## Phase 5 — Variants gallery

**Deliverables:**
- `mocks/variants.html` (new page): list all public variants from Supabase, columns: email handle, variant name, patch count, last active, link
- Click a variant → URL `?variant=<id>` query param applied to every scenario page; patch-renderer loads THAT variant's patches instead of current user's; read-only mode (no apply buttons)
- Banner at top: "browsing `<email>`'s variant · read-only · switch back to yours"
- Diff view: side-by-side or stacked, showing canonical vs. this variant's overrides per scenario

**Exit criteria:**
- Two test variants exist with different patches; gallery lists both; clicking each renders the corresponding state
- The same scenario looks different under different variants
- Diff view correctly highlights which paths differ
- Adversarial: "does cross-browse make the divergence VISCERAL? does it sell the meta-harness thesis at the population level?" ≥ 9.0/10

---

## Phase 6 — Architect prompt + prose escape hatch

**Deliverables:**
- Architect prompt per spec section (j) — verbatim where possible
- Prose escape hatch: if viewer's comment is about rewriting prose (architect classifies), output a `revision-variant` proposal instead of a patch. The proposal includes the suggested rewrite as a comment-thread node anchored to the relevant blockId
- Client renders revision-variant proposals differently from patches: a small "rewrite proposed · accept" UI that, on click, does a simulated text swap (no real Yjs in mocks; just localStorage-keyed override of the element's textContent)

**Exit criteria:**
- "Make this paragraph denser" routes to revision-variant, NOT a patch attempting to mutate prose
- "Make typing faster" routes to patch (CSS var mutation)
- Architect prompt is auditable: include schema fp + allowlist in every call
- Adversarial: "can hostile prompts make the architect propose patches outside the allowlist? do prose requests correctly route to revision-variant?" ≥ 9.0/10

---

## Phase 7 — Tests

**Deliverables:**
- Unit tests for `lib/schema-fp.ts`: fingerprint stability across key reorderings, $ref inlining, cycle detection
- Unit tests for `lib/allowlist.ts`: enumeration matches schema-source-of-truth
- Integration tests for `/api/variants/apply`: positive happy paths + negative paths for each error code (409, 412, 422 ×4 layers)
- Integration tests for `/api/variants/undo`: round-trip equivalence (patch → undo == identity)
- Integration test for supersession bookkeeping: apply 2 conflicting patches → check `superseded_by` is set on the earlier one
- Adversarial fuzzing of L4 DOM smoke check: inject `<script>`, `<iframe>`, `javascript:`, `data:`, prototype pollution attempts → all rejected with structured 422
- Cross-browser smoke: render two variants in Chrome + Safari (headless via Playwright if available, manual otherwise)

**Exit criteria:**
- 100% pass rate
- L4 catches all known injection patterns
- Adversarial: "is the test coverage actually useful or is it security theater? does it catch the bugs the spec's loop history called out?" ≥ 9.0/10

---

## Global stop conditions

The loop stops when ANY of:
- All 8 phases (0-7) have `status = complete` AND `adversarial_score >= 9.0`
- Iteration cap (20) reached
- Critical unrecoverable error logged (e.g., Supabase project unreachable, ANTHROPIC_API_KEY missing, can't proceed)

## Per-iteration protocol

Each iteration:
1. Read `loop-state.json`.
2. If stop condition met, exit.
3. Identify next pending phase (lowest-numbered with status != complete).
4. If phase is not yet started: dispatch the build agent(s) per phase deliverables. Set status to `building`.
5. If phase status is `building`: that means agents already ran — dispatch adversarial reviewer with the phase's exit criteria as the rubric.
6. If reviewer score >= 9.0: set status `complete`. Else set status `building` with `last_findings` populated; next iteration dispatches a fix agent that consumes `last_findings`.
7. Append a 3-5 sentence summary to `iteration-log.md` with what changed and the score.
8. Update `loop-state.json`.

## File layout when done

```
doclayer/
├── lib/
│   ├── variant-schema.json
│   ├── schema-fp.ts
│   ├── allowlist.ts
│   └── css-vars.ts
├── api/
│   ├── draft-feedback.ts           (updated, includes patch generation)
│   ├── variants/
│   │   ├── apply.ts
│   │   ├── undo.ts
│   │   └── regenerate.ts
├── supabase/
│   └── migrations/
│       └── 20260512_variants_v1.sql
├── mocks/
│   ├── (all scenarios get data-patchable attrs)
│   ├── identity.js                 (rewritten — Supabase Auth)
│   ├── comments.js                 (updated — Supabase backend + patch UI)
│   ├── patch-renderer.js           (new)
│   └── variants.html               (new — gallery)
├── tests/
│   └── (Phase 7 deliverables)
└── scripts/build/doclayer-variants-v1/
    ├── plan.md                     (this file)
    ├── loop-state.json
    ├── iteration-log.md
    ├── patchable-surface.md        (Phase 0 deliverable)
    └── per-phase-findings/
```
