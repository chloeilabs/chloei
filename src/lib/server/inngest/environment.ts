type Environment = Record<string, string | undefined>

function trimmed(value: string | undefined): string | undefined {
  const nextValue = value?.trim()
  return nextValue === "" ? undefined : nextValue
}

export function resolveInngestEnvironmentName(
  env: Environment = process.env
): string | undefined {
  const explicitEnvironment = trimmed(env.INNGEST_ENV)
  if (explicitEnvironment) {
    return explicitEnvironment
  }

  const vercelEnvironment =
    trimmed(env.VERCEL_ENV) ?? trimmed(env.VERCEL_TARGET_ENV)
  if (vercelEnvironment === "production") {
    return undefined
  }

  const branchEnvironment =
    trimmed(env.BRANCH_NAME) ?? trimmed(env.VERCEL_GIT_COMMIT_REF)
  const productionBranch = trimmed(env.VERCEL_GIT_PRODUCTION_BRANCH) ?? "main"
  if (branchEnvironment) {
    if (branchEnvironment === productionBranch) {
      return undefined
    }

    return branchEnvironment
  }

  return undefined
}

export function resolveInngestEnvironmentInferenceOverrides(
  env: Environment = process.env
): Environment | undefined {
  if (resolveInngestEnvironmentName(env)) {
    return undefined
  }

  return {
    BRANCH_NAME: undefined,
    INNGEST_ENV: undefined,
    VERCEL_GIT_COMMIT_REF: undefined,
  }
}

export function applyInngestEnvironmentInferenceOverrides(
  env: Environment = process.env
): Environment | undefined {
  const overrides = resolveInngestEnvironmentInferenceOverrides(env)
  if (!overrides) {
    return undefined
  }

  delete env.BRANCH_NAME
  delete env.INNGEST_ENV
  delete env.VERCEL_GIT_COMMIT_REF

  return overrides
}

export function shouldSendInngestEvents(
  env: Environment = process.env
): boolean {
  const eventKey = trimmed(env.INNGEST_EVENT_KEY)
  if (!eventKey) {
    return false
  }

  if (env.INNGEST_DEV === "1" || env.INNGEST_DEV === "true") {
    return true
  }

  return Boolean(resolveInngestEnvironmentName(env)) || env.VERCEL === "1"
}

export function shouldRunInngestInlineFallback(
  env: Environment = process.env
): boolean {
  const value = trimmed(env.INNGEST_INLINE_FALLBACK)
  return value === "1" || value === "true"
}
