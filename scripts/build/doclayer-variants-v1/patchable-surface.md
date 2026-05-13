# Patchable surface audit

Phase 0 deliverable for the doclayer variants v1 build. Locks the schema fingerprint
input — every entry below is one element in the path allowlist enumeration that goes
into `schema_fp = sha256(canonicalize(schema_with_refs_resolved))[:12]`.

Source-of-truth DSL: `scripts/autoresearch/runs/patch-dsl-v2/patch-dsl-final.md`
(sections (c) allowlist, (e) cssVar guard, (g) prose strategy, (j) architect prompt).

## Rendering policy (load-bearing)

**Microcopy renders as `textContent` only.** Markup in defaults is forbidden and
stripped at render time. Any `<`, `>`, `&` in microcopy input is HTML-entity
escaped before being written to the DOM. The patch renderer never invokes
`innerHTML` for any `/variant/microcopy/*` leaf.

**Prose vs microcopy.** Elements bearing `data-prose="<blockId>"` are NOT in the
patch DSL allowlist. Prose rewrites flow through `revision-variant` proposals
(spec section g), are stored in Yjs, and are scoped at the block-id level.

**Co-occurrence rule.** A single element CAN carry BOTH `data-prose="<blockId>"`
AND `data-patchable-type="block"`. This is legal and expected. The block atom's
`type` and position-in-`order` are patchable through the DSL (`block-type`,
`block-order`, `block-insert`, `block-delete`) while its inner prose is owned by
Yjs and routes through `revision-variant`. The two systems compose at the block
boundary: the DSL mutates the wrapper, Yjs mutates the contents. See section
`03-drafting` and `04-review` for live examples.

## Conventions

- All path tails are lowercase-kebab. Schema paths are JSON Pointer fragments under
  `/variant/...` (see spec section c).
- `type` is one of: `css-var`, `microcopy`, `visibility`, `animation-scale`,
  `block-type`, `block-order`, `block-insert`, `block-delete`.
- `guard` refers to the validation regex / numeric range / enum applied at L2
  (spec section d).
- All microcopy fields are bounded to ≤ 280 chars (spec section c).
  Heading variants (≤ 200), callout labels (≤ 80) are tighter.
- `data-patchable-type="visible"` marks toggle-visibility surfaces; these emit
  boolean leaves under `/variant/visibility/<key>` (NOT under `/variant/microcopy`).
- Absence of `data-patchable-type` on a `data-patchable` element means microcopy
  (the default). These emit string leaves under `/variant/microcopy/<key>`.
- `data-patchable-type="block"` marks `document-block` atoms whose `type` and
  position-in-`order` can be patched but whose prose is in Yjs.

### Guards

- `colorToken`: matches `^#[0-9a-fA-F]{3,8}$` (3/4/6/8-digit hex) OR an explicit
  CSS named-color allowlist (`black`, `white`, `transparent`, `currentColor`,
  the 16 base CSS colors) OR `rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)`
  with each numeric channel bounded to `[0,255]` and alpha to `[0,1]`. No
  `var()`, `calc()`, `url()`, named-color outside the allowlist, or unknown
  function tokens are accepted.
- `fontFamily`: ≤ 180 chars after trim; bans the substrings `url(`,
  `javascript:`, `data:`, `expression(`, `/*`, `*/`, `\\`; bans control chars
  `U+0000`–`U+001F` (and `U+007F`); only `[A-Za-z0-9 ,_\-'\"]` accepted in the
  body. Quoted family segments must close.
- `cssVar` numeric ranges: see per-token rows below.
- `microcopy` see L2 microcopy guards subsection.

### L2 microcopy guards (applied before any other check)

1. **NFC normalization** on input string.
2. **Reject zero-width / bidi controls / invisible runs:** any code point in
   `U+200B`–`U+200F`, `U+202A`–`U+202E`, `U+2060`–`U+206F`, `U+FEFF`.
3. **Reject control chars** `U+0000`–`U+001F` and `U+007F` except `\n` (U+000A).
4. **Reject markup tokens:** any `<`, `>` or `&...;` entity in the input string
   is rejected at validation time (defence in depth on top of textContent
   rendering); the DSL contract is plain text.
5. **Length cap:** ≤ 280 chars after NFC normalization (or tighter per-field
   cap as noted in each row).

### Forbidden — chrome elements (never patchable)

These elements MUST NOT carry `data-patchable` in any scenario and MUST be
unaffected by any patch application. The L4 DOM smoke check asserts that each
of the following still resolves to a present, attached element after any apply:

