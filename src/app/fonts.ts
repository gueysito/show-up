import localFont from "next/font/local";

// Self-hosted (SIL Open Font License) so pages make no third-party font requests.
export const display = localFont({
  src: "./fonts/inter-tight.woff2",
  weight: "600 800",
  variable: "--font-display",
  display: "swap",
});
export const sans = localFont({
  src: "./fonts/ibm-plex-sans.woff2",
  weight: "400 600",
  variable: "--font-sans",
  display: "swap",
});
export const mono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-400.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-mono-500.woff2", weight: "500" },
    { path: "./fonts/ibm-plex-mono-600.woff2", weight: "600" },
  ],
  variable: "--font-mono",
  display: "swap",
});
export const dot = localFont({
  src: "./fonts/doto-900.woff2",
  weight: "900",
  variable: "--font-dot",
  display: "swap",
  preload: false,
});
