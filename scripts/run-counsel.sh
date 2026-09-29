#!/usr/bin/env bash
# Runs the four counsel seats in parallel. One fresh process per model, each given the
# brief plus the full plan text, so every seat sees identical context without needing
# tool permissions. Outputs land in docs/counsel/.
set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p docs/counsel

for input in docs/counsel/BRIEF.md docs/plan/PLAN-v0.1.md; do
  if [[ ! -f "$input" ]]; then
    echo "missing input: $input" >&2
    exit 1
  fi
done

PROMPT="$(cat docs/counsel/BRIEF.md)

## The plan under review

$(cat docs/plan/PLAN-v0.1.md)"

seat() {
  local out="$1" model="$2" status
  echo "start $model -> $out"
  opencode run -m "$model" "$PROMPT" > "docs/counsel/$out" 2>&1
  status=$?
  echo "exit=$status $model"
  return "$status"
}

names=(01-muse-spark-1.3.md 02-glm-5.3-flash.md 03-hy4-preview.md 04-grok-4.6.md)
models=(opencode-go/muse-spark-1.3-contributor opencode-go/glm-5.3-flash opencode-go/hy4-preview opencode-go/grok-4.6)
pids=()
for i in "${!names[@]}"; do
  seat "${names[$i]}" "${models[$i]}" &
  pids+=("$!")
done

failed=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    echo "seat failed: ${names[$i]}" >&2
    failed=1
  fi
done

if [[ "$failed" -ne 0 ]]; then
  echo "ONE OR MORE SEATS FAILED" >&2
  exit 1
fi

echo "ALL FOUR SEATS FINISHED"
wc -c docs/counsel/0*.md
