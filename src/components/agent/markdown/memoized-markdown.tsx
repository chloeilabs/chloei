import { marked } from "marked"
import { isValidElement, memo, useMemo } from "react"
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
        <div className="yurie-markdown-table">
          <table>{children}</table>
        </div>
      ),
    }

    return (
      <div className="yurie-markdown prose prose-sm max-w-none min-w-0 text-foreground prose-neutral prose-invert prose-headings:font-medium prose-h1:text-2xl prose-code:rounded-sm prose-code:border prose-code:bg-card prose-code:px-1 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:bg-background prose-pre:p-0 prose-ol:list-decimal prose-ul:list-disc prose-li:marker:text-muted-foreground">
        <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
          {content}
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
