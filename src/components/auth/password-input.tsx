"use client"

import { type ComponentProps, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type PasswordInputProps = Omit<ComponentProps<typeof Input>, "type"> & {
  revealLabel?: string
}

export function PasswordInput({
  className,
  disabled,
  id,
  revealLabel = "password",
  ...props
}: PasswordInputProps) {
  const [isVisible, setIsVisible] = useState(false)

  return (
    <div className="relative">
      <Input
        {...props}
        id={id}
        disabled={disabled}
        type={isVisible ? "text" : "password"}
        className={cn("pr-14", className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-controls={id}
        aria-label={`${isVisible ? "Hide" : "Show"} ${revealLabel}`}
        aria-pressed={isVisible}
        className="absolute top-1/2 right-1 h-7 -translate-y-1/2 px-2 text-[11px] text-muted-foreground hover:bg-transparent hover:text-foreground"
        onClick={() => {
          setIsVisible((currentValue) => !currentValue)
        }}
      >
        {isVisible ? "Hide" : "Show"}
      </Button>
    </div>
  )
}
