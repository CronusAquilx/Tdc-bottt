import { useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPortalBankQueryKey, getGetPortalCrewQueryKey, getGetPortalLeaveRequestsQueryKey,
  getGetPortalPayoutsQueryKey, getGetPortalTimeclockQueryKey,
  useAddPortalCrewMember, useCreatePortalLeaveRequest, useForcePortalClockOut,
  useGetPortalBank, useGetPortalCrew, useGetPortalLeaveRequests, useGetPortalSession,
  useGetPortalTimeclock, useMarkPortalCrewPaid, useRecordPortalBankBalance,
  useRemovePortalCrewMember, useResetPortalBankBaseline, useResetPortalTimeclock,
  useReviewPortalLeaveRequest, useReviewPortalTimeclock, useUpdatePortalCrewMember,
} from "@workspace/api-client-react";
import type { PortalCrewMember, PortalRole } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Notice, PageHead, StaffShell } from "@/pages/staff";
import {
  BadgeDollarSign, CalendarDays, Check, Clock3, UserMinus, Users, Wallet,
} from "lucide-react";

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
const dateOnly = (value?: string | null) => value ? new Date(value).toLocaleDateString([], { dateStyle: "medium" }) : "—";
const isManager = (role?: PortalRole | null) => role === "owner" || role === "head_manager" || role === "manager";
const isLead = (role?: PortalRole | null) => role === "owner" || role === "head_manager";
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
function DeskQueryState({ loading, error, retry }: { loading: boolean; error: unknown; retry: () => void }) {
  if (loading) return <div className="space-y-3 p-5" aria-label="Loading records"><Skeleton className="h-12 w-full"/><Skeleton className="h-24 w-full"/><Skeleton className="h-24 w-full"/></div>;
  if (error) return <div className="p-5"><Notice kind="error">{messageOf(error, "The API request could not be loaded.")} <button className="ml-2 font-semibold underline" onClick={retry} data-testid="button-retry-query">Retry</button></Notice></div>;
  return null;
}

