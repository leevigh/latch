"use client";

import Link from "next/link";
import { Button } from "../ui/button";

export function Hero() {
  return (
    <div className="flex flex-col h-svh justify-center items-center relative overflow-hidden bg-background">
      <div className="text-center relative z-10 px-4 max-w-4xl mx-auto">
        <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-primary text-primary-foreground hover:bg-primary/80 mb-6">
          PRE-LAUNCH PROPOSAL
        </div>
        <h1 className="text-5xl sm:text-7xl md:text-8xl font-mono font-bold tracking-tighter mb-6">
          LATCH
        </h1>
        <p className="text-xl sm:text-2xl font-light text-muted-foreground mb-8">
          Latching G-Addresses to C-Addresses on Stellar
        </p>
        <p className="font-mono text-sm sm:text-base text-muted-foreground/80 max-w-[600px] mx-auto mb-12">
          A funding bridge, reference wallet, and user-friendly SDK that lets users onboard to Soroban Smart Accounts without ever touching the old G-address system.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Link href="https://www.notion.so/Latch-C-Address-Onboarding-Infrastructure-3096bfb65b0f80cca03ef84ed890b599?source=copy_link" target="_blank">
            <Button size="lg" variant="rounded" className="font-mono h-12 px-8">
              [Architecture]
            </Button>
          </Link>
          <Link href="/smart-accounts">
            <Button size="lg" variant="outline" className="font-mono h-12 px-8">
              [Demo]
            </Button>
          </Link>
        </div>
      </div>
      
       {/* Background decorative elements */}
      <div className="absolute inset-0 z-0 opacity-20 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/20 rounded-full blur-[120px]" />
      </div>

    </div>
  );
}
