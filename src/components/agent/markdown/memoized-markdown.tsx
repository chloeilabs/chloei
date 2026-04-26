import { marked } from "marked"
import {
  cloneElement,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useMemo,
} from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { ShikiCode } from "@/components/ui/shiki-code"
import { Source, SourceContent, SourceTrigger } from "@/components/ui/source"
import type { MessageSource } from "@/lib/shared"
import { cn } from "@/lib/utils"

function extractTextFromNode(node: React.ReactNode): string {
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractTextFromNode).join("")
  if (isValidElement<{ children?: React.ReactNode }>(node)) {
    return extractTextFromNode(node.props.children)
  }
  return ""
}

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown)
  return tokens.map((token) => token.raw)
}

interface MathPlaceholder {
  display: boolean
  latex: string
}

const MATH_PLACEHOLDER_PATTERN = /@@CHLOEI_MATH_(\d+)@@/g

function findClosingDelimiter(
  source: string,
  delimiter: string,
  fromIndex: number
): number {
  let index = fromIndex
  while (index < source.length) {
    const nextIndex = source.indexOf(delimiter, index)
    if (nextIndex === -1) {
      return -1
    }

    const precedingBackslashes = /\\+$/.exec(source.slice(0, nextIndex))?.[0]
      .length
    if (!precedingBackslashes || precedingBackslashes % 2 === 0) {
      return nextIndex
    }

    index = nextIndex + delimiter.length
  }

  return -1
}

function readFenceDelimiter(source: string, index: number): string | null {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1
  const prefix = source.slice(lineStart, index)
  if (!/^(?:[ \t]{0,3}>)*[ \t]{0,3}$/.test(prefix)) {
    return null
  }

  if (source.startsWith("```", index)) {
    return "```"
  }

  if (source.startsWith("~~~", index)) {
    return "~~~"
  }

  return null
}

function findFenceEnd(source: string, delimiter: string, fromIndex: number) {
  let index = fromIndex
  while (index < source.length) {
    const closingIndex = source.indexOf(delimiter, index)
    if (closingIndex === -1) {
      return source.length
    }

    if (readFenceDelimiter(source, closingIndex) === delimiter) {
      const lineEndIndex = source.indexOf("\n", closingIndex)
      return lineEndIndex === -1 ? source.length : lineEndIndex
    }

    index = closingIndex + delimiter.length
  }

  return source.length
}

function replaceMathWithPlaceholders(content: string): {
  content: string
  placeholders: MathPlaceholder[]
} {
  const placeholders: MathPlaceholder[] = []
  let output = ""
  let index = 0

  const appendPlaceholder = (latex: string, display: boolean) => {
    const placeholderIndex = placeholders.length
    placeholders.push({ display, latex: latex.trim() })
    output += `@@CHLOEI_MATH_${String(placeholderIndex)}@@`
  }

  while (index < content.length) {
    const fenceDelimiter = readFenceDelimiter(content, index)
    if (fenceDelimiter) {
      const endIndex = findFenceEnd(
        content,
        fenceDelimiter,
        index + fenceDelimiter.length
      )
      output += content.slice(index, endIndex)
      index = endIndex
      continue
    }

    if (content[index] === "`") {
      const tickMatch = /^`+/.exec(content.slice(index))
      const ticks = tickMatch?.[0] ?? "`"
      const closingIndex = content.indexOf(ticks, index + ticks.length)
      if (closingIndex !== -1) {
        output += content.slice(index, closingIndex + ticks.length)
        index = closingIndex + ticks.length
        continue
      }
    }

    if (content.startsWith("\\[", index)) {
      const closingIndex = findClosingDelimiter(content, "\\]", index + 2)
      if (closingIndex !== -1) {
        appendPlaceholder(content.slice(index + 2, closingIndex), true)
        index = closingIndex + 2
        continue
      }
    }

    if (content.startsWith("$$", index)) {
      const closingIndex = findClosingDelimiter(content, "$$", index + 2)
      if (closingIndex !== -1) {
        appendPlaceholder(content.slice(index + 2, closingIndex), true)
        index = closingIndex + 2
        continue
      }
    }

    if (content.startsWith("\\(", index)) {
      const closingIndex = findClosingDelimiter(content, "\\)", index + 2)
      if (closingIndex !== -1) {
        appendPlaceholder(content.slice(index + 2, closingIndex), false)
        index = closingIndex + 2
        continue
      }
    }

    output += content.charAt(index)
    index += 1
  }

  return { content: output, placeholders }
}

