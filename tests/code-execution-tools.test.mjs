import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const codeExecutionToolsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/code-execution-tools.ts")
).href

setTestModuleStubs({
  ai: toProjectFileUrl("tests/stubs/ai.mjs"),
})

const {
  createAiSdkCodeExecutionTools,
  getAiSdkCodeExecutionToolResultMetadata,
} = await import(codeExecutionToolsUrl)

test("restricted code execution blocks finance-only Python imports", async () => {
  const tools = createAiSdkCodeExecutionTools({ backend: "restricted" })
  const result = await tools.code_execution.execute({
    language: "python",
    code: "import pandas as pd\nprint('blocked')",
  })

  assert.equal(result.output, undefined)
  assert.equal(result.error?.code, "BLOCKED_PATTERN")
})

test("finance code execution reports workspace spreadsheet artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "chloei-code-test-"))
  try {
    const tools = createAiSdkCodeExecutionTools({
      backend: "finance",
      workspaceMode: "preserve",
      workspaceRoot: tempRoot,
    })
    const result = await tools.code_execution.execute({
      language: "python",
      code: [
        "import zipfile",
        "with zipfile.ZipFile('finance_artifact.xlsx', 'w') as workbook:",
        "    workbook.writestr('[Content_Types].xml', '<Types/>')",
        "print('created')",
      ].join("\n"),
    })

    assert.equal(result.error, undefined)
    assert.equal(result.output?.backend, "finance")
    assert.equal(
      result.output?.artifactManifest.some(
        (artifact) => artifact.path === "finance_artifact.xlsx"
      ),
      true
    )
    assert.match(result.output?.artifactDirectory ?? "", /workspace$/)

    const persistedResult = await tools.code_execution.execute({
      language: "python",
      code: [
        "import zipfile",
        "with zipfile.ZipFile('finance_artifact.xlsx') as workbook:",
        "    print(','.join(workbook.namelist()))",
      ].join("\n"),
    })

    assert.equal(persistedResult.error, undefined)
    assert.match(persistedResult.output?.stdout ?? "", /\[Content_Types\]\.xml/)

    assert.deepEqual(
      getAiSdkCodeExecutionToolResultMetadata({
        toolCallId: "call-code",
        toolName: "code_execution",
        output: result,
      }),
      {
        callId: "call-code",
        toolName: "code_execution",
        status: "success",
        operation: "python",
        provider: "local",
        durationMs: result.output.durationMs,
        errorCode: undefined,
        retryable: false,
        sources: [],
      }
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("finance code execution blocks unsafe path literals", async () => {
  const tools = createAiSdkCodeExecutionTools({ backend: "finance" })
  const result = await tools.code_execution.execute({
    language: "python",
    code: [
      "import zipfile",
      "with zipfile.ZipFile('../escape.xlsx', 'w') as workbook:",
      "    workbook.writestr('[Content_Types].xml', '<Types/>')",
    ].join("\n"),
  })

  assert.equal(result.output, undefined)
  assert.equal(result.error?.code, "BLOCKED_PATTERN")
  assert.match(result.error?.message ?? "", /relative workspace paths/)
})

test("preserved code execution workspace does not overwrite mounted inputs", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "chloei-code-test-"))
  try {
    const inputSource = path.join(tempRoot, "source.xlsx")
    await writeFile(inputSource, "original")

    const tools = createAiSdkCodeExecutionTools({
      backend: "finance",
      workspaceMode: "preserve",
      workspaceRoot: tempRoot,
      inputFiles: [
        {
          sourcePath: inputSource,
          relativePath: "mounted.xlsx",
        },
      ],
    })

    const writeResult = await tools.code_execution.execute({
      language: "python",
      code: [
        "import zipfile",
        "with zipfile.ZipFile('mounted.xlsx', 'w') as workbook:",
        "    workbook.writestr('modified.txt', 'changed')",
      ].join("\n"),
    })

    assert.equal(writeResult.error, undefined)

    const readResult = await tools.code_execution.execute({
      language: "python",
      code: [
        "import zipfile",
        "with zipfile.ZipFile('mounted.xlsx') as workbook:",
        "    print(','.join(workbook.namelist()))",
      ].join("\n"),
    })

    assert.equal(readResult.error, undefined)
    assert.match(readResult.output?.stdout ?? "", /modified\.txt/)
    assert.equal(
      readResult.output?.artifactManifest.some(
        (artifact) => artifact.path === "mounted.xlsx"
      ),
      false
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
