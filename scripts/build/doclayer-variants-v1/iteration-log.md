# doclayer variants v1 — iteration log

Each iteration appends a 3-5 sentence summary here.

---

## BUILD COMPLETE — all 8 phases shipped

| Phase | Name | Score | Review attempts | Score arc |
|---|---|---|---|---|
| 0 | Patchable surface audit | 9.17 | 2 | — |
| 1 | Supabase foundation | 9.28 | 3 | — |
| 2 | Manifest + schema fingerprint | 9.22 | 1 | — |
| 3 | Apply / Undo / Regenerate | 9.13 | 3 | — |
| 4 | Client patch flow | 9.10 | 3 | — |
| 5 | Variants gallery | 9.00 | 2 | 6.48 → 9.00 |
| 6 | Architect prompt + prose escape hatch | 9.20 | 3 | 8.20 → 8.80 → 9.20 |
| 7 | Tests | **9.30** | 2 | 7.40 → 9.30 |

**Best score:** 9.30 (Phase 7).
**Iterations consumed:** 19 / 20 (cap).
**Schema fingerprint v1:** `170cf77f16aa` — stable across all 19 iterations.
**Tests:** 138 passing (50 lib + 88 api), 0 fail, 1 todo. L4 fuzz table: 29 injection patterns, all rejected.
**Migrations pending Supabase apply:** 5 (variants_v1, versions_unique, variants_public_handle, revision_variants, revision_variant_schema_fp).
**Pending user action:** `git push origin main` (Phase 6 commit local; classifier blocked auto-push). `supabase login && supabase link --project-ref ritjqumjhbkujnvyfkwi && supabase db push`.

---

## Iteration 19 — Phase 7 (Tests) — COMPLETE 9.30/10

**What happened:** Fix agent addressed all 3 P0s from iter 18 by fixing production code, not papering over with "known-gap" assertions. Fix to `lib/macros.ts:106` adds the `test` op on `/variant/content/blocks/order` to delete_block (mirroring insert_block at line 82) so undo can capture prior order. Fix to `lib/patch-guards.ts:61-73` rejects 7 Unicode confusable codepoints (U+FF1C, U+FF1E, U+FF06, U+2039, U+203A, U+27E8, U+27E9) plus case-insensitive `javascript:` substring. Fix to `mocks/07-multiplayer.html:1191` removed the orphan `data-patchable` attribute (preserves schema_fp). Added 11 new L4 fuzz entries (event handlers, style-attr, meta/link/base/object/embed). Test count: 125 → 138.

