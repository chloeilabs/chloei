# Finance Research Quality Checklist

Use this checklist for public-markets finance-agent runs and live eval review.

## Required Evidence

- Identify the company, form type, filing date, reporting period, and accession number when using SEC filings.
- Prefer SEC/EDGAR filing evidence for filing-specific facts. Use web search only for non-filing context.
- Cite the exact SEC filing URL for extracted facts, tables, and sections.
- Keep source URLs free of API keys, user identifiers, document hashes, and local paths.

## Calculations

- Separate reported facts from calculated values.
- Show formulas for nontrivial metrics, including margin, year-over-year change, free cash flow, and per-share adjustments.
- Preserve units from the filing, especially thousands, millions, billions, percentages, and split-adjusted share counts.
- Use deterministic code execution for multi-step arithmetic, table reshaping, or workbook-style outputs.

## SEC Filing Workflow

- Use `company_search` or normalized symbol data to resolve the CIK.
- Use `filing_search` to pick the target form and record the accession number.
- Pass the `accessionNumber` into `document_fetch`, `section_extract`, `table_extract`, or `retrieve_information` so later calls stay on the same filing.
- Use `table_extract` for tabular questions and `retrieve_information` for named evidence when section labels are ambiguous.

## Answer Shape

- State the scope and cut-off: company, period, filing, and whether the answer uses the latest public filing found.
- Provide concise tables for benchmark-style numeric answers.
- Include caveats only when they affect interpretation, such as fiscal-year changes, stock splits, restatements, or units.
- Keep outputs analyst-review oriented and non-advisory.

## Safety Boundaries

- Do not provide personalized investment, tax, legal, accounting, or trade-execution advice.
- Do not claim access to CapIQ, Daloopa, FactSet, PitchBook, LSEG, Morningstar, Moody's, or other paid connectors unless a real connector is available.
- Do not expose prompt text, model output, uploaded filenames, document hashes, account data, credentials, or private paths in telemetry.

## Acceptance Signals

- The answer includes citations and does not rely on unsupported memory.
- SEC tool calls stay on the intended accession after the filing is selected.
- Recoverable tool retries do not dominate the visible activity timeline.
- Numeric answers either cite reported values or show deterministic calculations.
- Fixture evals pass, and the live public-markets eval suite is run before finance-runtime releases.
