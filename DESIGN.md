# doclayer

A meta-harness for collaborative writing. The editor reshapes itself per phase, per author, and per task. The published artifact is itself a reader-harness that adapts to each reader's prior knowledge.

---

## Premise

Most writing tools are fixed shells. Google Docs, Notion, Substack: same surface for planning, drafting, reviewing, publishing. AI features bolt on as a sidecar (Lex, Notion AI, Claude-in-doc): the shell stays static, the model slots in.

doclayer flips that. The *interface itself* is authored per phase by an LLM (the Architect, ported from meta-ide), constrained to a typed grammar of document atoms. Planning looks like a research scratchpad with two cursors and an outline tree. Drafting collapses into an editor with a voice sampler and a stuck-loop sidekick. Review becomes a diff view with dismissible AI suggestions. Publish becomes a preview of the reader-harness that ships.

And the killer move: when you publish, the published page is itself a meta-harness. A reader self-identifies (or the harness infers from priors) — software engineer with code background, PM thinking about product, AI researcher — and the article re-renders. Code examples expand or collapse. Analogies swap. The same artifact is many articles.

This is the proof that meta-harnesses generalize past code, and is also the distribution flywheel: every published doclayer post is itself a doclayer demo.

---

## Wedge

A single first user pair: Vishal + Akhil writing the meta-harness article series, target audience: AI engineers and builders. Dogfooded end-to-end. The published series is the marketing.

Concretely v1 covers: blank workspace → planned article → drafted article → reviewed article → published reader-harness on a real domain (e.g. `raw.works/posts/<slug>` or `doclayer.live/<slug>`).

Two authors. One artifact. Five phase manifests. One reader experience. Nothing more for v1.

---

## What gets reused vs. built fresh

### From Relayer (`~/ProjectsDev/Relayer`)

| Primitive | File reference | Reuse plan |
| --- | --- | --- |
| Chain runtime (state machines for tasks) | `AgenticEnvironment/src/graph_contract/chain_runtime.py` | Fork. Replace `WORKSPACE_BUILD` family with `DOCUMENT_*` families: `PLAN`, `DRAFT`, `REVIEW`, `PUBLISH`. |
| Graph-as-state + delta merge | `AgenticEnvironment/src/services/pipeline/graph_state.py:62-79`, `packages/graph-contract/src/graphMerge.ts` | Reuse intact. The "doc workspace" is a graph; nodes are sections, comments, decisions, citations. |
| WebSocket transport + handler pattern | `demo2/src/contexts/WebSocketContext.tsx`, `AgenticEnvironment/src/api/websocket/handlers/` | Reuse intact. Add a `presence` channel and a `yjs-sync` channel. |
| Memory (FAISS semantic search) | `AgenticEnvironment/src/services/memory_store.py:79-100` | Reuse. Index three corpora: per-author voice samples, per-doc evidence (links shared in chat, prior drafts), reader priors. |
| Deploy pipeline | `backend/models/workspace_deploy.py`, `services/workspace_deploy_service.py` | Fork. Code-deploy becomes article-publish: render → static bundle → CDN → reader-harness JS shell. |
| UI contract resolution (capability/plugin negotiation) | `AgenticEnvironment/src/graph_contract/ui_contract.py:1-52` | Reuse. The "writing" plugin extends the contract with rich-text and CRDT capabilities. |

### From meta-ide (`~/ProjectsDev/meta-ide`)

