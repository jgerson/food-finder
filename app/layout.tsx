import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Food Finder",
  description: "Search Food-101 dish photos by text or photo. CLIP in the browser, vectors in turbopuffer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-paper font-sans text-ink antialiased">
        <ClerkProvider signInUrl="/sign-in">{children}</ClerkProvider>
      </body>
    </html>
  );
}
