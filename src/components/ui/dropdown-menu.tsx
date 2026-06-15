"use client"

import { Menu as DropdownMenuPrimitive } from "@base-ui/react/menu"
import * as React from "react"

import { cn } from "@/lib/utils"

function DropdownMenu({ ...props }: DropdownMenuPrimitive.Root.Props) {
  return <DropdownMenuPrimitive.Root {...props} />
}

function DropdownMenuTrigger({
  asChild,
  children,
  ...props
}: DropdownMenuPrimitive.Trigger.Props & { asChild?: boolean }) {
  if (asChild && React.isValidElement(children)) {
    return (
      <DropdownMenuPrimitive.Trigger
        data-slot="dropdown-menu-trigger"
        render={children}
        {...props}
      />
    )
  }

  return (
    <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props}>
      {children}
    </DropdownMenuPrimitive.Trigger>
  )
}

function DropdownMenuGroup({ ...props }: DropdownMenuPrimitive.Group.Props) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  )
}

function DropdownMenuContent({
  className,
  side,
  align = "start",
  sideOffset = 4,
  alignOffset,
  ...props
}: DropdownMenuPrimitive.Popup.Props &
  Pick<
    DropdownMenuPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset"
  >) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className="z-50"
      >
        <DropdownMenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-none bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden transition duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className
          )}
          {...props}
        />
      </DropdownMenuPrimitive.Positioner>
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & { inset?: boolean }) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-2 text-xs text-muted-foreground data-[inset]:pl-7",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: DropdownMenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-none px-2 py-2 text-xs outline-none select-none",
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:data-highlighted:bg-destructive/10 data-[variant=destructive]:data-highlighted:text-destructive",
        "data-[inset]:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-[variant=destructive]:[&_svg]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
}