- `.topbar` and all descendants
- `.harness-strip` and all descendants
- `.statusbar` and all descendants
- `.lifecycle-ribbon` and all descendants
- `.advance-pill`
- `.scenario-nav` (and the nav-row container)
- `.guide-btn`
- `.fb-trigger`
- `.fb-panel`
- `.id-gear`

A patch whose CSS selector resolves into any of these subtrees is rejected at
L3 (selector resolution) before reaching L4.

## CSS variables (cross-scenario, shared by every mock)

These 25 leaves are defined in `mocks/style.css` `:root` and are read by every
scenario. They are the bulk of the global patch surface; per-scenario microcopy
adds another ~5–10 leaves each.

| CSS var | Schema path | Guard | Default | Notes |
|---|---|---|---|---|
| `--bg` | `/variant/tokens/color/bg` | colorToken | `#0a0a0b` | Workspace background. |
| `--panel` | `/variant/tokens/color/panel` | colorToken | `#131316` | Panel surface. |
| `--panel-2` | `/variant/tokens/color/panel-2` | colorToken | `#1a1a1f` | Inset panel surface. |
| `--border` | `/variant/tokens/color/border` | colorToken | `#26262c` | Default border. |
| `--border-soft` | `/variant/tokens/color/border-soft` | colorToken | `#1f1f25` | Subdued separators. |
| `--text` | `/variant/tokens/color/text` | colorToken | `#ebebef` | Body text. |
| `--text-2` | `/variant/tokens/color/text-2` | colorToken | `#b0b0b8` | Secondary text. |
| `--text-muted` | `/variant/tokens/color/text-muted` | colorToken | `#6a6a74` | Tertiary text / meta. |
| `--accent` | `/variant/tokens/color/accent` | colorToken | `#95e35d` | Brand green. |
| `--accent-soft` | `/variant/tokens/color/accent-soft` | colorToken | `#95e35d22` | Accent fill at low alpha (8-digit hex — uses colorToken's `{8}` branch). |
| `--accent-2` | `/variant/tokens/color/accent-2` | colorToken | `#7a9a6e` | Accent muted. |
| `--vishal` | `/variant/tokens/color/vishal` | colorToken | `#6ba0ff` | Author colour: Vishal. |
| `--akhil` | `/variant/tokens/color/akhil` | colorToken | `#ff8aa8` | Author colour: Akhil. |
| `--warn` | `/variant/tokens/color/warn` | colorToken | `#ffb86b` | Warning / open-tension. |
| `--third` | `/variant/tokens/color/third` | colorToken | `#b58acc` | Third-writer colour. |
| `--code` | `/variant/tokens/typography/code/family` | fontFamily | `'IBM Plex Mono', ...` | Mono stack. |
| `--sans` | `/variant/tokens/typography/sans/family` | fontFamily | `'Inter', ...` | Sans stack. |
| `--serif` | `/variant/tokens/typography/serif/family` | fontFamily | `'Iowan Old Style', ...` | Serif stack (used in reader). |
| `--r` | `/variant/tokens/spacing/radius` | spacing(0–24px) | `8px` | Default radius. |
| `--r-lg` | `/variant/tokens/spacing/radius-lg` | spacing(0–32px) | `14px` | Larger radius. |
| `--row-topbar` | `/variant/tokens/spacing/row-topbar` | spacing(28–80px) | `44px` | App-chrome row 1. |
| `--row-harness` | `/variant/tokens/spacing/row-harness` | spacing(20–48px) | `27px` | App-chrome row 2. |
| `--row-status` | `/variant/tokens/spacing/row-status` | spacing(20–48px) | `28px` | App-chrome row 3. |
| `--typing-speed-ms` | `/variant/styles/cssVars/typing-speed-ms` | int(10,300) | `60` | Drives `[data-typewriter]` engine (synthesised — added as a controllable knob by Phase 4 client). |
| `--anim-scale` | `/variant/styles/animation/global/duration` | float(0.5,2.0) | `1.0` | Multiplier applied by `patch-renderer.js` to all `animation-duration` / `transition-duration` via JS at apply time (no `var()` lookup — see note). |

Note on `--anim-scale`: the existing stylesheet hard-codes durations (e.g.
`pulse 1.6s`, `transition: all 220ms ease`). Rather than refactor every
declaration to reference a CSS var, the Phase 4 renderer multiplies a single
scale token against the computed style. The schema path is still a leaf so the
fingerprint accounts for it; only the application strategy differs.

## Animation scales

| Token | Schema path | Range | Default |
|---|---|---|---|
| global duration multiplier | `/variant/styles/animation/global/duration` | float 0.5–2.0 | 1.0 |
| typing speed (ms / char) | `/variant/styles/cssVars/typing-speed-ms` | int 10–300 | 60 |

## Visibility toggles (cross-scenario)

These are the "panel" toggles a viewer might reasonably want to hide/show. They
attach to wrapper elements via `data-patchable` + `data-patchable-type="visible"`.
Each scenario's visibility keys emit boolean leaves under `/variant/visibility/<key>`.
The per-scenario tables below give the *element selector* + schema path for
each visibility leaf.

---

## Per-scenario surface

### `index.html` (landing)

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `series-kicker` | `/variant/microcopy/series-kicker` | microcopy | ≤ 80 | "doclayer / mocks" | `.index-wrap .series-kicker-row` |
| `series-subtitle` | `/variant/microcopy/series-subtitle` | microcopy | ≤ 200 | "Two writers in their own lanes…" | `.index-wrap .series-subtitle` |
| `series-lede` | `/variant/microcopy/series-lede` | microcopy | ≤ 280 | "A meta-harness for collaborative writing…" | `.index-wrap p.lede` |
| `lifecycle-card-title` | `/variant/microcopy/lifecycle-card-title` | microcopy | ≤ 200 | "The whole lifecycle in one continuous reel." | `.lifecycle-card h3` |
| `lifecycle-card-blurb` | `/variant/microcopy/lifecycle-card-blurb` | microcopy | ≤ 280 | "A series of 4 articles…" | `.lifecycle-card p` |
| `next-strip-body` | `/variant/microcopy/next-strip-body` | microcopy | ≤ 280 | "Dogfooded build with Akhil…" | `.next-strip .body` |
| `next-strip` | `/variant/visibility/next-strip` | visibility | bool | true | `.next-strip` |
| `vs-frame` | `/variant/visibility/vs-frame` | visibility | bool | true | `.vs-frame` |

Prose zones (NOT patchable): `data-prose="index-hero"` on the `<h1>` element
("The doc that *becomes* the reader's harness."). Rewrites route through
`revision-variant`.

Count: 8 (6 microcopy + 2 visibility).

### `00-flow.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `flow-series-card-1` | `/variant/microcopy/flow-series-card-1` | microcopy | ≤ 200 | "What is a harness?" | `.sp-card.c1 .title` |
| `flow-series-card-2` | `/variant/microcopy/flow-series-card-2` | microcopy | ≤ 200 | "Why scaling LLMs doesn't solve it" | `.sp-card.c2 .title` |
| `flow-series-card-3` | `/variant/microcopy/flow-series-card-3` | microcopy | ≤ 200 | "Building meta-harnesses" | `.sp-card.c3 .title` |
| `flow-series-card-4` | `/variant/microcopy/flow-series-card-4` | microcopy | ≤ 200 | "Multiplayer & evals" | `.sp-card.c4 .title` |
| `flow-vishal-section-h` | `/variant/microcopy/flow-vishal-section-h` | microcopy | ≤ 200 | "Recursion as the prior" | `.twoup-shell.vishal h3` |
| `flow-akhil-section-h` | `/variant/microcopy/flow-akhil-section-h` | microcopy | ≤ 200 | "The shape of the ceiling" | `.twoup-shell.akhil h3` |
| `flow-sp-caption-1` | `/variant/microcopy/flow-sp-caption-1` | microcopy | ≤ 280 | "the architect proposed a trajectory · 4 articles · ~6 weeks" | `.sp-caption.cap-sp1` |
| `flow-counter-strip` | `/variant/visibility/flow-counter` | visibility | bool | true | `.flow-counter` |
| `flow-loop-indicator` | `/variant/visibility/flow-loop` | visibility | bool | true | `.loop-indicator` |
| `flow-agent-rail` | `/variant/visibility/flow-agent-rail` | visibility | bool | true | `.agent-rail-ghost` |

Prose zones (NOT patchable): `data-prose="flow-doc"` on the `.doc-title` element
("Meta-harnesses"); `data-prose="flow-editor-body"` on the in-flow draft text
under `.editor-flow`.

Count: 10 (7 microcopy + 3 visibility).

### `01-bootstrap.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `bootstrap-h2` | `/variant/microcopy/bootstrap-h2` | microcopy | ≤ 200 | "What are you writing?" | `.bootstrap-card h2` |
| `bootstrap-sub` | `/variant/microcopy/bootstrap-sub` | microcopy | ≤ 280 | "Four answers. The workspace composes itself around what you're writing." | `.bootstrap-card .sub` |
| `bootstrap-label-title` | `/variant/microcopy/bootstrap-label-title` | microcopy | ≤ 80 | "Title" | `.field:nth-of-type(1) label` |
| `bootstrap-label-coauthors` | `/variant/microcopy/bootstrap-label-coauthors` | microcopy | ≤ 80 | "Co-authors" | `.field:nth-of-type(2) label` |
| `bootstrap-label-audience` | `/variant/microcopy/bootstrap-label-audience` | microcopy | ≤ 80 | "Audience" | `.field:nth-of-type(3) label` |
| `bootstrap-label-output` | `/variant/microcopy/bootstrap-label-output` | microcopy | ≤ 80 | "Output" | `.field:nth-of-type(4) label` |
| `bootstrap-fit-pill` | `/variant/microcopy/bootstrap-fit-pill` | microcopy | ≤ 80 | "audience-fit · 0.86" | `.fit-pill` |
| `bootstrap-evidence-rail` | `/variant/visibility/bootstrap-evidence` | visibility | bool | true | `#stage-harness .panel.slide-left` |
| `bootstrap-tension-section` | `/variant/visibility/bootstrap-tension` | visibility | bool | true | `.bootstrap-tension-section-wrapper` |

Prose zones (NOT patchable): the architect-proposed paragraph
`<p class="fade-up d-4">` and outline items under
`data-prose="bootstrap-editor-body"`.

Count: 9 (7 microcopy + 2 visibility).

### `02-planning.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `planning-vishal-prior` | `/variant/microcopy/planning-vishal-prior` | microcopy | ≤ 80 | "builder · concrete-first" | `.plan-shell.vishal .prior-pill-tag` |
| `planning-akhil-prior` | `/variant/microcopy/planning-akhil-prior` | microcopy | ≤ 80 | "claim-first · evals advocate" | `.plan-shell.akhil .prior-pill-tag` |
| `planning-vishal-layout` | `/variant/microcopy/planning-vishal-layout` | microcopy | ≤ 80 | "editor + evidence rail" | `.plan-shell.vishal .layout-tag b` |
| `planning-akhil-layout` | `/variant/microcopy/planning-akhil-layout` | microcopy | ≤ 80 | "tension rail + editor" | `.plan-shell.akhil .layout-tag b` |
| `planning-gutter-caption` | `/variant/microcopy/planning-gutter-caption` | microcopy | ≤ 280 | "shared outline · shared chain · two harnesses" | `.twoup-gutter-caption` |
| `planning-evidence-pane` | `/variant/visibility/planning-evidence` | visibility | bool | true | `.plan-shell.vishal .evidence-pane` |
| `planning-tension-pane` | `/variant/visibility/planning-tension` | visibility | bool | true | `.plan-shell.akhil .tension-pane` |
| `planning-density-mini` | `/variant/visibility/planning-density` | visibility | bool | true | `.density-mini-akhil` |

Prose zones (NOT patchable): both editors' `<p>` paragraphs under
`data-prose="planning-vishal-body"` and `data-prose="planning-akhil-body"`.

Count: 8 (5 microcopy + 3 visibility).

### `03-drafting.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `drafting-stall-banner` | `/variant/microcopy/drafting-stall-banner` | microcopy | ≤ 280 | "still for 18s — architect drafted 3 continuations in 2 voices." | `.stall-banner > span:nth-child(2)` |
| `drafting-architect-caption` | `/variant/microcopy/drafting-architect-caption` | microcopy | ≤ 280 | "the architect didn't pick \"drafting.\" it picked …" | `.architect-caption` |
| `drafting-variant-v1-label` | `/variant/microcopy/drafting-variant-v1-label` | microcopy | ≤ 80 | "your voice · expansive" | `.variant.v1 .label` |
| `drafting-variant-v2-label` | `/variant/microcopy/drafting-variant-v2-label` | microcopy | ≤ 80 | "akhil's voice · denser" | `.variant.v2 .label` |
| `drafting-variant-v3-label` | `/variant/microcopy/drafting-variant-v3-label` | microcopy | ≤ 80 | "claim-first" | `.variant.v3 .label` |
| `drafting-voice-sampler` | `/variant/visibility/drafting-voice-sampler` | visibility | bool | true | `.voice-sampler-block` |
| `drafting-brainstorm-pad` | `/variant/visibility/drafting-brainstorm` | visibility | bool | true | `.brainstorm-pad` |
| `drafting-density-meter` | `/variant/visibility/drafting-density` | visibility | bool | true | `.density` |
| `drafting-fidelity-block` | `/variant/visibility/drafting-fidelity` | visibility | bool | true | `.fidelity-block` |

Prose zones (NOT patchable): the variant body texts under
`data-prose="drafting-variant-1|2|3"`, and the editor `<p>` under
`data-prose="drafting-editor-body"`. The three `.variant.vN` elements also
carry `data-patchable-type="block"` with stable `data-block-id`
(`drafting-variant-1|2|3`) — co-occurrence rule applies: DSL can change
block-type/order, Yjs owns inner prose.

The previous `drafting-grammar-callout` entry has been removed from the
allowlist — its default referenced the structural identifier `revision-variant`,
which made it a prompt-injection vector for relabelling the grammar. The
element keeps its `.grammar-callout` class but no longer carries
`data-patchable`.

Count: 9 (5 microcopy + 4 visibility). Plus 3 block-level atoms
(`drafting-variant-1|2|3`) — block-id only, type fixed to `paragraph` in v1.

### `04-review.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `review-budget-label` | `/variant/microcopy/review-budget-label` | microcopy | ≤ 80 | "AI suggestion budget" | `.budget .label > span:first-child` |
| `review-chip-1` | `/variant/microcopy/review-chip-1` | microcopy | ≤ 80 | "tighten · \"search space is constrained\"" | `#chip-1` |
| `review-chip-2` | `/variant/microcopy/review-chip-2` | microcopy | ≤ 80 | "add citation · meta-ide grammar" | `#chip-2` |
| `review-chip-3` | `/variant/microcopy/review-chip-3` | microcopy | ≤ 200 | "accept · atoms from a kit → atoms from a *typed* kit" | `#chip-3` |
| `review-chip-4` | `/variant/microcopy/review-chip-4` | microcopy | ≤ 80 | "soften · \"forced to compose\"" | `#chip-4` |
| `review-budget` | `/variant/visibility/review-budget` | visibility | bool | true | `.budget` |
| `review-lesson-card` | `/variant/visibility/review-lesson` | visibility | bool | true | `.lesson-card` |
| `review-approval-gate` | `/variant/visibility/review-approval` | visibility | bool | true | `.timeline` |

Prose zones (NOT patchable): all `<p>` content within `.review-doc .block` is
`data-prose="review-block-<n>"`.

Block atoms (`data-patchable-type="block"`, `data-block-id="review-block-1..5"`):
5 blocks. This is the **only** scenario where `block-type` and `block-order`
are enabled in v1.

Count: 8 (5 microcopy + 3 visibility). Plus 5 block-level atoms.

### `05-publish.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `publish-form-h3` | `/variant/microcopy/publish-form-h3` | microcopy | ≤ 200 | "Ship to a real domain" | `.publish-form > h3` |
| `publish-preflight-head` | `/variant/microcopy/publish-preflight-head` | microcopy | ≤ 80 | "ready to publish" | `.pf-head` |
| `publish-cta` | `/variant/microcopy/publish-cta` | microcopy | ≤ 80 | "Publish ▸" | `#publish-btn` |
| `publish-prior-eng` | `/variant/microcopy/publish-prior-eng` | microcopy | ≤ 80 | "AI engineer" | `#pp-eng` |
| `publish-prior-pm` | `/variant/microcopy/publish-prior-pm` | microcopy | ≤ 80 | "PM" | `#pp-pm` |
| `publish-prior-researcher` | `/variant/microcopy/publish-prior-researcher` | microcopy | ≤ 80 | "researcher" | `#pp-res` |
| `publish-byline` | `/variant/microcopy/publish-byline` | microcopy | ≤ 200 | "Akhil R & Vishal Tandale · 2026 · part 1 of 4" | `.preview-frame .byline` |
| `publish-manifest-expander` | `/variant/visibility/publish-manifest` | visibility | bool | true | `.manifest-expander` |
| `publish-share-row` | `/variant/visibility/publish-share` | visibility | bool | true | `.share-row` |
| `publish-build-seq` | `/variant/visibility/publish-build` | visibility | bool | true | `#build-seq` |

Prose zones (NOT patchable): the three preview-variant `<h2>` + paragraphs
(`#v-eng`, `#v-pm`, `#v-res`) under `data-prose="publish-variant-engineer"`,
`publish-variant-pm`, `publish-variant-researcher`. The architect rebinds these
through `revision-variant` proposals, never through DSL patches.

Count: 10 (7 microcopy + 3 visibility).

### `06-reader-harness.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `reader-pitch` | `/variant/microcopy/reader-pitch` | microcopy | ≤ 280 | "same article. same manifest. three priors…" | `.reader-top .pitch` |
| `reader-prior-label-eng` | `/variant/microcopy/reader-prior-label-eng` | microcopy | ≤ 80 | "AI engineer" | `.prior-pill-rd[data-prior=engineer]` |
| `reader-prior-label-pm` | `/variant/microcopy/reader-prior-label-pm` | microcopy | ≤ 80 | "PM" | `.prior-pill-rd[data-prior=pm]` |
| `reader-prior-label-res` | `/variant/microcopy/reader-prior-label-res` | microcopy | ≤ 80 | "researcher" | `.prior-pill-rd[data-prior=researcher]` |
| `reader-byline` | `/variant/microcopy/reader-byline` | microcopy | ≤ 200 | "Akhil R & Vishal Tandale · 2026 · part 1 of 4" | `.reader-col[data-col="1"] .byline` |
| `reader-intro-h2` | `/variant/microcopy/reader-intro-h2` | microcopy | ≤ 200 | "watch one article re-render for three priors" | `.intro-overlay h2` |
| `reader-grammar-strip` | `/variant/visibility/reader-grammar` | visibility | bool | true | `.prior-bar .grammar` |
| `reader-intro-overlay` | `/variant/visibility/reader-intro` | visibility | bool | true | `.intro-overlay` |

Prose zones (NOT patchable): every `.layer` paragraph and `.layer.head` inside
`.swap-zone` is `data-prose="reader-prior-<engineer|pm|researcher>-<index>"`.

Count: 8 (6 microcopy + 2 visibility).

### `07-multiplayer.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `multiplayer-vishal-prior` | `/variant/microcopy/multiplayer-vishal-prior` | microcopy | ≤ 200 | "builder · concrete-first · multiplayer fanboy" | `.shell.vishal .prior-pill-tag` |
| `multiplayer-akhil-prior` | `/variant/microcopy/multiplayer-akhil-prior` | microcopy | ≤ 200 | "claim-first · evals advocate · dense paragraphs" | `.shell.akhil .prior-pill-tag` |
| `multiplayer-vishal-layout` | `/variant/microcopy/multiplayer-vishal-layout` | microcopy | ≤ 200 | "wide-editor + evidence + voice-mirror" | `.shell.vishal .sub-strip .layout-tag b` |
| `multiplayer-akhil-layout` | `/variant/microcopy/multiplayer-akhil-layout` | microcopy | ≤ 200 | "§1 RLMs framing · claim-first paragraphs" | `.shell.akhil .sub-strip .layout-tag b` |
| `multiplayer-stuck-suggestion` | `/variant/microcopy/multiplayer-stuck-body` | microcopy | ≤ 280 | "stuck on framing? the architect noticed you've been still 4s…" | `.stuck-suggestion .body` |
| `multiplayer-evidence-rail` | `/variant/visibility/multiplayer-evidence` | visibility | bool | true | `.evidence-rail` |
| `multiplayer-voice-mirror` | `/variant/visibility/multiplayer-voice-mirror` | visibility | bool | true | `.voice-mirror` |
| `multiplayer-density-mini` | `/variant/visibility/multiplayer-density` | visibility | bool | true | `.shell.akhil .density-mini` |
| `multiplayer-leftrail` | `/variant/visibility/multiplayer-leftrail` | visibility | bool | true | `.akhil-leftrail` |
| `multiplayer-rightrail` | `/variant/visibility/multiplayer-rightrail` | visibility | bool | true | `.akhil-rightrail` |

Prose zones (NOT patchable): both editor columns under
`data-prose="multiplayer-vishal-body"` and `data-prose="multiplayer-akhil-body"`.

Note: `multiplayer-stuck-suggestion` default text has been rewritten without
embedded `<em>` markup (textContent-only contract).

Count: 10 (5 microcopy + 5 visibility).

### `08-workstream.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `workstream-article-1-audience` | `/variant/microcopy/workstream-article-1-audience` | microcopy | ≤ 80 | "AI engineers" | `.series-card.s1 .audience b` |
| `workstream-article-2-audience` | `/variant/microcopy/workstream-article-2-audience` | microcopy | ≤ 80 | "AI engineers + researchers" | `.series-card.s2 .audience b` |
| `workstream-article-3-audience` | `/variant/microcopy/workstream-article-3-audience` | microcopy | ≤ 80 | "builders" | `.series-card.s3 .audience b` |
| `workstream-article-4-audience` | `/variant/microcopy/workstream-article-4-audience` | microcopy | ≤ 80 | "product + research" | `.series-card.s4 .audience b` |
| `workstream-counter-strip` | `/variant/visibility/workstream-counter` | visibility | bool | true | `.counter-strip` |
| `workstream-agent-rail` | `/variant/visibility/workstream-agent` | visibility | bool | true | `.agents` |

Prose zones (NOT patchable): article titles (`<h4>` on `.series-card.s1..s4`)
now carry `data-prose="workstream-article-1..4"`. These route to
`revision-variant`. Per spec (g), article titles always live in Yjs. The lane
task-card titles ("Drafting article 2 · §3.2 …") with author mentions and
section references are still excluded as prompt-injection risk.

Count: 6 (4 microcopy + 2 visibility).

### `09-review-loop.html`

| key | schema path | type | guard / max | default | selector |
|---|---|---|---|---|---|
| `review-loop-pitch-drafting` | `/variant/microcopy/review-loop-pitch-drafting` | microcopy | ≤ 200 | "wide editor + inline-AI rail" | `.shell.vishal .layout-caption.cap-drafting .layout-tag b` |
| `review-loop-pitch-iterate` | `/variant/microcopy/review-loop-pitch-iterate` | microcopy | ≤ 200 | "iterate mode" | `.shell.vishal .layout-caption.cap-iterate .layout-tag b` |
| `review-loop-toast-body` | `/variant/microcopy/review-loop-toast-body` | microcopy | ≤ 280 | "1 critical · 2 suggestions · *agreed with adversarial*" | `.toast.to-vishal .body` |
| `review-loop-review-banner` | `/variant/microcopy/review-loop-review-banner` | microcopy | ≤ 200 | "harness shifted · review mode · §3.2 from vishal" | `.review-banner` |
| `review-loop-iterate-rail` | `/variant/visibility/review-loop-iterate-rail` | visibility | bool | true | `.vishal-iterate-rail` |
| `review-loop-inline-rail` | `/variant/visibility/review-loop-inline-rail` | visibility | bool | true | `.vishal-inline-rail` |
| `review-loop-akhil-leftrail` | `/variant/visibility/review-loop-akhil-leftrail` | visibility | bool | true | `.shell.akhil .akhil-leftrail` |
| `review-loop-toast-visible` | `/variant/visibility/review-loop-toast` | visibility | bool | true | `.toast.to-vishal` |
| `review-loop-min-strip` | `/variant/visibility/review-loop-min-strip` | visibility | bool | true | `.min-strip` |

Prose zones (NOT patchable): the §3.2 chassis paragraphs (Vishal's editor body)
and Akhil's §1 drafting body both carry `data-prose` markers.

Count: 9 (4 microcopy + 5 visibility). Note: `review-loop-toast-visible` is
documented here (was previously an untracked overtag in the HTML).

---

## Block-level patches (cross-scenario)

`document-block` atoms in the spec section (f) — the only block-typed surface in
v1 — appear in scenarios that render an editor body. We tag the *outer wrapper*
elements that compose a logical block with `data-patchable-type="block"` and a
stable `data-block-id`. The DSL's `insert_block` / `delete_block` envelope
macros target these:

| Scenario | Block wrapper selector | Block IDs available |
|---|---|---|
| 02-planning | `.plan-pane.editor-pane .editor > *` | none in v1 (prose owned by Yjs sub-doc, not block-mintable from mocks) |
| 03-drafting | `.variant.v1\|v2\|v3` | `drafting-variant-1`, `drafting-variant-2`, `drafting-variant-3` |
| 04-review | `.review-doc .block` | `review-block-1` … `review-block-5` |

For v1, **block-type changes and reorders are only enabled in `04-review.html`**
(the most natural place for a viewer to want to reorder or demote a block).
Other scenarios mark `data-block-id` for future-proofing but their `type` is
fixed to `paragraph` and not in the allowlist for type-changes until a later
schema version.

The co-occurrence rule (see top): in `03-drafting`, the three `.variant.vN`
elements carry BOTH `data-prose="drafting-variant-N"` AND
`data-patchable-type="block"` with `data-block-id="drafting-variant-N"`. Block
operations affect the wrapper; prose flows through Yjs/revision-variant.

---

## Summary

**Per-scenario `data-patchable=` counts (verified against live HTML):**

| Scenario | Microcopy | Visibility | Total patchable | Prose-zone blocks | Block atoms |
|---|---:|---:|---:|---:|---:|
| index | 6 | 2 | 8 | 1 (`index-hero`) | 0 |
| 00-flow | 7 | 3 | 10 | 2 (`flow-doc`, `flow-editor-body`) | 0 |
| 01-bootstrap | 7 | 2 | 9 | 1 (`bootstrap-editor-body`) | 0 |
| 02-planning | 5 | 3 | 8 | 2 (`planning-vishal-body`, `planning-akhil-body`) | 0 |
| 03-drafting | 5 | 4 | 9 | 4 (`drafting-editor-body`, `drafting-variant-1..3`) | 3 |
| 04-review | 5 | 3 | 8 | 5 (`review-block-1..5`) | 5 |
| 05-publish | 7 | 3 | 10 | 3 (`publish-variant-engineer\|pm\|researcher`) | 0 |
| 06-reader-harness | 6 | 2 | 8 | many (`reader-prior-*`) | 0 |
| 07-multiplayer | 5 | 5 | 10 | 2 (`multiplayer-vishal-body`, `multiplayer-akhil-body`) | 0 |
| 08-workstream | 4 | 2 | 6 | 4 (`workstream-article-1..4`) | 0 |
| 09-review-loop | 4 | 5 | 9 | 2 (`vishal-32-body`, `akhil-1-body`) | 0 |
| **Per-scenario totals** | **61** | **34** | **95** | — | **8** |

**Schema-fingerprint leaves:**

| Type | Count |
|---|---:|
| CSS variables (cross-scenario) | 25 |
| Animation scales | 2 |
| Microcopy keys (per-scenario sum) | 61 |
| Visibility toggles (per-scenario sum) | 34 |
| Block-type/order atoms (review only is type-mutable; drafting variants are block-id-only) | 5 |
| **Total leaves in fp input** | **127** |

(25 + 2 + 61 + 34 + 5 = 127.) The 3 drafting block atoms have a fixed `type`
in v1, so they contribute to the path enumeration but not to the type-mutable
leaf count; only the 5 review blocks are counted in the fingerprint as
type-mutable.

**Borderline calls (excluded):**

- Lane-task titles in `08-workstream` ("Drafting article 2 · §3.2 — RLMs
  framing") — these *look* like microcopy but they reference structural
  identifiers (`§3.2`) and author handles; allowing rewrites here is a
  prompt-injection vector for relabelling work. Excluded.
- `drafting-grammar-callout` — same reason; its default referenced the
  structural identifier `revision-variant`. Removed in this revision.
- Avatar initials (`V`, `A`) — identity-adjacent, excluded.
- `chain · DOC_*` tokens in the harness-strip — these are part of the chain
  runtime identity, not UX. Excluded.
- Reader column `<h1>` ("What is a harness?") in 06 — that's the *article
  title* and lives in Yjs. Routed to revision-variant.
- Cursor / avatar dot positions — purely live-state, not declarative manifest.
- Inline `style="…"` attributes throughout — already a mess (see flag below);
  excluded from v1 surface.
- All chrome elements per the "Forbidden — chrome elements" subsection above.

**Inconsistencies in the existing mocks (flag for cleanup before schema lock):**

1. Massive use of inline `style="…"` attributes especially in `08-workstream`
   and `09-review-loop` — should migrate to class-based styling so that CSS
   variable changes actually propagate. Today, a `--accent` patch won't reach
   text whose colour is set via `style="color:#95e35d"`.
2. Three subtly-different "lifecycle ribbon" components across scenarios
   (`lcr-step done`, `lcr-step current`, `lcr-step current series`,
   `lcr-step current loop`) — should consolidate.
3. Hardcoded colours in `index.html`'s `<style>` block (`#0d1a08`, `#1a0d12`,
   `rgba(149,227,93,0.06)`) shadow the `--accent` token. Patches to the token
   won't visibly affect those gradients.
4. Several scenarios use both `.fb-trigger` (feedback widget) and
   scenario-local comment markers (`.toast.to-vishal`, etc.) — overlapping UX
   concepts. Patching one doesn't affect the other.
5. `--anim-scale` doesn't exist in the stylesheet today; the Phase 4 client
   computes it in JS. That's documented above but should land as a CSS var
   declaration before Phase 2 hashes the schema.
