"use client"

import { useEffect } from "react"

import { ChloeiLogoSvg } from "@/components/graphics/logo/logo-svg"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <Empty className="grow">
      <EmptyHeader>
        <EmptyMedia variant="default">
          <span className="block size-10 shrink-0 overflow-hidden">
            <ChloeiLogoSvg />
          </span>
        </EmptyMedia>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>
          We couldn&apos;t load this page. You can try again.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="secondary"
          size="lg"
          onClick={() => {
            reset()
          }}
        >
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  )
}
