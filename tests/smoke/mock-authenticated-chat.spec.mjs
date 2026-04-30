import { expect, test } from "@playwright/test"

const smokePrompt =
  process.env.SMOKE_PROMPT?.trim() ||
  "Reply with exactly this text and nothing else: SMOKE_OK"
const expectedAssistantText =
  process.env.SMOKE_EXPECTED_TEXT?.trim() ||
  process.env.E2E_MOCK_AGENT_RESPONSE?.trim() ||
  "SMOKE_OK"

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

test.describe("mock authenticated chat smoke", () => {
  test.skip(
    process.env.E2E_MOCK_AUTH !== "1",
    "Set E2E_MOCK_AUTH=1 to run the credential-free smoke test."
  )

  test("sends a prompt and reloads persisted chat history", async ({
    baseURL,
    context,
    page,
  }) => {
    await context.addCookies([
      {
        name: "chloei_e2e_auth",
        value: "1",
        url: baseURL ?? "http://localhost:3000",
      },
    ])

    await page.goto("/")
    await expect(page.getByPlaceholder("Ask anything")).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Open threads" })
    ).toBeVisible()

    await page.getByPlaceholder("Ask anything").fill(smokePrompt)
    await page.keyboard.press("Enter")

    await expect(page.locator("[data-message-role='user']")).toContainText(
      smokePrompt
    )
    await expect(page.locator("[data-message-role='assistant']")).toContainText(
      expectedAssistantText,
      { timeout: 30_000 }
    )

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
