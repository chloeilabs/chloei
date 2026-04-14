"use client"

import { ArrowUpRight, LayoutGrid } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type LauncherTriggerVariant = "ghost" | "outline"
type LauncherTriggerSize = "icon" | "iconSm" | "iconXs"

interface FamilyApp {
  name: string
  shortName: string
  href: string
  badgeClassName: string
  external?: boolean
}

function isFamilyApp(app: FamilyApp | undefined): app is FamilyApp {
  return app !== undefined
}

// Add future Yurie apps here as they come online.
const YURIE_FAMILY_APPS: FamilyApp[] = [
  {
    name: "Space",
    shortName: "SP",
    href: "https://yuriespace-app-production.up.railway.app",
    badgeClassName:
      "border-stone-950/10 bg-linear-to-br from-violet-200 via-fuchsia-100 to-pink-100 text-stone-950",
    external: true,
  },
  {
    name: "Markets",
    shortName: "MK",
    href: "https://markets.yurie.ai",
    badgeClassName:
      "border-stone-950/10 bg-linear-to-br from-emerald-200 via-lime-100 to-yellow-100 text-stone-950",
    external: true,
  },
  {
    name: "Cloud",
    shortName: "CL",
    href: "https://cloud.yurie.ai",
    badgeClassName:
      "border-stone-950/10 bg-linear-to-br from-cyan-200 via-sky-100 to-indigo-100 text-stone-950",
    external: true,
  },
  {
    name: "Notes",
    shortName: "NO",
    href: "https://notes.yurie.ai",
    badgeClassName:
      "border-stone-950/10 bg-linear-to-br from-amber-200 via-orange-100 to-rose-50 text-stone-950",
    external: true,
  },
].filter(isFamilyApp)

function AppLauncherCard({
  app,
  isCurrent,
  spanTwoColumns = false,
}: {
  app: FamilyApp
  isCurrent: boolean
  spanTwoColumns?: boolean
}) {
  const className = cn(
    "group relative flex min-h-24 flex-col justify-between overflow-hidden bg-background px-4 py-3 transition-colors duration-150 hover:bg-muted/55",
    spanTwoColumns && "col-span-2",
    isCurrent && "bg-muted/40"
  )

  const content = (
    <>
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-foreground/50 to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        aria-hidden
      />

      <div className="flex items-start justify-between gap-3">
        <div
          className={cn(
            "flex size-10 items-center justify-center border font-departureMono text-[11px] tracking-[0.24em] uppercase shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]",
            app.badgeClassName
          )}
        >
          {app.shortName}
        </div>

        {isCurrent ? (
          <span className="border border-border/70 bg-background/80 px-1.5 py-0.5 font-departureMono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            Current
          </span>
        ) : (
          <ArrowUpRight className="mt-0.5 size-3.5 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
        )}
      </div>

      <div className="font-departureMono text-sm tracking-tight text-foreground">
        {app.name}
      </div>
    </>
  )

  if (app.external) {
    return (
      <a
        aria-current={isCurrent ? "page" : undefined}
        className={className}
        href={app.href}
        rel="noreferrer noopener"
        target="_blank"
      >
        {content}
      </a>
    )
  }

  return (
    <Link
      aria-current={isCurrent ? "page" : undefined}
      className={className}
      href={app.href}
    >
      {content}
    </Link>
  )
}

export function AppLauncher({
  className,
  triggerVariant = "ghost",
  triggerSize = "iconSm",
}: {
  className?: string
  triggerVariant?: LauncherTriggerVariant
  triggerSize?: LauncherTriggerSize
}) {
  const pathname = usePathname()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Yurie apps"
          className={className}
          size={triggerSize}
          variant={triggerVariant}
        >
          <LayoutGrid className="size-4" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden border-border/70 bg-background/95 p-0 backdrop-blur-sm"
        sideOffset={8}
      >
        <div className="border-b border-border/70 px-4 py-3">
          <div className="flex items-center gap-2">
            <LayoutGrid className="size-3.5 text-muted-foreground" />
            <div className="font-departureMono text-sm tracking-tight">
              Yurie Apps
            </div>
          </div>
        </div>

        <div className="grid auto-rows-fr grid-cols-2 gap-px bg-border/70 p-px">
          {YURIE_FAMILY_APPS.map((app, index) => {
            const isCurrent = !app.external && pathname === app.href
            const spanTwoColumns =
              YURIE_FAMILY_APPS.length % 2 === 1 &&
              index === YURIE_FAMILY_APPS.length - 1

            return (
              <AppLauncherCard
                key={`${app.name}:${app.href}`}
                app={app}
                isCurrent={isCurrent}
                spanTwoColumns={spanTwoColumns}
              />
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
