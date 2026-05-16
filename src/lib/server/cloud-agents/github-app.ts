import { createLogger } from "@/lib/logger"

const logger = createLogger("cloud-agent-github-app")

export interface GithubAppCredentials {
  appId: string
  privateKey: string
  installationId?: string
}

export function resolveGithubAppCredentials(): GithubAppCredentials | null {
  const appId = process.env.GITHUB_APP_ID?.trim()
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim()
  if (!appId || !privateKey) {
    return null
  }
  return {
    appId,
    privateKey,
    ...(process.env.GITHUB_APP_INSTALLATION_ID
      ? { installationId: process.env.GITHUB_APP_INSTALLATION_ID.trim() }
      : {}),
  }
}

export async function getGithubInstallationToken(params: {
  credentials: GithubAppCredentials
  owner: string
  repo: string
}): Promise<string> {
  const { createAppAuth } = await import("@octokit/auth-app")
  const auth = createAppAuth({
    appId: params.credentials.appId,
    privateKey: params.credentials.privateKey,
    ...(params.credentials.installationId
      ? { installationId: Number(params.credentials.installationId) }
      : {}),
  })

  if (params.credentials.installationId) {
    const installationAuth = await auth({
      type: "installation",
      installationId: Number(params.credentials.installationId),
    })
    return installationAuth.token
  }

  const appAuth = await auth({ type: "app" })
  const { Octokit } = await import("@octokit/rest")
  const octokit = new Octokit({ auth: appAuth.token })
  const installation = await octokit.apps.getRepoInstallation({
    owner: params.owner,
    repo: params.repo,
  })
  const installationAuth = await auth({
    type: "installation",
    installationId: installation.data.id,
  })
  logger.info("Resolved GitHub installation token via repo lookup.", {
    owner: params.owner,
    repo: params.repo,
    installationId: installation.data.id,
  })
  return installationAuth.token
}