export function TimeclockPage() {
  const queryClient = useQueryClient();
  const session = useGetPortalSession();
  const params = { limit: 200 };
  const clock = useGetPortalTimeclock(params, { query: { queryKey: getGetPortalTimeclockQueryKey(params) } });
  const review = useReviewPortalTimeclock();
  const forceOut = useForcePortalClockOut();
  const reset = useResetPortalTimeclock();
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const role = session.data?.account?.role;
  const manager = isManager(role);
  const canReview = manager || role === "trainer";
  const canReset = role === "owner";
  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetPortalTimeclockQueryKey(params) });
  const doReview = async (id: string, decision: "approved" | "rejected") => {
    setActionError(""); setActionMessage("");
    try { await review.mutateAsync({ id, data: { decision } }); await refresh(); }
    catch (error) { setActionError(messageOf(error, "The time entry could not be reviewed. The server may not allow this action.")); }
  };
  const doClockOut = async (entryId: string, name: string) => {
    if (!window.confirm(`Clock out ${name} now?`)) return;
    setActionError(""); setActionMessage("");
    try { await forceOut.mutateAsync({ id: entryId }); await refresh(); }
    catch (error) { setActionError(messageOf(error, "The active shift could not be clocked out.")); }
  };
  const doReset = async () => {
    if (!window.confirm("Emergency reset: clock out every active session? This cannot be undone.")) return;
    setActionError(""); setActionMessage("");
    try {
      const result = await reset.mutateAsync();
      setActionMessage(`Emergency reset complete. ${result.clocked_out} active ${result.clocked_out === 1 ? "session was" : "sessions were"} clocked out.`);
      await refresh();
    } catch (error) { setActionError(messageOf(error, "The emergency reset was rejected or could not be completed.")); }
  };
  return <StaffShell active="/staff/timeclock">
    <PageHead eyebrow="Shift records / timeclock" title="Timeclock" detail="Your visible shift entries and manager review controls. Entry visibility and permissions are enforced by the portal service."
      action={canReset ? <Button variant="destructive" disabled={reset.isPending} onClick={() => void doReset()} data-testid="button-emergency-clock-reset">{reset.isPending ? "Resetting…" : "Emergency reset"}</Button> : undefined}/>
    {actionError && <div className="mb-4"><Notice kind="error">{actionError}</Notice></div>}
    {actionMessage && <div className="mb-4"><Notice kind="success">{actionMessage}</Notice></div>}
    <section className="tdc-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="tdc-kicker text-primary">Shift register</p><h2 className="mt-1 font-bold">Visible entries</h2></div><span className="text-xs text-muted-foreground">{clock.data?.entries.length ?? 0} entries</span></div>
      <DeskQueryState loading={clock.isLoading} error={clock.error} retry={() => void refresh()}/>
      {!clock.isLoading && !clock.error && (clock.data?.entries.length ? <div className="overflow-x-auto"><table className="tdc-table"><thead><tr><th>Crew</th><th>Clocked in</th><th>Clocked out</th><th>Duration</th><th>State</th><th>Notes</th>{canReview && <th>Review / manager action</th>}</tr></thead><tbody>
        {clock.data.entries.map(entry => <tr key={entry.id} data-testid={`row-timeclock-${entry.id}`}><td className="font-semibold">{entry.mechanic_name}</td><td>{dateTime(entry.clock_in_time)}</td><td>{entry.active ? <span className="text-primary">Active shift</span> : dateTime(entry.clock_out_time)}</td><td className="font-mono">{entry.duration_minutes} min</td><td><span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-bold uppercase">{entry.status}</span></td><td className="max-w-48 text-xs text-muted-foreground">{entry.notes || "—"}</td>{canReview && <td><div className="flex flex-wrap gap-2">{entry.status === "pending" && !entry.active && <><Button size="sm" disabled={review.isPending} onClick={() => void doReview(entry.id, "approved")} data-testid={`button-approve-timeclock-${entry.id}`}><Check size={13}/>Approve</Button><Button size="sm" variant="outline" disabled={review.isPending} onClick={() => void doReview(entry.id, "rejected")} data-testid={`button-reject-timeclock-${entry.id}`}>Reject</Button></>}{manager && entry.active && <Button size="sm" variant="outline" disabled={forceOut.isPending} onClick={() => void doClockOut(entry.id, entry.mechanic_name)} data-testid={`button-clockout-${entry.id}`}>Clock out</Button>}</div></td>}</tr>)}
      </tbody></table></div> : <Empty icon={Clock3} title="No time entries yet" detail="Visible crew shifts will appear here when recorded by the connected crew system."/>)}
    </section>
    {!manager && <p className="mt-3 text-xs text-muted-foreground">Management controls are shown only to authorized roles. No clock-in endpoint is available in this portal interface.</p>}
  </StaffShell>;
}

export function LeavePage() {
  const queryClient = useQueryClient();
  const session = useGetPortalSession();
  const params = { status: "all" as const };
  const leave = useGetPortalLeaveRequests(params, { query: { queryKey: getGetPortalLeaveRequestsQueryKey(params) } });
  const create = useCreatePortalLeaveRequest();
  const review = useReviewPortalLeaveRequest();
  const [reason, setReason] = useState("");
  const [startDate, setStartDate] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [notes, setNotes] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const canReview = isManager(session.data?.account?.role);
  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetPortalLeaveRequestsQueryKey(params) });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setActionError(""); setMessage("");
    try {
      await create.mutateAsync({ data: { reason: reason.trim(), start_date: startDate, return_date: returnDate, notes: notes.trim() || undefined } });
      setReason(""); setStartDate(""); setReturnDate(""); setNotes("");
      setMessage("Leave request submitted.");
      await refresh();
    } catch (error) { setActionError(messageOf(error, "The leave request could not be submitted.")); }
  };
  const decide = async (id: string, decision: "approved" | "denied") => {
    setActionError(""); setMessage("");
    try { await review.mutateAsync({ id, data: { decision } }); await refresh(); }
    catch (error) { setActionError(messageOf(error, "The leave request could not be reviewed. Check your permissions.")); }
  };
  return <StaffShell active="/staff/leave">
    <PageHead eyebrow="Crew planning / leave" title="Leave requests" detail="Submit planned time away and review requests visible to your role."/>
    {actionError && <div className="mb-4"><Notice kind="error">{actionError}</Notice></div>}
    {message && <div className="mb-4"><Notice kind="success">{message}</Notice></div>}
    <div className="grid gap-5 xl:grid-cols-[.78fr_1.22fr]">
      <section className="tdc-panel p-5">
        <p className="tdc-kicker text-primary">New request</p><h2 className="mt-1 text-lg font-bold">Plan time away</h2>
        <form onSubmit={submit} className="mt-5 space-y-4" data-testid="form-leave-request">
          <label className="grid gap-1.5 text-sm font-medium">Reason<Input className="tdc-input" value={reason} onChange={e => setReason(e.target.value)} required maxLength={500} data-testid="input-leave-reason"/></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">First day away<Input className="tdc-input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required data-testid="input-leave-start"/></label>
            <label className="grid gap-1.5 text-sm font-medium">Return date<Input className="tdc-input" type="date" value={returnDate} onChange={e => setReturnDate(e.target.value)} required min={startDate || undefined} data-testid="input-leave-return"/></label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">Notes <span className="text-xs font-normal text-muted-foreground">Optional</span><textarea className="tdc-input min-h-24 resize-y" value={notes} onChange={e => setNotes(e.target.value)} maxLength={300} data-testid="input-leave-notes"/></label>
          <Button className="w-full" disabled={create.isPending} type="submit" data-testid="button-submit-leave">{create.isPending ? "Submitting…" : "Submit request"}</Button>
        </form>
      </section>
      <section className="tdc-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4"><p className="tdc-kicker text-primary">Leave register</p><h2 className="mt-1 font-bold">Requests in your view</h2></div>
        <DeskQueryState loading={leave.isLoading} error={leave.error} retry={() => void refresh()}/>
        {!leave.isLoading && !leave.error && (leave.data?.requests.length ? <div className="divide-y divide-border">{leave.data.requests.map(item => <article key={item.id} className="p-5" data-testid={`leave-request-${item.id}`}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{item.mechanic_name}</h3><p className="mt-1 text-xs text-muted-foreground">{dateOnly(item.start_date)} through {dateOnly(item.return_date)}</p></div><span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-bold uppercase">{item.status}</span></div>
          <p className="mt-3 text-sm">{item.reason}</p>{item.notes && <p className="mt-1 text-xs text-muted-foreground">{item.notes}</p>}
          {canReview && item.status === "pending" && <div className="mt-4 flex gap-2"><Button size="sm" disabled={review.isPending} onClick={() => void decide(item.id, "approved")} data-testid={`button-approve-leave-${item.id}`}>Approve</Button><Button size="sm" variant="outline" disabled={review.isPending} onClick={() => void decide(item.id, "denied")} data-testid={`button-deny-leave-${item.id}`}>Deny</Button></div>}
        </article>)}</div> : <Empty icon={CalendarDays} title="No leave requests" detail="New leave requests will appear here with their current review status."/>)}
      </section>
    </div>
  </StaffShell>;
}

