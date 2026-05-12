import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))

setTestModuleStubs({
  "@ai-sdk/gateway": toProjectFileUrl("tests/stubs/ai-sdk-gateway.mjs"),
  "./gateway-client": toProjectFileUrl("tests/stubs/gateway-client.mjs"),
  ai: toProjectFileUrl("tests/stubs/ai.mjs"),
})

const runtimeUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/agent-runtime-messages.ts")
).href
const agentRuntimePath = path.join(cwd, "src/lib/server/llm/agent-runtime.ts")
const pdfPreprocessorUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/pdf-attachment-preprocessor.ts")
).href
const modelsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/llm/models.ts")
).href
const visionPreprocessorUtilsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/image-vision-preprocessor-utils.ts")
).href

const { toModelMessages } = await import(runtimeUrl)
const { preparePdfAttachmentsForModel } = await import(pdfPreprocessorUrl)
const { AvailableModels, modelSupportsFileInput, modelSupportsImageInput } =
  await import(modelsUrl)
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

test("PDF file-input capability matches runtime-compatible Gateway models", () => {
  assert.equal(modelSupportsFileInput(AvailableModels.OPENAI_GPT_5_5), true)
  assert.equal(
    modelSupportsFileInput(AvailableModels.MOONSHOTAI_KIMI_K2_6),
    false
  )
  assert.equal(modelSupportsFileInput(AvailableModels.DEEPSEEK_V4_PRO), false)
})

test("PDF preprocessor replaces PDF attachments with text for non-file-input models", async () => {
  const messages = await preparePdfAttachmentsForModel({
    aiGatewayApiKey: "test-gateway-key",
    messages: [
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
            filename: 'letter & "notes".pdf',
            mediaType: "application/pdf",
            sizeBytes: 5,
            dataUrl: "data:application/pdf;base64,aGVsbG8=",
          },
        ],
      },
    ],
    extractPdfText: async ({ attachment }) =>
      `Extracted text from ${attachment.filename}.`,
    extractPdfTextWithModel: async () => {
      throw new Error("Gateway fallback should not run.")
    },
  })

  assert.equal(messages[0]?.role, "user")
  assert.deepEqual(messages[0]?.attachments, [
    {
      id: "attachment-image",
      kind: "image",
      filename: "chart.png",
      mediaType: "image/png",
      sizeBytes: 5,
      detail: "auto",
      dataUrl: "data:image/png;base64,aGVsbG8=",
    },
  ])
  assert.match(
    messages[0]?.content ?? "",
    /<attached_pdf filename="letter &amp; &quot;notes&quot;\.pdf">\nExtracted text from letter & "notes"\.pdf\.\n<\/attached_pdf>/
  )

  const modelMessages = toModelMessages(messages)
  assert.equal(modelMessages[0]?.role, "user")
  assert.equal(
    modelMessages[0]?.content.some((part) => part.type === "file"),
    false
  )
})

