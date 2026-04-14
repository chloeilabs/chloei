const GOOGLE_FAVICON_ENDPOINT =
  "https://www.google.com/s2/favicons?sz=64&domain_url="

const BLOCKED_HOSTNAME_SUFFIXES = [".internal", ".local", ".localhost"]

interface SourceLinkMetadata {
  domain: string
  faviconUrl: string | null
  href: string
}

export function getSourceLinkMetadata(rawHref: string): SourceLinkMetadata {
  const href = rawHref.trim()
  const parsedUrl = parseSourceUrl(href)
  const domain = getSourceDomain(parsedUrl, href)
  const faviconUrl =
    parsedUrl && isPublicWebHostname(parsedUrl.hostname)
      ? `${GOOGLE_FAVICON_ENDPOINT}${encodeURIComponent(parsedUrl.origin)}`
      : null

  return {
    href,
    domain,
    faviconUrl,
  }
}

function getSourceDomain(parsedUrl: URL | null, href: string): string {
  const hostname = normalizeHostname(parsedUrl?.hostname ?? "")
  if (hostname) {
    return hostname
  }

  const segments = href.split("/").filter(Boolean)
  return segments.at(-1) ?? href
}

function parseSourceUrl(href: string): URL | null {
  if (!href) {
    return null
  }

  try {
    const parsedUrl = new URL(href)
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null
    }

    return parsedUrl
  } catch {
    return null
  }
}

function isPublicWebHostname(rawHostname: string): boolean {
  const hostname = normalizeHostname(rawHostname)

  if (!hostname || /\s/.test(hostname)) {
    return false
  }

  if (
    hostname === "localhost" ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    return false
  }

  if (isIpv4Address(hostname) || isIpv6Address(hostname)) {
    return false
  }

  return hostname.includes(".")
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, "")
}

function isIpv4Address(hostname: string): boolean {
  const segments = hostname.split(".")

  return (
    segments.length === 4 &&
    segments.every(
      (segment) =>
        /^\d{1,3}$/.test(segment) &&
        Number(segment) >= 0 &&
        Number(segment) <= 255
    )
  )
}

function isIpv6Address(hostname: string): boolean {
  const unwrappedHostname = hostname.replace(/^\[/, "").replace(/\]$/, "")
  return unwrappedHostname.includes(":")
}
