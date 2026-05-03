import { statSync } from "node:fs"
import { registerHooks } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const registrationKey = Symbol.for("chloei.tests.ts-path-hooks")
const stubModulesKey = Symbol.for("chloei.tests.stub-modules")

function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function resolveCandidatePath(specifier, parentURL) {
  let basePath

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

function getStubModuleUrl(specifier) {
  const stubModules = globalThis[stubModulesKey]
  if (!(stubModules instanceof Map)) {
    return null
  }

  return stubModules.get(specifier) ?? null
}

export function toProjectFileUrl(relativePath) {
  return pathToFileURL(path.join(cwd, relativePath)).href
}

export function setTestModuleStubs(stubs) {
  const currentStubs =
    globalThis[stubModulesKey] instanceof Map
      ? globalThis[stubModulesKey]
      : new Map()

  for (const [specifier, stubUrl] of Object.entries(stubs)) {
    currentStubs.set(specifier, stubUrl)
  }

  globalThis[stubModulesKey] = currentStubs
}

export function clearTestModuleStubs() {
  delete globalThis[stubModulesKey]
}

if (!globalThis[registrationKey]) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const stubModuleUrl = getStubModuleUrl(specifier)
      if (stubModuleUrl) {
        return nextResolve(stubModuleUrl, context)
      }

      const candidate = resolveCandidatePath(specifier, context.parentURL)
      if (candidate) {
        return nextResolve(candidate, context)
      }

      return nextResolve(specifier, context)
    },
  })

  globalThis[registrationKey] = true
}
