import type { ImboxFacts, ImboxMessage, SenderHistory } from "../../../src/server/services/imbox/classifier";

/** What a test says about the mailbox: any part of the facts, the sender's history partly. */
export type FactsInput = Partial<Omit<ImboxFacts, "sender">> & { sender?: Partial<SenderHistory> };

/**
 * Test emails for the imbox classifier: what arrives in a real mailbox, in English and German, with what the mailbox knows about
 * the sender (`facts`) and what the classifier is expected to decide. The user is Philipp Staender <philipp@example.com>.
 */
export interface Sample {
  name: string;
  message: Partial<ImboxMessage> & { from: ImboxMessage["from"] };
  facts?: FactsInput;
  important: boolean;
  /** A signal that must be among the reasons (part of its name). */
  expectSignal?: string;
  ruledOut?: string;
}

const ME = { name: "Philipp Staender", address: "philipp@example.com" };

export function baseFacts(over: FactsInput = {}): ImboxFacts {
  return {
    ownAddresses: new Set(["philipp@example.com", "philipp@work.example.org"]),
    ownNames: ["philipp"],
    threadReply: false,
    inJunkFolder: false,
    ...over,
    sender: { sentTo: 0, receivedGood: 0, receivedJunk: 0, ...(over.sender ?? {}) },
  };
}

export function baseMessage(over: Partial<ImboxMessage>): ImboxMessage {
  return {
    from: [],
    to: [ME],
    cc: [],
    replyTo: [],
    subject: "",
    plainText: "",
    htmlText: null,
    headersRaw: "",
    authenticationResults: null,
    spf: null,
    attachmentNames: [],
    ...over,
  };
}

const LIST_HEADERS = 'List-Unsubscribe: <mailto:unsubscribe@shop.example.com>, <https://shop.example.com/u/123>\nList-Id: <news.shop.example.com>\nPrecedence: bulk';

export const IMPORTANT: Sample[] = [
  {
    name: "a friend I write to regularly",
    message: {
      from: [{ name: "Anna Becker", address: "anna.becker@gmail.example" }],
      subject: "Samstag?",
      plainText: "Hey Philipp,\n\nhast du am Samstag Zeit für ein Bier? Ich hab dir auch noch die Fotos vom Urlaub mitgebracht.\n\nLG Anna",
    },
    facts: { sender: { sentTo: 12, receivedGood: 30 } },
    important: true,
    expectSignal: "you have written to this address",
  },
  {
    name: "an answer to a message I sent (a stranger, but a conversation I started)",
    message: {
      from: [{ name: "Tom Vogel", address: "tom@vogel-consulting.example" }],
      subject: "Re: Anfrage Angebot Webseite",
      plainText: "Hallo Herr Staender,\n\nvielen Dank für Ihre Anfrage. Wir können Ihnen bis Freitag ein Angebot schicken.\n\nViele Grüße\nTom Vogel",
    },
    facts: { threadReply: true },
    important: true,
    expectSignal: "answers a message you sent",
  },
  {
    name: "a colleague: work-related, addressed to me by name, never written to before",
    message: {
      from: [{ name: "Julia Meier", address: "julia.meier@work.example.org" }],
      subject: "Meeting Projekt Alpha morgen",
      plainText: "Hi Philipp,\n\nkannst du morgen um 10 Uhr zur Besprechung zum Projekt Alpha kommen? Ich brauche dein Feedback zur Präsentation.\n\nJulia",
    },
    facts: { sender: { receivedGood: 3 } },
    important: true,
    expectSignal: "work-related",
  },
  {
    name: "a first message from a person, in English, addressed to me by name",
    message: {
      from: [{ name: "Sarah Klein", address: "sarah@startup.example" }],
      subject: "Question about your talk",
      plainText: "Hi Philipp,\n\nI saw your talk at the conference last week and had a question about the caching part. Do you have 10 minutes for a call next week?\n\nBest,\nSarah",
    },
    important: true,
    expectSignal: "greets you by name",
  },
  {
    name: "a person with a file, only me as recipient",
    message: {
      from: [{ name: "Dr. Lena Roth", address: "l.roth@praxis-roth.example" }],
      subject: "Ihre Unterlagen",
      plainText: "Sehr geehrter Herr Staender,\n\nanbei erhalten Sie die besprochenen Unterlagen.\n\nMit freundlichen Grüßen\nDr. Roth",
      attachmentNames: ["Unterlagen.pdf"],
    },
    facts: { sender: { receivedGood: 2 } },
    important: true,
  },
  {
    name: "a mailing list I take part in (I have written to it)",
    message: {
      from: [{ name: "Ruby Users", address: "ruby-users@lists.example.org" }],
      to: [{ address: "ruby-users@lists.example.org" }],
      subject: "Re: [ruby-users] best way to parse CSV?",
      plainText: "Philipp asked about CSV parsing. The stdlib csv gem works fine for most cases; for huge files stream it.\n",
      headersRaw: "List-Id: <ruby-users.lists.example.org>\nList-Unsubscribe: <mailto:ruby-users-unsubscribe@lists.example.org>",
    },
    facts: { sender: { sentTo: 6, receivedGood: 40 }, threadReply: true },
    important: true,
  },
];

