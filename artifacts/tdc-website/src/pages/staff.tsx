import { useState } from "react";
import type { ChangeEvent, FormEvent, InputHTMLAttributes, ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useActivatePortalAccount, useBootstrapPortal, useCompletePortalOrder, useCreatePortalAccount,
  useGetPortalAccounts, useGetPortalChannels, useGetPortalCrew, useGetPortalOrders,
  useGetPortalPayouts, useGetPortalSession, useInviteAllPortalCrew,
  useInviteOnePortalCrewMember, useLoginPortal, useLogoutPortal, useUpdatePortalPay,
  useProcessPortalPayroll,
  getGetPortalAccountsQueryKey, getGetPortalChannelsQueryKey, getGetPortalCrewQueryKey,
  getGetPortalOrdersQueryKey, getGetPortalPayoutsQueryKey, getGetPortalSessionQueryKey,
} from "@workspace/api-client-react";
import type { PortalRole } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity, BadgeDollarSign, Boxes, Check, ChevronRight,
  ClipboardList, Gauge, Hash, LockKeyhole, LogOut, Menu, MessageSquareText,
  PackageCheck, Settings2, ShieldCheck, UserPlus, Users, Wrench,
} from "lucide-react";

const roles: PortalRole[] = ["owner", "head_manager", "manager", "trainer", "mechanic"];
const cash = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const stamp = (value?: string | null) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const dateOnly = (value?: string | null) => value ? new Date(value).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "—";
const titleCase = (s: string) => s.replaceAll("_", " ");
const isLead = (role?: PortalRole | null) => role === "owner" || role === "head_manager";
const canManageCrew = (role?: PortalRole | null) => isLead(role) || role === "manager";
const isCompletedStatus = (status: string) => ["complete", "approved", "paid"].includes(status.toLowerCase());

export function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "error" | "success" }) {
  return <div role="status" data-testid={`notice-${kind}`} className={`rounded-lg border px-4 py-3 text-sm ${kind === "error" ? "border-red-300 bg-red-50 text-red-800" : kind === "success" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-border bg-card text-muted-foreground"}`}>{children}</div>;
}
export function QueryState({ loading, error, retry }: { loading: boolean; error: boolean; retry: () => void }) {
  if (loading) return <div className="space-y-3" aria-label="Loading"><Skeleton className="h-12 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>;
  if (error) return <Notice kind="error"><span>Could not load this desk view. </span><button className="font-semibold underline" onClick={retry} data-testid="button-retry">Try again</button></Notice>;
  return null;
}
function Field({ label, id, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }) {
  return <label htmlFor={id} className="grid gap-1.5 text-sm font-medium text-foreground">{label}<Input id={id} className="tdc-input" {...props} /></label>;
}

