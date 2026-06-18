import React from "react";
import { useGetRaffles } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Trophy, Users, Clock, Flame } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export function HomePage() {
  const { data, isLoading, error } = useGetRaffles();

  return (
    <div className="space-y-8 animate-in fade-in duration-700">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white uppercase flex items-center gap-3">
          <Flame className="w-10 h-10 text-primary" />
          Active Draws
        </h1>
        <p className="text-muted-foreground font-mono text-sm max-w-2xl">
          Welcome to the underground. Check active raffles, enter for a chance to win exclusive JDM rides, and watch the wheel spin live.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-64 w-full rounded-xl bg-white/5" />
          ))}
        </div>
      ) : error ? (
        <div className="p-8 border border-destructive/20 bg-destructive/10 rounded-xl text-destructive font-mono text-sm">
          Failed to load raffles. The network might be down.
        </div>
      ) : data?.raffles.length === 0 ? (
        <div className="p-12 border border-white/10 bg-white/5 rounded-xl text-center flex flex-col items-center justify-center">
          <Trophy className="w-12 h-12 text-muted-foreground mb-4 opacity-50" />
          <h3 className="text-lg font-bold text-white mb-2">No Active Raffles</h3>
          <p className="text-muted-foreground text-sm font-mono">The garage is quiet right now. Check back later.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {data?.raffles.map(raffle => (
            <RaffleCard key={raffle.id} raffle={raffle} />
          ))}
        </div>
      )}
    </div>
  );
}

function RaffleCard({ raffle }: { raffle: any }) {
  const isActive = raffle.status === "active";
  
  return (
    <Link href={`/raffle/${raffle.id}`} className="group block h-full">
      <div className="h-full flex flex-col bg-card border border-white/10 rounded-xl overflow-hidden hover:border-primary/50 hover:shadow-[0_0_30px_-5px_rgba(255,0,85,0.3)] transition-all duration-300">
        
        <div className="p-6 flex-1 flex flex-col">
          <div className="flex justify-between items-start mb-4">
            <Badge variant={isActive ? "default" : "secondary"} className={isActive ? "bg-primary text-primary-foreground font-bold tracking-wider" : "bg-muted text-muted-foreground font-mono"}>
              {isActive ? "LIVE" : "ENDED"}
            </Badge>
            {raffle.ends_at && isActive && (
              <div className="flex items-center gap-1.5 text-xs font-mono text-accent">
                <Clock className="w-3 h-3" />
                <span>{new Date(raffle.ends_at).toLocaleDateString()}</span>
              </div>
            )}
          </div>
          
          <h2 className="text-2xl font-black uppercase tracking-tight mb-2 group-hover:text-primary transition-colors line-clamp-2">
            {raffle.title}
          </h2>
          
          <p className="text-muted-foreground text-sm line-clamp-3 mb-6 flex-1 font-mono">
            {raffle.description}
          </p>

          <div className="grid grid-cols-2 gap-4 mt-auto border-t border-white/10 pt-4">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-muted-foreground tracking-wider font-bold">Entries</span>
              <div className="flex items-center gap-2 font-mono font-bold text-white">
                <Users className="w-4 h-4 text-secondary" />
                {raffle.winner_count} Winners
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-muted-foreground tracking-wider font-bold">Prizes</span>
              <div className="flex items-center gap-2 font-mono font-bold text-white truncate">
                <Trophy className="w-4 h-4 text-accent" />
                {raffle.prizes.length > 0 ? raffle.prizes[0] : "Mystery"}
                {raffle.prizes.length > 1 && <span className="text-muted-foreground text-xs">+{raffle.prizes.length - 1}</span>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
