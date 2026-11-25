"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const REPO = "https://github.com/vin-doh/haxen-restock-agent";
const LINKS: Array<[string, string]> = [["/", "Overview"], ["/demo", "Try it"], ["/live", "Live on Celo"]];

export default function NavLinks() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>
          {label}
        </Link>
      ))}
      <a href={REPO}>Code</a>
    </nav>
  );
}
