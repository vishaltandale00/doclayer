---
name: autoresearch
description: Run a recursive research loop on a design or research question. Spawns N parallel subagents per round, judges candidates, decides convergence, synthesizes a cited final answer. Use for design decisions where the space is wide and you want systematic exploration instead of vibes.
---

# autoresearch

A goal-directed iterative loop that fuses Karpathy's keep/discard discipline, Anthropic's parallel-subagent orchestration, STORM's perspective diversity, and GPT-Researcher's depth/breadth caps.

## When to use

- Choosing between competing design options where the tradeoffs aren't obvious
- Researching a fast-moving space where you don't trust a single AI summary
- Validating a design choice against the state of the art
- Any question where you'd otherwise just "pick whatever feels right"

**Don't use** for: questions with one obvious answer, questions a single web search resolves, questions where you already know the answer and want validation (you won't get unbiased loops).

## The loop

```
0. rubric: planner agent produces criteria + weights + target_score from the question
1. PROPOSE: N parallel subagents (each with a perspective: pragmatist/skeptic/historian/synthesizer/contrarian)
2. JUDGE: one judge agent re-scores candidates, ranks top-5
3. CONVERGE: terminator decides STOP or CONTINUE with a refined question
4. (if continue) loop back to 1
5. SYNTHESIZE: final agent produces a cited Markdown answer
```

Defaults: N=4 subagents per round, max_rounds=4, target_score=8.5/10, epsilon=0.3 (marginal-gain), top_k_seeded=2.

## Convergence heuristics (any one triggers STOP)

1. Top candidate weighted_total >= target_score
2. Top score didn't improve by epsilon for 2 consecutive rounds (diminishing returns)
3. Round's candidates highly similar to prior round AND no new evidence URLs (exploration exhausted)
4. round >= max_rounds (hard budget)
5. Refined question hashes to near-duplicate of earlier round's question (mirror-loop guard)

## Output structure

Each run writes to `scripts/autoresearch/runs/<slug>/`:
- `question.txt` — current/refined question
- `rubric.json` — criteria + weights + target_score
- `round-N/candidates.json` — proposer outputs
- `round-N/judge.json` — judge's rankings
- `evidence.jsonl` — append-only claim/url/quote tuples
- `winners.json` — top-5 candidates carried forward
- `final.md` — synthesized cited answer (only after STOP)

## Two ways to run

### Shape A — In-session via the Task tool (recommended)

From Claude Code, with the project loaded:

> Run `/autoresearch` on the question "Q". Defaults are fine.

The harness spawns Task subagents in parallel using the prompts in `scripts/autoresearch/prompts/`. Writes state to disk under `runs/<slug>/`. This is the form most aligned with how doclayer's existing skills (architect, feedback widget) work.

### Shape B — External Bash orchestrator (overnight / outside Claude Code)

Use `scripts/autoresearch/autoresearch.sh` (see file). Spawns fresh `claude -p` processes per phase per round, uses `&` + `wait` for parallel proposers, pipes JSON between phases. Heavier but cleaner state isolation.

```bash
scripts/autoresearch/autoresearch.sh "your question" runs/my-question
```

Requires `claude` CLI authenticated locally and `jq` for JSON munging.

## Prompts

Live in `scripts/autoresearch/prompts/`:
- `proposer.md` — given perspective + rubric, propose ONE candidate
- `judge.md` — re-score candidates, harsher than proposers
- `converge.md` — STOP / CONTINUE decision
- `synthesizer.md` — final cited answer

Edit these per-domain if needed. Don't rewrite the structure — change the voice.

## Anti-patterns

- Don't run with N=1. Single perspective = single bias. Min N=3.
- Don't set target_score=10. Loop will never converge. 8-9 is realistic.
- Don't skip the rubric phase. Without explicit criteria, judge can't be a critic.
- Don't pass full proposer transcripts forward. Always compress to {candidate, scores, gaps}. Otherwise context blows up at round 2.
- Don't trust the loop for ethics, security, or anything requiring real-world consequence reasoning. Use humans.

## Reference architecture sources

- karpathy/autoresearch (Mar 2026) — the keep/discard loop
- Anthropic's multi-agent research system — orchestrator-worker, perspective diversity, citation agent
- Stanford STORM — perspective-diversity-driven convergence
- GPT Researcher Deep Research Mode — recursive tree with depth/breadth caps
- "Mirror Loop" (arXiv 2510.21861) — anti-loop guard for recursive non-convergence

## First run target

Use this on doclayer's open design questions:
1. "What's the best patch DSL for doclayer's harness variant system, given safety + expressiveness + Supabase-queryability constraints?"
2. "How should architect-proposed patches be validated client-side before application?"
3. "What's the right shape for cross-variant comparison views?"
