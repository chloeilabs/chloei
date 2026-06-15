"use client"

import { SquareArrowRightExit } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"

import { getAuthErrorMessage } from "@/components/auth/auth-form-utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { getAuthClient } from "@/lib/auth-client"
import type { AuthViewer } from "@/lib/shared"

function getInitials(viewer: AuthViewer): string {
  const source = viewer.name.trim() || viewer.email
  if (!source) return "?"
  const parts = source.split(/\s+/).filter(Boolean)
  const first = parts[0]
  const second = parts[1]
  if (first && second) {
    return (first.charAt(0) + second.charAt(0)).toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

export function NavUser({ viewer }: { viewer: AuthViewer }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleSignOut = () => {
    startTransition(async () => {
      try {
        const authClient = await getAuthClient()
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
    })
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="aria-expanded:bg-muted">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                {getInitials(viewer)}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                {viewer.name ? (
                  <span className="truncate font-medium">{viewer.name}</span>
                ) : null}
                <span className="truncate text-xs">{viewer.email}</span>
              </div>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--anchor-width)"
            side="top"
            align="end"
            sideOffset={4}
          >
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
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
