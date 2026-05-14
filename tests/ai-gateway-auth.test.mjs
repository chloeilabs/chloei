import assert from "node:assert/strict"
import { afterEach, before, test } from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const authModuleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/ai-gateway-auth.ts")
).href

const savedEnv = {
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN,
  E2E_MOCK_AUTH: process.env.E2E_MOCK_AUTH,
}

let isAiGatewayAuthConfigured
let resolveAiGatewayApiKeySetting

before(async () => {
  const mod = await import(authModuleUrl)
  isAiGatewayAuthConfigured = mod.isAiGatewayAuthConfigured
  resolveAiGatewayApiKeySetting = mod.resolveAiGatewayApiKeySetting
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

test("isAiGatewayAuthConfigured is true when AI_GATEWAY_API_KEY is set", () => {
  delete process.env.VERCEL_OIDC_TOKEN
  delete process.env.E2E_MOCK_AUTH
  process.env.AI_GATEWAY_API_KEY = "sk-test"

  assert.equal(isAiGatewayAuthConfigured(), true)
})

test("isAiGatewayAuthConfigured is true when VERCEL_OIDC_TOKEN is set", () => {
  delete process.env.AI_GATEWAY_API_KEY
  delete process.env.E2E_MOCK_AUTH
  process.env.VERCEL_OIDC_TOKEN = "oidc-jwt"

  assert.equal(isAiGatewayAuthConfigured(), true)
})

test("isAiGatewayAuthConfigured is false when neither key nor OIDC is set", () => {
  delete process.env.AI_GATEWAY_API_KEY
  delete process.env.VERCEL_OIDC_TOKEN
  delete process.env.E2E_MOCK_AUTH

  assert.equal(isAiGatewayAuthConfigured(), false)
})

test("resolveAiGatewayApiKeySetting returns trimmed API key only", () => {
  process.env.AI_GATEWAY_API_KEY = "  my-key  "
  process.env.VERCEL_OIDC_TOKEN = "ignored-for-this-helper"

  assert.equal(resolveAiGatewayApiKeySetting(), "my-key")
})
