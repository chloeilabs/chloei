"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { getAuthClient } from "@/lib/auth-client"

import { buildAuthHref, getAuthErrorMessage } from "./auth-form-utils"
import { PasswordInput } from "./password-input"

export function SignUpForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const signInHref = buildAuthHref("/sign-in", redirectTo)

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()

    startTransition(() => {
      void (async () => {
        const trimmedName = name.trim()
        const normalizedEmail = email.trim().toLowerCase()

        if (!trimmedName) {
          setErrorMessage("Full name is required.")
          return
        }

        if (!normalizedEmail) {
          setErrorMessage("Email is required.")
          return
        }

        if (password.length < 8) {
          setErrorMessage("Password must be at least 8 characters.")
          return
        }

        if (password !== confirmPassword) {
          setErrorMessage("Passwords do not match.")
          return
        }

        try {
          const authClient = await getAuthClient()
          const result = await authClient.signUp.email({
            name: trimmedName,
            email: normalizedEmail,
            password,
            callbackURL: redirectTo,
          })

          if (result.error) {
            setErrorMessage(
              getAuthErrorMessage(
                result.error,
                "Unable to create your account. Please try again."
              )
            )
            return
          }

          setErrorMessage(null)
          router.replace(redirectTo)
          router.refresh()
        } catch (error) {
          setErrorMessage(
            getAuthErrorMessage(
              error,
              "Unable to create your account. Please try again."
            )
          )
        }
      })()
    })
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Field>
        <FieldLabel htmlFor="sign-up-name">Full Name</FieldLabel>
        <Input
          id="sign-up-name"
          type="text"
          value={name}
          autoComplete="name"
          placeholder="Jane Doe"
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="sign-up-email">Email</FieldLabel>
        <Input
          id="sign-up-email"
          type="email"
          value={email}
          autoComplete="email"
          placeholder="you@example.com"
          onChange={(event) => {
            setEmail(event.target.value)
          }}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="sign-up-password">Password</FieldLabel>
        <PasswordInput
          id="sign-up-password"
          value={password}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          onChange={(event) => {
            setPassword(event.target.value)
          }}
        />
        <FieldDescription>Use at least 8 characters.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="sign-up-confirm-password">
          Confirm Password
        </FieldLabel>
        <PasswordInput
          id="sign-up-confirm-password"
          value={confirmPassword}
          autoComplete="new-password"
          placeholder="Repeat your password"
          revealLabel="confirm password"
          onChange={(event) => {
            setConfirmPassword(event.target.value)
          }}
        />
      </Field>

      {errorMessage ? <FieldError>{errorMessage}</FieldError> : null}

      <Button type="submit" size="lg" disabled={isPending}>
        {isPending ? "Creating Account..." : "Create Account"}
      </Button>

      <p className="text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href={signInHref} className="text-foreground underline">
          Sign in
        </Link>
      </p>
    </form>
  )
}
