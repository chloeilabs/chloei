import "./globals.css"

import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import localFont from "next/font/local"
import Script from "next/script"
import { Toaster } from "sonner"

import { QueryClientProvider } from "@/components/layout/query-client-provider"
import { cn } from "@/lib/utils"

const isProduction = process.env.NODE_ENV === "production"

const localhostDevCacheResetScript = `
(() => {
  const host = window.location.hostname;
  const isLocalhost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";

  if (!isLocalhost) {
    return;
  }

  const reloadFlag = "chloei:localhost-dev-cache-reset:v1";
  if (window.sessionStorage.getItem(reloadFlag) === "done") {
    return;
  }

  let clearedSomething = false;
  const cleanupTasks = [];

  if ("serviceWorker" in navigator) {
    cleanupTasks.push(
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.all(
            registrations.map(async (registration) => {
              clearedSomething = true;
              await registration.unregister();
            })
          )
        )
        .catch(() => undefined)
    );
  }

  if ("caches" in window) {
    cleanupTasks.push(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.map(async (key) => {
              clearedSomething = true;
              await caches.delete(key);
            })
          )
        )
        .catch(() => undefined)
    );
  }

  Promise.all(cleanupTasks).then(() => {
    if (!clearedSomething) {
      return;
    }

    window.sessionStorage.setItem(reloadFlag, "done");
    window.location.reload();
  });
})();
`.trim()

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
})

const departureMono = localFont({
  src: "./fonts/DepartureMono-Regular.woff2",
  variable: "--font-departure-mono",
})

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0c0a09",
}

export const metadata: Metadata = {
  title: "Chloei",
  description: "Multi-provider AI agent.",
  applicationName: "Chloei",
  manifest: isProduction ? "/manifest.webmanifest" : undefined,
  appleWebApp: isProduction
    ? {
        capable: true,
        statusBarStyle: "black-translucent",
        title: "Chloei",
      }
    : undefined,
  icons: {
    icon: [
      {
        url: "/chloei-black.svg",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/chloei.svg",
        media: "(prefers-color-scheme: dark)",
      },
    ],
    apple: [
      {
        url: "/apple-touch-icon",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("dark font-sans", geistSans.variable, geistMono.variable)}
    >
      <body
        className={cn(departureMono.variable, "overscroll-none antialiased")}
      >
        {isProduction ? null : (
          <Script id="localhost-dev-cache-reset" strategy="beforeInteractive">
            {localhostDevCacheResetScript}
          </Script>
        )}
        <QueryClientProvider>
          {children}
          <Toaster />
        </QueryClientProvider>
      </body>
    </html>
  )
}