| Primitive | File reference | Reuse plan |
| --- | --- | --- |
| Architect (LLM that emits typed UI manifests) | `src/harness/architect.ts:58-100` | Fork. Replace IDE grammar with document grammar (see below). Prompt variants per phase. |
| Manifest renderer | `src/ui/Renderer.tsx:1-85` | Reuse. The walker is generic; new node types register via the binding engine. |
| Harness state machine | `src/harness/store.ts:1-40` | Reuse: `idle → style → planning → investigating → authoring → ready`. Add `yjs-sync` and `publish` states. |
| B-axis feedback (dismiss/pin → preference summary) | `src/harness/store.ts:65-84` | Reuse. Pinned panels persist across refines per author. |
| Lesson memory (curator-approved durable rules) | `src/memory/store.ts:1-50` | Reuse. Lessons become voice/style rules: "Akhil prefers denser, claim-first paragraphs; surface a density meter when he's drafting." |
| Trace log (typed event stream) | `src/trace/client.ts:26-35` | Reuse. Every harness mutation, every author edit, every comment is a trace event. Powers replay + offline eval. |
| Bounded grammar of UI atoms | `src/ui/grammar.ts:1-70` | Replace, see below. |

### Built fresh

1. **Document grammar** — typed manifest node kinds for writing:
   `document-block`, `outline-tree`, `voice-sampler`, `comment-thread`, `citation-card`, `evidence-panel`, `tension-tracker`, `revision-variant`, `density-meter`, `phase-tab`, `reader-prior-picker`, `evolving-explainer`. Strict schema, validated like meta-ide's grammar.

2. **CRDT layer (Yjs + ProseMirror)** — multiplayer editing inside `document-block` nodes. Each block is a Yjs sub-doc. Presence (cursors, selections, names) over WebSocket. Merge resolution is CRDT-native; harness manifest changes are merged via Relayer's delta logic on top.

3. **Reader-harness shell** — static export per published article + a thin JS runtime that loads the article's published manifest, asks the reader to identify (or infers from referrer/priors), and re-renders the manifest with that prior bound in. Same Renderer, different bindings.

4. **Author priors store** — per-author profile derived from voice samples, prior drafts, and explicit lessons. Used to score Architect output ("would Akhil pin or dismiss this layout?").

5. **Publish pipeline (article-flavored)** — markdown export, OG image generation, RSS, custom domain, reader-harness bundle attached. Fork of Relayer's deploy service.

---

## Document grammar (proposed)

Strictly typed; Architect cannot emit raw HTML.

```ts
type Node =
  | { kind: "phase-tab"; phase: "plan" | "draft" | "review" | "publish"; active: boolean }
  | { kind: "outline-tree"; items: OutlineItem[]; allowReorder: boolean }
  | { kind: "document-block"; blockId: string; yjsSubdoc: string; emphasis?: Emphasis }
  | { kind: "comment-thread"; anchorBlockId: string; comments: Comment[] }
  | { kind: "voice-sampler"; authorId: string; samples: TextSnippet[] }
  | { kind: "evidence-panel"; sources: Source[]; query?: string }
  | { kind: "citation-card"; sourceId: string; pinned: boolean }
  | { kind: "tension-tracker"; tensions: Tension[] }       // open disagreements between authors
  | { kind: "density-meter"; targetClaims: number; current: number }
  | { kind: "revision-variant"; variants: { label: string; text: string }[] }
  | { kind: "evolving-explainer"; topic: string; readerPrior: ReaderPrior; depth: 1|2|3 }
  | { kind: "reader-prior-picker"; presets: ReaderPrior[] };  // reader-only

type Manifest = { phase: Phase; root: Node[]; meta: { docId; authors; updatedAt } };
```

The Architect emits one Manifest per phase per refine. The Renderer walks it. Pin/dismiss feedback survives refines.

---

## Phase manifests (the five harnesses)

These are not five fixed templates. They are reference shapes — the layouts the Architect *tends* to compose when the session lands in each phase. Phase is only a coarse starting point; the actual manifest is authored per session, conditioned on the authors' priors and the current micro-task, and re-authored every time the micro-task changes.

Two co-authors on the same doc see *different* manifests. Akhil's PLAN harness leans dense and claim-first (his pinned `density-meter` survives every refine, his lesson memory surfaces "tension first" rules); Vishal's PLAN harness on the same doc reads wider, with more `evidence-panel` real estate and softer pacing. Same graph underneath, different chrome on top.

