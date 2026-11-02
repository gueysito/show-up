import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Showup | Event workspace",
  description: "Prepare the rules for a commitment worth keeping.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
