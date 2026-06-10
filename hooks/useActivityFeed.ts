import { useWallet } from "@crossmint/client-sdk-react-ui";
import { useQuery } from "@tanstack/react-query";
import { getUserYieldActions, YieldAction } from "./useYields";

// Unified activity event type
export interface ActivityEvent {
  from_address: string;
  to_address?: string;
  timestamp: number;
  type: string;
  amount: string;
  token_symbol?: string;
}

// Transform yield action to activity event format
function yieldActionToActivityEvent(action: YieldAction): ActivityEvent {
  const isEnter = action.intent === "enter";
  const type = isEnter ? "yield-enter" : "yield-exit";

  return {
    from_address: action.address,
    timestamp: new Date(action.createdAt).getTime(),
    type,
    amount: action.amountUsd || action.amount || "0",
    token_symbol: "USDC",
  };
}

export function useActivityFeed() {
  const { wallet } = useWallet();

  // Fetch wallet activity.
  //
  // We poll every 5s while the dashboard is mounted so the feed picks up new
  // transfers after a send/onramp without the user having to manually refresh.
  // Sends and onramps both call `refetch` synchronously when they complete, but
  // that immediate refetch races the Crossmint indexer — the just-broadcast tx
  // isn't yet visible as `status: succeeded`. Background polling bridges the
  // gap until the indexer catches up.
  //
  // Also catches external transfers (someone sending you USDC from outside the
  // app), which a "trigger-after-send" approach would miss.
  //
  // `refetchIntervalInBackground: false` pauses polling when the tab is hidden,
  // so we don't burn requests while the user is away.
  const walletActivityQuery = useQuery({
    queryKey: ["walletActivity", wallet?.address],
    queryFn: async () => await wallet?.transfers({ tokens: "usdc", status: "successful" }),
    enabled: !!wallet?.address,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });

  // Fetch yield actions - uses same query key as useYieldPositions for cache sharing
  const yieldActionsQuery = useQuery({
    queryKey: ["yieldPositions", wallet?.address],
    queryFn: () => getUserYieldActions(wallet!.address),
    staleTime: 30 * 1000, // Match useYieldPositions cache time
    enabled: !!wallet?.address,
  });

  // Combine and sort events
  const combinedEvents = (() => {
    // Map V1 transfers to ActivityEvent format.
    //
    // Defensive dedupe: the Crossmint wallets-transfers API currently returns
    // two byte-identical records for a self-send (sender == recipient). The
    // chain only emits one ERC-20 Transfer event; this is a server-side bug.
    // We collapse by transferId so the UI shows a single row.
    //
    // We rely on the API's `type` field directly ("wallets.transfer.in" /
    // "wallets.transfer.out") — the previous "self-transfer => onramp"
    // heuristic was conceptually inverted (onramps come from an EXTERNAL
    // sender, not a self-transfer) and is removed.
    const rawTransfers = walletActivityQuery.data?.data || [];
    const dedupedTransfers = rawTransfers.filter((tx: any, i: number, arr: any[]) => {
      if (!tx.transferId) return true; // keep records that lack a transferId (e.g., onramps)
      return arr.findIndex((o: any) => o.transferId === tx.transferId) === i;
    });

    const walletEvents: ActivityEvent[] = dedupedTransfers.map((tx: any) => ({
      from_address: tx.sender?.address || "",
      to_address: tx.recipient?.address,
      timestamp: new Date(tx.completedAt).getTime(),
      type: tx.type || "",
      amount: tx.token?.amount || "0",
      token_symbol: tx.token?.symbol,
    }));

    // Transform yield actions to activity events
    const yieldEvents: ActivityEvent[] = (yieldActionsQuery.data || []).map(
      yieldActionToActivityEvent
    );

    // Combine and sort by timestamp (most recent first)
    const allEvents = [...walletEvents, ...yieldEvents].sort((a, b) => b.timestamp - a.timestamp);

    return allEvents;
  })();

  return {
    data: { events: combinedEvents },
    isLoading: walletActivityQuery.isLoading || yieldActionsQuery.isLoading,
    error: walletActivityQuery.error || yieldActionsQuery.error,
    refetch: async () => {
      await Promise.all([walletActivityQuery.refetch(), yieldActionsQuery.refetch()]);
    },
  };
}