Within a phase, the manifest reshapes as the micro-task shifts. A DRAFT session might walk: drafting → framing-stuck (the harness collapses the editor and surfaces a `revision-variant` triad and a fresh `tension-tracker`) → brainstorm-scratchpad (the editor re-expands as a free-form scratch with the outline pinned ghost-style) → drafting (back to full-bleed). Same phase, four manifests, no template switch — just the Architect re-authoring against the new micro-task.

The five sections below describe the *typical* shape per phase. Read them as exemplars, not as the menu.

### 1. Bootstrap
A single `intent-form`-equivalent: title, audience, co-authors, deadline. Architect emits a tiny manifest: `[reader-prior-picker (audience target)] [outline-tree (auto-suggested)] [tension-tracker (empty)]`. After 30 seconds of input, harness transitions to PLAN phase.

### 2. Plan
Wide layout. Center: `outline-tree` with drag-reorder. Right: `evidence-panel` populated by the chat URLs both authors shared (the harness scrapes pasted Twitter/Substack/Docs links and indexes them in MemoryStore). Bottom: `tension-tracker` showing open disagreements ("Akhil thinks online vs offline harness is overcomplication; Vishal thinks it's recursive — unresolved"). Two live cursors. Lesson memory surfaces voice rules. Pinned panels persist.

### 3. Draft
Center: full-bleed `document-block` with ProseMirror. Right rail: `voice-sampler` showing recent paragraphs from each author (so the second author can mirror voice). `density-meter` floats: target claims/paragraph (e.g. Akhil's preference: 3+; Vishal's: 1.5). When a writer stalls (no edits 30s) the harness offers an inline `revision-variant` of the current paragraph in three voices. Comments anchor to blocks.

### 4. Review
Split view. Left: clean read. Right: `tension-tracker` consolidated, `comment-thread`s grouped by block. AI suggestions from a Relayer `REVIEW` chain appear as dismissible chips inside blocks; dismiss feedback flows back to lesson memory. Approval signals (per-block green check) gate the PUBLISH phase.

### 5. Publish
Center: live preview of the reader-harness experience with a `reader-prior-picker` so authors can simulate "engineer", "PM", "researcher" reads side-by-side. Below: deploy panel — domain, slug, RSS, OG image. One button: ship.

### 6. Reader (post-publish, on the public domain)
Top: `reader-prior-picker` with three presets + "ask me a few questions". Center: the manifest re-renders with reader prior bound. `evolving-explainer` nodes deepen or collapse. `revision-variant` nodes pick the variant for that prior. Below the article: a `comment-thread` rooted at the doc — readers comment, future readers' priors are influenced. Optional: footer CTA "this article was written in doclayer — want to write yours?"

---

## Multiplayer harness

The naive read of "personalized harness" is single-player: each user gets a bespoke editor. doclayer is multiplayer-first, and the architecture splits cleanly along that seam.

**Shared underneath.** The doc is one CRDT-merged artifact (Yjs sub-docs per `document-block`). The chain runtime is a single instance per doc — PLAN/DRAFT/REVIEW/PUBLISH state machines tick once, not once per author. The graph (sections, comments, decisions, citations, tensions) is one delta-merged structure. Evidence corpus, citation cards, comment threads, tension-tracker entries — all shared. There is exactly one source of truth for the doc's *content and structure*.

**Personalized on top.** The manifest is authored per author. The Architect runs once per author per refine, conditioned on that author's prior (voice samples, pinned panels, dismissed suggestions, lesson memory). Lessons are user-scoped: Akhil's "denser, claim-first" rule never leaks into Vishal's harness; Vishal's "show me framing tensions before density" rule never leaks into Akhil's. Pin/dismiss feedback is per-author. The Renderer walks each author's manifest independently against the shared graph.

