#!/usr/bin/env bash
# autoresearch — recursive research loop, Shape B (external orchestrator)
#
# Usage: autoresearch.sh "question" <out_dir> [--n=4] [--max-rounds=4] [--target=8.5]
#
# Requires: claude CLI authenticated, jq

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 \"question\" <out_dir> [--n=4] [--max-rounds=4] [--target=8.5]"
  exit 1
fi

QUESTION="$1"
OUT="$2"
shift 2

N=4
MAX_ROUNDS=4
TARGET=8.5
EPSILON=0.3

for arg in "$@"; do
  case "$arg" in
    --n=*)          N="${arg#*=}";;
    --max-rounds=*) MAX_ROUNDS="${arg#*=}";;
    --target=*)     TARGET="${arg#*=}";;
    --epsilon=*)    EPSILON="${arg#*=}";;
  esac
done

PROMPTS_DIR="$(cd "$(dirname "$0")" && pwd)/prompts"
mkdir -p "$OUT"
echo "$QUESTION" > "$OUT/question.txt"
: > "$OUT/evidence.jsonl"
PREV_TOP=0
PERSPECTIVES=("pragmatist" "skeptic" "historian" "synthesizer" "contrarian")

echo "▶ autoresearch starting"
echo "  question: $QUESTION"
echo "  out:      $OUT"
echo "  N:        $N  max_rounds: $MAX_ROUNDS  target: $TARGET"

# Phase 0: rubric
echo "▶ round 0 — building rubric"
claude -p "$(cat "$PROMPTS_DIR/proposer.md")

QUESTION: $QUESTION

You are NOT proposing a candidate this turn. Instead, produce a rubric:
{
  \"criteria\": [\"<criterion>\", ...],
  \"weights\":  { \"<criterion>\": <0-1>, ... },
  \"target_score\": <number, default $TARGET>,
  \"notes\": \"<short justification>\"
}
Output JSON only." --output-format text > "$OUT/rubric.json" || {
  echo "rubric generation failed" >&2
  exit 1
}
echo "  rubric.json written"

for round in $(seq 1 "$MAX_ROUNDS"); do
  echo "▶ round $round"
  RDIR="$OUT/round-$round"
  mkdir -p "$RDIR"

  # Phase 1: N parallel proposers
  for i in $(seq 1 "$N"); do
    PERSP="${PERSPECTIVES[$((i-1))]}"
    PRIOR_WINNERS="[]"
    [ -f "$OUT/winners.json" ] && PRIOR_WINNERS="$(cat "$OUT/winners.json")"
    EVIDENCE="$(cat "$OUT/evidence.jsonl" | jq -s . 2>/dev/null || echo '[]')"

    (
      claude -p "$(cat "$PROMPTS_DIR/proposer.md")

QUESTION: $(cat "$OUT/question.txt")

RUBRIC: $(cat "$OUT/rubric.json")

PERSPECTIVE: $PERSP

PRIOR_WINNERS: $PRIOR_WINNERS

PRIOR_EVIDENCE: $EVIDENCE" --output-format text > "$RDIR/cand-$i.json" 2>"$RDIR/cand-$i.err"
    ) &
  done
  wait
  echo "  $N proposers complete"

  # Phase 2: judge
  CANDIDATES="$(jq -s . "$RDIR"/cand-*.json)"
  PRIOR_WINNERS="[]"
  [ -f "$OUT/winners.json" ] && PRIOR_WINNERS="$(cat "$OUT/winners.json")"

  claude -p "$(cat "$PROMPTS_DIR/judge.md")

RUBRIC: $(cat "$OUT/rubric.json")

CANDIDATES: $CANDIDATES

PRIOR_WINNERS: $PRIOR_WINNERS" --output-format text > "$RDIR/judge.json"
  echo "  judge.json written"

  # Phase 3: merge winners — keep top 5 by weighted_total across rounds
  jq -s '
    (.[0] // []) + (.[1].rankings // [])
    | sort_by(-(.weighted_total // 0))
    | .[0:5]
  ' "$OUT/winners.json" "$RDIR/judge.json" 2>/dev/null > "$OUT/winners.tmp" || \
    jq '.rankings // [] | sort_by(-(.weighted_total // 0)) | .[0:5]' "$RDIR/judge.json" > "$OUT/winners.tmp"
  mv "$OUT/winners.tmp" "$OUT/winners.json"

  # Append evidence from proposers
  for f in "$RDIR"/cand-*.json; do
    jq -c '.evidence[]? // empty' "$f" >> "$OUT/evidence.jsonl" 2>/dev/null || true
  done

  TOP_NOW=$(jq -r '.[0].weighted_total // 0' "$OUT/winners.json")
  echo "  top weighted_total: $TOP_NOW (prev: $PREV_TOP)"

  # Phase 4: convergence test
  STATE="$(jq -n \
    --argjson round "$round" \
    --argjson max "$MAX_ROUNDS" \
    --argjson target "$TARGET" \
    --argjson epsilon "$EPSILON" \
    --argjson top "$TOP_NOW" \
    --argjson prev "$PREV_TOP" \
    --argjson winners "$(cat "$OUT/winners.json")" \
    '{round:$round, max_rounds:$max, target_score:$target, epsilon:$epsilon, top_now:$top, prev_top:$prev, winners:$winners}')"

  claude -p "$(cat "$PROMPTS_DIR/converge.md")

STATE: $STATE" --output-format text > "$RDIR/converge.json"

  DECISION="$(jq -r '.decision' "$RDIR/converge.json")"
  REASON="$(jq -r '.reason' "$RDIR/converge.json")"
  echo "  decision: $DECISION ($REASON)"

  if [ "$DECISION" = "STOP" ]; then
    break
  fi

  REFINED="$(jq -r '.refined_question' "$RDIR/converge.json")"
  echo "$REFINED" > "$OUT/question.txt"
  echo "  refined question saved"

  PREV_TOP="$TOP_NOW"
done

# Phase 5: synthesize
echo "▶ synthesizing final answer"
LAST_ROUND=$(ls -d "$OUT"/round-* | sort -V | tail -1)
CONVERGENCE_REASON="$(jq -r '.reason' "$LAST_ROUND/converge.json" 2>/dev/null || echo unknown)"

claude -p "$(cat "$PROMPTS_DIR/synthesizer.md")

ORIGINAL_QUESTION: $QUESTION

FINAL_WINNER: $(jq '.[0]' "$OUT/winners.json")

RUNNER_UPS: $(jq '.[1:4]' "$OUT/winners.json")

EVIDENCE_LEDGER: $(cat "$OUT/evidence.jsonl" | jq -s .)

CONVERGENCE_REASON: $CONVERGENCE_REASON" > "$OUT/final.md"

echo "✓ autoresearch complete"
echo "  final answer: $OUT/final.md"
