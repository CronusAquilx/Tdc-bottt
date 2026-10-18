import React from "react";
import { Link } from "wouter";
import { Flame, Wrench } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-shell min-h-[100dvh] flex flex-col">
      <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-background/90 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2 text-primary font-bold text-xl hover:text-primary/80 transition-colors" data-testid="link-home">
            <Flame className="w-6 h-6" />
            <span className="tracking-tighter">TOKYO DRIFT CUSTOMS</span>
          </Link>
          <nav className="flex items-center gap-5 text-xs font-semibold tracking-widest">
            <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-raffles">RAFFLES</Link>
            <Link href="/staff/login" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-crew"><Wrench size={14}/> CREW DESK</Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 container mx-auto px-4 py-8 md:py-10">
        {children}
      </main>
      <footer className="border-t border-white/10 py-8 mt-12 bg-card">
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