const LATEX_REPLACEMENTS: Record<string, string> = {
  "\\alpha": "α",
  "\\beta": "β",
  "\\Delta": "Δ",
  "\\delta": "δ",
  "\\epsilon": "ε",
  "\\gamma": "γ",
  "\\lambda": "λ",
  "\\mu": "μ",
  "\\omega": "ω",
  "\\pi": "π",
  "\\prod": "∏",
  "\\rho": "ρ",
  "\\sigma": "σ",
  "\\sqrt": "√",
  "\\sum": "Σ",
  "\\theta": "θ",
  "\\times": "×",
  "\\cdot": "·",
  "\\div": "÷",
  "\\pm": "±",
  "\\leq": "≤",
  "\\le": "≤",
  "\\geq": "≥",
  "\\ge": "≥",
  "\\neq": "≠",
  "\\approx": "≈",
  "\\infty": "∞",
  "\\rightarrow": "→",
  "\\to": "→",
}

const SUBSCRIPT_REPLACEMENTS: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
}

const SUPERSCRIPT_REPLACEMENTS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  a: "ᵃ",
  b: "ᵇ",
  c: "ᶜ",
  d: "ᵈ",
  e: "ᵉ",
  f: "ᶠ",
  g: "ᵍ",
  h: "ʰ",
  i: "ⁱ",
  j: "ʲ",
  k: "ᵏ",
  l: "ˡ",
  m: "ᵐ",
  n: "ⁿ",
  o: "ᵒ",
  p: "ᵖ",
  r: "ʳ",
  s: "ˢ",
  t: "ᵗ",
  u: "ᵘ",
  v: "ᵛ",
  w: "ʷ",
  x: "ˣ",
  y: "ʸ",
  z: "ᶻ",
}

function replaceLatexFractions(value: string): string {
  let next = value
  let previous: string

  do {
    previous = next
    next = next.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1) / ($2)")
  } while (next !== previous)

  return next
}

function formatScript(
  marker: "_" | "^",
  value: string,
  replacements: Record<string, string>
): string {
  const formatted = Array.from(value)
    .map((character) => replacements[character])
    .join("")

  return formatted.length === value.length ? formatted : `${marker}{${value}}`
}

function replaceLatexScripts(value: string): string {
  return value
    .replace(/_\{([^{}]+)\}/g, (_, group: string) =>
      formatScript("_", group, SUBSCRIPT_REPLACEMENTS)
    )
    .replace(/\^\{([^{}]+)\}/g, (_, group: string) =>
      formatScript("^", group, SUPERSCRIPT_REPLACEMENTS)
    )
    .replace(/_([A-Za-z0-9+\-=()])/g, (_, group: string) =>
      formatScript("_", group, SUBSCRIPT_REPLACEMENTS)
    )
    .replace(/\^([A-Za-z0-9+\-=()])/g, (_, group: string) =>
      formatScript("^", group, SUPERSCRIPT_REPLACEMENTS)
    )
}

