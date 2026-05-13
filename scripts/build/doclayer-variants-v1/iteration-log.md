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
