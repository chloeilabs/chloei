# Finance Evals

This directory contains Chloei's finance-agent benchmark harness.

## Commands

```bash
pnpm eval:finance
node evals/finance/grade-finance-evals.mjs --outputs evals/finance/results/example.json
node evals/finance/build-gdpval-manifest.mjs --input gdpval.jsonl
```

## Model Defaults

- GDPval candidate generation defaults to `openai/gpt-5.4-mini` through AI Gateway.
- OpenAI judge grading defaults to `gpt-5.4-mini` through the OpenAI API.
- Override either default with `--model`; override the judge with `OPENAI_EVAL_JUDGE_MODEL`.
- Use GPT-5.5 only for final calibration runs where maximum judge quality is worth the additional cost.

## Current Scope

- Internal broad-market finance smoke tasks live in `tasks/internal.jsonl`.
- `finance_data` and `code_execution` use fixture outputs by default so CI can run without provider credentials.
- GDPval public tasks are not vendored. Download/export the public `openai/gdpval` rows as JSONL, then run `build-gdpval-manifest.mjs` to create a finance/accounting/workbook manifest.

The harness grades required tool use, source coverage, expected terms, numeric tolerances, and artifact manifests. Full live-agent scoring should write one output per task with this shape:

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
