import { createHash } from "node:crypto"

function hashPrivacyValue(value: string, prefix = "sha256"): string {
  const digest = createHash("sha256").update(value).digest("hex")
  return `${prefix}:${digest}`
}

export function hashUserId(userId: string): string {
  return hashPrivacyValue(userId)
}
