"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./logo";
import { MobileMenu } from "./mobile-menu";

export const Header = () => {
  const pathname = usePathname();
  const isDemo = pathname === "/demo";

  return (
    <div className={`${isDemo ? "relative" : "fixed"} z-50 pt-8 md:pt-14 top-0 left-0 w-full`}>
      <header className="flex items-center justify-between container">
        <Link href="/">
          <Logo className="text-foreground" />
        </Link>
        <nav className="flex max-lg:hidden absolute left-1/2 -translate-x-1/2 items-center justify-center gap-x-10">
             <Link
              className="uppercase inline-block font-mono text-sm text-foreground/60 hover:text-foreground/100 duration-150 transition-colors ease-out"
              href="/smart-accounts"
            >
              Smart Accounts
            </Link>
             <Link
              className="uppercase inline-block font-mono text-sm text-foreground/60 hover:text-foreground/100 duration-150 transition-colors ease-out"
              href="https://www.notion.so/Latch-C-Address-Onboarding-Infrastructure-3096bfb65b0f80cca03ef84ed890b599?source=copy_link"
              target="_blank"
            >
              Architecture
            </Link>
             <Link
              className="uppercase inline-block font-mono text-sm text-foreground/60 hover:text-foreground/100 duration-150 transition-colors ease-out"
              href="https://x.com/frankyejezie"
              target="_blank"
            >
              Contact
            </Link>
        </nav>
        <div className="max-lg:hidden w-[100px]" /> {/* Spacer to balance logo */}
        <MobileMenu />
      </header>
    </div>
  );
};
