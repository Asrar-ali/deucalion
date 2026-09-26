import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Atkinson_Hyperlegible } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Designed by the Braille Institute for low vision. Offered as a toggle rather than the
 * default, because it is a deliberate trade: more distinguishable letterforms, wider set.
 */
const atkinson = Atkinson_Hyperlegible({
  variable: "--font-atkinson",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Deucalion — the living flood map",
  description:
    "Firsthand public posts about a flood, classified, mapped and auditable. Built for CE Strategies by Team Prometheus.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Never block zoom. Pinch-zoom is assistive technology for a lot of people.
  maximumScale: 5,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${atkinson.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full antialiased">
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {children}
        <noscript>
          <p style={{ padding: "1rem", maxWidth: "65ch" }}>
            Deucalion classifies and maps flood reports in the browser, so it needs JavaScript
            enabled. The underlying data and the analysis code are available at
            github.com/Asrar-ali/deucalion if you need the results without running the page.
          </p>
        </noscript>
      </body>
    </html>
  );
}
