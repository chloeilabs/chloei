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
    test.setTimeout(240_000)

    const lookupKey = `chloei-memory-smoke-key-${randomUUID()}`
    const nonce = `chloei-memory-smoke-${randomUUID()}`
    const recallPrompt = `For memory smoke key ${lookupKey}, what exact marker did I ask you to remember? Reply only with the marker value that starts with chloei-memory-smoke-.`

    await signIn(page)
    await submitPrompt(
      page,
      `Please remember this exact durable QA fact for future chats: for memory smoke key ${lookupKey}, the exact marker is ${nonce}. Reply with a short acknowledgement that includes the key and marker.`
    )

    let lastRecallText = ""

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.waitForTimeout(attempt === 0 ? 30_000 : 15_000)
      await page.getByRole("button", { name: "Start a new chat" }).click()
      await expect(page.getByPlaceholder("Ask anything")).toBeVisible()

      const recallResponse = await submitPrompt(page, recallPrompt)
      await expect(recallResponse).toContainText(/chloei-memory-smoke-/, {
        timeout: 120_000,
      })
      lastRecallText = (await recallResponse.textContent()) ?? ""

      if (lastRecallText.includes(nonce)) {
        return
      }
    }

    expect(lastRecallText).toContain(nonce)
  })
})
