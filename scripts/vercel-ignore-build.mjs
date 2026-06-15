#!/usr/bin/env node

import { execFileSync } from "node:child_process"

const explicitSkipFiles = new Set(["README.md", "CLAUDE.md"])

const skipPrefixes = [
  ".claude/",
  ".github/",
  "dist/",
  "docs/",
  "test-results/",
  "tests/",
]

function getChangedFiles() {
  const head = process.env.VERCEL_GIT_COMMIT_SHA || "HEAD"
  const previous = process.env.VERCEL_GIT_PREVIOUS_SHA || "HEAD^"

  try {
    return execFileSync("git", ["diff", "--name-only", previous, head], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean)
  } catch {
    return null
  }
}

function isSkippable(file) {
  return (
    explicitSkipFiles.has(file) ||
    skipPrefixes.some((prefix) => file.startsWith(prefix))
  )
}

const changedFiles = getChangedFiles()

if (!changedFiles || changedFiles.length === 0) {
  console.log(
    "Vercel build will run because changed files could not be determined."
  )
  process.exit(1)
}

const webRelevantFiles = changedFiles.filter((file) => !isSkippable(file))

if (webRelevantFiles.length > 0) {
  console.log("Vercel build will run because web-relevant files changed:")
  for (const file of webRelevantFiles) {
    console.log(`- ${file}`)
  }
  process.exit(1)
}

console.log(
  "Skipping Vercel build because only docs, test, or tooling files changed."
)
process.exit(0)
