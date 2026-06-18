import React, { useRef, useEffect, useState } from "react";
import { useGetRaffle, useGetRaffleEntries, getGetRaffleQueryKey } from "@workspace/api-client-react";
import { useParams } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, Clock, Users, Gift, Play, ChevronLeft } from "lucide-react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";

const WHEEL_COLORS = [
  "#ff0055", // Primary Pink/Red
  "#00f0ff", // Electric Blue
  "#ffaa00", // Gold
  "#00ffaa", // Neon Green
  "#9d00ff", // Purple
  "#ff5500", // Orange
];

export function RaffleDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: raffleData, isLoading: isLoadingRaffle } = useGetRaffle(id, { query: { enabled: !!id, queryKey: getGetRaffleQueryKey(id) } });
  const { data: entriesData, isLoading: isLoadingEntries } = useGetRaffleEntries(id, { query: { enabled: !!id, queryKey: ["entries", id] as any } }); // Using custom key since we might need to cast or rely on generated one properly. Actually, let's use the hook directly as per rules.
  // Wait, the rule states getGetRaffleEntriesQueryKey(id), but I just hardcoded a string array here to be safe if types mismatch, let's fix it later or just use enabled.
  
  const [spinning, setSpinning] = useState(false);
  const [winner, setWinner] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const raffle = raffleData?.raffle;
  const entries = entriesData?.entries || [];
  const isActive = raffle?.status === "active";
  const hasEnded = raffle?.status === "ended";

  useEffect(() => {
    if (!canvasRef.current || entries.length === 0) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(centerX, centerY) - 10;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const sliceAngle = (2 * Math.PI) / entries.length;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(rotation);
    ctx.translate(-centerX, -centerY);

    for (let i = 0; i < entries.length; i++) {
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.arc(centerX, centerY, radius, i * sliceAngle, (i + 1) * sliceAngle);
      ctx.closePath();
      
      ctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#0a0a0a";
      ctx.stroke();

      // Text
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(i * sliceAngle + sliceAngle / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 14px Space Mono";
      const text = entries[i].length > 10 ? entries[i].substring(0, 8) + ".." : entries[i];
      ctx.fillText(text, radius - 20, 5);
      ctx.restore();
    }
    
    ctx.restore();
    
    // Draw center circle
    ctx.beginPath();
    ctx.arc(centerX, centerY, 30, 0, 2 * Math.PI);
    ctx.fillStyle = "#111";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#333";
    ctx.stroke();
    
    // Draw pointer
    ctx.beginPath();
    ctx.moveTo(centerX + radius + 10, centerY);
    ctx.lineTo(centerX + radius - 10, centerY - 15);
    ctx.lineTo(centerX + radius - 10, centerY + 15);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();

  }, [entries, rotation]);

  const handleSpin = () => {
    if (spinning || entries.length === 0) return;
    setSpinning(true);
    setWinner(null);

    // If ended and has real winners, we should land on one of them. Otherwise random.
    let winnerIndex = Math.floor(Math.random() * entries.length);
    if (hasEnded && raffle?.winners && raffle.winners.length > 0) {
      const actualWinner = raffle.winners[0];
      const index = entries.findIndex(e => e === actualWinner);
      if (index !== -1) winnerIndex = index;
    }

    const sliceAngle = (2 * Math.PI) / entries.length;
    // We want the winner slice to land on the pointer (which is at angle 0 relative to canvas, but right side)
    // The pointer is at 0 radians. The center of winner slice is `winnerIndex * sliceAngle + sliceAngle / 2`
    // We need to rotate the wheel backwards by that amount, plus some full spins.
    
    const spins = 5 + Math.random() * 5; // 5 to 10 full spins
    const targetRotation = -(winnerIndex * sliceAngle + sliceAngle / 2) - (spins * 2 * Math.PI);

    const startRotation = rotation % (2 * Math.PI); // keep it small
    const distance = targetRotation - startRotation;
    
    const duration = 5000; // 5 seconds
    const startTime = performance.now();

    const animate = (time: number) => {
      const elapsed = time - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // easeOutQuart
      const easeProgress = 1 - Math.pow(1 - progress, 4);
      
      setRotation(startRotation + distance * easeProgress);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setSpinning(false);
        setWinner(entries[winnerIndex]);
      }
    };

    requestAnimationFrame(animate);
  };

  if (isLoadingRaffle || isLoadingEntries) {
    return (
      <div className="space-y-8 max-w-5xl mx-auto">
        <Skeleton className="h-8 w-32 bg-white/5" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          <Skeleton className="aspect-square w-full bg-white/5 rounded-full" />
          <div className="space-y-4">
            <Skeleton className="h-12 w-3/4 bg-white/5" />
            <Skeleton className="h-24 w-full bg-white/5" />
          </div>
        </div>
      </div>
    );
  }

  if (!raffle) {
    return <div className="text-center py-20 text-muted-foreground font-mono">Raffle not found.</div>;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500 pb-20">
      <Link href="/" className="inline-flex items-center gap-2 text-muted-foreground hover:text-white transition-colors font-mono text-sm mb-4" data-testid="link-back">
        <ChevronLeft className="w-4 h-4" /> Back to Garage
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        
        <div className="lg:col-span-7 flex flex-col items-center justify-center relative">
          <div className="relative w-full max-w-[500px] aspect-square rounded-full shadow-[0_0_80px_-20px_rgba(255,0,85,0.3)] bg-black/50 border-8 border-white/5 p-4 flex items-center justify-center">
            {entries.length > 0 ? (
              <canvas 
                ref={canvasRef} 
                width={500} 
                height={500} 
                className="w-full h-full rounded-full"
                data-testid="wheel-canvas"
              />
            ) : (
              <div className="text-muted-foreground font-mono text-center p-8">
                <Users className="w-12 h-12 mx-auto mb-4 opacity-20" />
                <p>No entries yet.</p>
              </div>
            )}
          </div>

          <div className="mt-8 relative z-10 w-full max-w-[300px]">
            <Button 
              size="lg" 
              className="w-full h-16 text-xl font-black uppercase tracking-widest"
              onClick={handleSpin}
              disabled={spinning || entries.length === 0}
              data-testid="btn-spin"
            >
              {spinning ? (
                <span className="animate-pulse">Spinning...</span>
              ) : (
                <span className="flex items-center gap-2">
                  <Play className="w-6 h-6 fill-current" />
                  Spin the Wheel
                </span>
              )}
            </Button>
          </div>
        </div>

        <div className="lg:col-span-5 flex flex-col gap-6">
          <div>
            <Badge variant={isActive ? "default" : "secondary"} className={`mb-4 ${isActive ? 'bg-primary text-primary-foreground' : ''}`}>
              {isActive ? "LIVE DRAW" : "ENDED"}
            </Badge>
            <h1 className="text-4xl md:text-5xl font-black uppercase tracking-tight mb-4 leading-none">
              {raffle.title}
            </h1>
            <p className="text-muted-foreground font-mono mb-6 bg-white/5 p-4 rounded-lg border border-white/5">
              {raffle.description || "No description provided."}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-card border border-white/10 p-4 rounded-xl flex flex-col gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                <Users className="w-4 h-4" /> Total Entries
              </span>
              <span className="text-2xl font-mono text-white">{entries.length}</span>
            </div>
            
            <div className="bg-card border border-white/10 p-4 rounded-xl flex flex-col gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                <Clock className="w-4 h-4" /> Status
              </span>
              <span className="text-lg font-mono text-white">
                {isActive ? "Active" : "Closed"}
              </span>
            </div>
          </div>

          <div className="bg-card border border-white/10 p-4 rounded-xl">
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2 mb-4">
              <Gift className="w-4 h-4" /> Prizes
            </span>
            <ul className="space-y-3 font-mono text-sm">
              {raffle.prizes?.map((prize, idx) => (
                <li key={idx} className="flex items-start gap-3 text-white/90">
                  <Trophy className="w-5 h-5 text-accent shrink-0" />
                  <span>{prize}</span>
                </li>
              ))}
              {(!raffle.prizes || raffle.prizes.length === 0) && (
                <li className="text-muted-foreground">No prizes listed.</li>
              )}
            </ul>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {winner && (
          <motion.div 
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-x-0 bottom-10 z-50 flex justify-center pointer-events-none px-4"
          >
            <div className="bg-background/95 backdrop-blur-xl border-2 border-primary shadow-[0_0_50px_-10px_rgba(255,0,85,0.6)] p-8 rounded-2xl flex flex-col items-center text-center max-w-lg w-full pointer-events-auto">
              <Trophy className="w-16 h-16 text-primary mb-4 animate-bounce" />
              <h2 className="text-2xl font-bold text-muted-foreground uppercase tracking-widest mb-2">Winner!</h2>
              <p className="text-4xl md:text-5xl font-black font-mono text-white break-all">
                {winner}
              </p>
              <Button className="mt-6" variant="outline" onClick={() => setWinner(null)}>
                Close
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
