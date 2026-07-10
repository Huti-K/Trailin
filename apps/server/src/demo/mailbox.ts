import {
  DEMO_PERSONAL_ACCOUNT_ID,
  DEMO_UNI_ACCOUNT_ID,
  DEMO_WORK_ACCOUNT_ID,
} from "./accounts.js";

/**
 * The demo mailbox: hand-authored email threads for the 3 fake accounts, so
 * the agent's demo email tools (demo/emailTools.ts) have something real to
 * search and read. Same cast and storylines as content.ts — digests mention
 * these emails, drafts reply to these threads (DraftSeed.threadId points at a
 * DemoThread.id), and continuity questions ("find everything from Thomas
 * Brandt") have consistent answers.
 *
 * Dates are relative (daysAgo/hour), like the rest of the demo content, so
 * nothing ever drifts into the future.
 */

export interface DemoEmailMessage {
  /** "Name <address>" — the demo account's own address for sent messages. */
  from: string;
  /** Recipient addresses, "Name <address>" or bare address. */
  to: string[];
  cc?: string[];
  daysAgo: number;
  hour: number;
  minute?: number;
  /** Plain-text body, the whole message. */
  body: string;
}

export interface DemoThread {
  /** Stable readable id, e.g. "th-work-acme-dispute". Draft seeds reference these. */
  id: string;
  /** Which demo account's mailbox this thread lives in (demo/accounts.ts ids). */
  accountId: string;
  subject: string;
  /** Chronological, oldest first. */
  messages: DemoEmailMessage[];
}

/**
 * Resolve a threadId, or a messageId of the form "<threadId>-mN", to its
 * DemoThread. Shared by demo/emailTools.ts's gmail-get-thread tool and
 * demo/demoDrafts.ts's getThread, so a draft's thread
 * link resolves identically whether the agent or the drafts UI reads it.
 */
export function resolveThread(threads: DemoThread[], id: string): DemoThread | undefined {
  const trimmed = id.trim();
  const direct = threads.find((t) => t.id === trimmed);
  if (direct) return direct;
  const withoutSuffix = trimmed.replace(/-m\d+$/, "");
  return withoutSuffix !== trimmed ? threads.find((t) => t.id === withoutSuffix) : undefined;
}

const SELIN_WORK = "Selin Kaya <selin@nordwind-studio.de>";
const SELIN_PERSONAL = "Selin Kaya <selin.kaya.mail@gmail.com>";
const SELIN_UNI = "Selin Kaya <s.kaya@student.tu-berlin.de>";

const BRANDT = "Thomas Brandt <t.brandt@acme-gmbh.de>";
const JONAS = "Jonas Weber <jonas@nordwind-studio.de>";
const MARA = "Mara Lindqvist <mara.lindqvist@lindqvist-buchhaltung.de>";
const RIEGER = "Felix Rieger <f.rieger@kaltwasser-rieger.de>";
const YUSUF = "Yusuf Demir <yusuf.demir.dev@gmail.com>";

/** The current and last completed calendar year — for demo copy that must track "now" instead of a fixed year. */
const CURRENT_YEAR = new Date().getFullYear();
const PREVIOUS_YEAR = CURRENT_YEAR - 1;

