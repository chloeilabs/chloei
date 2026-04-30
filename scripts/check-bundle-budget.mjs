import { readdirSync, statSync } from "node:fs"
import path from "node:path"

const projectRoot = process.cwd()
const chunksDir = path.join(projectRoot, ".next", "static", "chunks")

function readPositiveBytesEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number; got "${raw}".`)
  }
  return parsed
}

const maxTotalBytes = readPositiveBytesEnv(
  "BUNDLE_MAX_STATIC_CHUNKS_BYTES",
  14 * 1024 * 1024
)
const maxChunkBytes = readPositiveBytesEnv(
  "BUNDLE_MAX_STATIC_CHUNK_BYTES",
  1024 * 1024
)

function formatBytes(value) {
  return `${(value / 1024 / 1024).toFixed(2)} MiB`
}

function collectJavaScriptFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(entryPath))
      continue
    }

    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath)
    }
  }

  return files
}

const files = collectJavaScriptFiles(chunksDir)
const fileSizes = files.map((filePath) => ({
  filePath,
  size: statSync(filePath).size,
}))
const totalBytes = fileSizes.reduce((total, file) => total + file.size, 0)
const largestChunk = fileSizes.toSorted((a, b) => b.size - a.size)[0]
const failures = []

if (totalBytes > maxTotalBytes) {
  failures.push(
    `Static JS chunks total ${formatBytes(totalBytes)} exceeds ${formatBytes(maxTotalBytes)}.`
  )
}

if (largestChunk && largestChunk.size > maxChunkBytes) {
  failures.push(
    `Largest static JS chunk ${path.relative(projectRoot, largestChunk.filePath)} is ${formatBytes(largestChunk.size)}, exceeding ${formatBytes(maxChunkBytes)}.`
  )
}

console.log(
  JSON.stringify(
    {
      largestChunk: largestChunk
        ? {
            path: path.relative(projectRoot, largestChunk.filePath),
            size: largestChunk.size,
          }
        : null,
      maxChunkBytes,
      maxTotalBytes,
      totalBytes,
    },
    null,
    2
  )
)

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure)
  }
  process.exit(1)
}
