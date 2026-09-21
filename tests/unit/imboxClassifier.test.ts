import { describe, expect, test } from "bun:test";
import { classify, domainOf, IMPORTANT_THRESHOLD, registrableDomain } from "../../src/server/services/imbox/classifier";
import type { EmailAddress } from "../../src/server/types";
import { baseFacts, baseMessage, IMPORTANT, NOT_IMPORTANT, type Sample } from "../fixtures/imbox/messages";

const run = (sample: Sample) => classify(baseMessage(sample.message), baseFacts(sample.facts));
const signals = (sample: Sample) => run(sample).reasons.map(r => r.signal);

describe("imbox classifier: important mail", () => {
  for (const sample of IMPORTANT) {
    test(`important: ${sample.name}`, () => {
      const result = run(sample);
      expect(result.important).toBe(true);
      expect(result.ruledOut).toBeUndefined();
      expect(result.score).toBeGreaterThanOrEqual(IMPORTANT_THRESHOLD);
      if (sample.expectSignal) expect(signals(sample).some(s => s.includes(sample.expectSignal!))).toBe(true);
    });
  }
});

describe("imbox classifier: not important", () => {
  for (const sample of NOT_IMPORTANT) {
    test(`not important: ${sample.name}`, () => {
      const result = run(sample);
      expect(result.important).toBe(false);
      if (sample.ruledOut) expect(result.ruledOut).toBe(sample.ruledOut);
      if (sample.expectSignal) expect(signals(sample).some(s => s.includes(sample.expectSignal!))).toBe(true);
    });
  }
});

