import { AUTH_REQUIRED_ENV_NAMES } from "@/lib/server/auth"

export function AuthUnavailableState() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Authentication is unavailable until the server is configured with the
        required environment variables.
      </p>

      <div className="border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium">Required server variables</p>
        <ul className="mt-3 space-y-1 font-mono text-xs text-muted-foreground">
          {AUTH_REQUIRED_ENV_NAMES.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
