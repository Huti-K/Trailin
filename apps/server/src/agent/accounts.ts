import type { ConnectedAccount } from "@trailin/shared";
import { getAccountPermissions } from "../db/settings.js";
import { listAccounts } from "../integrations/pipedream/connect.js";

export function findAccount(
  accounts: ConnectedAccount[],
  raw: string,
): ConnectedAccount | undefined {
  const trimmed = raw.trim();
  return (
    accounts.find((a) => a.id === trimmed) ??
    accounts.find((a) => a.name.toLowerCase() === trimmed.toLowerCase())
  );
}

export function accountNotFoundText(raw: string, accounts: ConnectedAccount[]): string {
  const list =
    accounts.length > 0 ? accounts.map((a) => a.name).join(", ") : "no accounts are connected";
  return `No connected account matches "${raw}". Connected accounts: ${list}.`;
}

export interface AccountParamResolution {
  account?: ConnectedAccount;
  accounts: ConnectedAccount[];
  error?: string;
}

/** In "required" mode, `account` is set whenever `error` isn't. */
export async function resolveAccountParam(
  raw: unknown,
  mode: "optional" | "required" = "optional",
): Promise<AccountParamResolution> {
  const accounts = await listAccounts();
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") {
    if (mode === "optional") return { accounts };
    return { accounts, error: accountNotFoundText("", accounts) };
  }
  const account = findAccount(accounts, value);
  if (!account) return { accounts, error: accountNotFoundText(value, accounts) };
  return { account, accounts };
}

export function accountNameMap(accounts: ConnectedAccount[]): Map<string, string> {
  return new Map(accounts.map((a) => [a.id, a.name]));
}

/** Fail-open to an empty map so a Pipedream outage never breaks the caller (raw ids instead of names). */
export async function fetchAccountNameMap(): Promise<Map<string, string>> {
  try {
    return accountNameMap(await listAccounts());
  } catch {
    return new Map();
  }
}

/** Fail-open: a failed account listing (a Pipedream outage, not "not set up") returns "". */
export async function buildAccountsContext(): Promise<string> {
  let accounts: ConnectedAccount[];
  try {
    accounts = await listAccounts();
  } catch {
    return "";
  }
  if (accounts.length === 0) {
    return (
      `\n\nNo email account is connected yet, so there are no email tools. When the user asks ` +
      `for anything that needs mail access, tell them to finish the email setup under ` +
      `Settings → Connect email.`
    );
  }
  const permissions = new Map((await getAccountPermissions()).map((p) => [p.accountId, p]));
  const lines = accounts.map((account) => {
    const app = account.appName ?? account.app;
    const p = permissions.get(account.id);
    const granted = [
      ...(p?.write ? ["create & change"] : []),
      ...(p?.send ? ["send"] : []),
      ...(p?.delete ? ["delete"] : []),
    ];
    const access = granted.length > 0 ? ` — may ${granted.join(", ")}` : " — read-only";
    return `- ${account.name} (${app})${access}`;
  });
  return `\n\nConnected accounts:\n${lines.join("\n")}`;
}
