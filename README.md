# doclayer

A meta-harness for collaborative writing. The editor reshapes itself per phase, per author, and per task. The published artifact is itself a reader-harness that adapts to each reader's prior knowledge.

> *Most writing tools are fixed shells. doclayer flips that — the interface itself is authored per session by an LLM (the Architect), constrained to a typed grammar of document atoms.*

This repo contains the design doc and a suite of animated HTML mocks demonstrating the full collaboration lifecycle: trajectory generation → task distribution across writer lanes → parallel work with AI-augmented inline annotations → cross-author review loops → publish → reader-harness.

## Live demo

Hosted on Vercel — open `index.html` to start. Recommended viewing order:

1. **Lifecycle reel** (`00-flow.html`) — ~2 min end-to-end playthrough
2. **Review loop** (`09-review-loop.html`) — the protocol in 30s
3. **Multiplayer two-up** (`07-multiplayer.html`) — in-the-moment side-by-side view
4. **Workstream** (`08-workstream.html`) — canonical lanes view
5. **Single-author slices** (`01`–`05`) — phase detail
6. **Reader-harness** (`06-reader-harness.html`) — what ships

A walkthrough/explainer lives at `guide.html`. Every scenario also has a toggleable narration panel (bottom-left `? guide` button).

## Architecture

See [`DESIGN.md`](./DESIGN.md) for the full design, including:

- The meta-harness premise and wedge
- Reuse plan from [Relayer](https://github.com/vishaltandale00/Relayer) and meta-ide (~70%)
- Document grammar and phase manifests
- Multiplayer harness model (shared state + per-author surface, cross-collab via reviews/comments, AI agents per writer)
- Workstream & agent orchestration
- 6-week v1 build sequence

## Built

Static HTML + CSS animations + small inline JS (no build step, no deps beyond Google Fonts). Each scenario is a self-contained file. Shared design tokens in `mocks/style.css`. A character-by-character typing engine drives the live-author moments. A guide overlay system narrates each scenario beat-by-beat.

## Status

Mocks. The product is in design; v1 build is the next step.

## Author

[Vishal Tandale](mailto:vishalt2000@gmail.com) — also building [Relayer](https://github.com/vishaltandale00/Relayer).
