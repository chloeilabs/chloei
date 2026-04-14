import "./globals.css"

import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import localFont from "next/font/local"
import { Toaster } from "sonner"

import { QueryClientProvider } from "@/components/layout/query-client-provider"
import { cn } from "@/lib/utils"

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
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Chloei",
  },
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
        <QueryClientProvider>
          {children}
          <Toaster />
        </QueryClientProvider>
      </body>
    </html>
  )
}