export function BankPage() {
  const queryClient = useQueryClient();
  const bank = useGetPortalBank();
  const record = useRecordPortalBankBalance();
  const reset = useResetPortalBankBaseline();
  const markPaid = useMarkPortalCrewPaid();
  const session = useGetPortalSession();
  const [amount, setAmount] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetPortalBankQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetPortalPayoutsQueryKey({ limit: 100 }) }),
    ]);
  };
  const lead = isLead(session.data?.account?.role);
  const saveBalance = async (event: FormEvent) => {
    event.preventDefault(); setActionError(""); setMessage("");
    try {
      const result = await record.mutateAsync({ data: { amount: Number(amount) } });
      setMessage(`Balance recorded at ${money(result.balance)}. Expected ${money(result.expected_balance)}; variance ${money(result.variance)}.`);
      setAmount(""); await refresh();
    } catch (error) { setActionError(messageOf(error, "Balance could not be recorded. Check the amount and your permissions.")); }
  };
  const resetBaseline = async () => {
    if (!amount || Number(amount) < 0) { setActionError("Enter a valid balance before resetting the baseline."); return; }
    if (!window.confirm("Reset the bank comparison baseline to this amount? Existing history will remain, but this changes future reconciliation.")) return;
    setActionError(""); setMessage("");
    try { await reset.mutateAsync({ data: { amount: Number(amount) } }); setMessage("Bank comparison baseline reset."); setAmount(""); await refresh(); }
    catch (error) { setActionError(messageOf(error, "Bank baseline could not be reset.")); }
  };
  const settlePayouts = async () => {
    if (!window.confirm(`Mark payouts paid for ${selected.length} selected crew ${selected.length === 1 ? "member" : "members"}?`)) return;
    setActionError(""); setMessage("");
    try {
      const result = await markPaid.mutateAsync({ data: { discord_ids: selected } });
      setMessage(`${result.marked_count} payout ${result.marked_count === 1 ? "record" : "records"} marked paid · ${money(result.total)}.`);
      setSelected([]); await refresh();
    } catch (error) { setActionError(messageOf(error, "Payouts could not be marked paid.")); }
  };
  return <StaffShell active="/staff/bank">
    <PageHead eyebrow="Finance / reconciliation" title="Bank desk" detail="Compare the real recorded balance with bot-backed expected activity and settle unpaid payouts."/>
    {actionError && <div className="mb-4"><Notice kind="error">{actionError}</Notice></div>}
    {message && <div className="mb-4"><Notice kind="success">{message}</Notice></div>}
    <DeskQueryState loading={bank.isLoading} error={bank.error} retry={() => void queryClient.invalidateQueries({ queryKey: getGetPortalBankQueryKey() })}/>
    {!bank.isLoading && !bank.error && <>
      <section className="tdc-panel p-5">
        <div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/15 text-primary"><Wallet size={18}/></span><div><p className="tdc-kicker text-primary">Cash control</p><h2 className="mt-1 text-lg font-bold">Record a balance</h2><p className="mt-1 text-sm text-muted-foreground">Recording compares this count against expected order revenue and payout activity.</p></div></div>
        <form className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={saveBalance}>
          <label className="grid flex-1 gap-1.5 text-sm font-medium">Current bank balance<input className="tdc-input" type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required data-testid="input-bank-balance"/></label>
          <Button type="submit" disabled={record.isPending} data-testid="button-record-bank">{record.isPending ? "Recording…" : "Record balance"}</Button>
          {lead && <Button type="button" variant="outline" disabled={reset.isPending || !amount} onClick={() => void resetBaseline()} data-testid="button-reset-bank-baseline">{reset.isPending ? "Resetting…" : "Reset baseline"}</Button>}
        </form>
      </section>
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
        <section className="tdc-panel overflow-hidden"><div className="border-b border-border px-5 py-4"><p className="tdc-kicker text-primary">Reconciliation</p><h2 className="mt-1 font-bold">Balance history</h2></div>
          {bank.data?.logs.length ? <div className="overflow-x-auto"><table className="tdc-table"><thead><tr><th>Logged</th><th>Actual</th><th>Expected</th><th>Variance</th><th>Orders</th><th>Recorded by</th></tr></thead><tbody>{bank.data.logs.map(log => <tr key={log.id} data-testid={`row-bank-log-${log.id}`}><td>{dateTime(log.logged_at)}</td><td className="font-mono font-bold">{money(log.balance)}</td><td className="font-mono">{money(log.expected_balance)}</td><td className={`font-mono ${log.variance < 0 ? "text-primary" : ""}`}>{money(log.variance)}</td><td>{log.order_count}</td><td>{log.logged_by_name || log.logged_by}</td></tr>)}</tbody></table></div> : <Empty icon={BadgeDollarSign} title="No bank records yet" detail="Record a balance to begin the reconciliation history."/>}
        </section>
        <section className="tdc-panel overflow-hidden"><div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4"><div><p className="tdc-kicker text-primary">Payout queue</p><h2 className="mt-1 font-bold">Unpaid crew</h2></div><Button size="sm" disabled={!selected.length || markPaid.isPending} onClick={() => void settlePayouts()} data-testid="button-mark-paid">{markPaid.isPending ? "Updating…" : `Mark selected paid (${selected.length})`}</Button></div>
          {bank.data?.unpaid.length ? <div className="divide-y divide-border">{bank.data.unpaid.map(person => <label key={person.discord_id} className="flex cursor-pointer items-center gap-3 px-5 py-4 hover:bg-muted/40" data-testid={`unpaid-person-${person.discord_id}`}><input type="checkbox" checked={selected.includes(person.discord_id)} onChange={e => setSelected(current => e.target.checked ? [...current, person.discord_id] : current.filter(id => id !== person.discord_id))} data-testid={`checkbox-unpaid-${person.discord_id}`} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{person.display_name}</p><p className="mt-1 text-xs text-muted-foreground">{person.payout_count} payout{person.payout_count === 1 ? "" : "s"} · {person.current_pay_status}</p></div><span className="font-mono text-sm font-bold">{money(person.amount)}</span></label>)}</div> : <Empty icon={BadgeDollarSign} title="No unpaid payouts" detail="The current bank view has no outstanding crew payout records."/>}
        </section>
      </div>
    </>}
  </StaffShell>;
}

