import type { EmailAddress } from "../../types";

/**
 * The imbox classifier: is a message *important* — something a person wrote to you, that you would want to see —
 * or is it noise: marketing, one-time codes, activity notifications, suspected spam or phishing?
 *
 * It runs entirely on this computer, with no AI service: it adds up signals, each worth points that are positive (a person you
 * know, a reply in a conversation you took part in, addressed to you by name, ...) or negative (bulk mail headers, "unsubscribe",
 * no-reply senders, activity notifications, a one-time code, mail that pretends to be a bank, failed sender authentication, ...).
 * A message is important when the total reaches IMPORTANT_THRESHOLD and nothing ruled it out (Junk folder, one-time codes).
 * Every signal that counted is returned with its points and a short detail, so a result can always be explained.
 *
 * This file is pure — it only looks at what it is given. What needs the mailbox (who you have written to, what was received from
 * an address before, whether the message answers one of yours) is looked up by context.ts and passed in as `facts`.
 */

export interface ImboxMessage {
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string | null;
  plainText: string | null;
  htmlText: string | null;
  /** All header lines, as stored (`Key: value`, one per line). */
  headersRaw: string | null;
  authenticationResults: string | null;
  spf: string | null;
  /** File names of the real (non-inline) attachments. */
  attachmentNames: string[];
}

export interface SenderHistory {
  /** How many messages the user has sent to this exact address (over all of the user's accounts). */
  sentTo: number;
  /** Earlier messages from this exact address that are in normal folders. */
  receivedGood: number;
  /** Earlier messages from this exact address that ended up in Junk/Spam. */
  receivedJunk: number;
}

export interface ImboxFacts {
  /** The user's own addresses (all accounts), lower case. */
  ownAddresses: Set<string>;
  /** Words the user is greeted with: first names and the like, lower case. */
  ownNames: string[];
  sender: SenderHistory;
  /** The message answers (or continues) a message the user sent. */
  threadReply: boolean;
  /** The message lives in a Junk/Spam folder. */
  inJunkFolder: boolean;
}

export interface Reason {
  signal: string;
  points: number;
  detail?: string;
}

export interface Classification {
  important: boolean;
  score: number;
  /** Set when a rule decided regardless of the score ("junk folder", "one-time code"). */
  ruledOut?: string;
  reasons: Reason[];
}

/** The score a message needs to be important. */
export const IMPORTANT_THRESHOLD = 2;

// ---------------------------------------------------------------------------------------------------------------- helpers

const lower = (value: string | null | undefined) => (value ?? "").toLowerCase();

export function addressOf(list: EmailAddress[]): string {
  return lower(list[0]?.address).trim();
}

export function domainOf(address: string): string {
  return address.includes("@") ? address.slice(address.lastIndexOf("@") + 1) : "";
}

/** example.co.uk for mail.example.co.uk, example.com for news.example.com — good enough to tell "same organization" from "different". */
export function registrableDomain(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length <= 2) return domain;
  const secondLevel = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);
  const keep = labels[labels.length - 2]!.length <= 3 && secondLevel.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function headerValue(headers: string, name: string): string | null {
  const match = new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(headers);
  return match ? match[1]!.trim() : null;
}

function hasHeader(headers: string, name: string): boolean {
  return new RegExp(`^${name}:`, "im").test(headers);
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[ \t]+/g, " ");
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ------------------------------------------------------------------------------------------------------------ pattern lists

/** One-time codes and links that only make sense for a few minutes. */
const CODE_WORDS =
  /\b(verification|verify|confirmation|security|login|log-?in|sign-?in|one[- ]time|access|authentication|authorization|activation|2fa|two-?factor|auth)\s*(code|pin|token|number)\b|\botp\b|\bpass-?code\b|\b(bestätigungs|verifizierungs|verifikations|sicherheits|anmelde|zugangs|einmal|aktivierungs|freigabe)-?\s*(code|passwort|kennwort|pin)\b|\beinmalpasswort\b|\b(your|dein|ihr)\w*\s+(code|pin|tan)\s+(is|lautet|ist)\b|\bcode\s*:?\s*\d{4,8}\b|\b(mtan|pushtan|tan)\b/i;
