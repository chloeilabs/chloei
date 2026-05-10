import { randomUUID } from "node:crypto"

import { expect, test } from "@playwright/test"

const smokeEmail = process.env.SMOKE_EMAIL?.trim()
const smokePassword = process.env.SMOKE_PASSWORD ?? ""

async function signIn(page) {
  await page.goto("/sign-in?redirectTo=/")
  await page.getByLabel("Email").fill(smokeEmail)
  await page.locator("#sign-in-password").fill(smokePassword)
  await page.getByRole("button", { name: "Sign In" }).click()
  await expect(page).toHaveURL(/\/(?:$|\?)/, { timeout: 30_000 })
  await expect(page.getByPlaceholder("Ask anything")).toBeVisible()
}

async function submitPrompt(page, prompt) {
  const promptInput = page.getByPlaceholder("Ask anything")
  await promptInput.click()
  await promptInput.fill(prompt)
  await expect(promptInput).toHaveValue(prompt)

  const submitButton = page.locator("[data-prompt-form] button[type='submit']")
  await expect(submitButton).toBeEnabled()
  await submitButton.click()

  await expect(page.locator("[data-message-role='user']").last()).toContainText(
    prompt
  )
  const assistantMessage = page
    .locator("[data-message-role='assistant']")
    .last()
  await expect(assistantMessage).toContainText(/\S/, { timeout: 120_000 })
  await expect(submitButton).toBeEnabled({ timeout: 120_000 })
  return assistantMessage
}

test.describe("authenticated long-term memory smoke", () => {
  test.skip(
    !smokeEmail || !smokePassword,
    "Set SMOKE_EMAIL and SMOKE_PASSWORD to run authenticated memory smoke tests."
  )

  test("remembers a marker and retrieves it in a new chat", async ({
    page,
  }) => {
    const nonce = `chloei-memory-smoke-${randomUUID()}`

    await signIn(page)
    await submitPrompt(
      page,
      `Please remember this exact durable preference for future chats: my Chloei memory smoke marker is ${nonce}. Reply with a short acknowledgement that includes the marker.`
    )

    await page.waitForTimeout(20_000)
    await page.getByRole("button", { name: "Start a new chat" }).click()
    await expect(page.getByPlaceholder("Ask anything")).toBeVisible()

    const recallResponse = await submitPrompt(
      page,
      "What exact Chloei memory smoke marker did I ask you to remember? Reply only with the value that starts with chloei-memory-smoke-."
    )
    await expect(recallResponse).toContainText(nonce, { timeout: 120_000 })
  })
})
