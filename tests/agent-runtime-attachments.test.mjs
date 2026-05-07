import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const runtimeUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/agent-runtime-messages.ts")
).href
const modelsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/llm/models.ts")
).href
const visionPreprocessorUtilsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/image-vision-preprocessor-utils.ts")
).href

const { toModelMessages } = await import(runtimeUrl)
const { AvailableModels, modelSupportsImageInput } = await import(modelsUrl)
const { escapeAttachmentFilenameForPrompt } = await import(
  visionPreprocessorUtilsUrl
)

test("agent runtime converts image and PDF attachments to model message parts", () => {
  const messages = toModelMessages([
    {
      role: "user",
      content: "Analyze these files.",
      attachments: [
        {
          id: "attachment-image",
          kind: "image",
          filename: "chart.png",
          mediaType: "image/png",
          sizeBytes: 5,
          detail: "auto",
          dataUrl: "data:image/png;base64,aGVsbG8=",
        },
        {
          id: "attachment-pdf",
          kind: "pdf",
          filename: "letter.pdf",
          mediaType: "application/pdf",
          sizeBytes: 5,
          dataUrl: "data:application/pdf;base64,aGVsbG8=",
        },
      ],
    },
  ])

  assert.equal(messages[0]?.role, "user")
  assert.deepEqual(messages[0]?.content, [
    {
      type: "text",
      text: "Analyze these files.",
    },
    {
      type: "image",
      image: "data:image/png;base64,aGVsbG8=",
      mediaType: "image/png",
      providerOptions: {
        openai: {
          imageDetail: "auto",
        },
      },
    },
    {
      type: "file",
      data: "data:application/pdf;base64,aGVsbG8=",
      mediaType: "application/pdf",
      filename: "letter.pdf",
    },
  ])
})

test("vision preprocessor escapes attachment filenames for prompt wrappers", () => {
  const filename = 'a&b <chart> "q"\nrow\t2.png'
  const escaped = escapeAttachmentFilenameForPrompt(filename)

  assert.equal(escaped, "a&amp;b &lt;chart&gt; &quot;q&quot;\\nrow\\t2.png")
  assert.equal(escapeAttachmentFilenameForPrompt(escaped), escaped)
})

test("DeepSeek image attachments are routed through preprocessing", () => {
  assert.equal(modelSupportsImageInput(AvailableModels.DEEPSEEK_V4_PRO), false)
  assert.equal(
    modelSupportsImageInput(AvailableModels.MOONSHOTAI_KIMI_K2_6),
    true
  )
})
