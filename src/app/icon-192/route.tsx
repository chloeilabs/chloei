import { createInstallIconResponse } from "@/app/install-icon"

export function GET() {
  return createInstallIconResponse(192)
}
