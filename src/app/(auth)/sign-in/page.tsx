import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth/auth-shell"
import { AuthUnavailableState } from "@/components/auth/auth-unavailable-state"
import { SignInForm } from "@/components/auth/sign-in-form"
import { readSearchParam, sanitizeAuthRedirectPath } from "@/lib/auth-redirect"
import { isAuthConfigured } from "@/lib/server/auth"
import { getCurrentViewer } from "@/lib/server/auth-session"

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const redirectTo = sanitizeAuthRedirectPath(
    readSearchParam(params.redirectTo)
  )

  if (!isAuthConfigured()) {
    return (
      <AuthShell
        title="Sign In Unavailable"
        footer="Set the required server environment variables, then reload this page."
      >
        <AuthUnavailableState />
      </AuthShell>
    )
  }

  const viewer = await getCurrentViewer()

  if (viewer) {
    redirect(redirectTo)
  }

  return (
    <AuthShell title="Sign In">
      <SignInForm redirectTo={redirectTo} />
    </AuthShell>
  )
}
