import { useQuery } from "@tanstack/react-query";
import type { AccountColor, ConnectedAccount } from "@trailin/shared";
import { EMAIL_APPS } from "@trailin/shared";
import { api } from "@/lib/api";

/** Whether a Pipedream app slug is one of the supported mail providers. */
export const isEmailApp = (app: string) => (EMAIL_APPS as readonly string[]).includes(app);

/** Whether a connected account is a mailbox — judged by its provider, never by
 *  whether the display name happens to contain an "@". */
export const isEmailAccount = (account: ConnectedAccount) => isEmailApp(account.app);

/** An account's assigned dot color; undefined (→ `AccountDot`'s grey) when unassigned. */
export const accountColor = (colors: AccountColor[] | undefined, accountId?: string | null) =>
  colors?.find((c) => c.accountId === accountId)?.hex;

/**
 * Connected accounts plus their color assignments — the pair every account
 * dot, chip, and scope picker resolves from. One shared query per list, so
 * every consumer sees the same data and an "accounts" event (connect,
 * removal, recolor, regrant) refreshes them all. Cosmetic data: failures
 * resolve to empty lists, never an error state.
 */
export function useAccountColors({ withAccounts = true, enabled = true } = {}): {
  accounts: ConnectedAccount[];
  colors: AccountColor[];
} {
  const { data: accounts } = useQuery({
    queryKey: ["accounts", "list"],
    queryFn: () => api.pipedreamAccounts().catch(() => []),
    enabled: enabled && withAccounts,
  });
  const { data: colors } = useQuery({
    queryKey: ["accounts", "colors"],
    queryFn: () => api.accountColors().then((r) => r.colors),
    enabled,
  });
  return { accounts: accounts ?? [], colors: colors ?? [] };
}
