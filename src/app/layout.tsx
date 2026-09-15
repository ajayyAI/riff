import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

// Chrome. Dense editor UI sits at 11-14px, which is the size Inter is drawn for.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

// Every number a user can drag or scrub. Tabular figures stop the value jittering
// mid-scrub, which in a motion tool is a correctness problem, not a preference.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "riff",
  description:
    "Draw a character, attach its parts, and make it move. A 2D cutout rig editor.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-riff-desk text-riff-text">
        {children}
      </body>
    </html>
  );
}