const CODE_DIGITS = /(?<!\d|\d[.,-])\d{4,8}(?!\d|[.,-]\d)/; // 4-8 digits standing alone (a full stop after them is just the end of a sentence)
const CODE_EXPIRY = /\b(expires?|expire[sd]? in|valid for|gültig|läuft ab|nicht weitergeben|do not share|never share|niemals weitergeben|minutes?|minuten)\b/i;
const TEMP_LINK =
  /\b(reset (your )?password|password reset|passwort (zurücksetzen|vergessen)|magic link|sign[- ]in link|log[- ]in link|verify your e-?mail|confirm your e-?mail|bestätigen sie ihre e-?mail|e-?mail[- ]adresse bestätigen|new sign-?in|new login|neue anmeldung|new device|neues gerät)\b/i;

const MARKETING_PHRASES =
  /(\d+\s?%\s*(off|rabatt|discount|sparen)|\bsale\b|\bdiscount\b|\bcoupon\b|\bpromo(tion)?\b|\bdeals?\b|free shipping|kostenloser versand|limited time|nur (noch )?heute|jetzt (kaufen|sichern|bestellen|shoppen)|sichern sie sich|gutschein|rabatt|angebot(e)? (der woche|für sie)|exklusiv(e)? (angebot|für)|black friday|cyber monday|don't miss|verpass(e)? nicht|last chance|letzte chance|special offer|newsletter|view (this email )?in (your )?browser|im browser (ansehen|anzeigen)|webversion)/i;
const UNSUBSCRIBE = /\b(unsubscribe|abmelden|abbestellen|austragen|opt[- ]out|manage (your )?(email )?(preferences|subscription)|e-?mail-?einstellungen|newsletter abbestellen|von diesem newsletter)\b/i;

const ACTIVITY_SUBJECT =
  /(\b(commented|replied|reacted|liked|mentioned|tagged|invited|followed|assigned|approved|merged|opened|closed|pushed|starred|shared)\b.*\b(you|your|on|to|in|with)\b|\bnew (follower|comment|activity|message from|connection|notification|sign-?in|login|device|reply|mention)\b|\b(weekly|daily|monthly)\s+(digest|summary|update|recap|report)\b|\byour .{0,30}(summary|digest|recap|activity|statement)\b|\bnotifications?\b|\bbenachrichtigung\b|\b(hat|haben) (dich|sie|ihre?n?|deine?n?).{0,40}(kommentiert|erwähnt|eingeladen|geteilt|hinzugefügt|abonniert|markiert|geliked)|\bneue (aktivität|nachricht von|follower|kommentare?|benachrichtigung)\b|\berinnerung\b|\breminder\b|\bwhat'?s new\b|\bcheck out\b|\bschau dir\b|\bhast du schon\b|\bdid you see\b|\b(order|bestellung|sendung|paket)\b.{0,40}(shipped|delivered|confirmed|versandt|verschickt|zugestellt|bestätigt|unterwegs|eingegangen)|\b(order|bestellbestätigung|bestellung)\b|\btracking\b|\bsendungsverfolgung\b|\breceipt\b|\bquittung\b|\bihre rechnung (ist|steht)|\byour (invoice|receipt) (is|for)\b|\bsecurity alert\b|\bsicherheitswarnung\b|\b(has|have) been (updated|added|removed|created|changed)\b)/i;

/** Sending domains of platforms that tell you what happened there. */
const PLATFORM_DOMAINS = new Set([
  "github.com", "gitlab.com", "bitbucket.org", "linkedin.com", "facebook.com", "facebookmail.com", "twitter.com", "x.com", "instagram.com",
  "slack.com", "notion.so", "atlassian.net", "atlassian.com", "trello.com", "asana.com", "medium.com", "youtube.com", "pinterest.com",
  "reddit.com", "redditmail.com", "quora.com", "discord.com", "zoom.us", "dropbox.com", "docusign.net", "figma.com", "canva.com",
  "spotify.com", "netflix.com", "airbnb.com", "booking.com", "ebay.com", "amazon.com", "amazon.de", "paypal.com", "stripe.com",
  "shopify.com", "mailchimp.com", "sendgrid.net", "substack.com", "eventbrite.com", "meetup.com", "tiktok.com", "twitch.tv",
  "google.com", "accounts.google.com", "apple.com", "id.apple.com", "microsoft.com", "microsoftonline.com", "office365.com",
]);

const BULK_MAILERS = /\b(mailchimp|sendgrid|sparkpost|mailgun|amazon ses|klaviyo|hubspot|marketo|salesforce|constant contact|campaign monitor|sendinblue|brevo|cleverreach|rapidmail|newsletter2go|mandrill|postmark|customer\.io|braze|iterable|emarsys|mailjet|activecampaign)\b/i;

const NOREPLY_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounces?|automated|auto|system|robot|noreply\+.*)$/i;
const BULK_LOCAL = /^(newsletter|news|marketing|promo(tions?)?|deals?|offers?|angebote?|shop|store|sales?|campaign|mailing|digest|updates?|notifications?|notify|alerts?|info-?mail)$/i;
const GENERIC_LOCAL = /^(info|hello|hi|team|support|service|kundenservice|kontakt|contact|office|mail|admin|help|customer(care|service)?)$/i;

/** Names people impersonate in phishing mail. The display name says one of these, the address doesn't. */
const BRANDS = [
  "paypal", "amazon", "apple", "microsoft", "google", "netflix", "dhl", "ups", "fedex", "dpd", "hermes", "sparkasse", "volksbank", "postbank",
  "commerzbank", "deutsche bank", "ing", "n26", "visa", "mastercard", "american express", "facebook", "instagram", "linkedin", "whatsapp",
  "telekom", "vodafone", "o2", "1&1", "ebay", "steam", "coinbase", "binance", "finanzamt", "bundesagentur", "polizei", "zoll",
];
const URGENCY =
  /(verify your (account|identity|information)|(account|konto)\s+(has been\s+)?(suspended|locked|limited|disabled|gesperrt|eingeschränkt|deaktiviert)|confirm your (identity|password|account|details)|update your (payment|billing|account)|unusual (activity|sign-?in)|urgent(ly)? (action|response)|within (24|48) hours|innerhalb von (24|48) stunden|dringend|sofort handeln|ihr konto (wurde|wird)|passwort (ist )?abgelaufen|bestätigen sie (ihre|ihr)|zahlungsinformationen|kontodaten|you have won|sie haben gewonnen|claim your|inheritance|erbschaft|lottery|lotterie|wire transfer|überweisung)/i;
const SHORTENER = /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|tiny\.cc|rb\.gy)\//i;
const IP_LINK = /https?:\/\/\d{1,3}(\.\d{1,3}){3}[/:]/;
const RISKY_ATTACHMENT = /\.(exe|scr|bat|cmd|com|pif|js|jse|vbs|vbe|wsf|jar|msi|lnk|iso|img|hta|html?|docm|xlsm|pptm)$/i;