export const NOT_IMPORTANT: Sample[] = [
  {
    name: "a marketing newsletter",
    message: {
      from: [{ name: "Fashion Shop", address: "newsletter@shop.example.com" }],
      subject: "🔥 Black Friday: 40% Rabatt auf alles!",
      plainText: "Sichern Sie sich jetzt 40% Rabatt auf alle Artikel. Nur noch heute! Im Browser ansehen. Newsletter abbestellen: https://shop.example.com/u/123",
      htmlText: "<html><body><a href='https://shop.example.com/1'><img src='a.jpg'></a><a href='https://shop.example.com/2'>Jetzt kaufen</a><p>Newsletter abbestellen</p></body></html>",
      headersRaw: LIST_HEADERS,
    },
    important: false,
    expectSignal: "mailing-list",
  },
  {
    name: "a one-time login code",
    message: {
      from: [{ name: "Example Bank", address: "security@examplebank.example" }],
      subject: "Your verification code",
      plainText: "Your verification code is 482913. It expires in 10 minutes. Do not share this code with anyone.",
    },
    important: false,
    ruledOut: "one-time code",
  },
  {
    name: "a German TAN / Bestätigungscode",
    message: {
      from: [{ address: "service@bank.example" }],
      subject: "Ihr Bestätigungscode",
      plainText: "Ihr Bestätigungscode lautet 771204. Der Code ist 5 Minuten gültig. Geben Sie ihn niemals weiter.",
    },
    important: false,
    ruledOut: "one-time code",
  },
  {
    name: "a password-reset link from a service I never wrote to",
    message: {
      from: [{ address: "no-reply@service.example" }],
      subject: "Reset your password",
      plainText: "Click the link below to reset your password. If you did not request this, ignore this email.\nhttps://service.example/reset/abc",
    },
    important: false,
    ruledOut: "temporary link",
  },
  {
    name: "a phishing mail that pretends to be PayPal",
    message: {
      from: [{ name: "PayPal Service", address: "service@paypa1-security.example" }],
      replyTo: [{ address: "collect@mail-drop.example" }],
      subject: "Dringend: Ihr Konto wurde gesperrt",
      plainText: "Sehr geehrter Kunde, Ihr Konto wurde eingeschränkt. Bestätigen Sie Ihre Zahlungsinformationen innerhalb von 24 Stunden: http://185.23.44.9/paypal/login",
      htmlText: "<a href='http://185.23.44.9/x'>https://www.paypal.com/login</a>",
      authenticationResults: "mx.example.com; spf=fail smtp.mailfrom=paypa1-security.example; dkim=none; dmarc=fail",
    },
    important: false,
    expectSignal: "display name claims",
  },
  {
    name: "a message whose earlier mails from the same address are in Junk",
    message: {
      from: [{ name: "Marketing Team", address: "offers@cheap-pills.example" }],
      subject: "Hello dear friend",
      plainText: "I have a special offer for you. Please reply.",
    },
    facts: { sender: { receivedJunk: 4 } },
    important: false,
    expectSignal: "earlier messages from this address were spam",
  },
  {
    name: "a GitHub notification about activity",
    message: {
      from: [{ name: "octocat", address: "notifications@github.com" }],
      subject: "Re: [acme/app] Fix the login bug (#123)",
      plainText: "octocat commented on this pull request. Reply to this email directly or view it on GitHub.",
      headersRaw: "List-Id: acme/app <app.acme.github.com>\nList-Unsubscribe: <https://github.com/notifications/unsubscribe/xyz>",
    },
    important: false,
  },
  {
    name: "a social network activity mail",
    message: {
      from: [{ name: "LinkedIn", address: "notifications-noreply@linkedin.com" }],
      subject: "Anna Becker hat dein Foto kommentiert und 4 weitere neue Benachrichtigungen",
      plainText: "Sieh dir an, was du verpasst hast. Neue Aktivität in deinem Netzwerk.",
      htmlText: "<a href='https://linkedin.com/1'>a</a><a href='https://linkedin.com/2'>a</a><a href='https://linkedin.com/3'>a</a><a href='https://linkedin.com/4'>a</a><a href='https://linkedin.com/5'>a</a><a href='https://linkedin.com/6'>a</a><a href='https://linkedin.com/7'>a</a><a href='https://linkedin.com/8'>a</a>",
    },
    important: false,
    expectSignal: "activity",
  },
  {
    name: "an order / shipping status mail",
    message: {
      from: [{ name: "Amazon.de", address: "versandbestaetigung@amazon.de" }],
      subject: "Ihre Bestellung wurde versandt",
      plainText: "Hallo Philipp, Ihr Paket ist unterwegs. Sendungsverfolgung: https://amazon.de/track/1",
    },
    important: false,
  },
  {
    name: "a weekly digest from a platform",
    message: {
      from: [{ name: "Medium Daily Digest", address: "noreply@medium.com" }],
      subject: "Your weekly digest: stories picked for you",
      plainText: "Check out what's new. Unsubscribe from this digest.",
      headersRaw: "List-Unsubscribe: <https://medium.com/u>",
    },
    important: false,
  },
  {
    name: "a generic company mass mail without list headers",
    message: {
      from: [{ name: "Reisebüro Sonne", address: "info@reisebuero-sonne.example" }],
      to: [{ address: "undisclosed@reisebuero-sonne.example" }],
      subject: "Unsere Sommerangebote für Sie",
      plainText: "Liebe Kunden, entdecken Sie unsere Angebote der Woche: Gutschein 20% Rabatt auf Mallorca. Abmelden",
    },
    important: false,
  },
  {
    name: "an automatic out-of-office reply",
    message: {
      from: [{ name: "Max Muster", address: "max@firma.example" }],
      subject: "Automatische Antwort: Urlaub",
      plainText: "Ich bin bis zum 20.10. nicht im Büro.",
      headersRaw: "Auto-Submitted: auto-replied",
    },
    important: false,
    expectSignal: "automatically generated",
  },
  {
    name: "anything in the Junk folder, even from a friend",
    message: {
      from: [{ name: "Anna Becker", address: "anna.becker@gmail.example" }],
      subject: "Hallo",
      plainText: "Hi Philipp, wie gehts?",
    },
    facts: { sender: { sentTo: 12 }, inJunkFolder: true },
    important: false,
    ruledOut: "in the Junk folder",
  },
  {
    name: "a stranger's short mail without a greeting and to many recipients",
    message: {
      from: [{ address: "promo@unknown-domain.example" }],
      to: Array.from({ length: 14 }, (_, i) => ({ address: `user${i}@example.net` })),
      subject: "Business proposal",
      plainText: "I have a business proposal for you. Contact me.",
    },
    important: false,
  },
];