export function PortalAuthPage({ mode }: { mode: "login" | "setup" | "activate" }) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const query = new URLSearchParams(window.location.search);
  const token = query.get("token") || "";
  const login = useLoginPortal();
  const setup = useBootstrapPortal();
  const activate = useActivatePortalAccount();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [values, setValues] = useState({ username: "", password: "", setupKey: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const change = (key: keyof typeof values) => (e: ChangeEvent<HTMLInputElement>) => setValues(v => ({ ...v, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      if ((mode === "setup" || mode === "activate") && values.password.length < 12) throw new Error("Use at least 12 characters for your password.");
      if (values.password !== values.confirm && mode !== "login") throw new Error("Those passwords do not match.");
      if (mode === "login") {
        const session = await login.mutateAsync({ data: { username: values.username, password: values.password } });
        qc.clear();
        qc.setQueryData(getGetPortalSessionQueryKey(), session);
        setLocation("/staff");
      } else if (mode === "setup") {
        const session = await setup.mutateAsync({ data: { setupKey: values.setupKey, username: values.username, password: values.password } });
        qc.clear();
        qc.setQueryData(getGetPortalSessionQueryKey(), session);
        setLocation("/staff");
      } else {
        if (token.length < 20) throw new Error("This activation link is missing or invalid.");
        const session = await activate.mutateAsync({ data: { token, password: values.password } });
        qc.clear();
        qc.setQueryData(getGetPortalSessionQueryKey(), session);
        setDone(true);
      }
    } catch (err) { setError(err instanceof Error ? err.message : "That request could not be completed. Check the details and try again."); }
    finally { setBusy(false); }
  };
  const heading = mode === "login" ? "Crew access" : mode === "setup" ? "Open the desk" : "Set your password";
  return <main className="min-h-[100dvh] bg-[#e9e5dc] px-4 py-8 md:px-8">
    <div className="mx-auto grid min-h-[calc(100dvh-4rem)] max-w-6xl overflow-hidden rounded-2xl border border-[#d4cec2] bg-[#f8f6f0] shadow-xl md:grid-cols-[.92fr_1.08fr]">
      <aside className="relative flex flex-col justify-between overflow-hidden bg-[#202a32] p-8 text-[#f3eee3] md:p-12">
        <div className="absolute -right-20 -top-20 h-72 w-72 rounded-full border-[1px] border-white/10"/><div className="absolute -right-8 -top-8 h-48 w-48 rounded-full border border-white/10"/>
        <Link href="/" className="relative z-10 flex items-center gap-3" data-testid="link-public-home"><span className="grid h-10 w-10 place-items-center rounded-lg bg-[#cf563f] font-mono font-bold">T/</span><span className="text-sm font-bold tracking-[.16em]">TOKYO DRIFT<br/>CUSTOMS</span></Link>
        <div className="relative z-10 my-16 max-w-md"><p className="tdc-kicker text-[#e5b94f]">Crew operations · Tokyo</p><h1 className="mt-4 text-4xl font-black leading-[1.03] tracking-tight md:text-5xl">The work behind<br/>the build.</h1><p className="mt-5 max-w-sm text-sm leading-6 text-white/65">Orders, crew pay and channel activity. One dependable pit desk, with private access for the team.</p></div>
        <div className="relative z-10 flex items-center gap-2 border-t border-white/10 pt-5 text-xs text-white/50"><ShieldCheck size={15}/> Private crew portal · No Discord sign-in</div>
      </aside>
      <section className="flex items-center justify-center px-6 py-12 md:px-14">
        <div className="w-full max-w-md">
          <p className="tdc-kicker text-primary">{mode === "login" ? "Secure sign-in" : mode === "setup" ? "One-time owner setup" : "One-time activation"}</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight">{done ? "You're activated" : heading}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{done ? "Your password is set and your crew account is ready." : mode === "login" ? "Use the username and private password issued to you." : mode === "setup" ? "Create the first owner account using the one-time setup key." : "Choose a private password to activate your portal account."}</p>
          {done ? <div className="mt-7 space-y-4"><Notice kind="success">Activation complete. Your private crew session is ready.</Notice><Button className="w-full" onClick={() => setLocation("/staff")} data-testid="button-go-login">Open the crew desk</Button></div> :
            <form onSubmit={submit} className="mt-7 space-y-4" data-testid={`form-${mode}`}>
              {mode !== "activate" && <Field id={`${mode}-username`} label="Username" autoComplete="username" value={values.username} onChange={change("username")} required maxLength={64} data-testid="input-username"/>}
              {mode === "setup" && <Field id="setup-key" label="One-time setup key" type="password" autoComplete="off" value={values.setupKey} onChange={change("setupKey")} required data-testid="input-setup-key"/>}
              <Field id={`${mode}-password`} label={mode === "login" ? "Password" : "Create password"} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={values.password} onChange={change("password")} required minLength={mode === "login" ? 1 : 12} data-testid="input-password"/>
              {mode !== "login" && <Field id="confirm-password" label="Confirm password" type="password" autoComplete="new-password" value={values.confirm} onChange={change("confirm")} required minLength={12} data-testid="input-confirm-password"/>}
              {error && <Notice kind="error">{error}</Notice>}
              <Button disabled={busy} className="mt-2 w-full" type="submit" data-testid="button-submit-auth">{busy ? "Working…" : mode === "login" ? "Sign in to the desk" : mode === "setup" ? "Create owner account" : "Activate account"}</Button>
              {mode === "login" && <p className="pt-2 text-center text-xs text-muted-foreground">First owner? <Link href="/staff/setup" className="font-semibold text-primary underline-offset-4 hover:underline" data-testid="link-first-setup">Set up the portal</Link></p>}
            </form>}
        </div>
      </section>
    </div>
  </main>;
}

export function StaffShell({ children, active }: { children: ReactNode; active: string }) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const session = useGetPortalSession();
  const logout = useLogoutPortal();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  if (session.isLoading) return <main className="min-h-[100dvh] bg-background p-6"><div className="mx-auto max-w-7xl space-y-5"><Skeleton className="h-16 w-full"/><Skeleton className="h-72 w-full"/></div></main>;
  if (session.error) return <main className="grid min-h-[100dvh] place-items-center bg-[#eeeae1] p-5"><section className="tdc-panel w-full max-w-lg space-y-4 p-8"><p className="tdc-kicker text-primary">Connection issue</p><h1 className="text-2xl font-bold">The desk could not verify your session.</h1><Notice kind="error">Your sign-in state is unavailable. Retry to check it again.</Notice><Button className="w-full" onClick={() => void session.refetch()} data-testid="button-retry-session">Retry session check</Button></section></main>;
  if (!session.data?.account) {
    const needsSetup = session.data?.initialized === false;
    return <main className="grid min-h-[100dvh] place-items-center bg-[#eeeae1] p-5"><section className="tdc-panel w-full max-w-lg p-8 text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-[#f7e4de] text-primary"><LockKeyhole size={21}/></span><p className="tdc-kicker mt-5 text-primary">Private crew access</p><h1 className="mt-2 text-2xl font-bold">{needsSetup ? "Set up the TDC desk" : "Sign in to continue"}</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">{needsSetup ? "This portal has not been initialized yet. The first owner can create the portal using the one-time setup key." : "This page is for active crew accounts. Sign in with your private username and password."}</p><Button className="mt-6 w-full" onClick={() => setLocation(needsSetup ? "/staff/setup" : "/staff/login")} data-testid="button-staff-auth-redirect">{needsSetup ? "Open first-owner setup" : "Go to crew sign-in"}</Button><Link href="/" className="mt-4 inline-block text-xs text-muted-foreground underline-offset-4 hover:underline" data-testid="link-back-public">Back to public raffles</Link></section></main>;
  }
  const account = session.data.account;
  const links = [
    { href: "/staff", label: "Overview", icon: Gauge, show: true },
    { href: "/staff/orders", label: "Orders", icon: ClipboardList, show: true },
    { href: "/staff/crew", label: "Crew & pay", icon: Users, show: canManageCrew(account.role) },
    { href: "/staff/timeclock", label: "Timeclock", icon: Gauge, show: true },
    { href: "/staff/leave", label: "Leave", icon: Activity, show: true },
    { href: "/staff/bank", label: "Bank", icon: BadgeDollarSign, show: canManageCrew(account.role) },
    { href: "/staff/crew-admin", label: "Crew admin", icon: Wrench, show: canManageCrew(account.role) },
    { href: "/staff/channels", label: "Sales channels", icon: MessageSquareText, show: true },
    { href: "/staff/accounts", label: "Portal accounts", icon: Settings2, show: isLead(account.role) },
  ];
  const signOut = async () => {
    setLogoutError("");
    try {
      await logout.mutateAsync();
      qc.clear();
      setLocation("/staff/login");
    } catch {
      setLogoutError("Sign out could not be completed. Please try again.");
    }
  };
  return <div className="min-h-[100dvh] bg-[#eeeae1] text-foreground">
    <header className="sticky top-0 z-30 flex h-[66px] items-center justify-between border-b border-[#d8d2c7] bg-[#f8f6f0]/95 px-4 backdrop-blur md:px-7">
      <div className="flex items-center gap-3"><button onClick={() => setMobileOpen(x => !x)} className="grid h-9 w-9 place-items-center rounded-md border border-border md:hidden" aria-label="Toggle navigation" data-testid="button-menu"><Menu size={18}/></button><Link href="/staff" className="flex items-center gap-3" data-testid="link-staff-home"><span className="grid h-9 w-9 place-items-center rounded-md bg-[#cf563f] font-mono font-bold text-white">T/</span><span className="text-[13px] font-extrabold tracking-[.15em]">TDC <span className="font-normal text-muted-foreground">/ PIT DESK</span></span></Link></div>
      <div className="flex items-center gap-3"><div className="hidden text-right sm:block"><p className="text-sm font-semibold" data-testid="text-session-username">{account.username}</p><p className="tdc-kicker text-muted-foreground">{titleCase(account.role)}</p></div><button onClick={signOut} disabled={logout.isPending} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-muted" data-testid="button-logout"><LogOut size={14}/><span className="hidden sm:inline">Sign out</span></button></div>
    </header>
    <div className="mx-auto grid max-w-[1600px] md:grid-cols-[230px_minmax(0,1fr)]">
      <aside className={`${mobileOpen ? "block" : "hidden"} fixed inset-x-0 top-[66px] z-20 max-h-[calc(100dvh-66px)] overflow-y-auto border-b border-[#38424a] bg-[#202a32] p-4 text-[#eee8dd] md:sticky md:top-[66px] md:block md:h-[calc(100dvh-66px)] md:max-h-none md:overflow-visible md:border-b-0 md:border-r md:border-[#38424a] md:p-5`}>
        <p className="tdc-kicker mb-3 px-3 text-white/40">Operations</p>
        <nav className="space-y-1">{links.filter(l => l.show).map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${active === href ? "bg-[#34414a] text-white" : "text-white/65 hover:bg-white/5 hover:text-white"}`} data-testid={`link-nav-${href.split("/").pop() || "overview"}`}><Icon size={16}/>{label}{active === href && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#e0b448]"/>}</Link>)}</nav>
        <div className="mt-10 rounded-lg border border-white/10 bg-white/[.035] p-4"><p className="tdc-kicker text-[#e0b448]">Desk status</p><div className="mt-2 flex items-center gap-2 text-xs text-white/70"><span className="h-2 w-2 rounded-full bg-[#72a78a]"/>Private session active</div><p className="mt-2 text-[11px] leading-5 text-white/40">Account access is managed by your TDC lead.</p></div>
        <div className="absolute bottom-5 left-5 hidden items-center gap-2 text-[10px] tracking-widest text-white/30 md:flex"><Wrench size={12}/> BUILT FOR THE BAY</div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">{logoutError && <div className="mb-4"><Notice kind="error">{logoutError}</Notice></div>}{children}</main>
    </div>
  </div>;
}

export function PageHead({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="tdc-kicker text-primary">{eyebrow}</p><h1 className="mt-1 text-3xl font-bold tracking-tight md:text-[2.15rem]" data-testid="text-page-title">{title}</h1><p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{detail}</p></div>{action}</div>;
}
function Metric({ label, value, hint, icon: Icon, accent = "coral" }: { label: string; value: string; hint: string; icon: typeof Gauge; accent?: "coral" | "gold" | "green" }) {
  return <article className="tdc-panel p-5"><div className="flex items-start justify-between"><div><p className="tdc-kicker text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-bold tracking-tight" data-testid={`metric-${label.toLowerCase().replaceAll(" ", "-")}`}>{value}</p></div><span className={`grid h-9 w-9 place-items-center rounded-lg ${accent === "gold" ? "bg-[#f5eccf] text-[#896510]" : accent === "green" ? "bg-[#e0eee5] text-[#47785a]" : "bg-[#f7e4de] text-[#b34c37]"}`}><Icon size={17}/></span></div><p className="mt-2 text-xs text-muted-foreground">{hint}</p></article>;
}
export function Empty({ icon: Icon, title, detail }: { icon: typeof Gauge; title: string; detail: string }) {
  return <div className="flex flex-col items-center justify-center px-6 py-14 text-center"><span className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground"><Icon size={21}/></span><h3 className="mt-4 font-semibold">{title}</h3><p className="mt-1 max-w-sm text-sm text-muted-foreground">{detail}</p></div>;
}

export function StaffHome() {
  const session = useGetPortalSession();
  const orders = useGetPortalOrders({ limit: 12 });
  const crewAllowed = canManageCrew(session.data?.account?.role);
  const crew = useGetPortalCrew({ query: { enabled: crewAllowed, queryKey: getGetPortalCrewQueryKey() } });
  const channels = useGetPortalChannels({});
  const payouts = useGetPortalPayouts({ limit: 5 });
  const qc = useQueryClient();
  const retry = () => { void qc.invalidateQueries({ queryKey: getGetPortalOrdersQueryKey({ limit: 12 }) }); void qc.invalidateQueries({ queryKey: getGetPortalCrewQueryKey() }); void qc.invalidateQueries({ queryKey: getGetPortalChannelsQueryKey({}) }); void qc.invalidateQueries({ queryKey: getGetPortalPayoutsQueryKey({ limit: 5 }) }); };
  const orderList = orders.data?.orders || [];
  const done = orderList.filter(o => isCompletedStatus(o.status));
  return (
    <StaffShell active="/staff">
      <PageHead eyebrow="Shift overview / live" title="Good work starts here." detail="Your operations desk for the shop floor, crew earnings and the latest sales activity." />
      <QueryState loading={orders.isLoading || channels.isLoading || payouts.isLoading} error={!!(orders.error || channels.error || payouts.error)} retry={retry} />
      {!orders.isLoading && !orders.error && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Open orders" value={String(orderList.filter(o => o.status.toLowerCase() === "draft").length)} hint="Draft orders in this shift" icon={ClipboardList} />
            <Metric label="Completed" value={String(done.length)} hint="In the current order view" icon={PackageCheck} accent="green" />
            <Metric label="Crew on roster" value={!crewAllowed ? "Restricted" : crew.error ? "Unavailable" : crew.isLoading ? "—" : String(crew.data?.crew.length ?? 0)} hint={!crewAllowed ? "Manager access required" : crew.error ? "Crew data could not load" : "Active shop crew"} icon={Users} accent="gold" />
            <Metric label="Sales channels" value={String(channels.data?.channels.length ?? 0)} hint="Recent channel feeds" icon={Hash} />
          </div>
          <div className="mt-5 grid gap-5 xl:grid-cols-[1.45fr_.85fr]">
            <section className="tdc-panel overflow-hidden">
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <div><p className="tdc-kicker text-primary">Work queue</p><h2 className="mt-1 font-bold">Recent orders</h2></div>
                <Link href="/staff/orders" className="flex items-center gap-1 text-xs font-semibold text-primary" data-testid="link-view-orders">Full order desk <ChevronRight size={14} /></Link>
              </div>
              {orderList.length ? (
                <div className="overflow-x-auto"><table className="tdc-table"><thead><tr><th>Order</th><th>Mechanic</th><th>Status</th><th>Labour</th><th>Logged</th></tr></thead>
                  <tbody>{orderList.slice(0, 6).map(o => <tr key={o.id} data-testid={`row-order-${o.id}`}><td className="font-mono font-bold">{o.order_number}</td><td>{o.mechanic_name}</td><td><Status value={o.status} /></td><td className="font-mono">{cash(o.labour)}</td><td className="text-muted-foreground">{stamp(o.created_at)}</td></tr>)}</tbody>
                </table></div>
              ) : <Empty icon={ClipboardList} title="No orders in view" detail="Orders will appear here as the team logs work." />}
            </section>
            <section className="tdc-panel overflow-hidden">
              <div className="border-b border-border px-5 py-4"><p className="tdc-kicker text-primary">Payout trail</p><h2 className="mt-1 font-bold">Latest payouts</h2></div>
              {payouts.data?.payouts.length ? (
                <div className="divide-y divide-border">{payouts.data.payouts.slice(0, 5).map(p => <div className="flex items-center justify-between px-5 py-3.5" key={p.id} data-testid={`payout-summary-${p.id}`}><div><p className="text-sm font-semibold">{p.mechanic_name}</p><p className="mt-1 text-xs text-muted-foreground">Week of {dateOnly(p.week_start)} · {p.order_count} orders</p></div><div className="text-right"><p className="font-mono text-sm font-bold">{cash(p.amount)}</p><p className="mt-1 text-[10px] text-muted-foreground">{p.paid_at ? "Paid " + dateOnly(p.paid_at) : "Recorded"}</p></div></div>)}</div>
              ) : <Empty icon={BadgeDollarSign} title="No payout history yet" detail="Recorded crew payouts will show here." />}
            </section>
          </div>
          <section className="tdc-panel mt-5 overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="tdc-kicker text-primary">Bay pulse</p><h2 className="mt-1 font-bold">Channel activity</h2></div><Link href="/staff/channels" className="text-xs font-semibold text-primary" data-testid="link-view-channels">Open channels <ChevronRight className="inline" size={14} /></Link></div>
            {channels.data?.channels.length ? (
              <div className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">{channels.data.channels.slice(0, 2).map(ch => <div key={ch.display_name} className="p-5" data-testid={`channel-activity-${ch.display_name}`}><p className="flex items-center gap-2 text-xs font-semibold"><Hash size={14} className="text-primary" />{ch.channel_name || ch.display_name}</p>{ch.messages.slice(0, 2).map(m => <div key={m.id} className="mt-4 border-l-2 border-[#e0b448] pl-3"><p className="text-xs font-semibold">{m.author} <span className="ml-2 font-normal text-muted-foreground">{stamp(m.created_at)}</span></p><p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{m.content || m.embeds[0]?.description || m.embeds[0]?.title || "Embedded sale update"}</p></div>)}</div>)}</div>
            ) : <Empty icon={Activity} title="No channel activity" detail="Channel posts will appear when available." />}
          </section>
        </>
      )}
    </StaffShell>
  );
}

function Status({ value }: { value: string }) {
  const state = value.toLowerCase();
  const color = isCompletedStatus(state) ? "bg-[#e3eee5] text-[#3f7051]" : state === "rejected" ? "bg-red-100 text-red-800" : state === "draft" ? "bg-[#f5ecd0] text-[#86640f]" : "bg-muted text-muted-foreground";
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${color}`} data-testid={`status-${state}`}>{titleCase(value)}</span>;
}

export function OrdersPage() {
  const [status, setStatus] = useState("");
  const [actionError, setActionError] = useState("");
  const params = { status: status || undefined, limit: 100 };
  const { data, isLoading, error } = useGetPortalOrders(params, { query: { queryKey: getGetPortalOrdersQueryKey(params) } });
  const complete = useCompletePortalOrder();
  const qc = useQueryClient();
  const invalidate = async () => { await qc.invalidateQueries({ queryKey: getGetPortalOrdersQueryKey(params) }); await qc.invalidateQueries({ queryKey: getGetPortalCrewQueryKey() }); await qc.invalidateQueries({ queryKey: getGetPortalPayoutsQueryKey({ limit: 100 }) }); };
  return <StaffShell active="/staff/orders"><PageHead eyebrow="Shop floor / orders" title="Order desk" detail="Review visible work, order value and job status. Order visibility follows your portal role."/><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="grid h-7 w-7 place-items-center rounded-md bg-[#f7e4de] text-primary"><Boxes size={15}/></span>{data?.orders.length ?? 0} orders in view</div><label className="flex items-center gap-2 text-xs font-semibold">Status<select value={status} onChange={e => setStatus(e.target.value)} className="tdc-input !w-44 !py-2" data-testid="select-order-status"><option value="">All statuses</option><option value="draft">Draft</option><option value="complete">Complete</option><option value="approved">Approved</option><option value="paid">Paid</option><option value="rejected">Rejected</option></select></label></div>
    {actionError && <div className="mb-3"><Notice kind="error">{actionError}</Notice></div>}
    <div className="tdc-panel overflow-hidden"><QueryState loading={isLoading} error={!!error} retry={() => void qc.invalidateQueries({ queryKey: getGetPortalOrdersQueryKey(params) })}/>{!isLoading && !error && (data?.orders.length ? <div className="overflow-x-auto"><table className="tdc-table"><thead><tr><th>Order no.</th><th>Customer / vehicle</th><th>Mechanic</th><th>Items</th><th>Total</th><th>Labour</th><th>Status</th><th>Logged</th><th>Action</th></tr></thead><tbody>{data.orders.map(o => <tr key={o.id} data-testid={`row-order-${o.id}`}><td className="font-mono font-bold">{o.order_number}{o.is_own_car && <span className="ml-2 rounded bg-muted px-1.5 py-1 text-[9px] uppercase">Own car</span>}</td><td><span>{o.customer_name || "—"}</span>{o.notes && <p className="mt-1 max-w-44 truncate text-[11px] text-muted-foreground" title={o.notes}>{o.notes}</p>}</td><td>{o.mechanic_name}</td><td>{o.items.length} line{ o.items.length === 1 ? "" : "s"}</td><td className="font-mono">{cash(o.total)}</td><td className="font-mono">{cash(o.labour)}</td><td><Status value={o.status}/></td><td className="text-xs text-muted-foreground">{stamp(o.created_at)}</td><td>{o.status.toLowerCase() === "draft" && <Button size="sm" disabled={complete.isPending} onClick={async () => { setActionError(""); try { await complete.mutateAsync({ id: o.id }); await invalidate(); } catch { setActionError(`Order ${o.order_number} could not be completed. Try again.`); } }} data-testid={`button-complete-order-${o.id}`}><Check size={14}/> Complete</Button>}</td></tr>)}</tbody></table></div> : <Empty icon={ClipboardList} title="No matching orders" detail={status ? "Try another status filter to widen your view." : "There are no visible orders yet."}/>)}</div>
  </StaffShell>;
}

export function CrewPage() {
  const session = useGetPortalSession();
  const canEditPay = canManageCrew(session.data?.account?.role);
  const crew = useGetPortalCrew();
  const payouts = useGetPortalPayouts({ limit: 100 });
  const pay = useUpdatePortalPay();
  const payroll = useProcessPortalPayroll();
  const qc = useQueryClient();
  const [person, setPerson] = useState("");
  const [commission, setCommission] = useState("");
  const [cut, setCut] = useState("");
  const [commissionRate, setCommissionRate] = useState("");
  const [managerRate, setManagerRate] = useState("");
  const [message, setMessage] = useState("");
  const [payrollRequestId, setPayrollRequestId] = useState("");
  const [payrollMessage, setPayrollMessage] = useState("");
  const selectedCrew = crew.data?.crew.find(c => c.display_name === person);
  const managerEligible = selectedCrew?.role === "manager" || selectedCrew?.role === "owner";
  const hasPayChanges = Boolean(commission || cut || commissionRate || managerRate);
  const savePay = async (e: FormEvent) => {
    e.preventDefault(); setMessage("");
    try {
      await pay.mutateAsync({
        data: {
          display_name: person,
          commission: commission ? Number(commission) : null,
          manager_cut: cut ? Number(cut) : null,
          commission_rate: commissionRate ? Number(commissionRate) / 100 : null,
          manager_rate: managerRate ? Number(managerRate) : null,
        },
      });
      setMessage(`Pay settings saved for ${person}.`);
      setCommission("");
      setCut("");
      setCommissionRate("");
      setManagerRate("");
      await qc.invalidateQueries({ queryKey: getGetPortalCrewQueryKey() });
    } catch { setMessage("Pay settings could not be saved. Please check the values and try again."); }
  };
  const closePayroll = async () => {
    if (!payrollRequestId.trim()) { setPayrollMessage("Enter the payroll request reference before closing."); return; }
    if (!window.confirm("Confirm payroll close? This sends the weekly crew payroll through the bot.")) return;
    setPayrollMessage("");
    try {
      const result = await payroll.mutateAsync({ data: { request_id: payrollRequestId.trim() } });
      setPayrollMessage(`Payroll close recorded for ${result.mechanicCount} crew members · ${cash(result.totalToBill)} to bill.`);
      setPayrollRequestId("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: getGetPortalCrewQueryKey() }),
        qc.invalidateQueries({ queryKey: getGetPortalPayoutsQueryKey({ limit: 100 }) }),
      ]);
    } catch (err) { setPayrollMessage(err instanceof Error ? err.message : "Payroll close failed. Check your permissions and try again."); }
  };
  return <StaffShell active="/staff/crew"><PageHead eyebrow="People / compensation" title="Crew & pay" detail="A clear weekly picture of labour, commission, crew cut and total pay."/>
    <section className="tdc-panel overflow-hidden"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="tdc-kicker text-primary">Current week</p><h2 className="mt-1 font-bold">Crew earnings</h2></div><div className="tdc-kicker text-muted-foreground">{crew.data?.crew.length ?? 0} crew members</div></div><QueryState loading={crew.isLoading} error={!!crew.error} retry={() => void qc.invalidateQueries({ queryKey: getGetPortalCrewQueryKey() })}/>{!crew.isLoading && !crew.error && (crew.data?.crew.length ? <div className="overflow-x-auto"><table className="tdc-table"><thead><tr><th>Crew member</th><th>Role</th><th>Sales channel</th><th>Orders</th><th>Labour</th><th>Rate</th><th>Commission</th><th>Crew cut</th><th>Total pay</th></tr></thead><tbody>{crew.data.crew.map((c, i) => <tr key={`${c.display_name}-${i}`} data-testid={`row-crew-${i}`}><td className="font-semibold">{c.display_name}</td><td className="capitalize">{titleCase(c.role)}</td><td className="text-muted-foreground">{c.sales_channel || "—"}</td><td>{c.week_orders}</td><td className="font-mono">{cash(c.week_labour)}</td><td className="font-mono">{(c.effective_rate * 100).toFixed(1)}%</td><td className="font-mono">{cash(c.week_commission)}</td><td className="font-mono">{cash(c.crew_cut)} <span className="text-[10px] text-muted-foreground">({c.crew_cut_rate}%)</span></td><td className="font-mono font-bold">{cash(c.total_pay)}</td></tr>)}</tbody></table></div> : <Empty icon={Users} title="No crew data" detail="Crew earnings will appear when the roster is available."/>)}</section>
    {canEditPay && <div className="mt-5 grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
      <section className="tdc-panel p-5">
        <p className="tdc-kicker text-primary">Manager controls</p>
        <h2 className="mt-1 font-bold">Set weekly pay</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Matches /setpay: set this week’s commission or manager cut, and optionally change the ongoing rates. Leave fields blank to keep them unchanged.</p>
        <form className="mt-5 space-y-4" onSubmit={savePay} data-testid="form-pay-update">
          <label className="grid gap-1.5 text-sm font-medium">Crew member
            <select className="tdc-input" value={person} onChange={e => { setPerson(e.target.value); setCommission(""); setCut(""); setCommissionRate(""); setManagerRate(""); setMessage(""); }} required data-testid="select-pay-member">
              <option value="">Choose crew member</option>
              {crew.data?.crew.map((c, i) => <option key={`${c.display_name}-${i}`} value={c.display_name}>{c.display_name}</option>)}
            </select>
          </label>
          <Field id="pay-commission" label="Weekly commission ($)" type="number" min="0" step="0.01" value={commission} onChange={e => setCommission(e.target.value)} data-testid="input-pay-commission"/>
          {managerEligible && <Field id="pay-cut" label="Manager cut this week ($)" type="number" min="0" step="0.01" value={cut} onChange={e => setCut(e.target.value)} data-testid="input-pay-cut"/>}
          <Field id="pay-commission-rate" label="Commission rate (%)" type="number" min="0" max="100" step="0.1" value={commissionRate} onChange={e => setCommissionRate(e.target.value)} data-testid="input-pay-commission-rate"/>
          {managerEligible && <Field id="pay-manager-rate" label="Manager crew-cut rate (%)" type="number" min="0" max="100" step="0.1" value={managerRate} onChange={e => setManagerRate(e.target.value)} data-testid="input-pay-manager-rate"/>}
          <Button type="submit" disabled={pay.isPending || !person || !hasPayChanges} data-testid="button-save-pay"><BadgeDollarSign size={15}/>{pay.isPending ? "Saving…" : "Save pay settings"}</Button>
        </form>
        {message && <p className={`mt-3 text-xs ${message.includes("could not") ? "text-red-700" : "text-emerald-800"}`} role="status" data-testid="status-pay-result">{message}</p>}
      </section>
      <section className="tdc-panel overflow-hidden"><div className="border-b border-border px-5 py-4"><p className="tdc-kicker text-primary">Payroll record</p><h2 className="mt-1 font-bold">Payout history</h2></div><QueryState loading={payouts.isLoading} error={!!payouts.error} retry={() => void qc.invalidateQueries({ queryKey: getGetPortalPayoutsQueryKey({ limit: 100 }) })}/>{!payouts.isLoading && !payouts.error && (payouts.data?.payouts.length ? <div className="overflow-x-auto"><table className="tdc-table"><thead><tr><th>Week starting</th><th>Crew</th><th>Orders</th><th>Hours</th><th>Hourly pay</th><th>Manager cut</th><th>Total payout</th><th>Paid</th></tr></thead><tbody>{payouts.data.payouts.map(p => <tr key={p.id} data-testid={`row-payout-${p.id}`}><td>{dateOnly(p.week_start)}</td><td className="font-semibold">{p.mechanic_name}</td><td>{p.order_count}</td><td>{p.hours_worked}</td><td className="font-mono">{cash(p.hourly_pay)}</td><td className="font-mono">{cash(p.manager_cut)}</td><td className="font-mono font-bold">{cash(p.amount)}</td><td>{p.paid_at ? dateOnly(p.paid_at) : <span className="text-muted-foreground">Not marked paid</span>}</td></tr>)}</tbody></table></div> : <Empty icon={BadgeDollarSign} title="No payout records" detail="Payout entries will appear here when recorded."/>)}</section>
    </div>}
    {canEditPay && <section className="tdc-panel mt-5 p-5">
      <p className="tdc-kicker text-primary">Weekly close</p>
      <div className="mt-2 flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div><h2 className="text-lg font-bold">Process crew payroll</h2><p className="mt-1 max-w-xl text-sm text-muted-foreground">Runs the regular payroll close through the bot. Confirm before posting the close.</p></div>
        <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto">
          <label className="sr-only" htmlFor="payroll-request-id">Payroll request reference</label>
          <Input id="payroll-request-id" className="tdc-input sm:w-64" value={payrollRequestId} onChange={e => setPayrollRequestId(e.target.value)} placeholder="Payroll request reference" data-testid="input-payroll-request-id"/>
          <Button disabled={payroll.isPending || !payrollRequestId.trim()} onClick={() => void closePayroll()} data-testid="button-process-payroll">{payroll.isPending ? "Closing…" : "Close payroll"}</Button>
        </div>
      </div>
      {payrollMessage && <div className="mt-3"><Notice kind={payrollMessage.includes("failed") || payrollMessage.includes("Enter") ? "error" : "success"}>{payrollMessage}</Notice></div>}
    </section>}
  </StaffShell>;
}