export const MAILBOX: DemoThread[] = [
  // ---- Work: Acme GmbH billing dispute (Thomas Brandt), 4 threads ----
  {
    id: "th-work-acme-1042",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Rückfrage zur Rechnung #A-1042",
    messages: [
      {
        from: BRANDT,
        to: [SELIN_WORK],
        daysAgo: 21,
        hour: 16,
        minute: 20,
        body: `Hallo Frau Kaya,

wir haben Ihre Rechnung #A-1042 für den Website-Relaunch erhalten. 40 Stunden erscheinen uns für den abgerechneten Zeitraum deutlich zu hoch, insbesondere da ein Teil der Arbeit nach unserem Verständnis bereits im Vormonat abgerechnet wurde.

Bitte schicken Sie uns eine detaillierte Aufschlüsselung der Stunden, bevor wir die Rechnung zur Zahlung freigeben.

Mit freundlichen Grüßen
Thomas Brandt
Acme GmbH`,
      },
      {
        from: SELIN_WORK,
        to: [BRANDT],
        daysAgo: 20,
        hour: 9,
        minute: 40,
        body: `Hallo Herr Brandt,

danke für die Rückmeldung. Die 40 Stunden stammen vollständig aus dem laufenden Relaunch, es gibt keine Überschneidung mit dem Vormonat. Wir stellen Ihnen die Aufschlüsselung nach Projektphasen zusammen, Sie bekommen sie bis Ende der Woche.

Beste Grüße,
Selin Kaya
Nordwind Studio`,
      },
      {
        from: BRANDT,
        to: [SELIN_WORK],
        daysAgo: 19,
        hour: 11,
        minute: 15,
        body: `Hallo Frau Kaya,

gut, wir erwarten die Aufstellung. Zur Einordnung vorab: aus unserer Sicht sind maximal 32 Stunden nachvollziehbar. Die Content-Migration war laut Kickoff Ihrerseits mit "geringem Aufwand" angesetzt.

Mit freundlichen Grüßen
Thomas Brandt`,
      },
    ],
  },
  {
    id: "th-work-acme-strittig",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Rechnung weiterhin strittig",
    messages: [
      {
        from: BRANDT,
        to: [SELIN_WORK],
        daysAgo: 17,
        hour: 15,
        minute: 30,
        body: `Sehr geehrte Frau Kaya,

nach Durchsicht Ihrer Aufschlüsselung bestreiten wir hiermit formal 8 der 40 abgerechneten Stunden (Position Content-Migration sowie anteilig Testing). Diese Leistungen waren aus unserer Sicht nicht in diesem Umfang beauftragt.

Wir bitten um eine korrigierte Rechnung über 32 Stunden bis Ende nächster Woche.

Mit freundlichen Grüßen
Thomas Brandt
Acme GmbH`,
      },
      {
        from: SELIN_WORK,
        to: [BRANDT],
        cc: [JONAS],
        daysAgo: 16,
        hour: 10,
        minute: 10,
        body: `Hallo Herr Brandt,

die bestrittenen Positionen sind in unserer Zeiterfassung dokumentiert und wurden im Kickoff-Meeting so besprochen. Wir gehen die Unterlagen intern noch einmal durch und melden uns mit der vollständigen Dokumentation.

Beste Grüße,
Selin Kaya`,
      },
    ],
  },
  {
    id: "th-work-acme-eskalation",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Einbindung unserer Rechtsabteilung",
    messages: [
      {
        from: BRANDT,
        to: [SELIN_WORK],
        daysAgo: 14,
        hour: 17,
        minute: 45,
        body: `Sehr geehrte Frau Kaya,

da wir bislang keine korrigierte Rechnung erhalten haben, sehen wir uns gezwungen, den Vorgang an unsere Rechtsabteilung zu übergeben, sollte bis Ende der Woche keine Anpassung erfolgen.

Wir möchten diesen Schritt vermeiden, erwarten aber ein entgegenkommendes Signal Ihrerseits.

Mit freundlichen Grüßen
Thomas Brandt
Acme GmbH`,
      },
      {
        from: SELIN_WORK,
        to: [BRANDT],
        cc: [JONAS],
        daysAgo: 10,
        hour: 11,
        minute: 30,
        body: `Hallo Herr Brandt,

anbei die vollständige Zeiterfassung zur Rechnung #A-1042, aufgeschlüsselt nach Phasen: Konzept & Wireframes 8 Std., UI-Design 12 Std., Frontend-Entwicklung 14 Std., Content-Migration 4 Std., Testing 2 Std. — gesamt 40 Stunden.

Die Content-Migration und das Testing sind im Kickoff-Protokoll vom Projektstart ausdrücklich als Teil des Auftragsumfangs festgehalten. Wir sehen daher keinen Grund für eine Korrektur der Rechnung.

Gerne gehen wir die Aufstellung in einem kurzen Termin gemeinsam durch.

Beste Grüße,
Selin Kaya
Nordwind Studio`,
      },
      {
        from: BRANDT,
        to: [SELIN_WORK],
        daysAgo: 10,
        hour: 16,
        minute: 50,
        body: `Hallo Frau Kaya,

danke für die Aufstellung. Wir akzeptieren 90% der Rechnung und geben die Zahlung entsprechend frei. Für die verbleibenden Stunden bitten wir im Sinne der weiteren Zusammenarbeit um einen Kulanzrabatt.

Mit freundlichen Grüßen
Thomas Brandt`,
      },
      {
        from: SELIN_WORK,
        to: [BRANDT],
        cc: [JONAS],
        daysAgo: 8,
        hour: 9,
        minute: 20,
        body: `Hallo Herr Brandt,

danke für die Freigabe der 90%. Zum Kulanzrabatt auf die restlichen Stunden: das prüfen wir intern und melden uns bis Ende der Woche bei Ihnen.

Beste Grüße,
Selin Kaya`,
      },
      {
        from: BRANDT,
        to: [SELIN_WORK],
        daysAgo: 7,
        hour: 14,
        minute: 0,
        body: `Hallo Frau Kaya,

in Ordnung. Wir veranlassen die Zahlung der unstrittigen 90% schon einmal, der Betrag sollte in den nächsten Tagen bei Ihnen eingehen.

Mit freundlichen Grüßen
Thomas Brandt`,
      },
      {
        from: SELIN_WORK,
        to: [BRANDT],
        cc: [JONAS],
        daysAgo: 6,
        hour: 10,
        minute: 15,
        body: `Hallo Herr Brandt,

danke für die Info, wir haben die Zahlung notiert. Zum Restbetrag melden wir uns nach unserer internen Abstimmung.

Beste Grüße,
Selin Kaya`,
      },
    ],
  },
  {
    id: "th-work-acme-q3",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Anfrage Rabatt für Q3",
    messages: [
      {
        from: BRANDT,
        to: [SELIN_WORK],
        daysAgo: 4,
        hour: 9,
        minute: 50,
        body: `Hallo Frau Kaya,

mit Blick auf die weitere Zusammenarbeit und die ganze Rechnungssache der letzten Wochen möchten wir für den Q3-Retainer einen Nachlass von 10% vereinbaren. Wir denken, das wäre ein faires Signal auf beiden Seiten.

Bitte lassen Sie uns bis Anfang nächster Woche wissen, ob Sie mitgehen.

Mit freundlichen Grüßen
Thomas Brandt
Acme GmbH`,
      },
    ],
  },
  // ---- Work: Kaltwasser & Rieger (Felix Rieger), slow payment ----
  {
    id: "th-work-rieger-2031",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Projektabschluss Branding & Rechnung 2031",
    messages: [
      {
        from: SELIN_WORK,
        to: [RIEGER],
        daysAgo: 19,
        hour: 14,
        minute: 30,
        body: `Hallo Herr Rieger,

das Branding-Projekt ist damit abgeschlossen, alle finalen Dateien liegen im gemeinsamen Ordner. Danke für die gute Zusammenarbeit!

Unsere Buchhaltung (Mara Lindqvist) hat Ihnen heute die Rechnung #2031 über 2.450 € geschickt, Zahlungsziel 14 Tage.

Beste Grüße,
Selin Kaya
Nordwind Studio`,
      },
      {
        from: RIEGER,
        to: [SELIN_WORK],
        daysAgo: 19,
        hour: 16,
        minute: 45,
        body: `Hallo Frau Kaya,

vielen Dank, die Unterlagen und die Rechnung sind angekommen. Die Rechnung geht in unsere Buchhaltung. Das Ergebnis kommt im Büro sehr gut an, wir melden uns sicher für das nächste Projekt.

Beste Grüße
Felix Rieger
Kaltwasser & Rieger Architekten`,
      },
    ],
  },
  {
    id: "th-work-rieger-verzoegert",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Entschuldigung, Zahlung verzögert",
    messages: [
      {
        from: RIEGER,
        to: [SELIN_WORK],
        cc: [MARA],
        daysAgo: 11,
        hour: 15,
        minute: 40,
        body: `Hallo Frau Kaya,

danke für die Erinnerung und entschuldigen Sie die Verzögerung bei Rechnung #2031 — ich war zwei Wochen im Urlaub und die Freigabe ist liegen geblieben. Die Zahlung geht bis Ende der Woche raus.

Beste Grüße
Felix Rieger`,
      },
      {
        from: SELIN_WORK,
        to: [RIEGER],
        cc: [MARA],
        daysAgo: 10,
        hour: 8,
        minute: 50,
        body: `Hallo Herr Rieger,

alles gut, danke für die schnelle Rückmeldung — dann wissen wir Bescheid. Erholsamen Wiedereinstieg!

Beste Grüße,
Selin Kaya`,
      },
    ],
  },
  // ---- Work: Mara Lindqvist (freelance accountant), monthly bookkeeping ----
  {
    id: "th-work-mara-2031",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Rechnung 2031 an Kaltwasser & Rieger",
    messages: [
      {
        from: MARA,
        to: [SELIN_WORK],
        daysAgo: 21,
        hour: 9,
        minute: 10,
        body: `Hallo Selin,

Rechnung #2031 an Kaltwasser & Rieger Architekten ist heute raus (2.450 €, fällig in 14 Tagen). Kopie liegt wie immer im Buchhaltungsordner.

Viele Grüße
Mara`,
      },
      {
        from: MARA,
        to: [SELIN_WORK],
        daysAgo: 13,
        hour: 8,
        minute: 40,
        body: `Hallo Selin,

kurzer Hinweis: #2031 ist jetzt 3 Tage überfällig, von Kaltwasser & Rieger kam bisher nichts. Magst du eine freundliche Erinnerung schicken? Von mir wirkt das immer gleich so nach Mahnung.

Viele Grüße
Mara`,
      },
      {
        from: SELIN_WORK,
        to: [MARA],
        daysAgo: 12,
        hour: 10,
        minute: 20,
        body: `Hallo Mara,

mach ich, die Erinnerung an Herrn Rieger geht heute raus, ich setze dich in CC. Er ist erfahrungsgemäß langsam, aber zuverlässig.

Beste Grüße,
Selin`,
      },
      {
        from: MARA,
        to: [SELIN_WORK],
        daysAgo: 6,
        hour: 9,
        minute: 5,
        body: `Hallo Selin,

gute Nachricht: die Zahlung von Kaltwasser & Rieger ist heute vollständig eingegangen. #2031 ist damit erledigt.

Viele Grüße
Mara`,
      },
      {
        from: SELIN_WORK,
        to: [MARA],
        daysAgo: 5,
        hour: 11,
        minute: 30,
        body: `Hallo Mara,

super, danke dir! Dann ist Q2 auf der Einnahmenseite ja fast rund.

Beste Grüße,
Selin`,
      },
    ],
  },
  {
    id: "th-work-mara-q2",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Quartalsabschluss Q2",
    messages: [
      {
        from: MARA,
        to: [SELIN_WORK],
        daysAgo: 3,
        hour: 9,
        minute: 30,
        body: `Hallo Selin,

für den Q2-Abschluss fehlen mir noch ein paar Belege von euch: die Eingangsrechnung von Yusuf, die Software-Abos und eventuelle Reisekosten. Ich bräuchte alles bis Freitag, dann bekomme ich den Abschluss noch vor meinem Urlaub fertig.

Viele Grüße
Mara`,
      },
      {
        from: SELIN_WORK,
        to: [MARA],
        daysAgo: 2,
        hour: 18,
        minute: 20,
        body: `Hallo Mara,

bin dran — Yusufs Rechnung und die Reisekosten hab ich schon zusammen, die Abo-Belege ziehe ich mir morgen aus den Portalen. Du bekommst alles bis Donnerstag.

Beste Grüße,
Selin`,
      },
      {
        from: MARA,
        to: [SELIN_WORK],
        daysAgo: 1,
        hour: 8,
        minute: 30,
        body: `Hallo Selin,

perfekt, danke. Denk bei den Abos bitte an alle drei (Adobe, Figma, Slack) — letztes Quartal hat Figma gefehlt.

Viele Grüße
Mara`,
      },
    ],
  },
  // ---- Work: Yusuf Demir (freelance dev) ----
  {
    id: "th-work-yusuf-invoice",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Rechnung Acme-Projekt",
    messages: [
      {
        from: YUSUF,
        to: [SELIN_WORK],
        daysAgo: 20,
        hour: 10,
        minute: 30,
        body: `Hi Selin,

anbei meine Rechnung für die Entwicklungsarbeit am Acme-Projekt (1.200 €, Juni). Bankverbindung wie immer, steht aber auch nochmal auf der Rechnung.

Danke und viele Grüße
Yusuf`,
      },
      {
        from: YUSUF,
        to: [SELIN_WORK],
        daysAgo: 11,
        hour: 16,
        minute: 40,
        body: `Hi Selin,

kurze Nachfrage: ist meine Rechnung vom Acme-Projekt bei euch angekommen? Keine Eile mit der Zahlung, ich will nur sicher sein, dass sie nicht im Spam gelandet ist.

Viele Grüße
Yusuf`,
      },
    ],
  },
  {
    id: "th-work-yusuf-staging",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Acme Staging & offene Punkte",
    messages: [
      {
        from: YUSUF,
        to: [SELIN_WORK],
        daysAgo: 16,
        hour: 11,
        minute: 20,
        body: `Hi Selin,

das Staging für den Acme-Relaunch ist aktualisiert. Zwei Punkte sind noch offen: die Formular-Validierung spinnt auf Mobile (Fehlermeldung bleibt hängen) und die Galerie lädt auf langsamen Verbindungen zu träge. Beides machbar, sag mir nur, was zuerst.

Viele Grüße
Yusuf`,
      },
      {
        from: SELIN_WORK,
        to: [YUSUF],
        daysAgo: 16,
        hour: 14,
        minute: 5,
        body: `Hi Yusuf,

danke dir! Nimm bitte zuerst die Galerie — Acme schaut Ende der Woche aufs Staging, und Ladezeit fällt denen sofort auf. Das Formular danach.

Beste Grüße,
Selin`,
      },
      {
        from: YUSUF,
        to: [SELIN_WORK],
        daysAgo: 15,
        hour: 18,
        minute: 30,
        body: `Hi Selin,

beides erledigt: Galerie lädt jetzt progressiv, Formular-Bug war ein fehlender State-Reset. Lighthouse ist wieder komplett grün. Kannst du morgen kurz drüberschauen, bevor Acme draufguckt?

Viele Grüße
Yusuf`,
      },
    ],
  },
  // ---- Work: prospects (Meredith Voss, Robert Fenner) ----
  {
    id: "th-work-voss",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Interest in rebranding",
    messages: [
      {
        from: "Meredith Voss <meredith@vossandkline.com>",
        to: [SELIN_WORK],
        daysAgo: 7,
        hour: 17,
        minute: 10,
        body: `Hi Selin,

I got your name from Felix Rieger at Kaltwasser & Rieger — he showed me the branding work you did for them and I was impressed.

We're a consulting firm of about 20 people and our brand hasn't been touched since 2018. We'd like to talk about a full rebrand: logo, website, templates. Would you have time for an initial call next week?

Best regards,
Meredith Voss
Voss & Kline Consulting`,
      },
    ],
  },
  {
    id: "th-work-fenner",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Website Relaunch Anfrage",
    messages: [
      {
        from: "Robert Fenner <r.fenner@fenner-immobilien.de>",
        to: [SELIN_WORK],
        daysAgo: 16,
        hour: 13,
        minute: 40,
        body: `Sehr geehrte Frau Kaya,

wir sind ein Immobilienbüro in Berlin-Charlottenburg und möchten unsere Website erneuern lassen. Die bestehende Seite hat rund 15 Unterseiten, dazu hätten wir gerne ein neues Buchungssystem für Besichtigungstermine.

Können Sie uns einen groben Budgetrahmen und Zeitplan nennen? Referenzen aus der Immobilienbranche wären ebenfalls interessant.

Mit freundlichen Grüßen
Robert Fenner
Fenner Immobilien`,
      },
    ],
  },
  // ---- Work: internal (Jonas Weber, co-founder) ----
  {
    id: "th-work-jonas-acme",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Acme Rechnung",
    messages: [
      {
        from: SELIN_WORK,
        to: [JONAS],
        daysAgo: 20,
        hour: 17,
        minute: 30,
        body: `Hi Jonas,

Brandt stellt die 40 Stunden auf #A-1042 in Frage und will eine Aufschlüsselung. Ich hab ihm die Aufstellung nach Phasen zugesagt. Wie siehst du das — gibt es irgendeinen Punkt, wo wir wirklich angreifbar sind?

LG,
Selin`,
      },
      {
        from: JONAS,
        to: [SELIN_WORK],
        daysAgo: 19,
        hour: 21,
        minute: 30,
        body: `Hi Selin,

nein, die Stunden sind sauber. Die wollen die Rechnung einfach runterhandeln, das machen die laut Yusuf bei ihren anderen Dienstleistern genauso. Ich würde bei den 40 Stunden bleiben und die Zeiterfassung offenlegen — wir haben nichts zu verstecken.

Jonas`,
      },
      {
        from: JONAS,
        to: [SELIN_WORK],
        daysAgo: 12,
        hour: 14,
        minute: 20,
        body: `Hi Selin,

nach Brandts Rechtsabteilungs-Nummer hab ich mal eine feste Antwort vorbereitet: komplette Zeiterfassung, Verweis aufs Kickoff-Protokoll, keine Korrektur. Liegt im Entwürfe-Ordner. Schau bitte einmal drüber, bevor sie rausgeht — ich will nicht, dass uns eine Formulierung auf die Füße fällt.

Jonas`,
      },
      {
        from: SELIN_WORK,
        to: [JONAS],
        daysAgo: 11,
        hour: 10,
        minute: 40,
        body: `Hi Jonas,

hab drübergeschaut, ist gut. Ich hab zwei Formulierungen entschärft ("unbegründet" raus, "nicht nachvollziehbar" rein) und den Terminvorschlag ans Ende gezogen. So kann sie morgen früh raus.

LG,
Selin`,
      },
      {
        from: JONAS,
        to: [SELIN_WORK],
        daysAgo: 2,
        hour: 19,
        minute: 45,
        body: `Hi Selin,

zu Brandts 10%-Wunsch für Q3: ich bin dagegen. Wenn wir nach dem Rechnungstheater jetzt nachgeben, macht er das bei jeder Rechnung wieder. Lass uns vorher kurz die Q3-Strategie abstimmen — auch, ob wir den Retainer überhaupt verlängern wollen.

Jonas`,
      },
    ],
  },
  {
    id: "th-work-jonas-portfolio",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Neue Case Studies fürs Portfolio",
    messages: [
      {
        from: JONAS,
        to: [SELIN_WORK],
        daysAgo: 5,
        hour: 16,
        minute: 30,
        body: `Hi Selin,

ich hab drei neue Case Studies fürs Portfolio angelegt (Figma, Seite "Portfolio ${CURRENT_YEAR}"): Kaltwasser & Rieger, das Acme-Relaunch-Projekt und die alte Bäckerei-Kampagne. Magst du drüberschauen, bevor ich sie auf die Website stelle? Bei Acme bin ich unsicher, wie viel wir angesichts der Rechnungsgeschichte erzählen wollen.

Jonas`,
      },
    ],
  },
  // ---- Work: misc inbound ----
  {
    id: "th-work-nina",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Danke & Update",
    messages: [
      {
        from: "Nina Krause <nina.krause@gmail.com>",
        to: [SELIN_WORK],
        daysAgo: 19,
        hour: 12,
        minute: 50,
        body: `Hallo Selin,

ich wollte mich nochmal für die Praktikumszeit bei euch bedanken — ich hab in den sechs Monaten mehr gelernt als im ganzen Studium davor. Kleines Update: ich habe ab nächsten Monat eine feste Stelle als Junior Designerin bei einer Agentur in Kreuzberg!

Liebe Grüße an Jonas,
Nina`,
      },
    ],
  },
  {
    id: "th-work-meetup",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Speaker-Anfrage September",
    messages: [
      {
        from: "Design & Code Meetup Berlin <hello@designcodeberlin.de>",
        to: [SELIN_WORK],
        daysAgo: 9,
        hour: 10,
        minute: 20,
        body: `Hallo Selin, hallo Jonas,

wir planen gerade das September-Meetup und würden euch gerne als Speaker gewinnen — eure Arbeit für kleine Studios und lokale Marken passt perfekt zu unserem Schwerpunkt "Branding jenseits der Großagentur".

30 Minuten Talk plus Q&A, ca. 80 Leute, Location wie immer in der Kulturbrauerei. Hättet ihr Lust?

Viele Grüße vom Orga-Team
Design & Code Meetup Berlin`,
      },
    ],
  },
  {
    id: "th-work-ionos",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Ihre Domain nordwind-studio.de läuft in 30 Tagen ab",
    messages: [
      {
        from: "IONOS <support@ionos.de>",
        to: [SELIN_WORK],
        daysAgo: 20,
        hour: 6,
        minute: 15,
        body: `Guten Tag,

Ihre Domain nordwind-studio.de läuft in 30 Tagen ab. Die automatische Verlängerung ist aktiv — Sie müssen nichts weiter tun. Die Abbuchung erfolgt zum Verlängerungsdatum über die hinterlegte Zahlungsmethode.

Ihr IONOS Team`,
      },
    ],
  },
  {
    id: "th-work-nl-adobe",
    accountId: DEMO_WORK_ACCOUNT_ID,
    subject: "Neu in Creative Cloud: das Juli-Update",
    messages: [
      {
        from: "Adobe Creative Cloud <mail@email.adobe.com>",
        to: [SELIN_WORK],
        daysAgo: 8,
        hour: 5,
        minute: 30,
        body: `Das ist neu in Ihren Apps: schnellere Auswahlwerkzeuge in Photoshop, verbesserte Variable Fonts in Illustrator und neue Team-Bibliotheken-Funktionen.

Jetzt aktualisieren und alle Neuerungen entdecken.

Abmelden | Präferenzen verwalten`,
      },
    ],
  },
  // ---- Personal: family (Ayşe, Deniz) ----
  {
    id: "th-pers-mama-opa",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Geburtstag von Opa",
    messages: [
      {
        from: "Ayşe Kaya <ayse.kaya1968@gmail.com>",
        to: [SELIN_PERSONAL],
        daysAgo: 21,
        hour: 19,
        minute: 40,
        body: `Selin canım,

nicht vergessen: Opas 80. Geburtstag ist in drei Wochen! Wir feiern bei uns zu Hause, die ganze Familie kommt. Bist du dabei? Deniz hat schon zugesagt.

Öptüm,
Mama`,
      },
      {
        from: SELIN_PERSONAL,
        to: ["Ayşe Kaya <ayse.kaya1968@gmail.com>"],
        daysAgo: 20,
        hour: 12,
        minute: 30,
        body: `Liebe Mama,

natürlich bin ich dabei, das lasse ich mir doch nicht entgehen! Soll ich was mitbringen? Sag einfach Bescheid, wenn die Uhrzeit feststeht.

Liebe Grüße, Selin`,
      },
      {
        from: "Ayşe Kaya <ayse.kaya1968@gmail.com>",
        to: [SELIN_PERSONAL],
        daysAgo: 4,
        hour: 10,
        minute: 15,
        body: `Selin canım,

die Uhrzeit steht jetzt fest: Samstag um 18 Uhr bei uns. Bringst du einen großen Salat mit? Deine Tante bringt Börek, ich mache den Rest.

Öptüm,
Mama`,
      },
      {
        from: SELIN_PERSONAL,
        to: ["Ayşe Kaya <ayse.kaya1968@gmail.com>"],
        daysAgo: 3,
        hour: 9,
        minute: 0,
        body: `Liebe Mama,

Salat geht klar, ich mach den großen mit Granatapfel, den Opa so mag. Bis Samstag!

Liebe Grüße, Selin`,
      },
      {
        from: "Ayşe Kaya <ayse.kaya1968@gmail.com>",
        to: [SELIN_PERSONAL],
        daysAgo: 2,
        hour: 20,
        minute: 50,
        body: `Meine Lieben,

danke euch allen für den wunderschönen Abend, Opa hat sich so gefreut! Ein paar Fotos hänge ich an, die restlichen schickt Deniz rum.

Öptüm,
Mama`,
      },
    ],
  },
  {
    id: "th-pers-mama-geschenk",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Geschenk-Idee",
    messages: [
      {
        from: "Ayşe Kaya <ayse.kaya1968@gmail.com>",
        to: [SELIN_PERSONAL],
        daysAgo: 12,
        hour: 18,
        minute: 25,
        body: `Selin canım,

wegen Opas Geschenk: was hältst du davon, wenn du dir mit Deniz ein gemeinsames Geschenk teilst? Er hatte die Idee mit der gravierten Armbanduhr, die wäre alleine etwas teuer. Sprecht euch ab, ja?

Öptüm,
Mama`,
      },
    ],
  },
  {
    id: "th-pers-deniz-geschenk",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Geschenk",
    messages: [
      {
        from: "Deniz Kaya <deniz.kaya.b@gmail.com>",
        to: [SELIN_PERSONAL],
        daysAgo: 9,
        hour: 12,
        minute: 40,
        body: `Hey Selin,

hab die Uhr für Opa eben bestellt, mit Gravur ("80 Jahre — die Familie"). Kommt rechtzeitig an. Schickst du mir deinen Anteil per PayPal? 40 € wären es.

Deniz`,
      },
    ],
  },
  {
    id: "th-pers-deniz-grillen",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Grillen am Samstag",
    messages: [
      {
        from: "Deniz Kaya <deniz.kaya.b@gmail.com>",
        to: [SELIN_PERSONAL],
        daysAgo: 1,
        hour: 17,
        minute: 35,
        body: `Hey Selin,

wir grillen am Samstag bei mir aufm Balkon, so ab 16 Uhr. Ein paar Leute bringen Salate und Beilagen mit — magst du auch was beisteuern? Fleisch und Kohle hab ich.

Deniz`,
      },
    ],
  },
  // ---- Personal: friends (Elif, Kerem) ----
  {
    id: "th-pers-elif-konzert",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Konzert am Freitag?",
    messages: [
      {
        from: "Elif Aydın <elif.aydin89@gmail.com>",
        to: [SELIN_PERSONAL],
        daysAgo: 14,
        hour: 20,
        minute: 15,
        body: `Hey Selin,

am Freitag spielt die Band, von der ich dir erzählt hab, im Astra! Tickets gibt's noch für 24 €. Kommst du mit? Sag schnell Bescheid, ich würde uns dann welche holen.

Elif`,
      },
    ],
  },
  {
    id: "th-pers-kerem-fotos",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Fotos vom Wochenende",
    messages: [
      {
        from: "Kerem Aksu <kerem.aksu@web.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 21,
        hour: 21,
        minute: 10,
        body: `Hey Selin,

hier der Link zu den Fotos vom Ausflug: photos.app.goo.gl/kerem-wannsee-album

Die vom Steg sind richtig gut geworden. Musst nichts zurückschicken, nur angucken!

Kerem`,
      },
    ],
  },
  // ---- Personal: Ferienwohnung Seeblick (Sabine Möller) ----
  {
    id: "th-pers-sabine-buchung",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Verfügbarkeit Ferienwohnung Seeblick",
    messages: [
      {
        from: SELIN_PERSONAL,
        to: ["Sabine Möller <sabine.moeller@ferienwohnung-seeblick.de>"],
        daysAgo: 21,
        hour: 10,
        minute: 5,
        body: `Hallo Frau Möller,

wir haben Ihre Ferienwohnung Seeblick auf Rügen im Internet gefunden. Ist die Wohnung in der zweiten Augustwoche (Samstag bis Samstag) noch frei? Wir wären zwei Erwachsene und ein Hund.

Liebe Grüße,
Selin Kaya`,
      },
      {
        from: "Sabine Möller <sabine.moeller@ferienwohnung-seeblick.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 20,
        hour: 9,
        minute: 30,
        body: `Liebe Frau Kaya,

da haben Sie Glück, die Woche im August ist noch frei! Wenn Sie die Wohnung nehmen möchten, bestätigen Sie mir das bitte kurz, dann trage ich Sie fest ein.

Herzliche Grüße von der Ostsee
Sabine Möller`,
      },
      {
        from: SELIN_PERSONAL,
        to: ["Sabine Möller <sabine.moeller@ferienwohnung-seeblick.de>"],
        daysAgo: 19,
        hour: 18,
        minute: 45,
        body: `Hallo Frau Möller,

wunderbar, dann nehmen wir die Woche fest — zwei Erwachsene und ein Hund, wie geschrieben. Schicken Sie mir gerne die Buchungsbestätigung und alles Weitere zur Zahlung.

Liebe Grüße,
Selin Kaya`,
      },
      {
        from: "Sabine Möller <sabine.moeller@ferienwohnung-seeblick.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 17,
        hour: 11,
        minute: 20,
        body: `Liebe Frau Kaya,

hiermit bestätige ich Ihre Buchung der Ferienwohnung Seeblick für die zweite Augustwoche. Ich bitte um eine Anzahlung von 150 € innerhalb von 5 Tagen auf das unten stehende Konto, der Rest wird vor Ort bezahlt.

IBAN: DE89 3704 0044 0532 0130 00, Verwendungszweck: FW-2291

Herzliche Grüße
Sabine Möller`,
      },
      {
        from: "Sabine Möller <sabine.moeller@ferienwohnung-seeblick.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 14,
        hour: 15,
        minute: 10,
        body: `Liebe Frau Kaya,

die Anzahlung ist angekommen, vielen Dank! Damit ist die Buchung komplett. Alles Weitere (Anreise, Türcode) bespreche wir dann näher am Termin.

Herzliche Grüße
Sabine Möller`,
      },
    ],
  },
  {
    id: "th-pers-sabine-anreise",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Anreisezeiten",
    messages: [
      {
        from: "Sabine Möller <sabine.moeller@ferienwohnung-seeblick.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 10,
        hour: 17,
        minute: 20,
        body: `Liebe Frau Kaya,

damit ich die Übergabe planen kann: Wann kommen Sie am Anreisetag ungefähr an? Und sagen Sie mir bitte noch einmal, wie viele Gäste es sind?

Herzliche Grüße
Sabine Möller`,
      },
      {
        from: SELIN_PERSONAL,
        to: ["Sabine Möller <sabine.moeller@ferienwohnung-seeblick.de>"],
        daysAgo: 9,
        hour: 12,
        minute: 10,
        body: `Hallo Frau Möller,

wir kommen am Samstag gegen 15 Uhr an — wir sind zwei Erwachsene und ein Hund. Zwei Fragen hätte ich noch: Gibt es einen Parkplatz an der Wohnung? Und sind Haustiere grundsätzlich in Ordnung?

Liebe Grüße,
Selin Kaya`,
      },
      {
        from: "Sabine Möller <sabine.moeller@ferienwohnung-seeblick.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 6,
        hour: 18,
        minute: 40,
        body: `Liebe Frau Kaya,

ein Parkplatz gehört direkt zur Wohnung, der ist für Sie reserviert. Haustiere sind kein Problem — für den Hund berechne ich eine kleine Endreinigungsgebühr von 15 €. 15 Uhr am Samstag passt gut.

Herzliche Grüße
Sabine Möller`,
      },
    ],
  },
  // ---- Personal: recruiter, admin, misc ----
  {
    id: "th-pers-lena-vogt",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Spannende Rolle als Lead Product Designer",
    messages: [
      {
        from: "Lena Vogt <l.vogt@talentbridge-recruiting.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 16,
        hour: 11,
        minute: 25,
        body: `Hallo Frau Kaya,

ich bin auf Ihr Profil gestoßen und war beeindruckt von Ihrer Arbeit bei Nordwind Studio. Aktuell besetze ich für ein wachsendes Fintech-Startup in Berlin die Rolle Lead Product Designer — Gehaltsband 85-95k, hybrides Arbeiten, Team von aktuell sechs Designern.

Wäre das grundsätzlich interessant für Sie? Ich freue mich über eine kurze Rückmeldung.

Beste Grüße
Lena Vogt
TalentBridge Recruiting`,
      },
      {
        from: "Lena Vogt <l.vogt@talentbridge-recruiting.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 11,
        hour: 9,
        minute: 40,
        body: `Hallo Frau Kaya,

ich wollte kurz nachfassen, ob Sie meine Mail zur Lead-Product-Designer-Rolle gesehen haben. Falls die Position nichts für Sie ist, völlig in Ordnung — ein 15-minütiges Gespräch wäre aber vielleicht trotzdem interessant, allein um den Markt einzuordnen.

Beste Grüße
Lena Vogt
TalentBridge Recruiting`,
      },
    ],
  },
  {
    id: "th-pers-hausverwaltung",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: `Nebenkostenabrechnung ${PREVIOUS_YEAR}`,
    messages: [
      {
        from: "Hausverwaltung Nettbach <verwaltung@nettbach-hausverwaltung.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 19,
        hour: 8,
        minute: 50,
        body: `Sehr geehrte Frau Kaya,

anbei erhalten Sie die Betriebskostenabrechnung für das Jahr ${PREVIOUS_YEAR}. Es ergibt sich eine Nachzahlung von 42,00 €, zahlbar innerhalb von 30 Tagen.

Die wesentlichen Positionen: Heizung 612 €, Wasser/Abwasser 238 €, Hausmeister 148 €, Sonstige Kosten 84 €.

Mit freundlichen Grüßen
Hausverwaltung Nettbach GmbH`,
      },
    ],
  },
  {
    id: "th-pers-zahnarzt",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Terminerinnerung",
    messages: [
      {
        from: "Zahnarztpraxis Dr. Bloch <praxis@zahnarzt-bloch-berlin.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 7,
        hour: 9,
        minute: 5,
        body: `Sehr geehrte Frau Kaya,

wir erinnern Sie an Ihren Kontrolltermin am kommenden Dienstag um 10:00 Uhr. Sollten Sie den Termin nicht wahrnehmen können, geben Sie uns bitte mindestens 24 Stunden vorher Bescheid.

Mit freundlichen Grüßen
Ihr Praxisteam Dr. Bloch`,
      },
    ],
  },
  {
    id: "th-pers-max-kartons",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Umzugskartons",
    messages: [
      {
        from: "Max Schulz <max.schulz88@web.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 12,
        hour: 15,
        minute: 30,
        body: `Hey Selin,

du meintest doch neulich, du brauchst noch Umzugskartons für den Keller — ich hab hier noch gut 20 Stück stehen, stabile. Kannst du gerne haben, müsstest sie nur bei mir in Friedrichshain abholen. Wann würde dir passen?

Max`,
      },
    ],
  },
  // ---- Personal: newsletters ----
  {
    id: "th-pers-nl-n26",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Deine Monatsübersicht für Juni",
    messages: [
      {
        from: "N26 <no-reply@n26.com>",
        to: [SELIN_PERSONAL],
        daysAgo: 8,
        hour: 7,
        minute: 10,
        body: `Hallo Selin,

deine Monatsübersicht ist da: Im Juni hast du 1.842 € ausgegeben, 12% mehr als im Mai. Größte Kategorie: Restaurants & Cafés (386 €).

Alle Details findest du in deiner N26 App.

Dein N26 Team`,
      },
    ],
  },
  {
    id: "th-pers-nl-zalando",
    accountId: DEMO_PERSONAL_ACCOUNT_ID,
    subject: "Nur dieses Wochenende: 20% auf Sommerstyles",
    messages: [
      {
        from: "Zalando <info@mail.zalando.de>",
        to: [SELIN_PERSONAL],
        daysAgo: 13,
        hour: 6,
        minute: 20,
        body: `SOMMER-SALE

Nur dieses Wochenende: 20% Rabatt auf über 5.000 Sommerstyles mit dem Code SOMMER20.

Jetzt shoppen und sparen.

Abmelden | Newsletter-Einstellungen`,
      },
    ],
  },
  // ---- University: thesis supervision (Prof. Dr. Steiner) — the long chain ----
  {
    id: "th-uni-thesis",
    accountId: DEMO_UNI_ACCOUNT_ID,
    subject: "Kapitel 3 – Methodik",
    messages: [
      {
        from: SELIN_UNI,
        to: ["Prof. Dr. Steiner <steiner@tu-berlin.de>"],
        daysAgo: 22,
        hour: 22,
        minute: 10,
        body: `Sehr geehrter Herr Prof. Dr. Steiner,

anbei sende ich Ihnen Kapitel 3 (Methodik) meiner Arbeit als PDF. Eine Frage vorab zu Abschnitt 3.3: Ich bin unsicher, ob der Fragebogen-Pretest mit 5 Personen ausreichend dokumentiert ist oder ob Sie sich dort mehr Detail wünschen.

Mit freundlichen Grüßen,
Selin Kaya`,
      },
      {
        from: "Prof. Dr. Steiner <steiner@tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 21,
        hour: 9,
        minute: 20,
        body: `Liebe Frau Kaya,

danke, Kapitel 3 ist angekommen. Ich schaue es mir in Ruhe an, Sie bekommen meine Rückmeldung innerhalb der nächsten zwei Wochen. Ihre Frage zu 3.3 nehme ich dabei mit auf.

Mit besten Grüßen
Steiner`,
      },
      {
        from: "Prof. Dr. Steiner <steiner@tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 16,
        hour: 10,
        minute: 45,
        body: `Liebe Frau Kaya,

ich habe Kapitel 3 durchgesehen. Zwei wesentliche Punkte:

Erstens ist die Stichprobengröße in 3.2 nicht ausreichend begründet — hier fehlt eine nachvollziehbare Herleitung, warum n=120 angemessen ist. Zweitens fehlen mehrere Zitate, mindestens Müller (2019) und Fischer & Bauer (2021), auf die sich Ihre Argumentation erkennbar stützt.

Außerdem die Frage: Planen Sie die qualitative Vorstudie aus Ihrem Exposé noch? Im aktuellen Kapitel taucht sie nicht mehr auf.

Mit besten Grüßen
Steiner`,
      },
      {
        from: SELIN_UNI,
        to: ["Prof. Dr. Steiner <steiner@tu-berlin.de>"],
        daysAgo: 15,
        hour: 14,
        minute: 30,
        body: `Sehr geehrter Herr Prof. Dr. Steiner,

vielen Dank für die schnelle Rückmeldung. Die Begründung der Stichprobengröße arbeite ich in 3.2 nach, ich würde dafür eine Power-Analyse ergänzen. Die fehlenden Zitate trage ich nach.

Zur qualitativen Vorstudie: Aus Zeitgründen würde ich sie streichen und stattdessen den Fragebogen-Pretest ausbauen (10 statt 5 Personen, mit dokumentiertem Leitfaden). Wäre das aus Ihrer Sicht vertretbar?

Mit freundlichen Grüßen,
Selin Kaya`,
      },
      {
        from: "Prof. Dr. Steiner <steiner@tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 12,
        hour: 8,
        minute: 50,
        body: `Liebe Frau Kaya,

einverstanden — der ausgebaute Pretest ist ein sauberer Ersatz für die Vorstudie, dokumentieren Sie die Entscheidung aber bitte kurz in 3.1.

Zur Besprechung der Überarbeitung schlage ich zwei Termine vor: Dienstag 11:00 Uhr oder Donnerstag 14:00 Uhr, jeweils in meinem Büro.

Mit besten Grüßen
Steiner`,
      },
      {
        from: SELIN_UNI,
        to: ["Prof. Dr. Steiner <steiner@tu-berlin.de>"],
        daysAgo: 10,
        hour: 9,
        minute: 15,
        body: `Sehr geehrter Herr Prof. Dr. Steiner,

Donnerstag 14:00 Uhr passt mir sehr gut. Die Begründung der Streichung nehme ich wie vorgeschlagen in 3.1 auf.

Mit freundlichen Grüßen,
Selin Kaya`,
      },
      {
        from: "Sekretariat Prof. Steiner <sekretariat-steiner@tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 9,
        hour: 11,
        minute: 40,
        body: `Liebe Frau Kaya,

hiermit bestätige ich Ihren Termin bei Prof. Dr. Steiner am Donnerstag um 14:00 Uhr, Raum H 3005. Bitte melden Sie sich kurz im Sekretariat, wenn Sie da sind.

Freundliche Grüße
Sekretariat Prof. Steiner`,
      },
      {
        from: SELIN_UNI,
        to: ["Prof. Dr. Steiner <steiner@tu-berlin.de>"],
        daysAgo: 9,
        hour: 20,
        minute: 30,
        body: `Sehr geehrter Herr Prof. Dr. Steiner,

anbei die überarbeitete Fassung von Kapitel 3. Die Stichprobengröße ist nun über eine Power-Analyse begründet (Abschnitt 3.2), die fehlenden Zitate (Müller 2019, Fischer & Bauer 2021) sind ergänzt, und die Streichung der Vorstudie ist in 3.1 dokumentiert.

Über eine kurze Rückmeldung vor unserem Termin am Donnerstag würde ich mich freuen.

Mit freundlichen Grüßen,
Selin Kaya`,
      },
      {
        from: "Prof. Dr. Steiner <steiner@tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 6,
        hour: 9,
        minute: 10,
        body: `Liebe Frau Kaya,

die Überarbeitung sieht gut aus — die Power-Analyse ist genau das, was gefehlt hat. Es bleiben Kleinigkeiten: Die Zitierweise wechselt in 3.2 zwischen zwei Formaten (bitte durchgängig APA), und die Tabellenbeschriftungen gehören über die Tabelle, nicht darunter.

Wie sieht Ihr Zeitplan für Kapitel 4 aus? Das sollten wir am Donnerstag besprechen.

Mit besten Grüßen
Steiner`,
      },
      {
        from: "Prof. Dr. Steiner <steiner@tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 3,
        hour: 8,
        minute: 40,
        body: `Liebe Frau Kaya,

zur Erinnerung: Der vollständige Entwurf Ihrer Arbeit ist in drei Wochen fällig. Schicken Sie mir bitte vorab die finale Kapitelgliederung, damit wir spät auftauchende Strukturprobleme vermeiden.

Mit besten Grüßen
Steiner`,
      },
      {
        from: SELIN_UNI,
        to: ["Prof. Dr. Steiner <steiner@tu-berlin.de>"],
        daysAgo: 2,
        hour: 17,
        minute: 20,
        body: `Sehr geehrter Herr Prof. Dr. Steiner,

anbei die finale Kapitelgliederung (Betreff wie besprochen mit Kapitelbezug). Kapitel 4 (Ergebnisse) schließe ich bis Ende des Monats ab, die Rohfassung von Kapitel 5 folgt direkt danach — der Abgabetermin ist damit gut erreichbar.

Mit freundlichen Grüßen,
Selin Kaya`,
      },
    ],
  },
  // ---- University: group project & fellow students ----
  {
    id: "th-uni-yeliz-statistik",
    accountId: DEMO_UNI_ACCOUNT_ID,
    subject: "Gruppenarbeit Statistik",
    messages: [
      {
        from: "Yeliz Aksoy <yeliz.aksoy@campus.tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 20,
        hour: 16,
        minute: 20,
        body: `Hey Selin,

die Statistik-Aufgabe ist raus und Aufgabe 3 sieht übel aus (gemischte Modelle, natürlich). Sollen wir uns zusammensetzen statt einzeln dran zu verzweifeln? Matteo wäre auch dabei.

LG
Yeliz`,
      },
      {
        from: SELIN_UNI,
        to: ["Yeliz Aksoy <yeliz.aksoy@campus.tu-berlin.de>"],
        daysAgo: 19,
        hour: 13,
        minute: 45,
        body: `Hey Yeliz,

gerne, alleine wird das nichts bei mir. Diese oder nächste Woche? Nachmittags passt mir am besten, vormittags sitze ich an der Thesis.

LG
Selin`,
      },
      {
        from: "Yeliz Aksoy <yeliz.aksoy@campus.tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 14,
        hour: 12,
        minute: 30,
        body: `Hey Selin,

wie wäre Donnerstag 16 Uhr in der Bibliothek? Ich reserviere einen Gruppenraum, Matteo hat schon zugesagt. Bring am besten deine Notizen zu Aufgabe 3 mit, du warst da glaube ich am weitesten.

LG
Yeliz`,
      },
    ],
  },
  {
    id: "th-uni-matteo-skript",
    accountId: DEMO_UNI_ACCOUNT_ID,
    subject: "Skript Woche 12",
    messages: [
      {
        from: "Matteo Rossi <matteo.rossi@campus.tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 10,
        hour: 21,
        minute: 15,
        body: `Hey Selin,

du hast letzte Woche die Vorlesung verpasst, oder? Hier meine Mitschrift von Woche 12 als PDF — die Folien allein bringen dir nichts, er hat die Hälfte nur mündlich erklärt.

Ciao
Matteo`,
      },
      {
        from: "Matteo Rossi <matteo.rossi@campus.tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 2,
        hour: 19,
        minute: 30,
        body: `Hey Selin,

kurze Frage: ist die Mitschrift von Woche 12 bei dir angekommen? Keine Eile, will nur wissen, ob der Anhang durchgegangen ist — die Uni-Mail schluckt PDFs manchmal.

Ciao
Matteo`,
      },
    ],
  },
  // ---- University: administration & notices ----
  {
    id: "th-uni-pruefungsamt",
    accountId: DEMO_UNI_ACCOUNT_ID,
    subject: "Rückmeldung Wintersemester",
    messages: [
      {
        from: "Prüfungsamt TU Berlin <pruefungsamt@tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 21,
        hour: 8,
        minute: 30,
        body: `Sehr geehrte Studierende,

die Rückmeldefrist für das Wintersemester läuft am 15. des Monats ab. Bitte überweisen Sie den Semesterbeitrag von 314,09 € rechtzeitig — maßgeblich ist der Zahlungseingang, nicht das Überweisungsdatum.

Bei nicht fristgerechter Rückmeldung wird ein Säumniszuschlag fällig.

Mit freundlichen Grüßen
Ihr Prüfungsamt der TU Berlin`,
      },
    ],
  },
  {
    id: "th-uni-bibliothek",
    accountId: DEMO_UNI_ACCOUNT_ID,
    subject: "Fällige Medien – Erinnerung",
    messages: [
      {
        from: "Bibliothek TU Berlin <bibliothek@tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 17,
        hour: 7,
        minute: 0,
        body: `Guten Tag,

2 von Ihnen entliehene Medien sind in 3 Tagen fällig:

"Quantitative Methoden der Sozialforschung" (Signatur QS 240)
"Fragebogenkonstruktion in der Praxis" (Signatur QS 315)

Eine Verlängerung ist über Ihr Bibliothekskonto möglich, sofern keine Vormerkung vorliegt.

Ihre Universitätsbibliothek`,
      },
      {
        from: "Bibliothek TU Berlin <bibliothek@tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 5,
        hour: 12,
        minute: 20,
        body: `Guten Tag,

2 von Ihnen entliehene Medien sind in 3 Tagen fällig:

"Quantitative Methoden der Sozialforschung" (Signatur QS 240)
"Statistik für Human- und Sozialwissenschaftler" (Signatur QS 108)

Eine Verlängerung ist über Ihr Bibliothekskonto möglich, sofern keine Vormerkung vorliegt.

Ihre Universitätsbibliothek`,
      },
    ],
  },
  // ---- University: recruiter cross-account (Lena Vogt also writes the personal address) ----
  {
    id: "th-uni-lena-vogt",
    accountId: DEMO_UNI_ACCOUNT_ID,
    subject: "Absolventenprogramm Product Design",
    messages: [
      {
        from: "Lena Vogt <l.vogt@talentbridge-recruiting.de>",
        to: [SELIN_UNI],
        daysAgo: 12,
        hour: 10,
        minute: 50,
        body: `Hallo Frau Kaya,

Ihre TU-Berlin-Adresse habe ich über das Absolventenverzeichnis Ihres Studiengangs gefunden. Für Absolventinnen mit Design-Schwerpunkt habe ich aktuell ein Trainee-Programm bei einem großen E-Commerce-Unternehmen im Angebot — Start flexibel nach Abgabe Ihrer Abschlussarbeit.

Falls Sie parallel schon fest arbeiten, ignorieren Sie diese Mail einfach.

Beste Grüße
Lena Vogt
TalentBridge Recruiting`,
      },
    ],
  },
  // ---- University: newsletters ----
  {
    id: "th-uni-nl-fachschaft",
    accountId: DEMO_UNI_ACCOUNT_ID,
    subject: "Fachschafts-Rundmail: Sommerfest & Klausurenarchiv",
    messages: [
      {
        from: "Fachschaft Informatik <fachschaft-informatik@lists.tu-berlin.de>",
        to: [SELIN_UNI],
        daysAgo: 6,
        hour: 18,
        minute: 0,
        body: `Hallo zusammen,

zwei Dinge diese Woche: Das Fachschafts-Sommerfest steigt am 26. ab 16 Uhr auf der Wiese hinterm MAR-Gebäude (Grill vorhanden, bringt was mit). Und das Klausurenarchiv ist umgezogen — der neue Link steht im Wiki.

Eure Fachschaft`,
      },
    ],
  },
  {
    id: "th-uni-nl-daad",
    accountId: DEMO_UNI_ACCOUNT_ID,
    subject: "DAAD Newsletter: Stipendien mit Bewerbungsschluss im August",
    messages: [
      {
        from: "DAAD <newsletter@daad.de>",
        to: [SELIN_UNI],
        daysAgo: 11,
        hour: 9,
        minute: 0,
        body: `Liebe Leserinnen und Leser,

im August enden die Bewerbungsfristen für mehrere Förderprogramme, darunter Jahresstipendien für Masterabsolventen und Kurzstipendien für Abschlussarbeiten im Ausland.

Alle Ausschreibungen finden Sie in der Stipendiendatenbank auf daad.de.

Ihr DAAD-Newsletter-Team`,
      },
    ],
  },
];
