import { LANGUAGE_ENGLISH_NAMES, type Language } from "@trailin/shared";
import { getAccountPermissions, getLanguageSetting, getTimezoneSetting } from "../db/settings.js";
import { prompts } from "../prompts.js";
import { buildAccountsContext } from "./accounts.js";
import { type SessionCapabilities, sessionCapabilities } from "./capabilities.js";
import { buildFileAccessContext } from "./fileTools.js";
import { buildKnowledgeContext } from "./knowledgeTools.js";
import { buildSkillsContext } from "./skillTools.js";

/**
 * What the model reads: the session system prompt and the per-turn notes.
 * The split is deliberate — the system prompt must stay byte-stable across
 * turns for provider prompt caching (see buildSystemPrompt), so anything
 * volatile (the clock) rides the turn prompt instead.
 */

/** Intl locale used for the system prompt's date/time, keyed by the app's language setting. */
const DATE_LOCALE_BY_LANGUAGE: Record<Language, string> = {
  en: "en-US",
  de: "de-DE",
};

/** e.g. "Thu, Jul 9, 2026, 10:31" — rendered in the given IANA timezone and locale. */
function formatNow(timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

/**
 * The base prompt plus the Settings rules (scheduled runs rely on them too).
 * Defaults to the interactive profile when no capabilities are given.
 *
 * Byte-stable across turns unless its inputs genuinely change (settings,
 * connected accounts, memories, library): pi-ai puts a provider cache
 * breakpoint on the system prompt, so a volatile interpolation here (a clock,
 * a per-request id) would invalidate the cached prefix — system prompt plus
 * the entire prior conversation — on every turn. Per-turn context like the
 * current date/time rides the turn prompt instead: see buildTurnTimeNote.
 */
export async function buildSystemPrompt(caps?: SessionCapabilities): Promise<string> {
  const { interactive, onOffice, whatsapp } = caps ?? (await sessionCapabilities(true));
  let prompt = prompts.system;

  if (!interactive) {
    // Scheduled automations run with no human to review a send before it goes
    // out, so loadEmailTools withholds every provider write tool for this run
    // regardless of any account's permission grants (see providerWrites in
    // agent/emailToolset.ts) — say so plainly rather than let the interactive
    // permissions copy below imply sending is possible here.
    prompt += `
- Unattended scheduled run: provider write actions (send, reply, forward, label, move, delete) are
  unavailable in this run, regardless of any account's permission grants in Settings. Where a task
  would otherwise call for one of those, create a draft instead so the user can review and send it
  themselves.
- Search the document library first whenever this run's task relates to any listed document.`;
  } else {
    const permissions = await getAccountPermissions();
    if (!permissions.some((p) => p.write || p.send || p.delete)) {
      prompt += `
- Read-only mode: you only have tools that read, search or create drafts. You cannot send, delete
  or change anything. If the user asks for such an action, explain that permissions (create &
  change, send, delete) are granted per account on its row under Settings → Email.`;
    } else {
      prompt += `
- Permissions are granted per account and per category (create & change, send, delete), not
  globally — see what each connected account may do in the list below. Where a grant is missing
  you can only read, search and create drafts; if the user asks for more there, explain that
  permissions are granted per account on its row under Settings → Email.`;
    }

    // The automation-management tools exist only in interactive sessions, so
    // only those sessions are told about them.
    prompt += `
- When the user wants something done on a schedule — recurring ("every morning…", "each Friday…")
  or once at a later date ("on the 15th…") — set it up with automation_create instead of doing it
  once and letting the request drop, then tell them what you created (name, schedule, next run).
- When the user describes a repeatable way they want a task done — "always do it like this",
  "from now on when I ask for X…" — save it as a skill with skill_write, then tell them what you
  saved. A scheduled skill is an automation whose instruction says to follow it.`;
  }

  // Everything in this block exists only alongside configured onOffice
  // credentials: the leads directory is part of the real-estate workflow, so
  // its tools (see assembly.ts's buildAgent) and guidance disappear together
  // with the CRM's.
  if (onOffice.configured) {
    prompt += `
- Trailin keeps a leads directory (lead_record / lead_list / lead_update): every prospect who
  shows interest — in a property, a viewing, the user's services — belongs in it. When handling
  such an email, record the sender with lead_record (email, name, what they're interested in, the
  message date as inboundAt); it merges by address, so recording twice is safe. As correspondence
  develops, keep the lead's status and last-message timestamps current with lead_update — the
  directory is only useful when it reflects who owes whom a reply.`;
    if (interactive) {
      prompt += `
  For follow-ups on a specific lead ("check in three days whether they answered"), create an
  automation with automation_create and pass its leadId — the automation is then attached to the
  lead, shown with it, and deleted with it. Write the instruction self-contained: name the lead's
  email address, what to check (e.g. lead_list status + searching the mailbox for a reply), and
  what to do about it (update the lead, draft a nudge — unattended runs cannot send).`;
    }
    prompt += `
- The user's onOffice CRM is connected — the onoffice_* tools work against it. Reach for them
  whenever a request touches contacts/leads, properties (estates), viewings/appointments or CRM
  tasks: match an email sender to their address record, find the estate an inquiry is about
  (onoffice_search first, then read the full record). Field names vary per onOffice account —
  call onoffice_get_fields before filtering on or writing any field you aren't certain exists.`;
    if (onOffice.writes) {
      prompt += `
  CRM records are live business data: before any modify, delete, send or other side-effecting
  onOffice call, state exactly which record and fields you'll touch and get the user's explicit
  confirmation.`;
    } else if (interactive) {
      prompt += `
  You can read the CRM and create new records; modifying, deleting or sending via onOffice is
  not armed. If the user asks for one of those, explain that CRM write access is granted on the
  onOffice row under Settings → Email.`;
    } else if (onOffice.creates) {
      prompt += `
  In this run you can read the CRM and create new records (onoffice_create_address — always set
  checkDuplicate — plus appointments, tasks and relations). Modifying, deleting or sending via
  onOffice is not possible unattended. After creating an address for a lead, store its record id
  on the lead (lead_update, onofficeAddressId).`;
    } else {
      prompt += `
  Only the CRM read tools are available in this run; creating or changing CRM records is not
  possible unattended.`;
    }
  }

  if (whatsapp.linked) {
    prompt += `
- The user's personal WhatsApp is linked — the whatsapp_* tools work on its mirrored chats
  (synced since pairing, text only; media shows as a bracketed marker). Reach for them whenever
  a request touches WhatsApp conversations; leads often continue there — match people by phone
  number or name with whatsapp_search_contacts.`;
    if (whatsapp.sends) {
      prompt += `
  A WhatsApp message sends immediately — there is no draft stage. Before calling
  whatsapp_send_message, state the exact recipient and text and get the user's explicit
  confirmation.`;
    } else if (interactive) {
      prompt += `
  You can read WhatsApp but not send; if the user asks to send, explain that sending is
  granted on the WhatsApp row under Settings → Email.`;
    } else {
      prompt += `
  Only the WhatsApp read tools are available in this run; sending is never possible
  unattended.`;
    }
  }

  // The file tools exist only in interactive sessions (see assembly.ts's
  // buildAgent), so only those prompts describe them.
  if (interactive) {
    prompt += await buildFileAccessContext();
  }

  const language = (await getLanguageSetting()) ?? "de";
  if (language !== "en") {
    prompt += `
- Always answer in ${LANGUAGE_ENGLISH_NAMES[language]}, no matter what language the user's message
  or their emails are written in. Quoted email text and draft emails may keep their own language.`;
  }

  prompt += await buildAccountsContext();
  prompt += await buildKnowledgeContext();
  prompt += await buildSkillsContext();
  return prompt;
}

/**
 * Bracketed note carrying the current date/time, appended to each turn's
 * prompt (see turnRecorder.ts) rather than written into the system prompt.
 * Keeping the clock out of the system prompt is what keeps that prompt
 * byte-stable across turns — see buildSystemPrompt's cache invariant.
 */
export async function buildTurnTimeNote(): Promise<string> {
  const language = (await getLanguageSetting()) ?? "de";
  const timezone = (await getTimezoneSetting()) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    `\n\n[Current date and time: ${formatNow(timezone, DATE_LOCALE_BY_LANGUAGE[language] ?? "en-US")} ` +
    `(${timezone}). The user lives in this timezone — present times in it and interpret relative ` +
    `dates ("today", "next Monday") against it.]`
  );
}
