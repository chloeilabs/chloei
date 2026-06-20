import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AUTH_REQUIRED_ENV_NAMES } from "@/lib/server/auth"

export function AuthUnavailableState() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Authentication is unavailable until the server is configured with the
        required environment variables.
      </p>

      <Alert>
        <AlertTitle>Required server variables</AlertTitle>
        <AlertDescription>
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {AUTH_REQUIRED_ENV_NAMES.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  )
}