**Events propagate without forcing UI parity.** Yjs ops flow over the shared sync channel — every keystroke lands in both authors' `document-block`s regardless of how either harness presents that block. Presence (cursors, selections, names) shows on both sides. Comments, citations, tension-tracker entries, approval signals — all shared graph mutations, both authors see them. But *how* they're surfaced differs: one author may see a fresh tension as a foregrounded `tension-tracker` row; the other may see it inlined as a chip on the relevant block. Same event, two harnesses, two renderings.

The pitch: *two co-authors with the same doc see two different harnesses, and that's the point.* Voice, pacing, attention budget, surfacing rules — all author-shaped. The artifact is shared; the harness is yours.

---

## Workstream & agent orchestration

The doc is not the unit of collaboration. The *artifact-trajectory* is — a series of pieces (article 1, article 2, the cross-cutting essay, the launch post) that the harness rolls out together. The harness generates the trajectory, then distributes writing work across users. Two people in one paragraph is the rare moment, not the steady state.

**Both authors are writers.** Akhil and Vishal are full writers — not a writer-and-researcher pair, not a writer-and-reviewer pair. Each works out of their own task queue, drafting different sections of different articles in parallel. Vishal might be writing the wedge essay while Akhil writes §1 of article 2; tomorrow they swap to other sections. Lanes distribute *writing work* (which section, which article), not *activities* (one researches, the other writes). Tasks have states — `drafting`, `blocked · awaiting research`, `awaiting review`, `addressing critique`, `approving visual` — and the lane shows what's actionable now.

**Cross-reviews and comments are the only human-to-human routing.** When Vishal finishes a section, the harness routes it to Akhil's queue as a review task; Akhil's comments land in Vishal's queue as `address review` tasks. Symmetric in the other direction. Authors never hand each other "research" — they hand each other *drafts to react to*.

**AI agents augment each writer's own work.** Every writer's draft is served by all three agents, in parallel, into that writer's own queue. Nobody waits on a human collaborator for evidence, critique, or visuals.

- **Research agent** — delivers relevant prior writing, web sources, and conversation threads *to the writer who needs them*. Unblocks `blocked · awaiting research` in the originating queue. (The other human is never the source of research.)
- **Adversarial agent** — generates counter-arguments and weak-spot critiques on a writer's own draft and surfaces them in that writer's own queue as `address adversarial: …` tasks.
- **Visual agent** — produces OG cards, frames, diagrams for the section the writer is drafting; `approve visual` lands in that writer's queue.

**The harness arranges.** When a writer is stalled, surface research. When a section draft lands, route it to the other writer as a *review*. When a section needs visual grounding, fire the visual agent into that writer's lane. Each writer always works on what's most productive given the trajectory state — not on whatever they last had open.

**Anti-pattern:** dividing the labor of writing into roles — one person becomes "the researcher," the other "the reviewer," and only one of them is really an author. doclayer rejects this. Both are writers on different pieces; agents handle research/critique/visuals; the only thing crossing between humans is review and comment traffic. Scenario 07 is the in-the-moment two-up; scenario 08 is the steady state.

*The harness arranges the work, then arranges the surface around it.*

---

## Architecture

```
[Browser — Author]
  Editor (ProseMirror + Yjs CRDT)
  Renderer (manifest walker, ported from meta-ide)
  Presence (cursors, names)
  Trace client (typed events)
            ↕ WebSocket
[Backend]
  Yjs sync server (per doc-block)
  Chain Runtime (fork of Relayer; DOC_PLAN/DRAFT/REVIEW/PUBLISH families)
  Architect LLM (fork of meta-ide; emits Manifest per phase)
  Memory:
    - per-author voice corpus (FAISS)
    - per-doc evidence corpus (FAISS)
    - lesson store (durable rules, curator-approved)
  Publish pipeline → static bundle + reader-harness JS

[Browser — Reader, post-publish]
  Reader-harness JS shell
  Manifest (frozen at publish time)
  Renderer (subset; read-only bindings)
  Reader-prior store (cookie + optional account)
```

