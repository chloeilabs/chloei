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

  const branchEnvironment =
    trimmed(env.BRANCH_NAME) ?? trimmed(env.VERCEL_GIT_COMMIT_REF)
  if (branchEnvironment) {
    return branchEnvironment
  }

  return undefined
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