function CrewMemberEditor({ member, actorRole, selected, canSelect, onToggle, onChanged }: {
  member: PortalCrewMember;
  actorRole: PortalRole;
  selected: boolean;
  canSelect: boolean;
  onToggle: (discordId: string) => void;
  onChanged: () => void;
}) {
  const update = useUpdatePortalCrewMember();
  const remove = useRemovePortalCrewMember();
  const [role, setRole] = useState<"mechanic" | "trainer" | "manager" | "owner" | "head_manager">(member.role);
  const [status, setStatus] = useState(member.status);
  const [cityId, setCityId] = useState(member.in_city_id || "");
  const [error, setError] = useState("");
  const canEdit = actorRole === "owner" ||
    (actorRole === "head_manager" && member.role !== "owner") ||
    (actorRole === "manager" && member.role !== "owner" && member.role !== "manager");
  const canAssignManager = isLead(actorRole);
  const canAssignOwner = actorRole === "owner";
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    try {
      await update.mutateAsync({ discordId: member.discord_id, data: { ...(role === "head_manager" ? {} : { role }), status, in_city_id: cityId.trim() || null } });
      onChanged();
    } catch (reason) { setError(messageOf(reason, `Could not update ${member.display_name}.`)); }
  };
  const removeMember = async () => {
    if (!window.confirm(`Remove ${member.display_name} from the crew roster? Existing orders and payroll history are preserved.`)) return;
    setError("");
    try { await remove.mutateAsync({ discordId: member.discord_id }); onChanged(); }
    catch (reason) { setError(messageOf(reason, `Could not remove ${member.display_name}.`)); }
  };
  return <article className="border-b border-border p-5 last:border-0" data-testid={`crew-admin-member-${member.discord_id}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3">{canSelect && <input type="checkbox" aria-label={`Select ${member.display_name}`} checked={selected} onChange={() => onToggle(member.discord_id)} className="mt-1 h-4 w-4 accent-[#cf563f]" data-testid={`checkbox-select-crew-${member.discord_id}`}/>}<div><h3 className="font-semibold">{member.display_name}</h3><p className="mt-1 font-mono text-[11px] text-muted-foreground">{member.discord_id}</p></div></div><div className="text-right"><span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-bold uppercase">{member.status.replaceAll("_", " ")}</span><p className="mt-2 text-xs text-muted-foreground">In-city ID: {member.in_city_id || "—"}</p></div></div>
    <form className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr_auto_auto]" onSubmit={save}>
      <label className="grid gap-1 text-xs font-semibold">Rank<select className="tdc-input !py-2" value={role} onChange={e => setRole(e.target.value as typeof role)} disabled={!canEdit} data-testid={`select-crew-role-${member.discord_id}`}>{member.role === "head_manager" && <option value="head_manager">Head manager</option>}<option value="mechanic">Mechanic</option><option value="trainer">Trainer</option>{(canAssignManager || member.role === "manager") && <option value="manager" disabled={!canAssignManager}>Manager</option>}{(canAssignOwner || member.role === "owner") && <option value="owner" disabled={!canAssignOwner}>Owner</option>}</select></label>
      <label className="grid gap-1 text-xs font-semibold">Status<select className="tdc-input !py-2" value={status} onChange={e => setStatus(e.target.value as PortalCrewMember["status"])} disabled={!canEdit} data-testid={`select-crew-status-${member.discord_id}`}><option value="online">Online</option><option value="offline">Offline</option><option value="on_break">On break</option></select></label>
      <label className="grid gap-1 text-xs font-semibold">In-city ID<Input className="tdc-input !py-2" value={cityId} onChange={e => setCityId(e.target.value)} maxLength={40} disabled={!canEdit} data-testid={`input-crew-city-${member.discord_id}`}/></label>
      <Button className="self-end" type="submit" disabled={!canEdit || update.isPending} data-testid={`button-save-crew-${member.discord_id}`}>{update.isPending ? "Saving…" : "Save"}</Button>
      <Button className="self-end" type="button" variant="outline" disabled={!canEdit || remove.isPending} onClick={() => void removeMember()} data-testid={`button-remove-crew-${member.discord_id}`}><UserMinus size={14}/>Remove</Button>
    </form>
    {error && <div className="mt-3"><Notice kind="error">{error}</Notice></div>}
  </article>;
}

export function CrewAdminPage() {
  const queryClient = useQueryClient();
  const session = useGetPortalSession();
  const allowed = isManager(session.data?.account?.role);
  const lead = isLead(session.data?.account?.role);
  const crew = useGetPortalCrew({ query: { enabled: allowed, queryKey: getGetPortalCrewQueryKey() } });
  const add = useAddPortalCrewMember();
  const [discordId, setDiscordId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"mechanic" | "trainer" | "manager">("mechanic");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const removeSelected = useRemovePortalCrewMember();
  const actorRole = session.data?.account?.role ?? "mechanic";
  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetPortalCrewQueryKey() });
  const activeCrew = crew.data?.crew ?? [];
  const accountName = session.data?.account?.username.trim().toLocaleLowerCase() ?? "";
  const ownMatches = activeCrew.filter(member => {
    const name = member.display_name.trim().toLocaleLowerCase();
    return name === accountName || name.split(/\s+/)[0] === accountName;
  });
  const ownCrewId = ownMatches.length === 1 ? ownMatches[0].discord_id : "";
  const removable = (member: PortalCrewMember) =>
    member.discord_id !== ownCrewId &&
    (actorRole === "owner" ||
      (actorRole === "head_manager" && member.role !== "owner") ||
      (actorRole === "manager" && member.role !== "owner" && member.role !== "manager"));
  const selectedRemovable = activeCrew.filter(member => selected.includes(member.discord_id) && removable(member));
  const toggleSelected = (discordId: string) => setSelected(current =>
    current.includes(discordId) ? current.filter(id => id !== discordId) : [...current, discordId]
  );
  const removeMany = async () => {
    const targets = selectedRemovable;
    if (!targets.length) return;
    if (!window.confirm(`Remove ${targets.length} selected crew ${targets.length === 1 ? "member" : "members"}? Their website access will be disabled; orders and payroll history stay intact.`)) return;
    setError(""); setMessage("");
    const removed: string[] = [];
    const failed: string[] = [];
    for (const member of targets) {
      try {
        await removeSelected.mutateAsync({ discordId: member.discord_id });
        removed.push(member.discord_id);
      } catch {
        failed.push(member.display_name);
      }
    }
    setSelected(current => current.filter(id => !removed.includes(id)));
    if (removed.length) await refresh();
    if (failed.length) setError(`${removed.length} removed; could not remove: ${failed.join(", ")}.`);
    else setMessage(`${removed.length} crew ${removed.length === 1 ? "member" : "members"} removed. Their historical orders and payroll remain.`);
  };
  const addMember = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await add.mutateAsync({ data: { discord_id: discordId.trim(), display_name: displayName.trim(), role } });
      setMessage(`${displayName.trim()} added to the roster.`);
      setDiscordId(""); setDisplayName(""); setRole("mechanic");
      await refresh();
    } catch (reason) { setError(messageOf(reason, "Crew member could not be added. Check the roster ID and permissions.")); }
  };
  return <StaffShell active="/staff/crew-admin">
    <PageHead eyebrow="People / roster controls" title="Crew administration" detail="Manage the bot-backed crew roster, rank, availability and in-city ID. Website login accounts remain independent."/>
    {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
    {message && <div className="mb-4"><Notice kind="success">{message}</Notice></div>}
    {!allowed ? <section className="tdc-panel p-8"><Empty icon={Users} title="Manager access required" detail="This roster control surface is limited to manager roles. The API remains authoritative for permissions."/></section> : <>
      <section className="tdc-panel p-5">
        <p className="tdc-kicker text-primary">Roster entry</p><h2 className="mt-1 text-lg font-bold">Add a crew member</h2><p className="mt-1 text-sm text-muted-foreground">This ID identifies the bot roster record; it does not link or sign in to a website account.</p>
        <form onSubmit={addMember} className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-[1.1fr_1.2fr_1fr_auto]" data-testid="form-add-crew">
          <label className="grid gap-1.5 text-sm font-medium">Bot roster ID<Input className="tdc-input" value={discordId} onChange={e => setDiscordId(e.target.value)} minLength={17} maxLength={20} required data-testid="input-crew-id"/></label>
          <label className="grid gap-1.5 text-sm font-medium">Display name<Input className="tdc-input" value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={64} required data-testid="input-crew-name"/></label>
          <label className="grid gap-1.5 text-sm font-medium">Rank<select className="tdc-input" value={role} onChange={e => setRole(e.target.value as typeof role)} data-testid="select-new-crew-role"><option value="mechanic">Mechanic</option><option value="trainer">Trainer</option>{lead && <option value="manager">Manager</option>}</select></label>
          <Button className="self-end" disabled={add.isPending} type="submit" data-testid="button-add-crew">{add.isPending ? "Adding…" : "Add to roster"}</Button>
        </form>
      </section>
      <section className="tdc-panel mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><div><p className="tdc-kicker text-primary">Roster register</p><h2 className="mt-1 font-bold">Crew profiles</h2><p className="mt-1 text-xs text-muted-foreground">Select several profiles to remove them together, including crew who have left the Discord server.</p></div><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{crew.data?.crew.length ?? 0} records</span><Button variant="destructive" disabled={!selectedRemovable.length || removeSelected.isPending} onClick={() => void removeMany()} data-testid="button-remove-selected-crew"><UserMinus size={14}/>{removeSelected.isPending ? "Removing…" : `Remove selected (${selectedRemovable.length})`}</Button></div></div>
        <DeskQueryState loading={crew.isLoading} error={crew.error} retry={() => void refresh()}/>
        {!crew.isLoading && !crew.error && (activeCrew.length ? activeCrew.map(member => <CrewMemberEditor key={member.discord_id} member={member} actorRole={actorRole} selected={selected.includes(member.discord_id)} canSelect={removable(member)} onToggle={toggleSelected} onChanged={() => { setSelected(current => current.filter(id => id !== member.discord_id)); void refresh(); }}/>) : <Empty icon={Users} title="Roster is empty" detail="Add a crew member to start managing bot-backed profiles."/>)}
      </section>
    </>}
  </StaffShell>;
}
