import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth/auth-shell"
import { AuthUnavailableState } from "@/components/auth/auth-unavailable-state"
import { SignUpForm } from "@/components/auth/sign-up-form"
import { readSearchParam, sanitizeAuthRedirectPath } from "@/lib/auth-redirect"
import { isAuthConfigured } from "@/lib/server/auth"
import { getCurrentViewer } from "@/lib/server/auth-session"

export default async function SignUpPage({
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
        title="Sign Up Unavailable"
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
    <AuthShell title="Create Account">
      <SignUpForm redirectTo={redirectTo} />
    </AuthShell>
  )
}
