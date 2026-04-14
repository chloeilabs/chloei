"use client"

import { Check, Copy } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { getHighlighter } from "@/lib/editor/highlighter"
import { cn } from "@/lib/utils"

import { Button } from "./button"

function resolveLanguageName(language?: string, className?: string): string {
  const rawLanguage =
    language ?? className?.replace(/language-/, "").trim() ?? ""
  const normalizedLanguage = rawLanguage.toLowerCase()

  if (!normalizedLanguage || normalizedLanguage === "plaintext") {
    return "Code"
  }

  const LANGUAGE_LABELS: Record<string, string> = {
    bash: "Bash",
    css: "CSS",
    go: "Go",
    html: "HTML",
    java: "Java",
    javascript: "JavaScript",
    js: "JavaScript",
    json: "JSON",
    jsx: "JSX",
    markdown: "Markdown",
    md: "Markdown",
    python: "Python",
    py: "Python",
    rust: "Rust",
    sh: "Shell",
    sql: "SQL",
    text: "Text",
    ts: "TypeScript",
    tsx: "TSX",
    typescript: "TypeScript",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
  }

  return (
    LANGUAGE_LABELS[normalizedLanguage] ??
    normalizedLanguage.charAt(0).toUpperCase() + normalizedLanguage.slice(1)
  )
}

function normalizeHighlightedCodeHtml(html: string): string {
  return html.replace(
    /background-color:[^;"]+;?/gi,
    "background-color:transparent;"
  )
}

export function ShikiCode({
  children,
  className,
  inline = false,
  language,
}: {
  children: string
  className?: string
  inline?: boolean
  language?: string
}) {
  const [highlightedCode, setHighlightedCode] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const blockContainerRef = useRef<HTMLElement | null>(null)
  const { copyToClipboard, isCopied } = useCopyToClipboard()
  const languageName = useMemo(
    () => resolveLanguageName(language, className),
    [language, className]
  )

  useEffect(() => {
    async function highlightCode() {
      try {
        const highlighter = await getHighlighter()
        const html = highlighter.codeToHtml(children, {
          lang: language ?? className?.replace(/language-/, "") ?? "plaintext",
          theme: "vesper",
        })
        setHighlightedCode(normalizeHighlightedCodeHtml(html))
      } catch (error) {
        console.warn("Failed to highlight code:", error)
        setHighlightedCode(`<pre><code>${children}</code></pre>`)
      } finally {
        setIsLoading(false)
      }
    }

    void highlightCode()
  }, [children, language, className])

  useLayoutEffect(() => {
    if (inline) {
      return
    }

    blockContainerRef.current?.scrollTo({ left: 0 })
  }, [children, highlightedCode, inline])

  if (inline) {
    return (
      <code
        className={cn(
          "inline rounded bg-muted px-1 py-px font-mono text-xs text-muted-foreground",
          className
        )}
      >
        {children}
      </code>
    )
  }

  const codeFrameClassName =
    "not-prose my-3 w-full min-w-0 overflow-hidden rounded-none border border-border bg-background font-mono text-xs"
  const codeHeaderClassName =
    "flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-2 text-[11px] tracking-wide text-muted-foreground"
  const codeViewportClassName =
    "w-full min-w-0 max-h-[500px] overflow-x-auto overflow-y-auto"
  const codeHeader = (
    <div className={codeHeaderClassName}>
      <span>{languageName}</span>
      <Button
        type="button"
        variant="ghost"
        size="iconXs"
        aria-label={isCopied ? "Copied" : "Copy code"}
        className="translate-x-[3px] text-muted-foreground hover:text-foreground"
        onClick={() => {
          void copyToClipboard(children)
        }}
      >
        {isCopied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </div>
  )

  if (isLoading) {
    return (
      <div className={cn(codeFrameClassName, className)}>
        {codeHeader}

        <pre
          ref={(node) => {
            blockContainerRef.current = node
          }}
          className={cn(
            codeViewportClassName,
            "bg-card/40 p-3 [&_code]:block [&_code]:min-w-full [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0"
          )}
        >
          <code>{children}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className={cn(codeFrameClassName, className)}>
      {codeHeader}
      <div
        ref={(node) => {
          blockContainerRef.current = node
        }}
        className={cn(
          codeViewportClassName,
          "bg-card/40 [&_code]:block [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_pre]:m-0 [&_pre]:w-fit [&_pre]:min-w-full [&_pre]:!bg-transparent [&_pre]:p-3"
        )}
        dangerouslySetInnerHTML={{ __html: highlightedCode }}
      />
    </div>
  )
}
