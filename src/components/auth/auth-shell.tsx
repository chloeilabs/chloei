import Link from "next/link"

import { RefreshGlow } from "@/components/graphics/effects/refresh-glow"
import { LogoHover } from "@/components/graphics/logo/logo-hover"
import { cn } from "@/lib/utils"

export function AuthShell({
  title,
  description,
  footer,
  children,
}: {
  title: string
  description?: string
  footer?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-full w-full items-center justify-center px-4 py-10 sm:px-6">
      <div className="relative isolate flex w-full max-w-md items-center justify-center">
        <RefreshGlow className="pointer-events-none top-16 left-1/2 z-0 h-[calc(100svh-14rem)] w-screen max-w-5xl -translate-x-1/2" />

        <div className="relative z-10 w-full border border-border bg-background/80 p-6 backdrop-blur-sm sm:p-8">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <Link
                href="/"
                className={cn(
                  "inline-flex items-center gap-3 text-sm font-medium tracking-tight text-foreground"
                )}
              >
                <LogoHover size="md" />
                <span className="font-departureMono">Yurie</span>
              </Link>

              <div className="flex flex-col gap-1">
                <h1 className="font-departureMono text-2xl tracking-tight">
                  {title}
                </h1>
                {description ? (
                  <p className="text-sm text-muted-foreground">{description}</p>
                ) : null}
              </div>
            </div>

            {children}

            {footer ? (
              <div className="border-t border-border pt-4 text-sm text-muted-foreground">
                {footer}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
