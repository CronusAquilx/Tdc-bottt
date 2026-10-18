import { useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  getGetPortalCrewQueryKey,
  getGetPortalOrdersQueryKey,
  getGetPortalPayoutsQueryKey,
  useCompletePortalOrder,
  useCreatePortalOrder,
  useGetPortalOrderCatalog,
} from "@workspace/api-client-react";
import type { PortalOrderCatalogItemsItem } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Empty, Notice, PageHead, QueryState, StaffShell } from "@/pages/staff";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  Minus,
  Package,
  Plus,
  Wrench,
} from "lucide-react";

const orderSchema = z.object({
  customer_name: z.string().trim().min(1, "Enter the customer's name.").max(100, "Keep the name under 100 characters."),
  notes: z.string().max(500, "Notes must be 500 characters or fewer."),
  labour: z.coerce.number().min(0, "Labour cannot be negative."),
});

type OrderFormValues = z.infer<typeof orderSchema>;
type CatalogItem = PortalOrderCatalogItemsItem;

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

const readableCategory = (category: string) =>
  category.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());

export function OrderBuilderPage() {
  const queryClient = useQueryClient();
  const catalog = useGetPortalOrderCatalog();
  const createOrder = useCreatePortalOrder();
  const completeOrder = useCompletePortalOrder();
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [requestError, setRequestError] = useState("");
  const [success, setSuccess] = useState("");
  const [completedOrderId, setCompletedOrderId] = useState("");

  const form = useForm<OrderFormValues>({
    resolver: zodResolver(orderSchema),
    defaultValues: { customer_name: "", notes: "", labour: 0 },
    mode: "onChange",
  });

  const items = catalog.data?.items ?? [];
  const selectedLines = useMemo(
    () => items.filter(item => (selected[item.id] ?? 0) > 0),
    [items, selected],
  );
  const selectedCount = Object.values(selected).reduce((total, quantity) => total + quantity, 0);
  const partsTotal = selectedLines.reduce((total, item) => total + item.cost * selected[item.id], 0);
  const labour = Number(form.watch("labour")) || 0;
  const customerTotal = partsTotal + labour;
  const commissionRate = catalog.data?.commission_rate ?? 0;
  const commissionEstimate = Math.round(labour * commissionRate);
  const projectedWeekCommission = (catalog.data?.week_commission ?? 0) + commissionEstimate;
  const canStartOrders = catalog.data?.active_shift === true;
  const busy = createOrder.isPending || completeOrder.isPending;

  const refreshOrderViews = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetPortalOrdersQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetPortalCrewQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetPortalPayoutsQueryKey() }),
    ]);
  };

  const changeQuantity = (item: CatalogItem, delta: number) => {
    if (!canStartOrders || (delta > 0 && selectedCount >= 50)) return;
    setSelected(current => {
      const quantity = Math.max(0, Math.min(50, (current[item.id] ?? 0) + delta));
      const next = { ...current };
      if (quantity === 0) delete next[item.id];
      else next[item.id] = quantity;
      return next;
    });
    if (!form.formState.dirtyFields.labour) {
      const currentQty = selected[item.id] ?? 0;
      const nextQty = Math.max(0, Math.min(50, currentQty + delta));
      const deltaQty = nextQty - currentQty;
      form.setValue("labour", Math.max(0, Number(form.getValues("labour")) + item.labour * deltaQty), {
        shouldValidate: true,
      });
    }
    setSuccess("");
    setCompletedOrderId("");
  };

  const submitOrder = async (values: OrderFormValues, complete: boolean) => {
    setRequestError("");
    setSuccess("");
    setCompletedOrderId("");

    if (!canStartOrders) {
      setRequestError("You need an active shift before you can start an order.");
      return;
    }
    if (!selectedCount) {
      setRequestError("Choose at least one catalog item before saving this order.");
      return;
    }

    let createdId = "";
    try {
      const created = await createOrder.mutateAsync({
        data: {
          customer_name: values.customer_name.trim(),
          notes: values.notes.trim() || undefined,
          item_ids: selectedLines.flatMap(item => Array.from({ length: selected[item.id] }, () => item.id)),
          labour: values.labour,
        },
      });
      createdId = created.id;
      await refreshOrderViews();

      if (complete) {
        await completeOrder.mutateAsync({ id: created.id });
        await refreshOrderViews();
        setCompletedOrderId(created.order_number);
        setSuccess(`Order ${created.order_number} is complete. The sales channel and crew pay have been updated.`);
      } else {
        setSuccess(`Draft ${created.order_number} saved. You can complete it later from the order desk.`);
      }
      setSelected({});
      form.reset({ customer_name: "", notes: "", labour: 0 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (createdId) {
        setRequestError(`The draft was saved, but completion did not go through. Find the draft in Orders and retry completion.${detail ? ` ${detail}` : ""}`);
      } else {
        setRequestError(detail || "The order could not be saved. Check the details and try again.");
      }
    }
  };

  const groupedItems = useMemo(() => {
    const groups = new Map<string, CatalogItem[]>();
    const categories = catalog.data?.categories ?? [];
    categories.forEach(category => groups.set(category, []));
    items.forEach(item => {
      const category = item.category || "Other";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)?.push(item);
    });
    return [...groups.entries()].filter(([, categoryItems]) => categoryItems.length > 0);
  }, [catalog.data?.categories, items]);

  return (
    <StaffShell active="/staff/orders">
      <PageHead
        eyebrow="Shop floor / new work"
        title="Build an order."
        detail="Choose parts from the live shop catalog, set labour and review the estimate before it hits the sales channel."
        action={<div className="flex items-center gap-2 self-start rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground sm:self-auto"><span className={`h-2 w-2 rounded-full ${catalog.data?.active_shift ? "bg-emerald-400" : "bg-muted-foreground/50"}`} />{catalog.isLoading ? "Checking shift" : canStartOrders ? "Shift active" : "Off shift"}</div>}
      />

      {requestError && <div className="mb-4"><Notice kind="error">{requestError}</Notice></div>}
      {success && <div className="mb-4"><Notice kind="success">{success}</Notice></div>}
      {completedOrderId && <p className="sr-only" data-testid="text-completed-order">{completedOrderId}</p>}

      <QueryState
        loading={catalog.isLoading}
        error={!!catalog.error}
        retry={() => void catalog.refetch()}
      />

      {!catalog.isLoading && !catalog.error && catalog.data && (
        <>
          {!canStartOrders && (
            <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-300/25 bg-amber-300/[.07] px-4 py-3.5 text-sm" data-testid="notice-inactive-shift">
              <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-300" />
              <div><p className="font-semibold text-foreground">Clock in before starting an order</p><p className="mt-1 text-xs leading-5 text-muted-foreground">The server reports no active shift for your account. Catalog browsing is available, but item selection and order actions stay disabled until you are clocked in.</p></div>
            </div>
          )}

          {items.length === 0 ? (
            <section className="tdc-panel">
              <Empty icon={Package} title="Catalog is empty" detail="No orderable items are available from the live shop catalog right now." />
            </section>
          ) : (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(values => void submitOrder(values, false))}
                className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_350px]"
                data-testid="form-order-builder"
              >
                <div className="min-w-0 space-y-5">
                  <section className="tdc-panel overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
                      <div><p className="tdc-kicker text-primary">01 / Catalog</p><h2 className="mt-1 font-bold">Select work & parts</h2></div>
                      <span className="font-mono text-xs text-muted-foreground" data-testid="text-selected-count">{selectedCount} selected</span>
                    </div>
                    <div className="divide-y divide-border">
                      {groupedItems.map(([category, categoryItems], groupIndex) => (
                        <section key={category} className="px-4 py-4 sm:px-5" data-testid={`catalog-category-${category.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`}>
                          <div className="mb-3 flex items-center gap-2"><span className="tdc-kicker text-muted-foreground">{String(groupIndex + 1).padStart(2, "0")}</span><h3 className="text-sm font-bold">{readableCategory(category)}</h3><span className="ml-auto text-[11px] text-muted-foreground">{categoryItems.length} item{categoryItems.length === 1 ? "" : "s"}</span></div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {categoryItems.map(item => {
                              const quantity = selected[item.id] ?? 0;
                              return (
                                <article key={item.id} className={`flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3 transition-colors ${quantity > 0 ? "border-primary/60 bg-primary/[.055]" : "border-border bg-background/30"}`} data-testid={`catalog-item-${item.id}`}>
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold" title={item.label}>{item.label}</p>
                                     <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground"><span className="font-mono text-foreground">Parts {money(item.cost)}</span><span>Catalog price {money(item.price)}</span><span>Labour guide {money(item.labour)}</span></p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    {quantity === 0 ? (
                                      <Button type="button" variant="outline" size="sm" disabled={!canStartOrders || selectedCount >= 50} onClick={() => changeQuantity(item, 1)} aria-label={`Add ${item.label}`} data-testid={`button-add-item-${item.id}`}><Plus size={14}/><span className="hidden sm:inline">Add</span></Button>
                                    ) : (
                                      <>
                                        <Button type="button" variant="outline" size="icon" className="h-8 w-8" disabled={!canStartOrders} onClick={() => changeQuantity(item, -1)} aria-label={`Remove one ${item.label}`} data-testid={`button-remove-item-${item.id}`}><Minus size={14}/></Button>
                                        <span className="min-w-6 text-center font-mono text-sm font-bold" data-testid={`text-quantity-${item.id}`}>{quantity}</span>
                                        <Button type="button" variant="outline" size="icon" className="h-8 w-8" disabled={!canStartOrders || quantity >= 50 || selectedCount >= 50} onClick={() => changeQuantity(item, 1)} aria-label={`Add one ${item.label}`} data-testid={`button-increase-item-${item.id}`}><Plus size={14}/></Button>
                                      </>
                                    )}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        </section>
                      ))}
                    </div>
                  </section>

                  <section className="tdc-panel p-5">
                    <div className="mb-4"><p className="tdc-kicker text-primary">02 / Customer</p><h2 className="mt-1 font-bold">Job details</h2></div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormField
                        control={form.control}
                        name="customer_name"
                        render={({ field }) => (
                          <FormItem className="sm:col-span-2">
                            <FormLabel className="text-sm font-medium">Customer name <span className="text-primary">*</span></FormLabel>
                            <FormControl><Input {...field} className="tdc-input" placeholder="Name for the work order" maxLength={100} disabled={!canStartOrders} data-testid="input-customer-name" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="labour"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium">Labour charge</FormLabel>
                            <FormControl><Input {...field} type="number" min="0" step="0.01" className="tdc-input font-mono" disabled={!canStartOrders} data-testid="input-order-labour" /></FormControl>
                            <p className="text-xs leading-5 text-muted-foreground">Starts from selected catalog labour guides. Edit for the agreed job amount.</p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="notes"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium">Order notes <span className="font-normal text-muted-foreground">Optional</span></FormLabel>
                            <FormControl><textarea {...field} className="tdc-input min-h-[90px] resize-y text-sm" maxLength={500} placeholder="Anything the team should know…" disabled={!canStartOrders} data-testid="input-order-notes" /></FormControl>
                            <p className="text-right text-[10px] text-muted-foreground">{field.value.length}/500</p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </section>
                </div>

                <aside className="xl:sticky xl:top-[86px]">
                  <section className="tdc-panel overflow-hidden">
                    <div className="border-b border-border px-5 py-4">
                      <p className="tdc-kicker text-primary">Live estimate</p>
                      <h2 className="mt-1 text-lg font-bold">Order total</h2>
                      <p className="mt-1 text-xs text-muted-foreground">Updates as your selection changes.</p>
                    </div>
                    <div className="space-y-4 p-5">
                      <div className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 text-muted-foreground"><Package size={15}/> Parts ({selectedCount})</span><span className="font-mono font-semibold" data-testid="estimate-parts">{money(partsTotal)}</span></div>
                      <div className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 text-muted-foreground"><Wrench size={15}/> Labour</span><span className="font-mono font-semibold" data-testid="estimate-labour">{money(labour)}</span></div>
                      <div className="border-t border-dashed border-border pt-4">
                        <div className="flex items-end justify-between gap-3"><span className="text-sm font-semibold">Customer total</span><span className="font-mono text-2xl font-bold tracking-tight" data-testid="estimate-customer-total">{money(customerTotal)}</span></div>
                      </div>
                      <div className="flex items-center justify-between rounded-md bg-primary/[.09] px-3 py-2.5 text-sm"><span className="flex items-center gap-2 text-muted-foreground"><CircleDollarSign size={15}/> This order commission</span><span className="font-mono font-bold text-primary" data-testid="estimate-commission">{money(commissionEstimate)}</span></div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Week total after completion</span><span className="font-mono" data-testid="estimate-week-commission">{money(projectedWeekCommission)}</span></div>
                      <p className="text-[10px] leading-4 text-muted-foreground">Commission uses the current rate of {(commissionRate * 100).toFixed(1)}% against labour. Final pay is calculated by the server.</p>
                    </div>
                    <div className="space-y-2 border-t border-border bg-background/25 p-4">
                      <Button type="submit" className="w-full" disabled={!canStartOrders || busy || !selectedCount} data-testid="button-save-order-draft">
                        {createOrder.isPending ? "Saving draft…" : <><ClipboardCheck size={15}/> Save draft</>}
                      </Button>
                      <Button type="button" variant="outline" className="w-full" disabled={!canStartOrders || busy || !selectedCount || !form.formState.isValid} onClick={form.handleSubmit(values => void submitOrder(values, true))} data-testid="button-complete-order">
                        {completeOrder.isPending ? "Completing…" : createOrder.isPending ? "Creating draft…" : <><Check size={15}/> Complete order <ArrowRight size={14}/></>}
                      </Button>
                      <p className="pt-1 text-center text-[10px] leading-4 text-muted-foreground">Complete saves a draft first, then posts the order to your sales channel.</p>
                    </div>
                  </section>
                  {selectedLines.length > 0 && (
                    <section className="tdc-panel mt-4 overflow-hidden">
                      <div className="flex items-center justify-between border-b border-border px-4 py-3"><p className="tdc-kicker text-muted-foreground">Selected lines</p><ChevronDown size={14} className="text-muted-foreground"/></div>
                      <div className="divide-y divide-border">
                        {selectedLines.map(item => (
                          <div key={item.id} className="flex items-center justify-between gap-3 px-4 py-3 text-xs" data-testid={`summary-line-${item.id}`}>
                            <span className="min-w-0 truncate">{selected[item.id]} × {item.label}</span><span className="shrink-0 font-mono">{money(item.price * selected[item.id])}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </aside>
              </form>
            </Form>
          )}
        </>
      )}
    </StaffShell>
  );
}

export default OrderBuilderPage;
