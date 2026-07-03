// Stub for @/lib/server/env in engine tests.
export function getOpenAiApiKey() {
  return process.env.OPENAI_API_KEY ?? "sk-test"
}
export function getExaApiKey() {
  return process.env.EXA_API_KEY
}
export function getOpenAiWebhookSecret() {
  return process.env.OPENAI_WEBHOOK_SECRET
}
