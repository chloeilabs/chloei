import type { Buffer } from "node:buffer"

const MAX_EXTRACTED_TEXT_CHARS = 200_000
const SIMPLE_PDF_SCAN_CHARS = 2_000_000

type PdfCanvasGlobalName = "DOMMatrix" | "ImageData" | "Path2D"

async function installPdfCanvasPolyfills(): Promise<void> {
  const runtimeGlobal = globalThis as Partial<
    Record<PdfCanvasGlobalName, unknown>
  >
  if (
    runtimeGlobal.DOMMatrix &&
    runtimeGlobal.ImageData &&
    runtimeGlobal.Path2D
  ) {
    return
  }

  const canvas = await import("@napi-rs/canvas")
  runtimeGlobal.DOMMatrix ??= canvas.DOMMatrix
  runtimeGlobal.ImageData ??= canvas.ImageData
  runtimeGlobal.Path2D ??= canvas.Path2D
}

export function normalizeExtractedKnowledgeText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS)
}

export function normalizeExtractedReadableText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS)
}

function toPdfData(buffer: Buffer): Uint8Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  )
  return new Uint8Array(arrayBuffer)
}

function decodePdfLiteralString(value: string): string {
  let decoded = ""
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index)
    if (char !== "\\") {
      decoded += char
      continue
    }

    const next = value.charAt(index + 1)
    if (!next) {
      continue
    }

    if (next === "\r" || next === "\n") {
      index += next === "\r" && value[index + 2] === "\n" ? 2 : 1
      continue
    }

    const namedEscapes: Record<string, string> = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      "(": "(",
      ")": ")",
      "\\": "\\",
    }
    const namedEscape = namedEscapes[next]
    if (namedEscape !== undefined) {
      decoded += namedEscape
      index += 1
      continue
    }

    if (/[0-7]/.test(next)) {
      let octal = next
      let offset = index + 2
      while (octal.length < 3 && /[0-7]/.test(value.charAt(offset))) {
        octal += value.charAt(offset)
        offset += 1
      }
      decoded += String.fromCharCode(Number.parseInt(octal, 8))
      index = offset - 1
      continue
    }

    decoded += next
    index += 1
  }

  return decoded
}

function extractSimplePdfRawText(buffer: Buffer): string {
  const source = buffer.toString(
    "latin1",
    0,
    Math.min(buffer.length, SIMPLE_PDF_SCAN_CHARS)
  )
  const fragments: string[] = []
  const literalTextPattern = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g
  const arrayTextPattern = /\[([\s\S]{0,8000}?)\]\s*TJ/g
  const arrayMatches = [...source.matchAll(arrayTextPattern)]
  const arrayRanges = arrayMatches.map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))

  for (const match of source.matchAll(literalTextPattern)) {
    const matchIndex = match.index
    if (
      arrayRanges.some(
        (range) => matchIndex >= range.start && matchIndex < range.end
      )
    ) {
      continue
    }

    fragments.push(decodePdfLiteralString(match[1] ?? ""))
  }

  for (const arrayMatch of arrayMatches) {
    const arraySource = arrayMatch[1] ?? ""
    const arrayLiteralPattern = /\(((?:\\.|[^\\()])*)\)/g
    for (const literalMatch of arraySource.matchAll(arrayLiteralPattern)) {
      fragments.push(decodePdfLiteralString(literalMatch[1] ?? ""))
    }
  }

  return fragments.join("\n").trim()
}

async function extractRawPdfText(buffer: Buffer): Promise<string> {
  await installPdfCanvasPolyfills()

  const { PDFParse } = await import("pdf-parse")
  const parser = new PDFParse({
    data: toPdfData(buffer),
    isEvalSupported: false,
    stopAtErrors: false,
    useWorkerFetch: false,
  })

  try {
    const result = await parser.getText()
    return result.text
  } catch (error) {
    const fallbackText = extractSimplePdfRawText(buffer)
    if (normalizeExtractedKnowledgeText(fallbackText)) {
      return fallbackText
    }

    throw error
  } finally {
    await parser.destroy()
  }
}

export async function extractPdfTextForModelInput(
  buffer: Buffer
): Promise<string> {
  return normalizeExtractedReadableText(await extractRawPdfText(buffer))
}