function formatLatex(latex: string): string {
  let next = latex
    .replace(/\\begin\{(?:aligned|align|equation|split)\*?\}/g, "")
    .replace(/\\end\{(?:aligned|align|equation|split)\*?\}/g, "")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\mathrm\{([^{}]*)\}/g, "$1")
    .replace(/\\left/g, "")
    .replace(/\\right/g, "")
    .replace(/\\,/g, " ")
    .replace(/\\!/g, "")
    .replace(/\\%/g, "%")
    .replace(/\\\\/g, "\n")
    .replace(/&/g, "")

  next = replaceLatexFractions(next)

  for (const [command, replacement] of Object.entries(LATEX_REPLACEMENTS)) {
    next = next.replaceAll(command, replacement)
  }

  next = replaceLatexScripts(next)

  return next
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

function LatexMath({
  display,
  latex,
  standalone = false,
}: {
  display: boolean
  latex: string
  standalone?: boolean
}) {
  const formatted = formatLatex(latex)
  const lines = formatted.split("\n").filter(Boolean)

  if (display) {
    return (
      <span aria-label={latex} className="chloei-math chloei-math-display">
        {lines.map((line, index) => (
          <span className="chloei-math-line" key={`${line}-${String(index)}`}>
            {line}
          </span>
        ))}
      </span>
    )
  }

  return (
    <span
      aria-label={latex}
      className={cn(
        "chloei-math",
        standalone ? "chloei-math-standalone-inline" : "chloei-math-inline"
      )}
    >
      {formatted}
    </span>
  )
}

function renderTextWithMath(
  text: string,
  placeholders: MathPlaceholder[]
): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(MATH_PLACEHOLDER_PATTERN)) {
    const matchIndex = match.index
    if (matchIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, matchIndex))
    }

    const placeholderIndex = Number(match[1])
    const placeholder = placeholders[placeholderIndex]
    if (placeholder) {
      nodes.push(
        <LatexMath
          display={placeholder.display}
          key={`math-${String(placeholderIndex)}-${String(matchIndex)}`}
          latex={placeholder.latex}
        />
      )
    } else {
      nodes.push(match[0])
    }

    lastIndex = matchIndex + match[0].length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

function renderChildrenWithMath(
  children: ReactNode,
  placeholders: MathPlaceholder[]
): ReactNode {
  if (typeof children === "string") {
    return renderTextWithMath(children, placeholders)
  }

  if (Array.isArray(children)) {
    const renderedChildren: ReactNode[] = []

    for (const child of children as ReactNode[]) {
      if (typeof child === "string") {
        renderedChildren.push(...renderTextWithMath(child, placeholders))
      } else {
        renderedChildren.push(renderChildrenWithMath(child, placeholders))
      }
    }

    return renderedChildren
  }

  if (isValidElement<{ children?: ReactNode }>(children)) {
    const childElement = children as ReactElement<{ children?: ReactNode }>
    if (childElement.props.children === undefined) {
      return children
    }

    return cloneElement(childElement, {
      children: renderChildrenWithMath(
        childElement.props.children,
        placeholders
      ),
    })
  }

  return children
}

function getSoleMathPlaceholder(
  children: ReactNode,
  placeholders: MathPlaceholder[]
): MathPlaceholder | null {
  const text = extractTextFromNode(children).trim()
  const match = /^@@CHLOEI_MATH_(\d+)@@$/.exec(text)
  if (!match) {
    return null
  }

  return placeholders[Number(match[1])] ?? null
}

function normalizeSourceUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) {
    return ""
  }

  try {
    const parsed = new URL(trimmed)
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return trimmed
  }
}

function isNumericCitationLabel(label: string): boolean {
  const normalized = label.replace(/\s+/g, "").trim()
  return /^\[?\d+\]?$/.test(normalized)
}

