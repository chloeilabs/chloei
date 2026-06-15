"use client"

import { PreviewCard as HoverCardPrimitive } from "@base-ui/react/preview-card"
import * as React from "react"

import { cn } from "@/lib/utils"

function HoverCard({ ...props }: HoverCardPrimitive.Root.Props) {
  return <HoverCardPrimitive.Root {...props} />
}

function HoverCardTrigger({
  asChild,
  children,
  ...props
}: HoverCardPrimitive.Trigger.Props & { asChild?: boolean }) {
  if (asChild && React.isValidElement(children)) {
    return (
      <HoverCardPrimitive.Trigger
        data-slot="hover-card-trigger"
        render={children}
        {...props}
      />
    )
  }

  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props}>
      {children}
    </HoverCardPrimitive.Trigger>
  )
}

function HoverCardContent({
  className,
  side,
  align = "center",
  sideOffset = 4,
  alignOffset,
  ...props
}: HoverCardPrimitive.Popup.Props &
  Pick<
    HoverCardPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset"
  >) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className="z-50"
      >
        <HoverCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            "w-64 origin-(--transform-origin) rounded-none border bg-popover p-4 text-popover-foreground shadow-md outline-hidden transition duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className
          )}
          {...props}
        />
      </HoverCardPrimitive.Positioner>
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }
