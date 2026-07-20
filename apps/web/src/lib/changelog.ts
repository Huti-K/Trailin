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
    version: "0.3.5",
    date: "2026-07-20",
    notes: {
      en: [
        "Trailin starts faster, most of all on the first launch after an update on Windows. The app now ships as a single archive instead of tens of thousands of separate files, which is what the virus scanner spends its time on.",
        "The window opens as soon as the app can answer. Loading the schedule, the document index and the message channels no longer holds up the start.",
        "The startup screen shows a progress bar instead of a spinner, and explains what is happening if the wait gets long.",
        "The app no longer fetches its typeface from the internet. It starts the same offline or behind a hotel network, and opening Trailin is no longer visible to an outside service.",
      ],
      de: [
        "Trailin startet schneller, vor allem beim ersten Start nach einem Update unter Windows. Die App wird jetzt als ein einziges Archiv ausgeliefert statt als zehntausende einzelne Dateien, die der Virenscanner alle prüft.",
        "Das Fenster öffnet sich, sobald die App antworten kann. Zeitplan, Dokumentenindex und Nachrichtenkanäle halten den Start nicht mehr auf.",
        "Der Startbildschirm zeigt einen Fortschrittsbalken statt eines Kreisels und erklärt, woran es liegt, wenn es länger dauert.",
        "Die App lädt ihre Schrift nicht mehr aus dem Internet. Sie startet ohne Netz genauso wie im Hotel-WLAN, und der Start von Trailin ist für einen fremden Dienst nicht mehr sichtbar.",
      ],
    },
  },
  {
    version: "0.3.4",
    date: "2026-07-20",
    notes: {
      en: [
        "WhatsApp messages waiting for approval can be edited by hand on the start page, the way email drafts already could.",
        "Every draft has a refine button that reopens the chat it was written in, so the assistant keeps the full context instead of starting cold.",
        "Lists no longer jump. A message you send or discard fades out and the rows below slide up to close the gap, and a to-do you tick leaves the same way.",
        "The assistant no longer uses dashes in its replies.",
      ],
      de: [
        "WhatsApp-Nachrichten, die auf Freigabe warten, lassen sich auf der Startseite von Hand bearbeiten, so wie es bei E-Mail-Entwürfen schon möglich war.",
        "Jeder Entwurf hat einen Knopf zum Verfeinern, der den Chat wieder öffnet, in dem er geschrieben wurde, damit der Assistent den vollen Zusammenhang behält.",
        "Listen springen nicht mehr. Eine gesendete oder verworfene Nachricht blendet sich aus, die Zeilen darunter rücken weich nach oben, und ein abgehaktes To-do verschwindet genauso.",
        "Der Assistent verwendet in seinen Antworten keine Gedankenstriche mehr.",
      ],
    },
  },
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
