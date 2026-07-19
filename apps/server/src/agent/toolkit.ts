import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { type Static, type TObject, type TProperties, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentCard, ConnectedAccount } from "@trailin/shared";
import { errorMessage } from "../core/utils/util.js";
import { accountNameMap, resolveAccountParam } from "./accounts.js";

/**
 * Typed factory for the app's own agent tools (MCP-wrapped tools stay plain
 * AgentTool literals, see emailToolset.ts). Parameters are declared once as
 * TypeBox properties, so the JSON schema the model sees and the `params` type
 * execute receives cannot drift, and every call is re-validated here: direct
 * invocations (tests, delegate workers) get the same guarantee as pi's agent
 * loop.
 */

type ToolResult = AgentToolResult<AgentCard | undefined>;

export function textResult(value: string, card?: AgentCard) {
  return {
    content: [{ type: "text" as const, text: value }],
    details: card,
  };
}

export interface ToolCtx {
  toolCallId: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<AgentCard | undefined>;
}

export interface AccountToolCtx extends ToolCtx {
  account?: ConnectedAccount;
  accounts: ConnectedAccount[];
  /** ` [name]` label for multi-account output rows; empty when already scoped to one account. */
  accountTag: (accountId: string) => string;
}

export interface RequiredAccountToolCtx extends AccountToolCtx {
  account: ConnectedAccount;
}

interface ToolSpecBase<P extends TProperties> {
  name: string;
  label: string;
  description: string;
  params: P;
  /** Return a thrown error's message as result text instead of failing the run. */
  catchToText?: boolean;
}

const OPTIONAL_ACCOUNT_DESCRIPTION =
  "Optional: only this connected account (its email address or id).";
const REQUIRED_ACCOUNT_DESCRIPTION = "The connected account (its email address or id).";

function parseJsonComposite(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Repairs the malformed argument shapes models actually produce, before
 * validation rejects them: the whole arguments object as one JSON string, a
 * JSON-encoded string where an array/object belongs, and a bare element where
 * an array belongs. Only unambiguous fixes are applied; anything else returns
 * unchanged for validation to report. pi runs this through prepareArguments,
 * ahead of its own validation (which handles primitive coercion like "5" → 5).
 */
export function repairToolArguments(parameters: TObject, raw: unknown): unknown {
  if (Value.Check(parameters, raw)) return raw;

  let args = raw;
  if (typeof args === "string") {
    const parsed = parseJsonComposite(args);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return raw;
    args = parsed;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return raw;

  const repaired: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [key, schema] of Object.entries(parameters.properties ?? {})) {
    const value = repaired[key];
    if (value === undefined) continue;
    const type = (schema as { type?: unknown }).type;
    if (type === "array") {
      if (typeof value === "string") {
        const parsed = parseJsonComposite(value);
        repaired[key] = Array.isArray(parsed) ? parsed : [value];
      } else if (!Array.isArray(value)) {
        repaired[key] = [value];
      }
    } else if (type === "object" && typeof value === "string") {
      const parsed = parseJsonComposite(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        repaired[key] = parsed;
      }
    }
  }
  return repaired;
}

export function tool<P extends TProperties>(
  spec: ToolSpecBase<P> & {
    account: "required";
    accountDescription?: string;
    execute: (params: Static<TObject<P>>, ctx: RequiredAccountToolCtx) => Promise<ToolResult>;
  },
): AgentTool;
export function tool<P extends TProperties>(
  spec: ToolSpecBase<P> & {
    account: "optional";
    accountDescription?: string;
    execute: (params: Static<TObject<P>>, ctx: AccountToolCtx) => Promise<ToolResult>;
  },
): AgentTool;
export function tool<P extends TProperties>(
  spec: ToolSpecBase<P> & {
    account?: undefined;
    execute: (params: Static<TObject<P>>, ctx: ToolCtx) => Promise<ToolResult>;
  },
): AgentTool;
export function tool(
  spec: ToolSpecBase<TProperties> & {
    account?: "optional" | "required";
    accountDescription?: string;
    execute: (params: never, ctx: never) => Promise<ToolResult>;
  },
): AgentTool {
  // The overloads pair each ctx shape with its account mode; the
  // implementation enforces that by construction, so the widening cast is sound.
  const execute = spec.execute as (params: unknown, ctx: unknown) => Promise<ToolResult>;
  const properties: TProperties = spec.account
    ? {
        ...spec.params,
        account:
          spec.account === "required"
            ? Type.String({ description: spec.accountDescription ?? REQUIRED_ACCOUNT_DESCRIPTION })
            : Type.Optional(
                Type.String({
                  description: spec.accountDescription ?? OPTIONAL_ACCOUNT_DESCRIPTION,
                }),
              ),
      }
    : spec.params;
  const parameters = Type.Object(properties);

  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters,
    prepareArguments: (args) => repairToolArguments(parameters, args),
    execute: async (toolCallId, params, signal, onUpdate) => {
      if (!Value.Check(parameters, params)) {
        const issue = Value.Errors(parameters, params).First();
        return textResult(
          `Invalid ${spec.name} parameters: ` +
            `${issue ? `${issue.path || "value"} ${issue.message}` : "schema mismatch"}.`,
        );
      }

      let ctx: ToolCtx | AccountToolCtx = { toolCallId, signal, onUpdate };
      if (spec.account) {
        const raw = (params as { account?: string }).account;
        const resolved = await resolveAccountParam(raw, spec.account);
        if (resolved.error) return textResult(resolved.error);
        const names = accountNameMap(resolved.accounts);
        ctx = {
          ...ctx,
          account: resolved.account,
          accounts: resolved.accounts,
          accountTag: (accountId: string) =>
            resolved.account ? "" : ` [${names.get(accountId) ?? accountId}]`,
        };
      }

      if (!spec.catchToText) return execute(params, ctx);
      try {
        return await execute(params, ctx);
      } catch (error) {
        return textResult(errorMessage(error));
      }
    },
  };
}

export function limitParam(defaultLimit: number, noun = "results") {
  return Type.Optional(Type.Number({ description: `Max ${noun} (default ${defaultLimit}).` }));
}

export function clampLimit(raw: number | undefined, defaultLimit: number, max: number): number {
  const n = raw !== undefined && Number.isFinite(raw) ? Math.floor(raw) : defaultLimit;
  return Math.min(Math.max(n, 1), max);
}

export interface NumberedRow {
  head: string;
  body?: Array<string | false | undefined>;
}

export function numberedList(rows: NumberedRow[]): string {
  return rows
    .map((row, i) =>
      [
        `${i + 1}. ${row.head}`,
        ...(row.body ?? [])
          .filter((line): line is string => line !== false && line !== undefined)
          .map((line) => `   ${line}`),
      ].join("\n"),
    )
    .join("\n");
}
