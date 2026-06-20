"use client"

import { Eye, EyeOff } from "lucide-react"
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
        className={cn("pr-11", className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-controls={id}
        aria-label={`${isVisible ? "Hide" : "Show"} ${revealLabel}`}
        aria-pressed={isVisible}
        className="absolute inset-y-0 right-1.5 my-auto text-muted-foreground hover:text-foreground"
        onClick={() => {
          setIsVisible((currentValue) => !currentValue)
        }}
      >
        {isVisible ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  )
}
