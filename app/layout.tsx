import type { Metadata } from "next";
import Link from "next/link";
import NavLinks from "./NavLinks.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "HaxenMed Restock Agent",
  description: "An agent that restocks a pharmacy and pays its suppliers in their own currency on Celo, inside limits the owner sets.",
};

const REPO = "https://github.com/vin-doh/haxen-restock-agent";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="wrap">
            <Link href="/" className="brand">
              <img src="/logo.png" alt="" width={30} height={30} />
              HaxenMed Restock Agent
            </Link>
            <NavLinks />
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer>
          <div className="wrap">
            Built by HaxenTech for Agents Open for Business (Celo × Loops House), with Textile FX and Altana. Source:{" "}
            <a href={REPO}>github.com/vin-doh/haxen-restock-agent</a>.
          </div>
        </footer>
      </body>
    </html>
  );
}
