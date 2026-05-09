import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-artifacts.ts")
).href

const {
  buildAgentArtifactBaseUrl,
  buildAgentArtifactDownloadUrl,
  getAgentArtifactFilePath,
  getAgentArtifactWorkspaceRoot,
  normalizeAgentArtifactId,
  normalizeAgentArtifactPath,
} = await import(moduleUrl)

test("agent artifact helpers build scoped download paths", () => {
  assert.equal(normalizeAgentArtifactId("run_123-abc"), "run_123-abc")
  assert.equal(normalizeAgentArtifactId("../run"), null)
  assert.equal(
    normalizeAgentArtifactPath("models/output.xlsx"),
    "models/output.xlsx"
  )
  assert.equal(normalizeAgentArtifactPath("../output.xlsx"), null)

  assert.equal(
    buildAgentArtifactBaseUrl("run_123"),
    "/api/agent/artifacts/run_123"
  )
  assert.equal(
    buildAgentArtifactDownloadUrl("run_123", "models/output sheet.xlsx"),
    "/api/agent/artifacts/run_123/models/output%20sheet.xlsx"
  )
})

test("agent artifact file paths stay inside the user workspace", () => {
  const workspaceRoot = getAgentArtifactWorkspaceRoot({
    artifactId: "run_123",
    userId: "user-1",
  })
  const filePath = getAgentArtifactFilePath({
    artifactId: "run_123",
    relativePath: "models/output.xlsx",
    userId: "user-1",
  })

  assert.equal(filePath, path.join(workspaceRoot, "models/output.xlsx"))
  assert.equal(
    getAgentArtifactFilePath({
      artifactId: "run_123",
      relativePath: "../escape.xlsx",
      userId: "user-1",
    }),
    null
  )
})
