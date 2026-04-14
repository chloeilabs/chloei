"use client"

import { CircleUser, SquareArrowRightExit } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { authClient } from "@/lib/auth-client"
import type { AuthViewer } from "@/lib/shared"

import { getAuthErrorMessage } from "./auth-form-utils"

export function UserMenu({
  viewer,
  className,
  triggerVariant = "ghost",
  triggerSize = "iconSm",
}: {
  viewer: AuthViewer
  className?: string
  triggerVariant?: "ghost" | "outline"
  triggerSize?: "icon" | "iconSm" | "iconXs"
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleSignOut = () => {
    startTransition(() => {
      void (async () => {
        try {
          const result = await authClient.signOut()
          if (result.error) {
            toast.error("Sign out failed", {
              description: getAuthErrorMessage(
                result.error,
                "Unable to sign out. Please try again."
              ),
            })
            return
          }
          router.replace("/sign-in")
          router.refresh()
        } catch (error) {
          toast.error("Sign out failed", {
            description: getAuthErrorMessage(
              error,
              "Unable to sign out. Please try again."
            ),
          })
        }
      })()
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="User menu"
          className={className}
          size={triggerSize}
          variant={triggerVariant}
        >
          <CircleUser className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            {viewer.name ? (
              <span className="text-sm font-medium">{viewer.name}</span>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {viewer.email}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={isPending}
          onSelect={handleSignOut}
        >
          <SquareArrowRightExit className="size-4" />
          {isPending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
