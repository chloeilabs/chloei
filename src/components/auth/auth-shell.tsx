import Link from "next/link"

import { ChloeiLogoSvg } from "@/components/graphics/logo/logo-svg"
import { Separator } from "@/components/ui/separator"

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
    <div className="flex min-h-full w-full items-center justify-center bg-background px-4 py-10 sm:px-6">
      <div className="relative isolate flex w-full max-w-md items-center justify-center">
        <div className="relative z-10 w-full bg-background/80 p-6 backdrop-blur-sm sm:p-8">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <Link
                href="/"
                className="inline-flex items-center gap-3 text-sm font-medium tracking-tight text-foreground"
              >
                <span className="block size-5 shrink-0 overflow-hidden">
                  <ChloeiLogoSvg />
                </span>
                <span>Chloei</span>
              </Link>

              <div className="flex flex-col gap-1">
                <h1 className="text-2xl tracking-tight">{title}</h1>
                {description ? (
                  <p className="text-sm text-muted-foreground">{description}</p>
                ) : null}
              </div>
            </div>

            {children}

            {footer ? (
              <div className="flex flex-col gap-4 text-sm text-muted-foreground">
                <Separator />
                {footer}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
