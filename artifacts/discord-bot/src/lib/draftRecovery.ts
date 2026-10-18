/**
 * Keep the order ID encoded in a component unchanged.
 *
 * A missing/stale ID must never be silently redirected to another draft: that
 * can attach old buttons to a different customer's order. Callers validate the
 * returned ID and tell the mechanic to start a new order if it no longer exists.
 */
export async function resolveDraftId(_interaction: any, orderId: string): Promise<string> {
  return orderId;
}
