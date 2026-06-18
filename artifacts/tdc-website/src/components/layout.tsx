import React from "react";
import { Link } from "wouter";
import { Flame } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground dark">
      <header className="sticky top-0 z-50 w-full border-b border-white/5 bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-primary font-bold text-xl hover:text-primary/80 transition-colors" data-testid="link-home">
            <Flame className="w-6 h-6" />
            <span className="tracking-tighter">TOKYO DRIFT CUSTOMS</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm font-medium">
            <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-raffles">RAFFLES</Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>
      <footer className="border-t border-white/5 py-8 mt-12 bg-black/20">
        <div className="container mx-auto px-4 flex flex-col md:flex-row items-center justify-between text-muted-foreground text-xs font-mono">
          <p>&copy; {new Date().getFullYear()} TOKYO DRIFT CUSTOMS</p>
          <div className="flex gap-4 mt-4 md:mt-0">
            <span>STAY FAST</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
