import { expect, test } from "@playwright/test"

const smokeEmail = process.env.SMOKE_EMAIL?.trim()
const smokePassword = process.env.SMOKE_PASSWORD ?? ""
const smokePrompt =
  process.env.SMOKE_PROMPT?.trim() ||
  "Reply with exactly this text and nothing else: SMOKE_OK"
const expectedAssistantText = process.env.SMOKE_EXPECTED_TEXT?.trim()

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

test.describe("authenticated chat smoke", () => {
  test.skip(
    !smokeEmail || !smokePassword,
    "Set SMOKE_EMAIL and SMOKE_PASSWORD to run authenticated smoke tests."
  )

  test("signs in, sends a prompt, and reloads persisted chat history", async ({
    page,
  }) => {
    await page.goto("/sign-in?redirectTo=/")
    await page.getByLabel("Email").fill(smokeEmail)
    await page.getByLabel("Password").fill(smokePassword)
    await page.getByRole("button", { name: "Sign In" }).click()

    await expect(page).toHaveURL(/\/(?:$|\?)/, { timeout: 30_000 })
    await expect(page.getByPlaceholder("Ask anything")).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Open threads" })
    ).toBeVisible()

    await page.getByPlaceholder("Ask anything").fill(smokePrompt)
    await page.keyboard.press("Enter")

    await expect(page.locator("[data-message-role='user']")).toContainText(
      smokePrompt
    )
    const assistantMessage = page.locator("[data-message-role='assistant']")
    if (expectedAssistantText) {
      await expect(assistantMessage).toContainText(expectedAssistantText, {
        timeout: 90_000,
      })
    } else {
      await expect(assistantMessage).toContainText(/\S/, { timeout: 90_000 })
    }

    await page.waitForTimeout(1_500)

    await page.reload()
    await expect(page.getByPlaceholder("Ask anything")).toBeVisible()
    await page.getByRole("button", { name: "Open threads" }).click()
    const threadTitlePattern = new RegExp(escapeRegex(smokePrompt.slice(0, 24)))
    const persistedThread = page.getByRole("button", {
      name: threadTitlePattern,
    })
    await expect(persistedThread.first()).toBeVisible()
    await persistedThread.first().click()
    await expect(page.locator("[data-message-role='user']")).toContainText(
      smokePrompt
    )
  })
})
