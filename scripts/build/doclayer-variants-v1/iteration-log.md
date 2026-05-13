# doclayer variants v1 — iteration log

Each iteration appends a 3-5 sentence summary here.

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