const BUSINESS_WORDS =
  /\b(meeting|call|appointment|agenda|project|projekt|deadline|frist|offer|angebot|contract|vertrag|proposal|budget|kunde|customer|client|invoice|rechnung|termin|besprechung|abstimmung|feedback|review|präsentation|presentation|bericht|report|unterlagen|dokumente|documents|konferenz|conference|workshop|meilenstein|milestone|team|kollege|colleague|zusammenarbeit|anfrage|request|bewerbung|application)\b/i;

// ------------------------------------------------------------------------------------------------------------ classifier

export function classify(message: ImboxMessage, facts: ImboxFacts): Classification {
  const reasons: Reason[] = [];
  let score = 0;
  let ruledOut: string | undefined;
  const add = (signal: string, points: number, detail?: string) => {
    score += points;
    reasons.push({ signal, points, ...(detail ? { detail } : {}) });
  };
  const rule = (signal: string, detail?: string) => {
    ruledOut ??= signal;
    reasons.push({ signal, points: 0, ...(detail ? { detail } : {}) });
  };

  const headers = message.headersRaw ?? "";
  const subject = message.subject ?? "";
  const from = message.from[0];
  const fromAddress = addressOf(message.from);
  const fromDomain = domainOf(fromAddress);
  const fromLocal = fromAddress.includes("@") ? fromAddress.slice(0, fromAddress.lastIndexOf("@")) : fromAddress;
  const text = (message.plainText && message.plainText.trim() ? message.plainText : stripHtml(message.htmlText ?? "")).slice(0, 30_000);
  const lowerText = text.toLowerCase();
  const html = message.htmlText ?? "";
  const seen = facts.sender.sentTo > 0 || facts.sender.receivedGood > 0; // this exact address is a known one

  // --- rules that decide on their own -----------------------------------------------------------------------------------
  if (facts.inJunkFolder) rule("in the Junk folder");
  if (fromAddress && facts.ownAddresses.has(fromAddress)) {
    // Mail from yourself (notes, forwards): not noise, not remarkable either — it needs a reason to be in the imbox.
    reasons.push({ signal: "from one of your own addresses", points: 0 });
  }

  const shortMail = text.length < 1500;
  const codeWords = CODE_WORDS.test(subject) || (shortMail && CODE_WORDS.test(text));
  if (codeWords && shortMail && CODE_DIGITS.test(`${subject} ${text}`) && (CODE_EXPIRY.test(text) || CODE_WORDS.test(subject))) {
    rule("one-time code", "a login/verification code that is only good for a moment");
  } else if (TEMP_LINK.test(subject) || (text.length < 1200 && TEMP_LINK.test(text))) {
    if (facts.sender.sentTo === 0) rule("temporary link", "sign-in / password-reset / confirmation mail");
  }

  // --- who is it from ------------------------------------------------------------------------------------------------------
  if (facts.sender.sentTo > 0) {
    add("you have written to this address", facts.sender.sentTo >= 5 ? 5 : 4, `${facts.sender.sentTo} message(s) sent`);
  }
  if (facts.threadReply) add("answers a message you sent", 4);

  // --- bulk / marketing ------------------------------------------------------------------------------------------------------
  const listHeaders = hasHeader(headers, "list-unsubscribe") || hasHeader(headers, "list-id") || /^precedence:[ \t]*(bulk|list|junk)/im.test(headers);
  const bulkMailer =
    BULK_MAILERS.test(headerValue(headers, "x-mailer") ?? "") || hasHeader(headers, "x-mailgun-sid") ||
    hasHeader(headers, "x-campaign") || hasHeader(headers, "x-campaignid") || hasHeader(headers, "feedback-id") || hasHeader(headers, "x-mailchimp-id") ||
    hasHeader(headers, "x-sg-eid") || hasHeader(headers, "x-sfmc-stack") || hasHeader(headers, "x-mandrill-user") || hasHeader(headers, "x-mj-campaign");
  if (listHeaders) add("mailing-list / bulk headers", facts.sender.sentTo > 0 ? -2 : -4, "List-Unsubscribe, List-Id or Precedence: bulk");
  if (bulkMailer) add("sent through a mass-mailing service", -3);
  const autoSubmitted = headerValue(headers, "auto-submitted");
  if ((autoSubmitted && !/^no$/i.test(autoSubmitted)) || hasHeader(headers, "x-auto-response-suppress")) add("automatically generated", -3, "Auto-Submitted / X-Auto-Response-Suppress");
  const bulkish = listHeaders || bulkMailer || Boolean(autoSubmitted && !/^no$/i.test(autoSubmitted));

  if (UNSUBSCRIBE.test(text) || UNSUBSCRIBE.test(html.slice(0, 200_000))) add("has an unsubscribe link", -2);
  const marketing = MARKETING_PHRASES.exec(`${subject}\n${lowerText.slice(0, 6000)}`);
  if (marketing) add("marketing wording", -2, marketing[0].trim().slice(0, 40));

  const links = (html.match(/<a\s[^>]*href=/gi) ?? []).length || (text.match(/https?:\/\//g) ?? []).length;
  const images = (html.match(/<img\b/gi) ?? []).length;
  if (links >= 8 || images >= 5) add("designed like a newsletter", -1, `${links} links, ${images} images`);

  if (NOREPLY_LOCAL.test(fromLocal)) add("no-reply sender", facts.sender.sentTo > 0 ? -1 : -3, fromAddress);
  else if (BULK_LOCAL.test(fromLocal)) add("newsletter / notification sender", -3, fromAddress);
  else if (GENERIC_LOCAL.test(fromLocal) && facts.sender.sentTo === 0) add("generic company address", -1, fromAddress);

  // --- notifications about activity elsewhere ----------------------------------------------------------------------------
  const platform = PLATFORM_DOMAINS.has(registrableDomain(fromDomain)) || PLATFORM_DOMAINS.has(fromDomain);
  if (ACTIVITY_SUBJECT.test(subject) && facts.sender.sentTo === 0) add("activity / status notification", -3, subject.slice(0, 50));
  if (platform && facts.sender.sentTo === 0) add("sent by a platform, not a person", -3, fromDomain);

  // --- suspicious: spam and phishing ----------------------------------------------------------------------------------------
  const auth = lower(`${message.authenticationResults ?? ""} ${headerValue(headers, "authentication-results") ?? ""} ${message.spf ?? ""} ${headerValue(headers, "received-spf") ?? ""}`);
  const authFailed = /\b(spf|dkim|dmarc)=(fail|softfail|permerror)\b|\bspf\s+(fail|softfail)\b|^fail\b/.test(auth) || /\bfail\b/.test(lower(message.spf ?? "").split(/\s/)[0] ?? "");
  if (authFailed) add("sender authentication failed", seen ? -2 : -4, "SPF / DKIM / DMARC");

  const displayName = lower(from?.name);
  if (displayName && !facts.sender.sentTo) {
    const brand = BRANDS.find(name => new RegExp(`(^|[^a-z])${escapeRegExp(name)}([^a-z]|$)`).test(displayName));
    // The real company's own domain has the brand as its name (apple.com, email.apple.com, amazon.de); apple-id-check.example doesn't.
    if (brand && registrableDomain(fromDomain).split(".")[0] !== brand.replace(/[\s&]+/g, "")) add("display name claims to be a company the address doesn't belong to", -4, `"${brand}" vs ${fromDomain}`);
  }
  const replyTo = addressOf(message.replyTo);
  if (replyTo && fromAddress && registrableDomain(domainOf(replyTo)) !== registrableDomain(fromDomain) && !seen) add("Reply-To goes to a different domain", -1.5, replyTo);

  if (!seen) {
    const urgency = URGENCY.exec(`${subject}\n${lowerText.slice(0, 4000)}`);
    if (urgency) add("pressure / credential wording from an unknown sender", -3, urgency[0].slice(0, 40));
    if (SHORTENER.test(html) || SHORTENER.test(text) || IP_LINK.test(html) || IP_LINK.test(text)) add("link shortener or raw IP address in a link", -2);
    const mismatch = /<a\s[^>]*href=["']https?:\/\/([^/"']+)[^>]*>\s*(?:<[^>]+>\s*)*https?:\/\/([^/<\s"']+)/gi.exec(html);
    if (mismatch && registrableDomain(mismatch[1]!.toLowerCase()) !== registrableDomain(mismatch[2]!.toLowerCase())) add("a link's text shows a different address than where it goes", -3);
    const risky = message.attachmentNames.find(name => RISKY_ATTACHMENT.test(name));
    if (risky) add("risky attachment from an unknown sender", -3, risky);
  }
  if (facts.sender.receivedJunk > 0 && facts.sender.receivedGood === 0 && facts.sender.sentTo === 0) {
    add("earlier messages from this address were spam", -5, `${facts.sender.receivedJunk} in Junk`);
  }

  // --- a person writing to you -----------------------------------------------------------------------------------------
  const toAddresses = message.to.map(a => lower(a.address).trim());
  const toMe = toAddresses.some(a => facts.ownAddresses.has(a));
  const ccMe = message.cc.some(a => facts.ownAddresses.has(lower(a.address).trim()));
  const recipients = message.to.length + message.cc.length;
  if (toMe && recipients <= 3) add("addressed to you", 1.5, recipients === 1 ? "you are the only recipient" : `${recipients} recipients`);
  else if (toMe && recipients <= 10) add("addressed to you among others", 0.5, `${recipients} recipients`);
  else if (!toMe && ccMe) add("you are only in Cc", recipients <= 3 ? 1 : 0.5);
  else if (!toMe) add("not addressed to you directly", -1, "a list, Bcc or forwarded mail");
  if (recipients > 10) add("sent to many people", -1, `${recipients} recipients`);

  let greeted: string | null = null;
  const head = text.trimStart().slice(0, 400);
  for (const name of facts.ownNames) {
    const word = escapeRegExp(name);
    // "Hi Philipp", "Lieber Philipp", "Sehr geehrter Herr Philipp" in the opening — or the name alone opening the message: "Philipp,".
    const greeting = new RegExp(`\\b(hi|hello|hey|dear|hallo|liebe[rs]?|moin|servus|guten (tag|morgen|abend)|good (morning|afternoon|evening)|sehr geehrte[rs]?( herr| frau)?)[ ,]+${word}\\b`, "i");
    const opening = new RegExp(`^${word}\\s*[,:!]`, "i");
    if (greeting.test(head) || opening.test(head)) {
      greeted = name;
      break;
    }
  }
  if (greeted && !listHeaders) add("greets you by name", 2, greeted);

  // What a personal message looks like: no bulk machinery, short, few links and pictures, maybe a file from a person.
  const humanLooking = !bulkish && !marketing && !platform && text.trim().length >= 15 && text.length <= 4000 && links <= 3 && images <= 1;
  if (humanLooking) add("reads like a personal message", 1);
  // Someone unknown, and nothing in it is meant for you in particular: being the only recipient isn't enough.
  if (!seen && !greeted && !facts.threadReply) add("unknown sender and nothing personal in it", -1.5);
  if (humanLooking && message.attachmentNames.length > 0 && !message.attachmentNames.some(n => RISKY_ATTACHMENT.test(n))) add("a person sent you a file", 0.5);

  if (seen && !bulkish && facts.sender.receivedGood >= 1) add("you have received normal mail from this address before", facts.sender.receivedGood >= 5 ? 2 : 1, `${facts.sender.receivedGood} earlier`);

  if ((toMe || greeted) && !bulkish && !platform && BUSINESS_WORDS.test(`${subject}\n${text.slice(0, 3000)}`)) add("work-related and meant for you", 1.5);

  const total = Math.round(score * 100) / 100;
  return { important: ruledOut === undefined && total >= IMPORTANT_THRESHOLD, score: total, ...(ruledOut ? { ruledOut } : {}), reasons };
}
