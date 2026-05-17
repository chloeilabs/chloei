import { Buffer } from "node:buffer"

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

async function authenticateMockUser({ baseURL, context }) {
  await context.addCookies([
    {
      name: "chloei_e2e_auth",
      value: "1",
      url: baseURL ?? "http://localhost:3000",
    },
  ])
}

async function openMockChat({ baseURL, context, page }) {
  await authenticateMockUser({ baseURL, context })
  await page.goto("/")
  await expect(page.getByPlaceholder("Ask anything")).toBeVisible()
}

async function selectThreadFromSidebar(page, threadTitlePattern) {
  const viewport = page.viewportSize()
  const isMobile = viewport ? viewport.width < 768 : false

  if (isMobile) {
    await page.getByRole("button", { name: "Toggle Sidebar" }).first().click()
  }

  const threadButton = page
    .getByRole("button", { name: threadTitlePattern })
    .first()
  await expect(threadButton).toBeVisible()
  await threadButton.click()
}

async function sendPrompt(page, prompt, expectedText = expectedAssistantText) {
  await page.getByPlaceholder("Ask anything").last().fill(prompt)
  await page.keyboard.press("Enter")

  await expect(page.locator("[data-message-role='user']")).toContainText(prompt)
  await expect(page.locator("[data-message-role='assistant']")).toContainText(
    expectedText,
    { timeout: 30_000 }
  )
}

test.describe("mock authenticated chat smoke", () => {
  test.skip(
    process.env.E2E_MOCK_AUTH !== "1",
    "Set E2E_MOCK_AUTH=1 to run the credential-free smoke test."
  )

  test("redirects unauthenticated visitors to sign in", async ({ page }) => {
    await page.goto("/")
    await expect(page).toHaveURL(/\/sign-in(?:$|\?)/)
  })

  test("sends a prompt and reloads persisted chat history", async ({
    baseURL,
    context,
    page,
  }) => {
    await openMockChat({ baseURL, context, page })
    await sendPrompt(page, smokePrompt)

    await page.reload()
    await expect(page.getByPlaceholder("Ask anything")).toBeVisible()

    const threadTitlePattern = new RegExp(escapeRegex(smokePrompt.slice(0, 24)))
    await selectThreadFromSidebar(page, threadTitlePattern)
    await expect(page.locator("[data-message-role='user']")).toContainText(
      smokePrompt
    )
  })

  test("starts a new chat without losing the previous thread", async ({
    baseURL,
    context,
    page,
  }) => {
    const firstPrompt = "First mocked thread smoke prompt"
    const secondPrompt = "Second mocked thread smoke prompt"

    await openMockChat({ baseURL, context, page })
    await sendPrompt(page, firstPrompt)

    await page.getByRole("button", { name: "Start a new chat" }).click()
    await expect(page.locator("[data-message-role='user']")).toHaveCount(0)

    await sendPrompt(page, secondPrompt)

    const firstThreadTitle = new RegExp(escapeRegex(firstPrompt.slice(0, 24)))
    await selectThreadFromSidebar(page, firstThreadTitle)
    await expect(page.locator("[data-message-role='user']")).toContainText(
      firstPrompt
    )
  })

  test("filters chats from the sidebar search and closes with escape", async ({
    baseURL,
    context,
    page,
  }) => {
    await openMockChat({ baseURL, context, page })
    await sendPrompt(page, smokePrompt)

    await page.getByRole("button", { name: "Search chats" }).click()
    const searchInput = page.getByPlaceholder("Search chats…")
    await expect(searchInput).toBeVisible()

    await searchInput.fill(smokePrompt.slice(0, 12))
    const filtered = page.getByRole("button", {
      name: new RegExp(escapeRegex(smokePrompt.slice(0, 12))),
    })
    await expect(filtered.first()).toBeVisible()

    await page.keyboard.press("Escape")
    await expect(searchInput).toHaveCount(0)
  })

  test("edits a user message and regenerates the assistant response", async ({
    baseURL,
    context,
    page,
  }) => {
    const originalPrompt = "Original edit smoke prompt"
    const editedPrompt = "Edited regenerate smoke prompt"

    await openMockChat({ baseURL, context, page })
    await sendPrompt(page, originalPrompt)

    const userMessage = page
      .locator("[data-message-role='user']")
      .filter({ hasText: originalPrompt })
      .first()
    await userMessage.getByRole("button").click()
    const editTextarea = page.locator("[data-message-role='user'] textarea")
    await editTextarea.fill(editedPrompt)
    await editTextarea.press("Enter")

    await expect(page.locator("[data-message-role='user']")).toContainText(
      editedPrompt
    )
    await expect(page.locator("[data-message-role='user']")).not.toContainText(
      originalPrompt
    )
    await expect(page.locator("[data-message-role='assistant']")).toContainText(
      expectedAssistantText,
      { timeout: 30_000 }
    )
  })

  test("attaches and submits a PDF in the mocked chat flow", async ({
    baseURL,
    context,
    page,
  }) => {
    await openMockChat({ baseURL, context, page })

    await page.locator("input[type='file']").setInputFiles({
      name: "smoke-report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%EOF\n"),
    })
    await expect(page.getByText("smoke-report.pdf")).toBeVisible()

    await page.getByRole("button", { name: "Remove smoke-report.pdf" }).click()
    await expect(page.getByText("smoke-report.pdf")).toHaveCount(0)

    await page.locator("input[type='file']").setInputFiles({
      name: "smoke-report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%EOF\n"),
    })
    await expect(page.getByText("smoke-report.pdf")).toBeVisible()
    await page.getByPlaceholder("Ask anything").press("Enter")

    await expect(page.locator("[data-message-role='user']")).toContainText(
      "Analyze the attached file(s)."
    )
    await expect(page.locator("[data-message-role='assistant']")).toContainText(
      expectedAssistantText,
      { timeout: 30_000 }
    )
  })

  test("sends a prompt on a mobile viewport", async ({
    baseURL,
    context,
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openMockChat({ baseURL, context, page })
    await sendPrompt(page, "Mobile mocked chat smoke prompt")
  })
})