**Adversarial round 2:** Score **9.30/10**. Zero P0s, zero P1s, 3 P2s (more confusable codepoints would be nice — U+FE64/FE65 small angles, U+276E/F heavy angles; `javascript:` substring rejects legitimate microcopy referring to the protocol; the L2/L4 split honestly documents that L4-only failure paths don't exist with current guards).

**Score arc:** 7.40 → 9.30.

**Status:** Build complete. Loop stops with `stop_reason = all_phases_complete`. No ScheduleWakeup.

---

## Iteration 18 — Phase 7 (Tests) — REVIEW FAILED 7.40/10

**What happened:** Build agent added 66 tests across 6 files (schema-fp-extra, allowlist-extra, apply-layers, apply-l4-fuzz, undo, supersession), bringing the suite to 125 passing. 18-pattern L4 fuzz table. But during test-writing surfaced 3 real bugs: delete_block undo round-trip broken, Unicode fullwidth confusables bypass microcopyGuard, orphan `data-patchable="multiplayer-stuck-suggestion"` with no schema leaf. Build agent documented these as expected behavior instead of fixing.

**Adversarial round 1:** Score **7.40/10**. Three P0s, all the same anti-pattern: "test asserts buggy behavior passes IS theater." Per rubric, Phase 7 must validate correct behavior, not lock in bugs. Fix path: production code fix + flip test assertions to positive.

**Next iteration:** Surgical fix pass.

---

## Iteration 17 — Phase 6 (Architect prompt + prose escape hatch) — COMPLETE 9.20/10

**What happened:** Surgical fix pass for the two P1s from iter 16. Fix 1 (slot regression): `renderPatchPreview` and `renderRevisionVariantPreview` in `mocks/comments.js` now set `slot.dataset.slotKind = 'patch'|'revision'` on first claim; re-render path falls back to `.dlc-patch-slot-claimed[data-slot-kind=...]` lookup and clears innerHTML for reuse. Fix 2 (stale flag): added `[data-revision-stale="1"]` CSS rule in `mocks/style.css` (dashed underline + hover tooltip), cleared the flag on successful accept (`applyRevisionToDom`) and on successful replay (`replayAcceptedRevisions`).

**Adversarial round 3:** Score **9.20/10**. Zero P0s, zero P1s. 5 P2s (revision-render lacks symmetric MutationObserver teardown, `--vishal` for stale color drifts under variant overrides, tooltip clip risk in overflow-hidden ancestors, hardcoded English copy, no slot-count invariant assert). All P2s are non-blocking.

**Score arc:** 8.20 → 8.80 → 9.20.

**Status:** Phase 6 complete. 7 of 8 phases done. Only Phase 7 (Tests) remains. Next iteration dispatches the Phase 7 build agent.

---

## Iteration 16 — Phase 6 (Architect prompt + prose escape hatch) — REVIEW PARTIAL 8.80/10

**What happened:** Fix agent landed all 3 P0s + 5 P1s from iter 15. FNV-1a 32-bit verified byte-correct, 0 ancestor-violations across 8 mocks (HTML demotion moved 9 container `data-prose` attrs down to ~30 new leaf attrs), two-cursor independent pagination in `identity.js`, additive migration `20260513000002_revision_variant_schema_fp.sql`, allowlist validation in `draft-feedback.ts`, dual-emit dual-render in `comments.js`. 29 tests pass.

**Adversarial round 2:** Score **8.80/10**. Caught a regression introduced by the P1-4 fix (`dlc-patch-slot-claimed` never cleared → re-render silent no-op on anon→signed-in flow) and one cosmetic gap (`data-revision-stale` set but no CSS rule, never cleared on successful accept).

**Next iteration:** Surgical 2-line fix pass. This is the 3rd review attempt — pass-or-escalate.

---

## Iteration 15 — Phase 6 (Architect prompt + prose escape hatch) — REVIEW FAILED 8.20/10

**What happened:** Build agent landed ~825 LOC across `api/draft-feedback.ts` (tightened architect prompt with 9 worked examples + REVISION_VARIANT payload schema), 2 new endpoints (`revision-propose.ts`, `revision-accept.ts`), migration `20260513000001_revision_variants.sql` (ALTER on `comments` with `kind`/`target_block_id`/`proposed_text`/`revision_status` + check constraint + owner-accept RLS), client UI in `mocks/comments.js` (vishal-accent bubble, propose→accept two-step), `mocks/patch-renderer.js` `replayAcceptedRevisions()`, audit-trail fold into the patches modal, and 6 `data-prose` ids on 04-review/06-reader-harness.

**Adversarial findings (3 P0s):**
1. **Ancestor data-prose wipes descendants** — `mocks/06-reader-harness.html:836` puts `data-prose="reader-article-engineer-pm-researcher"` on a `<div class="article">` whose children include `data-patchable="reader-byline"` (line 838) and three nested `data-prose` paragraphs (851-853). `applyRevisionToDom`'s `el.textContent = text` would destroy all of them. Same hazard in `00-flow.html:2499`.
2. **Stale replay overwrites canonical** — `replayAcceptedRevisions` stores only `text`, no version/hash of the source-at-accept. If canonical prose changes upstream, localStorage replays OLD suggested over NEW canonical forever.
3. **Propose DoS** — `revision-propose.ts` has no rate limit, runs with service client, and proposals pollute the owner's timeline because `identity.js:828` includes `revision_status='proposed'`. Any signed-in user can flood any public variant's audit.

**Score arc:** 8.20 first attempt. Iteration 16 dispatches a fix agent.

---

## Iteration 1 — 2026-05-12T22:00Z

**Phase 0** (patchable surface audit) build agent ran. Tagged ~122 leaves across 11 scenarios + index: 25 CSS variables (typing-speed, anim-scale, color tokens, spacing, typography), ~58 microcopy strings, ~32 visibility wrappers, 5 block-level surfaces. Wrote `patchable-surface.md` (~250 lines). Added `data-patchable` + `data-prose` attributes to all mock HTML files and `/* PATCHABLE: */` annotations to `style.css`.

Adversarial reviewer scored **6.83/10 — REJECT** (below the 9.0 target). 12 must-fix items surfaced. Critical (f1): visibility booleans were dumped into `/variant/microcopy/<key>-visible` which violates the spec — microcopy is string-only, will fail L1 Ajv at Phase 2. High-severity: article titles (flow-doc-title, workstream-article-N-title) tagged as microcopy but they're prose per spec (g) — should be `data-prose`. Per-scenario counts in the doc don't match the live HTML (03-drafting doc says 10, file has 13; 04-review doc says 8, file has 13). Multiplayer stuck-suggestion default contains literal `<em>` HTML with no documented rendering mode — XSS-adjacent. Missing guards for 8-digit hex (`#95e35d22`) and fontFamily values with commas/quotes. No NFC normalization policy for microcopy.

**Next iteration**: Phase 0 fix agent consumes the 12 findings and addresses each in priority order. Adversarial reviewer re-runs.

## Iteration 2 — 2026-05-12T22:25Z

**Phase 0 fix iteration**. Fix agent addressed all 12 findings from iteration 1's review: introduced `/variant/visibility/<key>` namespace (resolves critical schema-path violation), converted 5 article titles + the index hero to `data-prose`, stripped HTML from multiplayer-stuck-suggestion default, added Rendering Policy + L2 Unicode guards + colorToken/fontFamily regex definitions + co-occurrence rule + forbidden chrome enumeration to the audit doc, reconciled all per-scenario counts to live HTML.

Adversarial re-review scored **9.17/10 — PASS** (up from 6.83). All 12 fixes landed in both source and doc. Counts arithmetic-check against grep. Three low-severity nits documented (non-blocking): key/path divergence on multiplayer-stuck-suggestion, bootstrap label selectors still nth-of-type, "16 base CSS colors" not enumerated explicitly.

Phase 0 complete. Total patchable surface: **95 attributes + 25 CSS vars + 2 animation scales + 5 block atoms = 127 fingerprint leaves**.

**Next iteration**: Phase 1 (Supabase foundation) — migrations, RLS policies, magic-link email auth wired to identity.js.

## Iteration 3 — 2026-05-12T22:33Z

**Phase 1 build** (Supabase foundation). Build agent shipped: 5-table migration SQL (`variants`, `comments`, `patches`, `variant_doc_versions`, `variant_patches_audit`) with RLS policies, indexes, and auto-create-variant trigger. Rewrote `mocks/identity.js` to use Supabase magic-link auth via CDN ESM, with full graceful fallback to localStorage handle when Supabase env is missing. Wrote `scripts/build-inject-env.js` to inject `SUPABASE_URL` + `SUPABASE_ANON_KEY` into `window.__doclayerConfig` at deploy time. All 12 HTML files updated.

Adversarial scored **7.56/10 — FIX**. 8 must-fix items, 1 critical: `comments_insert_own` and `patches_insert_own` RLS policies require variant-owner, which means non-owners CAN'T comment on public variants — directly contradicts the "anchored design feedback on public variants" product premise. Other findings: missing DELETE policy on comments, build step mutates source HTML in place (committable secrets risk), magic-link `emailRedirectTo` URL collision, security definer trigger missing `search_path`, missing partial indexes, identity update() shadowing when signed in.

**USER ACTION BLOCKER (separate from review):** migration apply needs `supabase login` (interactive). Commands surfaced.

**Next iteration**: Phase 1 fix agent addresses all 8 findings. Re-review.

## Iteration 4 — 2026-05-12T22:46Z

**Phase 1 fix iteration 1**. Fix agent landed all 8 findings from iter 3: RLS now permits cross-user comments/patches on public variants, DELETE policies added, build script writes to `dist/` (source mocks untouched, gitignored), magic-link redirect URL stripped of hash, security definer trigger has explicit `search_path`, 3 new indexes, identity update() guarded against shadowing, event listener cleanup wired.

Adversarial re-review scored **8.78/10 — FIX** (up from 7.56). Just under 9.0. 3 new real concerns surfaced: (1) `patches_update_own` lets owner mutate any column including `spec` — breaks editorial trust; (2) `hydrateFromSession` fallback duplicates DB trigger and masks trigger failures silently; (3) three code paths write `currentIdentity` independently — race-condition risk. All quick fixes.

**Next iteration**: Phase 1 fix iteration 2. After all 3 land, re-review should clear 9.0. Migration apply still blocked on `! supabase login`.

## Iteration 5 — 2026-05-12T22:54Z

**Phase 1 fix iteration 2**. Addressed 3 remaining concerns: (1) added `patches_enforce_immutable` BEFORE UPDATE trigger that locks `spec/comment_id/schema_fp/scenario_id/variant_id/created_at/id` columns — editorial trust restored; only lifecycle state (status/superseded_by_id/stale/applied_at) mutable. (2) Trigger-fallback path in identity.js now `console.warn`s, dispatches `doclayer:trigger-fallback` event, and shows a ⚠ degraded mode pill in the gear panel. (3) Single `setIdentity(id)` funnel for all currentIdentity writes; INVARIANT documented.

Adversarial scored **9.28/10 — PASS**. Phase 1 complete. Score arc: 7.56 → 8.78 → 9.28 across 3 review attempts. All RLS gaps closed, schema integrity restored, code quality improvements visible.

**Phase 1 ships.** Migration apply still requires `! supabase login && supabase link --project-ref ritjqumjhbkujnvyfkwi && supabase db push` — surfaced to user. Phase 2 (manifest schema + fingerprint) can proceed without migration applied; it's lib code.

**Next iteration**: Phase 2 dispatch — JSON schema, fingerprint canonicalization (JCS), allowlist enumeration, CSS-var registry.

## Iteration 6 — 2026-05-12T23:01Z

**Phase 2** (Manifest + schema fingerprint). Single-pass: build + review.

Build agent shipped: canonical JSON Schema at `lib/variant-schema.json` (125 unique leaves: 21 cssVars/tokens/spacing/typography + 1 anim scale + 34 visibility + 61 microcopy + 5 block atoms + 1 block order); JCS-compliant fingerprint canonicalization at `lib/schema-fp.ts` (~230 LOC) with $ref inlining + cycle sentinel + UTF-16 code-unit key sort + annotation-strip; schema-driven allowlist enumeration at `lib/allowlist.ts`; CSS-var registry at `lib/css-vars.ts` (25 entries). 30/30 tests passing in `lib/__tests__/`.

**v1 schema fingerprint: `170cf77f16aa`** — locked. Every patch from now on carries this; mismatches trigger 409 SCHEMA_STALE.

Adversarial scored **9.22/10 — PASS**. Canonicalization audited: $refs inlined, cycles → sentinel + REF_LIMIT, external refs throw, UTF-16 sort verified (NOT default Array.sort), correct annotation strip-list, shortest-round-trip number serialization, JCS-compliant string escaping. 5 low-severity non-blocking nits (rgb channel bounds, allowlist memoization, additional `additionalProperties:false` test, large-float guard, css-var scenarios drift check).

Reconciled audit's 127 → schema's 125: `--typing-speed-ms` and `--anim-scale` were double-counted in the Phase 0 audit (appearing in both "CSS variables" and "Animation scales" tables). Schema places each at one canonical path.

**Next iteration**: Phase 3 (apply / undo / regenerate endpoints) — server-side patch pipeline. Will need migration applied to test end-to-end.

## Iteration 7 — 2026-05-12T23:14Z

**Phase 3** (Apply/Undo/Regenerate endpoints) — biggest server-side surface. Build agent shipped ~1665 LOC: full L1-L4 validation pipeline, RFC 6902 test ops, Model B supersession, undo with inverse synthesis, regenerate path for stale fps, architect prompt rewritten per spec section (j) with inline schema + fp + allowlist. 45/45 tests pass.

Adversarial scored **6.82/10 — REJECT** (below 7.0). 8 must-fix items, 3 HIGH-severity correctness bugs in production-critical paths:

1. **Macro pairing bypass**: when a macro is present, L1.5 test-pairing check is skipped for ALL user-supplied ops. A hostile architect can attach a valid macro + ship unpaired mutating ops alongside it. Real exploit path.
2. **Concurrent version fork**: two concurrent applies read same latestVersion, both pass L1-L4, both insert with same prior_version_id. No optimistic lock. Version history forks silently. Real race.
3. **Undo macro replay drift**: undo re-expands macros against CURRENT doc, not pre-patch doc. If doc state drifted between apply and undo, inverse ops corrupt the doc. Need to persist expanded effectiveOps.

Plus 2 mediums (rgba channel range bounds, U+2028/U+2029 unhandled, scenario_id hardcoded 'unknown') and 1 low (L4 smoke synthetic-only).

Reviewer earned its keep — these would have been catastrophic in production.

**Next iteration**: Phase 3 fix agent on 8 findings. Migration apply still blocked on `! supabase login`.

## Iteration 8 — 2026-05-12T23:31Z

**Phase 3 fix iter 1**. Fix agent addressed all 8 prior findings: macro pairing bypass closed (security comment + always-enforce pair-check), concurrent-version-fork prevented via unique constraint migration + 409 VERSION_FORK_DETECTED, undo replays captured `effective_ops` instead of re-expanding macros against drifted doc, color guard parses RGB channels with bounds, applyOp gets strictAdd + allowAbsenceTest options for macro TOCTOU guard, U+2028/U+2029 added to microcopy rejection set, scenario_id required + validated against 11-scenario allowlist, L4 smoke loads real `mocks/<id>.html`. 9 new regression tests. 54/54 passing.

Adversarial re-review scored **8.87/10 — FIX**. Score arc: 6.82 → 8.87. Reviewer noted: "All 8 must-fix items genuinely landed with regression coverage. The remaining gap is polish, not security. Recommend treating these as nits and granting PASS." 3 remaining: (1) L4 silently falls back to synthetic when mocks file missing — fail-closed instead; (2) Audit insert has no error handling — silent gaps if network blips; (3) Supersession scans `spec.ops` which is empty for macro-only patches.

This is the **2nd review attempt** on Phase 3. 3rd attempt rejection would trigger stuck escalation. These 3 polish items should clear 9.0.

**Next iteration**: Phase 3 fix iter 2 on 3 polish items. Migration `20260512000001_versions_unique.sql` also pending apply.

## Iteration 9 — 2026-05-12T23:44Z

**Phase 3 fix iter 2 — PASS.** All 3 polish items landed: L4 smoke fails-closed when scenario mock missing (was silently fallback); audit insert wrapped try/catch with console.error + `audit_log_warning` flag in response; supersession scan unions paths from both `spec.ops` and `spec.effective_ops` so macro-only patches participate in lineage. 5 new tests; 59/59 passing.

Adversarial scored **9.13/10 — PASS** on 3rd attempt. Score arc: 6.82 → 8.87 → 9.13.

The reviewer earned its keep on Phase 3 — caught three production-critical correctness bugs that would have shipped catastrophically: macro pairing bypass (hostile architect smuggling unpaired ops), concurrent version fork (no optimistic lock → silent history divergence), undo macro replay drift (re-expanding against drifted doc → corruption). All closed with regression coverage.

Phase 3 ships. Two migrations pending Supabase apply: `20260512000000_variants_v1.sql` + `20260512000001_versions_unique.sql`.

**Next iteration**: Phase 4 (Client patch flow) — frontend integration: patch preview, apply button, 60s undo countdown, patch-stack popover. Builds on the now-stable server pipeline.

## Iteration 10 — 2026-05-13T00:00Z

**Phase 4** (Client patch flow). Build agent shipped: new `mocks/patch-renderer.js` (365 LOC) exposing `applyPatchLive` / `undoPatch` / `getPatchHistoryAtPath`; `mocks/comments.js` extended with patch preview UI + apply flow + 60s undo countdown; `mocks/identity.js` settings panel adds "your patches" section; `mocks/style.css` +225 LOC for `.patch-preview` / `.patched-hidden` / `.patch-stack-popover` etc; script tag wired to all 11 scenarios + index.

Adversarial scored **6.48/10 — REJECT**. 5 must-fix items, 3 HIGH:
1. **Undo macro-revert desync**: local reversal silently no-ops on macro-only patches (no paired test op on same path), so server reverts but DOM stays mutated.
2. **Preview hides structural ops**: macro-only patches render as "(no diff)" but apply real structural changes — viewer applies blind.
3. **CSS-var registry drift**: client reimplements the schema-path → CSS-var-name mapping with regexes instead of consuming `lib/css-vars.ts`.

Plus 2 mediums (anonymous apply affordance shows enabled button that 401s; 410 GONE + 422 SMOKE_FAILED scenario + VERSION_FORK_DETECTED.reload() handling incomplete).

XSS surface is clean (textContent throughout, escapeHtml in popover). The killers are correctness bugs, not security.

**Next iteration**: Phase 4 fix agent on 5 items. 2 attempts remaining before stuck escalation.

## Iteration 11 — 2026-05-13T00:06Z

**Phase 4 fix iter 1**. All 5 prior must-fix items landed: undo now server-authoritative (returns doc, client calls `fetchAndReplay`), preview shows macro+effective_ops+block formatting, css-vars exported to `mocks/css-vars.json` (single source of truth, regex mapping removed), anonymous viewers get "sign in to apply" CTA opening magic-link modal, 410+422 SMOKE scenario+VERSION_FORK_DETECTED all properly mapped.

Adversarial re-review scored **8.14/10 — FIX** (up from 6.48). All 5 fixes verifiably landed. The 2 pre-existing weaknesses (settings "your patches" pane shallow, popover missing macro info) weren't on the must-fix list and stayed below threshold, dragging weighted score under 9.0.

**2nd review attempt complete. 1 attempt remaining.** 4 items for PASS: build the full "your patches" modal, surface macro info in popover, drop the same-count gate on effective_ops, AbortController for one-shot listener.

**Next iteration**: Phase 4 fix iter 2 on 4 polish items. Score should clear 9.0.

## Iteration 12 — 2026-05-13T00:17Z

**Phase 4 fix iter 2 — PASS at 9.10/10.** All 4 polish items landed: full "your patches" modal (groups by scenario, pagination via applied_at cursor, status badges, superseded-by scroll-to-flash, head-only count queries no longer load spec payloads), popover shows `macro: <kind>` badges with blockId fragments, effective_ops gate dropped (always renders when patch.macro present), AbortController scopes identity-ready listener with `doclayer:modal-closed` event + MutationObserver bubble-removal abort.

Score arc on Phase 4: **6.48 → 8.14 → 9.10** across 3 review attempts. Reviewer's 3 categories of critical bugs (undo macro desync, structural-ops invisibility, CSS-var registry drift) all closed. Anonymous fallback proper. Error states distinctly mapped. Cross-scenario state survives reload via Supabase-driven replay.

**Phase 4 ships.** Halfway+ point: 5 of 8 phases complete. Best score 9.28.

**Next iteration**: Phase 5 (Variants gallery) — list all public variants, browse another viewer's variant read-only, diff view.

## Iteration 13 — 2026-05-13T00:27Z

**Phase 5** (Variants gallery). Build agent shipped: new `mocks/variants.html` (442 LOC) with avatar grid, search/sort/empty state, top-3 intents, browse/diff actions; cross-browse mode in `mocks/patch-renderer.js` (~85 LOC) with `?variant=<id>` query param, read-only banner, body class overrides, link rewriting at install; diff modal reusing `pm-*` classes; index.html + guide.html link to gallery; 395 LOC of new CSS.

Adversarial scored **6.48/10 weighted — FIX** (unweighted 7.17). The phase that exists to sell the thesis at the population level failed at thesis-selling.

3 HIGH-severity items: (1) cards are interchangeable — no visual preview of the variant's aesthetic, top-3 intents are the only character surface; (2) diff modal renders microcopy as `(canonical text) → variant value` — that's a placeholder not a diff, the canonical IS knowable but isn't surfaced; (3) `viewer-<6chars>` slugs strip humanity — gallery should feel populated by PEOPLE not database IDs.

3 medium/low: link rewriting only runs once at install (dynamic links escape browse mode), fixed-position elements may collide with banner, "load more" is a silent no-op.

**Next iteration**: Phase 5 fix agent on 6 items. 2 attempts remaining.

## Iteration 14 — 2026-05-13T00:39Z

**Phase 5 fix iter 1 — PASS at 9.00/10.** All 6 must-fix items landed. The thesis-selling pieces: 5-chip palette strip on each card (`--bg/--panel/--accent/--vishal/--akhil`) showing actual variant values, scenario coverage pills linking deep into browse mode, avatar ring colored with variant's actual accent. Diff modal now resolves real canonical from `lib/variant-schema.json` walk — no more `(canonical text)` placeholder. New migration `20260513000000_variants_public_handle.sql` exposes `email_handle = split_part(email,'@',1)` via SECURITY DEFINER view — humans not slugs. MutationObserver + capture-click handler for dynamic links. Top-anchored fixed elements offset 38px under `body.variant-readonly`. Real cursor pagination on `last_active_at`.

Score arc on Phase 5: **6.48 → 9.00** across 2 review attempts.

**Phase 5 ships. 6 of 8 phases complete.** Best score 9.28. Three migrations pending Supabase apply (variants_v1, versions_unique, variants_public_handle).

**Next iteration**: Phase 6 (Architect prompt + prose escape hatch) — refined architect-side. Phase 3 already implemented most of this; Phase 6 polishes the prose-routing detection and revision-variant client rendering.
