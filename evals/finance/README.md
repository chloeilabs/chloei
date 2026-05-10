# Finance Evals

This directory contains Chloei's finance-agent benchmark harness.

## Commands

```bash
pnpm eval:finance
pnpm eval:finance:live
pnpm eval:finance -- --mode live --input evals/finance/tasks/live-public-markets.jsonl --limit 4
node evals/finance/grade-finance-evals.mjs --outputs evals/finance/results/example.json
pnpm eval:finance:braintrust -- --grade evals/finance/results/finance-grade.json
node evals/finance/build-gdpval-manifest.mjs --input gdpval.jsonl --output evals/finance/results/gdpval-finance-manifest.json
node evals/finance/judge-gdpval-gateway.mjs --manifest evals/finance/results/gdpval-finance-manifest.json
```

## Model Defaults

- GDPval candidate generation defaults to `openai/gpt-5.4-mini` through AI Gateway.
- GDPval judge grading defaults to `moonshotai/kimi-k2.6` through AI Gateway.
- Both live candidate generation and judge grading use `AI_GATEWAY_API_KEY`; no separate OpenAI API key is required for evals.
- Override either live default with `--model` when running a script directly.

## Current Scope

- Internal broad-market finance smoke tasks live in `tasks/internal.jsonl`.
- Live public-markets acceptance tasks live in `tasks/live-public-markets.jsonl`. They cover filing retrieval, accession-targeted SEC table extraction, earnings-style reviews, and deterministic calculation prompts for SEC-heavy public-company work.
- `finance_data` and `code_execution` use fixture outputs by default so CI can run without provider credentials.
- `publish-braintrust-eval.mjs` sends only eval task metadata, outputs, tool/source/artifact summaries, and scores to Braintrust. Set `BRAINTRUST_API_KEY`, `BRAINTRUST_PROJECT_NAME`, and `BRAINTRUST_EXPERIMENT_NAME` before publishing.
- GDPval public tasks are not vendored. Download/export the public `openai/gdpval` rows as JSONL, then run `build-gdpval-manifest.mjs` to create a finance/accounting/workbook manifest.

The harness grades required tool use, source coverage, expected terms, numeric tolerances, and artifact manifests. The live public-markets suite intentionally uses flexible term/source checks because model wording can vary while the SEC evidence path remains the key reliability signal. Full live-agent scoring should write one output per task with this shape:

```json
{
  "taskId": "equity_statement_margin_check",
  "output": {
    "text": "answer text",
    "toolCalls": [
      { "toolName": "finance_data", "operation": "financial_statements" }
    ],
    "sources": [{ "url": "https://example.com", "title": "Example" }],
    "values": { "grossMargin": 0.43 },
    "artifacts": [{ "path": "finance_summary.xlsx", "sizeBytes": 4096 }]
  }
}
```
