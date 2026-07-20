export type ChangelogEntry = {
  version: string;
  /** ISO date the version was released. */
  date: string;
  /** Release notes per UI language; keep both in step. */
  notes: { en: string[]; de: string[] };
};

/**
 * Hand-maintained release notes shown in-app (the update card and Settings →
 * About → Changelog). Newest first; add an entry when cutting a tagged release.
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.3.3",
    date: "2026-07-20",
    notes: {
      en: [
        "Home marks what arrived since your last visit with a small dot and counts it at the top, so nothing new slips past.",
        "WhatsApp can now be connected as a Business account instead of scanning a QR code with your phone. Sending works right away, reading chats stays with the phone link.",
        "Every run shows why it started: a slot caught up after the app was closed, a completed to-do, or new mail.",
        "The search for a service to connect finds onOffice and WhatsApp on more terms, in German too, and shows them the moment you type.",
      ],
      de: [
        "Die Startseite markiert mit einem kleinen Punkt, was seit dem letzten Besuch dazugekommen ist, und zählt es oben mit, damit nichts Neues untergeht.",
        "WhatsApp lässt sich jetzt auch als Business-Konto verbinden, statt einen QR-Code mit dem Telefon zu scannen. Das Senden funktioniert sofort, das Lesen von Chats bleibt bei der Telefonverbindung.",
        "Jeder Lauf zeigt, warum er gestartet ist: ein nachgeholter Termin, ein erledigtes To-do oder neue Mail.",
        "Die Suche nach einem Dienst findet onOffice und WhatsApp bei mehr Begriffen, auch auf Deutsch, und zeigt sie sofort beim Tippen.",
      ],
    },
  },
  {
    version: "0.3.2",
    date: "2026-07-19",
    notes: {
      en: [
        "Library files can be downloaded with one click, even the kinds that normally open in the browser.",
        "A new button opens the current library folder straight in Finder or Explorer.",
        "Accounts, automations, and email drafts now update on their own the moment something changes, no reload needed.",
      ],
      de: [
        "Bibliotheksdateien lassen sich mit einem Klick herunterladen, auch solche, die sonst im Browser öffnen.",
        "Ein neuer Knopf öffnet den aktuellen Bibliotheksordner direkt im Finder oder Explorer.",
        "Konten, Automationen und E-Mail-Entwürfe aktualisieren sich von selbst, sobald sich etwas ändert, ganz ohne Neuladen.",
      ],
    },
  },
  {
    version: "0.3.1",
    date: "2026-07-19",
    notes: {
      en: [
        "Automations can be dragged into the order you want.",
        "Runs now start knowing why they fired: a completed to-do, new mail, or a missed slot.",
        "Connecting an account opens in your browser, where you are already signed in, and the app picks up the new account by itself.",
        "The instruction box in the automation editor gives your text more room.",
      ],
      de: [
        "Automationen lassen sich per Ziehen in die gewünschte Reihenfolge bringen.",
        "Läufe wissen jetzt beim Start, warum sie ausgelöst wurden: ein erledigtes To-do, neue Mail oder ein verpasster Termin.",
        "Die Kontoverbindung öffnet im Browser, wo die Anmeldung schon besteht, und die App übernimmt das neue Konto von selbst.",
        "Das Anweisungsfeld im Automationen-Editor bietet dem Text mehr Platz.",
      ],
    },
  },
  {
    version: "0.3.0",
    date: "2026-07-19",
    notes: {
      en: [
        "Release notes now show up in the app after an update, and any time under Settings, About.",
        "The window opens right away with a spinner while Trailin starts, instead of a silent wait.",
        "A cleaner window on the Mac: the app draws its own chrome edge to edge.",
        "WhatsApp drafts awaiting your approval can be revised in place instead of piling up copies.",
      ],
      de: [
        "Versionshinweise erscheinen nach einem Update direkt in der App und jederzeit unter Einstellungen, Über.",
        "Das Fenster öffnet sofort mit einem Ladeindikator, während Trailin startet, statt still zu warten.",
        "Aufgeräumtes Fenster auf dem Mac: Die App zeichnet ihre Oberfläche randlos selbst.",
        "WhatsApp-Entwürfe in der Freigabe lassen sich direkt überarbeiten, statt sich zu stapeln.",
      ],
    },
  },
  {
    version: "0.2.0",
    date: "2026-07-16",
    notes: {
      en: [
        "Home is now one agenda: missed runs, approvals, and the day's schedule in a single flow.",
        "Flat to-dos you can edit in place, kept current by the agent.",
        "Outbound messages draft for your approval before anything sends.",
      ],
      de: [
        "Start ist jetzt eine Agenda: verpasste Läufe, Freigaben und der Tagesplan in einem Fluss.",
        "Flache To-dos, direkt bearbeitbar, vom Agenten aktuell gehalten.",
        "Ausgehende Nachrichten werden zur Freigabe entworfen, bevor etwas gesendet wird.",
      ],
    },
  },
  {
    version: "0.1.0",
    date: "2026-07-16",
    notes: {
      en: [
        "First release: connect Gmail or Outlook, chat with your inbox, and run the agent on a schedule.",
      ],
      de: [
        "Erste Version: Gmail oder Outlook verbinden, mit dem Postfach chatten und den Agenten nach Zeitplan laufen lassen.",
      ],
    },
  },
];

export function changelogNotes(entry: ChangelogEntry, lang: string): string[] {
  return entry.notes[lang.startsWith("de") ? "de" : "en"];
}
