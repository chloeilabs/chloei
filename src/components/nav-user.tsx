"use client"

import { SquareArrowRightExit } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"

import { getAuthErrorMessage } from "@/components/auth/auth-form-utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
  return source.charAt(0).toUpperCase()
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
            <SidebarMenuButton
              size="lg"
              className="h-12 pl-1 transition-[width,height,padding,margin] group-data-[collapsible=icon]:mb-2 group-data-[collapsible=icon]:-ml-0.5 group-data-[collapsible=icon]:h-9! group-data-[collapsible=icon]:w-9! group-data-[collapsible=icon]:rounded-[8px] group-data-[collapsible=icon]:pl-1.5! group-data-[state=expanded]:mb-0.5 group-data-[state=expanded]:-ml-0.5 group-data-[state=expanded]:w-[calc(100%+5px)] group-data-[state=expanded]:pl-1.5 aria-expanded:bg-muted"
            >
              <Avatar className="size-6 rounded-full after:rounded-full">
                <AvatarFallback className="rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {getInitials(viewer)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
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
              onClick={handleSignOut}
            >
              <SquareArrowRightExit />
              {isPending ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
