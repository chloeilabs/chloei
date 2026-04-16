import { statSync } from "node:fs"
import { registerHooks } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const registrationKey = Symbol.for("chloei.tests.ts-path-hooks")

function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function resolveCandidatePath(specifier, parentURL) {
  let basePath = null

  if (specifier.startsWith("@/")) {
    basePath = path.join(cwd, "src", specifier.slice(2))
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (!parentURL?.startsWith("file://")) {
      return null
    }

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