export function ChannelsPage() {
  const { data, isLoading, error } = useGetPortalChannels({});
  const qc = useQueryClient();
  return <StaffShell active="/staff/channels"><PageHead eyebrow="Signal / sales channels" title="Channel activity" detail="Recent messages and bot-posted sales summaries from the shop channels. Access is restricted by role."/>
    <QueryState loading={isLoading} error={!!error} retry={() => void qc.invalidateQueries({ queryKey: getGetPortalChannelsQueryKey({}) })}/>
    {!isLoading && !error && (data?.channels.length ? <div className="space-y-4">{data.channels.map(channel => <section key={channel.display_name} className="tdc-panel overflow-hidden" data-testid={`channel-${channel.display_name}`}><header className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="tdc-kicker text-primary">Discord sales feed</p><h2 className="mt-1 flex items-center gap-2 font-bold"><Hash size={16} className="text-muted-foreground"/>{channel.channel_name || channel.display_name}</h2></div><span className="rounded-full bg-muted px-3 py-1 text-[10px] font-semibold text-muted-foreground">{channel.messages.length} messages</span></header>{channel.messages.length ? <div className="divide-y divide-border">{channel.messages.map(m => <article key={m.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[150px_minmax(0,1fr)]" data-testid={`message-${m.id}`}><div><p className="text-sm font-semibold">{m.author}</p><p className="mt-1 text-[11px] text-muted-foreground">{stamp(m.created_at)}{m.is_bot && <span className="ml-2 rounded bg-[#f5ecd0] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#86640f]">Bot</span>}</p></div><div>{m.content && <p className="whitespace-pre-wrap text-sm leading-6">{m.content}</p>}{m.embeds.map((embed, i) => <div className="mt-2 rounded-md border-l-[3px] border-[#d5a934] bg-[#f4f0e6] px-4 py-3" key={i}>{embed.title && <h3 className="text-sm font-bold">{embed.title}</h3>}{embed.description && <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-muted-foreground">{embed.description}</p>}{embed.fields.length > 0 && <dl className="mt-3 grid gap-2 sm:grid-cols-2">{embed.fields.map((f, j) => <div key={j}><dt className="tdc-kicker text-muted-foreground">{f.name}</dt><dd className="mt-1 whitespace-pre-wrap text-xs leading-5">{f.value}</dd></div>)}</dl>}</div>)}{!m.content && !m.embeds.length && <p className="text-xs italic text-muted-foreground">Message has no text content.</p>}</div></article>)}</div> : <Empty icon={MessageSquareText} title="Channel is quiet" detail="No recent messages were returned for this sales channel." />}</section>)}</div> : <section className="tdc-panel"><Empty icon={MessageSquareText} title="No channels available" detail="Sales-channel activity will appear when feeds are configured."/></section>)}
  </StaffShell>;
}

export function AccountsPage() {
  const session = useGetPortalSession();
  const allowed = isLead(session.data?.account?.role);
  const accounts = useGetPortalAccounts({ query: { enabled: allowed, queryKey: getGetPortalAccountsQueryKey() } });
  const create = useCreatePortalAccount();
  const inviteAll = useInviteAllPortalCrew();
  const inviteOne = useInviteOnePortalCrewMember();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<PortalRole>("manager");
  const [crewName, setCrewName] = useState("");
  const [result, setResult] = useState("");
  const [activationLink, setActivationLink] = useState("");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: getGetPortalAccountsQueryKey() }); };
  const addAccount = async (e: FormEvent) => {
    e.preventDefault(); setResult(""); setActivationLink("");
    try { const res = await create.mutateAsync({ data: { username, role } }); setResult(`Account created for ${res.account.username}. Share this one-time activation link with them.`); setActivationLink(res.setup_url); setUsername(""); await refresh(); }
    catch { setResult("Account could not be created. Verify the username and role."); }
  };
  const sendAll = async () => {
    setResult(""); setActivationLink("");
    try { const res = await inviteAll.mutateAsync(); setResult(`Invitations sent: ${res.sent} · skipped: ${res.skipped}${res.failures.length ? ` · failed: ${res.failures.join(", ")}` : ""}`); await refresh(); }
    catch { setResult("Crew invitations could not be sent. Try again."); }
  };
  const sendOne = async (e: FormEvent) => {
    e.preventDefault(); setResult(""); setActivationLink("");
    try { const res = await inviteOne.mutateAsync({ data: { display_name: crewName } }); setResult(`Invitation sent: ${res.sent} · skipped: ${res.skipped}${res.failures.length ? ` · failed: ${res.failures.join(", ")}` : ""}`); setCrewName(""); await refresh(); }
    catch { setResult("Invite could not be sent. Check the crew member name."); }
  };
  if (!isLead(session.data?.account?.role)) return <StaffShell active="/staff/accounts"><PageHead eyebrow="Access / restricted" title="Portal accounts" detail="Account management is only available to owners and head managers."/><div className="tdc-panel p-6"><Notice kind="error">Your role does not have permission to manage portal accounts. Contact an owner or head manager.</Notice></div></StaffShell>;
  return <StaffShell active="/staff/accounts"><PageHead eyebrow="Access / portal accounts" title="Manage access" detail="Invite crew, create portal-only leadership accounts and track activation status."/>
    <div className="grid gap-5 xl:grid-cols-3">
      <section className="tdc-panel p-5"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#f7e4de] text-primary"><UserPlus size={17}/></span><p className="tdc-kicker mt-4 text-primary">Crew sync</p><h2 className="mt-1 text-lg font-bold">Invite everyone</h2><p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">Send a private activation invitation to eligible crew members.</p><Button className="mt-4 w-full" onClick={sendAll} disabled={inviteAll.isPending} data-testid="button-invite-all"><Users size={15}/>{inviteAll.isPending ? "Sending invites…" : "Invite all crew"}</Button></section>
      <section className="tdc-panel p-5"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#f5ecd0] text-[#896510]"><MessageSquareText size={17}/></span><p className="tdc-kicker mt-4 text-primary">Single invite</p><h2 className="mt-1 text-lg font-bold">Invite one crew member</h2><form className="mt-3 space-y-3" onSubmit={sendOne}><Field id="crew-invite-name" label="Display name" value={crewName} onChange={e => setCrewName(e.target.value)} placeholder="Crew member name" required data-testid="input-invite-name"/><Button type="submit" disabled={inviteOne.isPending} className="w-full" data-testid="button-invite-one">{inviteOne.isPending ? "Sending…" : "Send invitation"}</Button></form></section>
      <section className="tdc-panel p-5"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#e0eee5] text-[#47785a]"><LockKeyhole size={17}/></span><p className="tdc-kicker mt-4 text-primary">Portal-only account</p><h2 className="mt-1 text-lg font-bold">Create boss access</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Creates an account without Discord sign-in. They'll set their own password through activation.</p><form className="mt-3 space-y-3" onSubmit={addAccount}><Field id="account-username" label="Username" value={username} onChange={e => setUsername(e.target.value)} required maxLength={64} data-testid="input-account-username"/><label className="grid gap-1.5 text-sm font-medium">Portal role<select className="tdc-input" value={role} onChange={e => setRole(e.target.value as PortalRole)} data-testid="select-account-role">{roles.map(r => <option key={r} value={r}>{titleCase(r)}</option>)}</select></label><Button type="submit" disabled={create.isPending} className="w-full" data-testid="button-create-account">{create.isPending ? "Creating…" : "Create account"}</Button></form></section>
    </div>
     {result && <div className="mt-4"><Notice kind={result.includes("could not") ? "error" : "success"}>{result}{activationLink && <a className="ml-2 inline-block font-semibold underline underline-offset-4" href={activationLink} target="_blank" rel="noreferrer">Open one-time activation link</a>}</Notice></div>}
    <section className="tdc-panel mt-5 overflow-hidden"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="tdc-kicker text-primary">Access register</p><h2 className="mt-1 font-bold">Portal accounts</h2></div><span className="text-xs text-muted-foreground">{accounts.data?.accounts.length ?? 0} accounts</span></div><QueryState loading={accounts.isLoading} error={!!accounts.error} retry={() => void refresh()}/>{!accounts.isLoading && !accounts.error && (accounts.data?.accounts.length ? <div className="overflow-x-auto"><table className="tdc-table"><thead><tr><th>Username</th><th>Role</th><th>Account status</th><th>Account ID</th></tr></thead><tbody>{accounts.data.accounts.map(a => <tr key={a.id} data-testid={`row-account-${a.id}`}><td className="font-semibold">{a.username}</td><td className="capitalize">{titleCase(a.role)}</td><td><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${a.active ? "bg-[#e3eee5] text-[#3f7051]" : "bg-[#f5ecd0] text-[#86640f]"}`}>{a.active ? "Active" : "Pending activation"}</span></td><td className="font-mono text-xs text-muted-foreground">{a.id}</td></tr>)}</tbody></table></div> : <Empty icon={Users} title="No portal accounts" detail="Create a boss account or send crew invitations to get started."/>)}</section>
  </StaffShell>;
}
