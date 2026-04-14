"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { authClient } from "@/lib/auth-client"

import { buildAuthHref, getAuthErrorMessage } from "./auth-form-utils"
import { PasswordInput } from "./password-input"

export function SignInForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const signUpHref = buildAuthHref("/sign-up", redirectTo)

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()

    startTransition(() => {
      void (async () => {
        const normalizedEmail = email.trim().toLowerCase()

        if (!normalizedEmail) {
          setErrorMessage("Email is required.")
          return
        }

        if (!password) {
          setErrorMessage("Password is required.")
          return
        }

        try {
          const result = await authClient.signIn.email({
            email: normalizedEmail,
            password,
            callbackURL: redirectTo,
            rememberMe: true,
          })

          if (result.error) {
            setErrorMessage(
              getAuthErrorMessage(
                result.error,
                "Unable to sign in. Please check your credentials and try again."
              )
            )
            return
          }

          setErrorMessage(null)
          router.replace(result.data.url ?? redirectTo)
          router.refresh()
        } catch (error) {
          setErrorMessage(
            getAuthErrorMessage(
              error,
              "Unable to sign in. Please check your credentials and try again."
            )
          )
        }
      })()
    })
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-2">
        <label htmlFor="sign-in-email" className="text-sm font-medium">
          Email
        </label>
        <Input
          id="sign-in-email"
          type="email"
          value={email}
          autoComplete="email"
          placeholder="you@example.com"
          onChange={(event) => {
            setEmail(event.target.value)
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="sign-in-password" className="text-sm font-medium">
          Password
        </label>
        <PasswordInput
          id="sign-in-password"
          value={password}
          autoComplete="current-password"
          placeholder="••••••••"
          onChange={(event) => {
            setPassword(event.target.value)
          }}
        />
      </div>

      {errorMessage ? (
        <p className="text-sm text-destructive">{errorMessage}</p>
      ) : null}

      <Button type="submit" size="lg" disabled={isPending}>
        {isPending ? "Signing In..." : "Sign In"}
      </Button>

      <p className="text-sm text-muted-foreground">
        Need an account?{" "}
        <Link href={signUpHref} className="text-foreground underline">
          Sign up
        </Link>
      </p>
    </form>
  )
}
