"use client"

import Image from "next/image"
import { createContext, useContext } from "react"

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { getSourceLinkMetadata } from "@/lib/shared/source-links"
import { cn } from "@/lib/utils"

const SourceContext = createContext<{
  faviconUrl: string | null
  href: string
  domain: string
} | null>(null)

function useSourceContext() {
  const ctx = useContext(SourceContext)
  if (!ctx) throw new Error("Source.* must be used inside <Source>")
  return ctx
}

interface SourceProps {
  href: string
  children: React.ReactNode
}

export function Source({ href, children }: SourceProps) {
  const sourceLink = getSourceLinkMetadata(href)

  return (
    <SourceContext.Provider value={sourceLink}>
      <HoverCard openDelay={150} closeDelay={0}>
        {children}
      </HoverCard>
    </SourceContext.Provider>
  )
}

interface SourceTriggerProps {
  label?: string | number
  showFavicon?: boolean
  className?: string
}

export function SourceTrigger({
  label,
  showFavicon = false,
  className,
}: SourceTriggerProps) {
  const { faviconUrl, href, domain } = useSourceContext()
  const defaultLabel = domain.replace("www.", "") || "Source"
  const labelToShow = label ?? defaultLabel

  return (
    <HoverCardTrigger asChild>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "inline-flex h-5 max-w-32 items-center gap-1 overflow-hidden rounded-none bg-muted py-0 text-xs text-muted-foreground no-underline transition-colors duration-150 hover:bg-muted-foreground/30 hover:text-primary",
          showFavicon ? "pr-2 pl-1" : "px-1",
          className
        )}
      >
        {showFavicon && faviconUrl && (
          <Image
            src={faviconUrl}
            alt="favicon"
            width={14}
            height={14}
            className="size-3.5 rounded-none"
          />
        )}
        <span className="truncate text-center font-normal tabular-nums">
          {labelToShow}
        </span>
      </a>
    </HoverCardTrigger>
  )
}

interface SourceContentProps {
  title: string
  description: string
  className?: string
  showFavicon?: boolean
}

export function SourceContent({
  title,
  description,
  className,
  showFavicon = true,
}: SourceContentProps) {
  const { faviconUrl, href, domain } = useSourceContext()
  const domainLabel = domain.replace("www.", "") || "Source"

  return (
    <HoverCardContent className={cn("w-80 p-0 shadow-xs", className)}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-col gap-2 p-3"
      >
        <div className="flex items-center gap-1.5">
          {showFavicon && faviconUrl && (
            <Image
              src={faviconUrl}
              alt="favicon"
              className="size-4 rounded-none"
              width={16}
              height={16}
            />
          )}
          <div className="truncate text-sm text-primary">{domainLabel}</div>
        </div>
        <div className="line-clamp-2 text-sm font-medium">{title}</div>
        <div className="line-clamp-2 text-sm text-muted-foreground">
          {description}
        </div>
      </a>
    </HoverCardContent>
  )
}
