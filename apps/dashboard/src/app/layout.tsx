import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Self-Sustaining Onchain Agent on Base",
  description: "Public dashboard for a smart-account ERC-4337 onchain agent"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
