import type { Metadata, Viewport } from "next";
import { display, dot, mono, sans } from "./fonts";
import "./globals.css";

const description =
  "Turn an RSVP into a refundable commitment. Show up, check in, and get your deposit back.";
const origin = process.env.SHOWUP_AUTH_ORIGIN;

export const metadata: Metadata = {
  metadataBase: origin ? new URL(origin) : undefined,
  title: "Showup | Make showing up mean something",
  description,
  robots: { index: false, follow: false },
  openGraph: {
    title: "Showup | Make showing up mean something",
    description,
    siteName: "Showup",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};
export const viewport: Viewport = { themeColor: "#e9e1cd" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const fonts = [display, sans, mono, dot].map((font) => font.variable).join(" ");
  return (
    <html lang="en" className={fonts}>
      <body>{children}</body>
    </html>
  );
}