describe("imbox classifier: the criteria one by one", () => {
  const person: { from: EmailAddress[]; plainText: string } = { from: [{ name: "Kim Lee", address: "kim@lee.example" }], plainText: "Hi Philipp,\n\nkurze Frage zu gestern.\n\nKim" };

  test("a person I know beats bulk headers, but only a little: a list I wrote to is still counted down", () => {
    const withList = baseMessage({ ...person, headersRaw: "List-Id: <x.example>" });
    const known = classify(withList, baseFacts({ sender: { sentTo: 3 } }));
    const unknown = classify(withList, baseFacts());
    expect(known.reasons.find(r => r.signal.includes("mailing-list"))!.points).toBe(-2);
    expect(unknown.reasons.find(r => r.signal.includes("mailing-list"))!.points).toBe(-4);
    expect(known.score).toBeGreaterThan(unknown.score);
  });

  test("writing to an address counts more when it's regular", () => {
    const once = classify(baseMessage(person), baseFacts({ sender: { sentTo: 1 } })).score;
    const often = classify(baseMessage(person), baseFacts({ sender: { sentTo: 6 } })).score;
    expect(often).toBeGreaterThan(once);
  });

  test("addressed to me: the only recipient counts, many recipients don't, Cc is a little, not at all is a minus", () => {
    const score = (over: Partial<Parameters<typeof baseMessage>[0]>) => classify(baseMessage({ ...person, ...over }), baseFacts()).score;
    const me = { address: "philipp@example.com" };
    const others = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `o${i}@example.net` }));
    expect(score({ to: [me] })).toBeGreaterThan(score({ to: [me, ...others(6)] }));
    expect(score({ to: [me] })).toBeGreaterThan(score({ to: others(1), cc: [me] }));
    expect(score({ to: others(1), cc: [me] })).toBeGreaterThan(score({ to: [me, ...others(6)] }));
    expect(score({ to: [me, ...others(6)] })).toBeGreaterThan(score({ to: others(1) }));
  });

  test("my other account's address counts as me", () => {
    const result = classify(baseMessage({ ...person, to: [{ address: "philipp@work.example.org" }] }), baseFacts());
    expect(result.reasons.some(r => r.signal === "addressed to you")).toBe(true);
  });

  test("greetings by name: English and German forms, my first name only in the opening", () => {
    const greeted = (text: string) => classify(baseMessage({ ...person, plainText: text }), baseFacts()).reasons.some(r => r.signal === "greets you by name");
    expect(greeted("Hi Philipp,\n\nhello")).toBe(true);
    expect(greeted("Lieber Philipp,\n\nhallo")).toBe(true);
    expect(greeted("Hallo Philipp!\n\nhallo")).toBe(true);
    expect(greeted("Philipp,\n\nkannst du bitte…")).toBe(true);
    expect(greeted("Hello everyone,\n\nPhilipp will present next week")).toBe(false);
    expect(greeted("Dear customer,\n\nthanks")).toBe(false);
  });

  test("marketing: unsubscribe text and sales wording count against, each once", () => {
    const result = classify(baseMessage({ ...person, plainText: "Hi Philipp, 30% off today only! Sale sale sale. Unsubscribe here." }), baseFacts());
    expect(result.reasons.filter(r => r.signal === "marketing wording")).toHaveLength(1);
    expect(result.reasons.filter(r => r.signal === "has an unsubscribe link")).toHaveLength(1);
  });

  test("no-reply and newsletter senders count against, generic ones (info@) a little, unless I know them", () => {
    const points = (address: string, sentTo = 0) =>
      classify(baseMessage({ from: [{ address }], plainText: "Hallo Philipp, wie geht es dir? Melde dich mal." }), baseFacts({ sender: { sentTo } })).reasons.find(r => /sender|address/.test(r.signal) && r.points < 0)?.points ?? 0;
    expect(points("noreply@x.example")).toBe(-3);
    expect(points("newsletter@x.example")).toBe(-3);
    expect(points("info@x.example")).toBe(-1);
    expect(points("info@x.example", 4)).toBe(0);
    expect(points("noreply@x.example", 4)).toBe(-1);
    expect(points("anna@x.example")).toBe(0);
  });

  test("one-time codes: many spellings, in both languages; ordinary numbers are not codes", () => {
    const isCode = (subject: string, text: string) => classify(baseMessage({ from: [{ address: "a@b.example" }], subject, plainText: text }), baseFacts()).ruledOut === "one-time code";
    expect(isCode("Your code", "Your login code: 123456. Valid for 10 minutes.")).toBe(true);
    expect(isCode("Security code", "Use 998877 to sign in. It expires in 5 minutes.")).toBe(true);
    expect(isCode("Dein Anmeldecode", "Dein Anmeldecode lautet 4432. Er ist 10 Minuten gültig.")).toBe(true);
    expect(isCode("Your OTP", "OTP: 556677. Do not share.")).toBe(true);
    expect(isCode("Rechnung 2026", "Die Rechnung über 12345 Euro ist fällig, bitte in 30 Tagen überweisen.")).toBe(false);
    expect(isCode("Termin", "Wir treffen uns um 14:00 im Raum 4512.")).toBe(false);
  });

  test("phishing: a brand in the display name that the address doesn't match; the same brand from its own domain is fine", () => {
    const fake = classify(baseMessage({ from: [{ name: "Apple Support", address: "support@apple-id-check.example" }], plainText: "Hi" }), baseFacts());
    const real = classify(baseMessage({ from: [{ name: "Apple", address: "no_reply@email.apple.com" }], plainText: "Hi" }), baseFacts());
    expect(fake.reasons.some(r => r.signal.startsWith("display name claims"))).toBe(true);
    expect(real.reasons.some(r => r.signal.startsWith("display name claims"))).toBe(false);
  });

  test("failed sender authentication counts against — more for a stranger than for someone I know", () => {
    const auth = "mx; spf=fail smtp.mailfrom=x.example; dkim=pass; dmarc=fail";
    const stranger = classify(baseMessage({ ...person, authenticationResults: auth }), baseFacts());
    const known = classify(baseMessage({ ...person, authenticationResults: auth }), baseFacts({ sender: { receivedGood: 3 } }));
    expect(stranger.reasons.find(r => r.signal.includes("authentication"))!.points).toBe(-4);
    expect(known.reasons.find(r => r.signal.includes("authentication"))!.points).toBe(-2);
    const passing = classify(baseMessage({ ...person, authenticationResults: "mx; spf=pass; dkim=pass; dmarc=pass" }), baseFacts());
    expect(passing.reasons.some(r => r.signal.includes("authentication"))).toBe(false);
  });

  test("risky attachments and link tricks only count against senders I don't know", () => {
    const withExe = { ...person, attachmentNames: ["invoice.exe"] };
    expect(classify(baseMessage(withExe), baseFacts()).reasons.some(r => r.signal.startsWith("risky attachment"))).toBe(true);
    expect(classify(baseMessage(withExe), baseFacts({ sender: { sentTo: 2 } })).reasons.some(r => r.signal.startsWith("risky attachment"))).toBe(false);
    const shortened = { ...person, plainText: "Hi Philipp, look at https://bit.ly/3xYz" };
    expect(classify(baseMessage(shortened), baseFacts()).reasons.some(r => r.signal.startsWith("link shortener"))).toBe(true);
  });

  test("received normal mail before helps a person, not a mailing list", () => {
    const seen = classify(baseMessage(person), baseFacts({ sender: { receivedGood: 6 } }));
    expect(seen.reasons.find(r => r.signal.startsWith("you have received normal mail"))!.points).toBe(2);
    const list = classify(baseMessage({ ...person, headersRaw: "List-Unsubscribe: <x>" }), baseFacts({ sender: { receivedGood: 6 } }));
    expect(list.reasons.some(r => r.signal.startsWith("you have received normal mail"))).toBe(false);
  });

  test("every result explains itself: reasons add up to the score", () => {
    for (const sample of [...IMPORTANT, ...NOT_IMPORTANT]) {
      const result = run(sample);
      const sum = result.reasons.reduce((total, r) => total + r.points, 0);
      expect(Math.abs(sum - result.score)).toBeLessThan(0.02);
    }
  });

  test("HTML-only mail is read as text; empty or odd input doesn't throw", () => {
    const html = classify(baseMessage({ from: [{ name: "Kim", address: "kim@lee.example" }], plainText: null, htmlText: "<p>Hi Philipp,</p><p>kurze Frage.</p>" }), baseFacts());
    expect(html.reasons.some(r => r.signal === "greets you by name")).toBe(true);
    expect(() => classify(baseMessage({ from: [], subject: null, plainText: null }), baseFacts())).not.toThrow();
    expect(classify(baseMessage({ from: [], subject: null, plainText: null }), baseFacts()).important).toBe(false);
  });
});

describe("domain helpers", () => {
  test("registrable domains", () => {
    expect(registrableDomain("mail.example.com")).toBe("example.com");
    expect(registrableDomain("news.shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.org")).toBe("example.org");
    expect(domainOf("a@b.example")).toBe("b.example");
    expect(domainOf("nonsense")).toBe("");
  });
});
