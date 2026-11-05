import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Showup | Make showing up mean something",
  description:
    "Turn an RSVP into a refundable commitment. Show up, check in, and get your deposit back.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
