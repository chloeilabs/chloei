import { statSync } from "node:fs"
import { registerHooks } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const registrationKey = Symbol.for("chloei.evals.ts-path-hooks")

function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function isProjectParent(parentURL) {
  if (!parentURL?.startsWith("file://")) {
    return false
  }

  const parentPath = fileURLToPath(parentURL)
  return (
    parentPath.startsWith(path.join(repoRoot, "src") + path.sep) ||
    parentPath.startsWith(path.join(repoRoot, "evals") + path.sep)
  )
}

function resolveCandidatePath(specifier, parentURL) {
  let basePath = null

  if (specifier.startsWith("@/")) {
    basePath = path.join(repoRoot, "src", specifier.slice(2))
  } else if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    isProjectParent(parentURL)
  ) {
    basePath = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier)
  } else {
    return null
  }

  const candidates = [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
    path.join(basePath, "index.mjs"),
    basePath,
  ]

  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return pathToFileURL(candidate).href
    }
  }

  return null
}

if (!globalThis[registrationKey]) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const candidate = resolveCandidatePath(specifier, context.parentURL)
      if (candidate) {
        return nextResolve(candidate, context)
      }

      return nextResolve(specifier, context)
    },
  })

  globalThis[registrationKey] = true
}