Same Renderer in author and reader contexts. Only the bindings differ (read-only in reader, no Architect calls live, but a small static lookup re-binds `evolving-explainer` and `revision-variant` nodes by prior).

---

## Scope discipline (what v1 is NOT)

- Not multi-doc workspaces. One doc = one workspace.
- Not >2 authors. Two cursors only. (Akhil + Vishal is the wedge.)
- No autonomous agents writing whole sections. AI emits suggestions; authors accept/dismiss.
- No version branching beyond linear history. Yjs handles concurrent edits; no explicit branches.
- No third-party publishing integrations (Medium, Ghost). Just `doclayer.live/<slug>` or a custom domain CNAME.
- No org accounts. Personal sign-in only.
- No mobile. Desktop browser only.

If we hold this scope, v1 is shippable in ~6 weeks, and the dogfood loop (Vishal + Akhil writing the article in doclayer) starts in week 2 with a partial harness.

---

## Build sequence

1. **Week 1**: Fork Relayer chain runtime; strip code-build chains; add `DOC_PLAN/DRAFT/REVIEW` skeletons. Fork meta-ide Renderer + Architect; replace grammar with document grammar. Empty manifests render. No editor yet.
2. **Week 2**: Yjs + ProseMirror in `document-block`. Two-cursor presence. Author can type collaboratively in a single block. No phase logic yet — but Vishal + Akhil can start the meta-harness article here.
3. **Week 3**: Architect emits PLAN-phase manifest. `outline-tree`, `evidence-panel` (URL scraping into FAISS), `tension-tracker`. Pin/dismiss feedback wired.
4. **Week 4**: DRAFT-phase manifest. `voice-sampler`, `density-meter`, `revision-variant` on stall. Lesson memory: per-author voice rules.
5. **Week 5**: REVIEW-phase manifest + AI suggestion chips. Approval gates.
6. **Week 6**: PUBLISH pipeline. Static bundle + reader-harness JS shell. `reader-prior-picker` + `evolving-explainer` re-binding. Deploy to `doclayer.live`.

Article ships in week 6 as the launch. Series continues through dogfooding.

---

## Why this is the right shape

- **Generalization claim**: meta-harnesses for non-code tasks. doclayer is one data point; Relayer is the other. Same primitives.
- **Distribution flywheel**: every published doclayer article is a live demo of the reader-harness. Built-in viral surface.
- **Tight scope**: two authors, one doc, five manifests. Achievable.
- **Dogfooded**: the first article is *about* meta-harnesses, *written in* a meta-harness, *published as* a meta-harness. The medium proves the message.
- **Reuses 70%+ of existing code**: chain runtime, renderer, memory, deploy. Net new: Yjs layer, document grammar, reader-harness shell, publish pipeline.

---

## Open questions

1. Reader-harness manifest at publish time: frozen snapshot, or does it re-call Architect on demand at read time? Frozen is safer for v1; on-demand is more interesting long-term.
2. Reader prior inference: explicit picker only, or sniff referrer / past visits? v1: explicit only.
3. Memory boundary across docs: per-author voice rules — do they leak across docs the author writes? Default: yes (it's the author's voice). Per-doc evidence corpus: scoped to doc.
4. CRDT + manifest interaction: if Architect refines the manifest mid-edit, do we lose unflushed Yjs ops? Need a "manifest refine waits for sync barrier" rule.
5. Pricing & gating: free for v1; paywall the custom-domain publishing later.

---

## Mocks

See `mocks/index.html` for the animated scenario walkthrough. Six scenarios:

1. **Bootstrap** — blank workspace → first manifest
2. **Planning** — two-cursor outlining with evidence panel and tension tracker
3. **Drafting** — voice sampler, density meter, revision variants on stall
4. **Review** — diff + dismissible AI suggestions
5. **Publish** — reader-harness preview + deploy
6. **Reader harness** — the published article adapting to three different reader priors

Each mock animates the key transition for that phase. Open `mocks/index.html` and let it auto-play.
