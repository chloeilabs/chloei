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
  const tools = createAiSdkCodeExecutionTools()
  const result = await tools.code_execution.execute({
    language: "python",
    code: "import pandas as pd\nprint('blocked')",
  })

  assert.equal(result.output, undefined)
  assert.equal(result.error?.code, "BLOCKED_PATTERN")
})

test("code execution reports computation results with local provider metadata", async () => {
  const tools = createAiSdkCodeExecutionTools()
  const result = await tools.code_execution.execute({
    language: "python",
    code: "print(sum(range(10)))",
  })

  assert.equal(result.error, undefined)
  assert.equal(result.output?.backend, "restricted")
  assert.match(result.output?.stdout ?? "", /45/)
  assert.deepEqual(result.output?.artifactManifest, [])

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
})

test("preserved code execution workspace hides raw artifact directory by default", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "chloei-code-test-"))
  try {
    const tools = createAiSdkCodeExecutionTools({
      workspaceMode: "preserve",
      workspaceRoot: tempRoot,
    })
    const result = await tools.code_execution.execute({
      language: "python",
      code: "print('ok')",
    })

    assert.equal(result.error, undefined)
    assert.equal(result.output?.artifactDirectory, undefined)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("preserved code execution workspace excludes nested mounted inputs from artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "chloei-code-test-"))
  try {
    const inputSource = path.join(tempRoot, "source.xlsx")
    await writeFile(inputSource, "original")

    const tools = createAiSdkCodeExecutionTools({
      workspaceMode: "preserve",
      workspaceRoot: tempRoot,
      inputFiles: [
        {
          sourcePath: inputSource,
          relativePath: "models/input.xlsx",
        },
      ],
    })

    const result = await tools.code_execution.execute({
      language: "python",
      code: "print('noop')",
    })

    assert.equal(result.error, undefined)
    assert.deepEqual(result.output?.artifactManifest, [])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
