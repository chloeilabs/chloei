"use client"

import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import * as React from "react"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      disableHoverableContent
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 4,
  lighter = false,
  children,
  shortcut = "",
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  shortcut?: string
  lighter?: boolean
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 hidden h-7 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in items-center gap-2 rounded-none border bg-card px-2 py-0.5 text-xs text-balance text-muted-foreground fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 md:flex",
          shortcut && "pr-1",
          lighter && "border-sidebar-border! bg-sidebar-accent!",
          className
        )}
        {...props}
      >
        {children}
        {shortcut && (
          <span className="flex h-5 items-center rounded border border-b-2 border-sidebar-border bg-gradient-to-t from-transparent to-sidebar-accent px-1">
            {shortcut}
          </span>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipTrigger }
