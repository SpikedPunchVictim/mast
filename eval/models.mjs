// N1 bake-off — model registry.
//
// The single source of truth for the contender set. Each entry records what the
// harness needs to run the model and what the report needs to cite. `dtype` is
// the quantization the harness ships when embedding this model; the shipped MAST
// pipeline (src/indexer/embedder.ts) hardcodes fp32, so fp32 is the "shipped"
// row and any quantized run is an explicit delta probe (see quantProbe).
//
// Params/dims/ctx/license are copied from FABLE_FEEDBAK.md "N1 candidate models
// (researched 2026-07-09)"; dims are re-detected at load time and the detected
// value is what the report uses (the table value is a sanity check only).

export const INCUMBENT_ID = 'jinaai/jina-embeddings-v2-base-code';

/** @typedef {{ id: string, label: string, role: 'incumbent'|'finalist'|'reference', paramsM: number, tableDims: number, ctx: number, license: string, dtype: string, codeSpecialized: boolean, matryoshka?: number[], note?: string }} ModelSpec */

/** @type {ModelSpec[]} */
export const MODELS = [
  {
    id: INCUMBENT_ID,
    label: 'jina-v2-base-code (incumbent)',
    role: 'incumbent',
    paramsM: 161,
    tableDims: 768,
    ctx: 8192,
    license: 'Apache-2.0',
    dtype: 'fp32',
    codeSpecialized: true,
  },
  {
    id: 'Alibaba-NLP/gte-modernbert-base',
    label: 'gte-modernbert-base',
    role: 'finalist',
    paramsM: 149,
    tableDims: 768,
    ctx: 8192,
    license: 'Apache-2.0',
    dtype: 'fp32',
    codeSpecialized: false,
  },
  {
    id: 'onnx-community/embeddinggemma-300m-ONNX',
    label: 'embeddinggemma-300m',
    role: 'finalist',
    paramsM: 300,
    tableDims: 768,
    ctx: 2048,
    license: 'Gemma-terms',
    dtype: 'fp32',
    codeSpecialized: false,
    matryoshka: [768, 512, 256],
    note: '2048 ctx cap — truncation analysis required',
  },
  {
    id: 'Salesforce/SFR-Embedding-Code-400M_R',
    label: 'SFR-Embedding-Code-400M_R',
    role: 'reference', // CC-BY-NC-4.0 — benchmark reference only, NOT adoptable
    paramsM: 400,
    tableDims: 768,
    ctx: 8192,
    license: 'CC-BY-NC-4.0 (NON-ADOPTABLE)',
    dtype: 'fp32',
    codeSpecialized: true,
    note: 'license gate: non-commercial. Measures the code-specialization ceiling.',
  },
  {
    id: 'nomic-ai/CodeRankEmbed',
    label: 'CodeRankEmbed',
    role: 'finalist',
    paramsM: 137,
    tableDims: 768,
    ctx: 8192,
    license: 'MIT',
    dtype: 'fp32',
    codeSpecialized: true,
    note: 'no published ONNX — attempt Transformers.js load within 3 tries, else drop.',
  },
];

// CodeRankEmbed gate record (3-attempts rule):
//   Attempt 1 — official repo: GATE FAILED, "Could not locate file
//     https://huggingface.co/nomic-ai/CodeRankEmbed/resolve/main/onnx/model.onnx"
//     (no published ONNX, as the candidate table warned).
//   Attempt 2 — community ONNX mirrors exist (Zenabius/CodeRankEmbed-onnx etc.)
//     with a loadable Transformers.js layout, but they are unofficial third-party
//     conversions of the weights; running untrusted converted weights was denied
//     and is outside the sanctioned eval path.
//   Attempt 3 — in-house conversion would require a Python/optimum toolchain not
//     present in this repo; not a "clean" load per the drop rule.
// Verdict: INCOMPATIBLE, DROPPED. Revisit if nomic-ai publishes official ONNX.

export function getModel(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model: ${id}`);
  return m;
}
