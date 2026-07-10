#!/usr/bin/env bash
# Run every contender sequentially (one process each → clean RAM/timing, no CPU
# contention skew). Each writes results/<model>__<dtype>.json. Continues past a
# model that fails its gate (e.g. CodeRankEmbed if ONNX won't load).
set -u
cd "$(dirname "$0")/.."

MODELS=(
  "jinaai/jina-embeddings-v2-base-code fp32"
  "Alibaba-NLP/gte-modernbert-base fp32"
  "onnx-community/embeddinggemma-300m-ONNX fp32"
  "Salesforce/SFR-Embedding-Code-400M_R fp32"
  "nomic-ai/CodeRankEmbed fp32"
)

for spec in "${MODELS[@]}"; do
  echo "==================== $spec ===================="
  # shellcheck disable=SC2086
  node eval/run-model.mjs $spec || echo "run-model exited non-zero for: $spec (continuing)"
  echo
done

echo "ALL MODELS DONE"