test("PDF preprocessor keeps native PDFs without text extraction for file-input models", async () => {
  let extractionCalls = 0
  const messages = await preparePdfAttachmentsForModel({
    aiGatewayApiKey: "test-gateway-key",
    preservePdfAttachments: true,
    messages: [
      {
        role: "user",
        content: "Analyze these files.",
        attachments: [
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
    ],
    extractPdfText: async () => {
      extractionCalls += 1
      throw new Error("File-input models should receive native PDFs directly.")
    },
    extractPdfTextWithModel: async () => {
      throw new Error("Gateway fallback should not run.")
    },
  })

  assert.equal(extractionCalls, 0)
  assert.equal(messages[0]?.content, "Analyze these files.")
  assert.deepEqual(messages[0]?.attachments, [
    {
      id: "attachment-pdf",
      kind: "pdf",
      filename: "letter.pdf",
      mediaType: "application/pdf",
      sizeBytes: 5,
      dataUrl: "data:application/pdf;base64,aGVsbG8=",
    },
  ])
  assert.deepEqual(toModelMessages(messages)[0]?.content, [
    {
      type: "text",
      text: "Analyze these files.",
    },
    {
      type: "file",
      data: "data:application/pdf;base64,aGVsbG8=",
      mediaType: "application/pdf",
      filename: "letter.pdf",
    },
  ])
})

test("PDF preprocessor falls back to Gateway extraction when local text is empty", async () => {
  let gatewayFallbackCalls = 0
  const messages = await preparePdfAttachmentsForModel({
    aiGatewayApiKey: "test-gateway-key",
    messages: [
      {
        role: "user",
        content: "Read the PDF.",
        attachments: [
          {
            id: "attachment-pdf",
            kind: "pdf",
            filename: "scan.pdf",
            mediaType: "application/pdf",
            sizeBytes: 5,
            dataUrl: "data:application/pdf;base64,aGVsbG8=",
          },
        ],
      },
    ],
    extractPdfText: async () => null,
    extractPdfTextWithModel: async () => {
      gatewayFallbackCalls += 1
      return "Model-extracted PDF text."
    },
  })

  assert.equal(gatewayFallbackCalls, 1)
  assert.match(messages[0]?.content ?? "", /Model-extracted PDF text\./)
  assert.equal(messages[0]?.attachments, undefined)
})

test("PDF preprocessor falls back to Gateway extraction when local text is raw PDF syntax", async () => {
  let gatewayFallbackCalls = 0
  const messages = await preparePdfAttachmentsForModel({
    aiGatewayApiKey: "test-gateway-key",
    messages: [
      {
        role: "user",
        content: "Read the PDF.",
        attachments: [
          {
            id: "attachment-pdf",
            kind: "pdf",
            filename: "encoded.pdf",
            mediaType: "application/pdf",
            sizeBytes: 5,
            dataUrl: "data:application/pdf;base64,aGVsbG8=",
          },
        ],
      },
    ],
    extractPdfText: async () =>
      "%PDF-1.7\n1 0 obj\n/Filter /FlateDecode\nstream\nbinary encoded bytes\nendstream\nendobj\n%%EOF",
    extractPdfTextWithModel: async () => {
      gatewayFallbackCalls += 1
      return "Gateway-readable PDF text."
    },
  })

  assert.equal(gatewayFallbackCalls, 1)
  assert.match(messages[0]?.content ?? "", /Gateway-readable PDF text\./)
  assert.doesNotMatch(messages[0]?.content ?? "", /%PDF-1\.7/)
  assert.equal(messages[0]?.attachments, undefined)
})

test("PDF preprocessor preserves Gateway-extracted document layout", async () => {
  resetTestMocks()
  setTestMocks({
    ai: {
      generateText: async () => ({
        text: "Heading\r\n\r\nRow 1    Value A\tValue B  \n\n\n\nRow 2",
      }),
    },
  })

  try {
    const messages = await preparePdfAttachmentsForModel({
      aiGatewayApiKey: "test-gateway-key",
      messages: [
        {
          role: "user",
          content: "Read the PDF.",
          attachments: [
            {
              id: "attachment-pdf",
              kind: "pdf",
              filename: "layout.pdf",
              mediaType: "application/pdf",
              sizeBytes: 5,
              dataUrl: "data:application/pdf;base64,aGVsbG8=",
            },
          ],
        },
      ],
      extractPdfText: async () => null,
    })

    assert.match(
      messages[0]?.content ?? "",
      /<attached_pdf filename="layout\.pdf">\nHeading\n\nRow 1 {4}Value A\tValue B\n\n\nRow 2\n<\/attached_pdf>/
    )
  } finally {
    resetTestMocks()
  }
})

test("PDF preprocessor strips unsupported PDF parts when extraction fails", async () => {
  const messages = await preparePdfAttachmentsForModel({
    aiGatewayApiKey: "test-gateway-key",
    messages: [
      {
        role: "user",
        content: "Read the PDF.",
        attachments: [
          {
            id: "attachment-pdf",
            kind: "pdf",
            filename: "unreadable.pdf",
            mediaType: "application/pdf",
            sizeBytes: 5,
            dataUrl: "data:application/pdf;base64,aGVsbG8=",
          },
        ],
      },
    ],
    extractPdfText: async () => {
      throw new Error("local parse failed")
    },
    extractPdfTextWithModel: async () => null,
  })

  assert.match(
    messages[0]?.content ?? "",
    /PDF text extraction was unavailable for this attachment\./
  )
  assert.equal(messages[0]?.attachments, undefined)
  assert.equal(toModelMessages(messages)[0]?.content, messages[0]?.content)
})

test("agent runtime hydrates blob attachments before PDF preprocessing", async () => {
  const source = await readFile(agentRuntimePath, "utf8")

  assert.match(
    source,
    /const blobHydratedMessages = await hydrateBlobBackedAttachments[\s\S]*const pdfPreparedMessages = await preparePdfAttachmentsForModel/
  )
  assert.match(
    source,
    /preparePdfAttachmentsForModel\(\{[\s\S]*messages: blobHydratedMessages/
  )
  assert.match(
    source,
    /preservePdfAttachments: modelSupportsFileInput\(params\.model\)/
  )
  assert.match(
    source,
    /describeImagesForTextOnlyModel\(\{[\s\S]*messages: pdfPreparedMessages/
  )
})
