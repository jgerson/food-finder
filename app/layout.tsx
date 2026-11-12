import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Food Finder",
  description: "Search Food-101 dish photos by text or photo. CLIP in the browser, vectors in turbopuffer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-paper font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