const MemoizedMarkdownBlock = memo(
  ({
    content,
    showSourceFavicon,
    sources,
  }: {
    content: string
    showSourceFavicon: boolean
    sources: MessageSource[]
  }) => {
    const mathContent = useMemo(
      () => replaceMathWithPlaceholders(content),
      [content]
    )
    const sourceTitleByUrl = useMemo(() => {
      const nextMap = new Map<string, string>()

      for (const source of sources) {
        const normalizedUrl = normalizeSourceUrl(source.url)
        if (!normalizedUrl) {
          continue
        }

        nextMap.set(normalizedUrl, source.title)
      }

      return nextMap
    }, [sources])

    const components: Components = {
      p: ({ children }) => {
        const soleMath = getSoleMathPlaceholder(
          children,
          mathContent.placeholders
        )
        if (soleMath) {
          return (
            <LatexMath
              display={soleMath.display}
              latex={soleMath.latex}
              standalone={!soleMath.display}
            />
          )
        }

        return (
          <p>{renderChildrenWithMath(children, mathContent.placeholders)}</p>
        )
      },
      li: ({ children }) => (
        <li>{renderChildrenWithMath(children, mathContent.placeholders)}</li>
      ),
      td: ({ children }) => (
        <td>{renderChildrenWithMath(children, mathContent.placeholders)}</td>
      ),
      th: ({ children }) => (
        <th>{renderChildrenWithMath(children, mathContent.placeholders)}</th>
      ),
      strong: ({ children }) => (
        <strong>
          {renderChildrenWithMath(children, mathContent.placeholders)}
        </strong>
      ),
      em: ({ children }) => (
        <em>{renderChildrenWithMath(children, mathContent.placeholders)}</em>
      ),
      code: ({ children, className }) => {
        const codeContent = extractTextFromNode(children).replace(/\n$/, "")
        return (
          <ShikiCode inline={!className} {...(className ? { className } : {})}>
            {codeContent}
          </ShikiCode>
        )
      },
      a: ({ href, children, title }) => {
        if (!href) return <span>{children}</span>
        const rawLabel = extractTextFromNode(children)
        const normalizedHref = normalizeSourceUrl(href)
        const sourceTitle = sourceTitleByUrl.get(normalizedHref)
        const label =
          isNumericCitationLabel(rawLabel) && sourceTitle
            ? sourceTitle
            : rawLabel

        return (
          <Source href={href}>
            <SourceTrigger label={label} showFavicon={showSourceFavicon} />
            <SourceContent
              title={sourceTitle ?? title ?? (label || "Source")}
              description={href}
              showFavicon={showSourceFavicon}
            />
          </Source>
        )
      },
      table: ({ children }) => (
        <div className="chloei-markdown-table">
          <table>{children}</table>
        </div>
      ),
    }

    return (
      <div className="chloei-markdown prose prose-sm max-w-none min-w-0 text-foreground prose-neutral prose-invert prose-headings:font-medium prose-h1:text-2xl prose-code:rounded-sm prose-code:border prose-code:bg-card prose-code:px-1 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:bg-background prose-pre:p-0 prose-ol:list-decimal prose-ul:list-disc prose-li:marker:text-muted-foreground">
        <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
          {mathContent.content}
        </ReactMarkdown>
      </div>
    )
  },
  (prevProps, nextProps) =>
    prevProps.content === nextProps.content &&
    prevProps.showSourceFavicon === nextProps.showSourceFavicon &&
    prevProps.sources === nextProps.sources
)

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock"

export const MemoizedMarkdown = memo(
  ({
    content,
    id,
    className,
    showSourceFavicon = true,
    sources = [],
  }: {
    content: string
    id: string
    className?: string
    showSourceFavicon?: boolean
    sources?: MessageSource[]
  }) => {
    const blocks = useMemo(() => parseMarkdownIntoBlocks(content), [content])

    return (
      <div className={cn("w-full min-w-0 space-y-2", className)}>
        {blocks.map((block, index) => (
          <MemoizedMarkdownBlock
            content={block}
            key={`${id}-block_${String(index)}`}
            showSourceFavicon={showSourceFavicon}
            sources={sources}
          />
        ))}
      </div>
    )
  }
)

MemoizedMarkdown.displayName = "MemoizedMarkdown"
