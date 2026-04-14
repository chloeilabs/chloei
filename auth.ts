import { existsSync } from "node:fs"
import process from "node:process"

for (const envFile of [".env", ".env.local"]) {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile)
  }
}

const { AUTH_UNAVAILABLE_MESSAGE, getAuthOrNull } = await import(
  "./src/lib/server/auth"
)

const auth = getAuthOrNull()

if (!auth) {
  throw new Error(
    `${AUTH_UNAVAILABLE_MESSAGE} Set DATABASE_URL, BETTER_AUTH_SECRET, and BETTER_AUTH_URL before running auth commands locally. On Vercel, BETTER_AUTH_URL can be inferred from the deployment URL.`
  )
}

export { auth }
