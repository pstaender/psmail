/** Query-param prefixes/names used purely for click/campaign tracking, stripped from link hrefs before rendering. */
const TRACKING_PARAM_PREFIXES = ["utm_", "pk_", "mc_", "ns_", "hsa_", "oly_"];

const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "twclid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  "mkt_tok",
  "vero_id",
  "vero_conv",
  "trk",
  "trkcampaign",
  "ref_src",
  "ref_url",
  "wickedid",
  "rb_clickid",
  "s_cid",
  "icid",
  "ito",
  "spm",
  "scm",
  "piwik_campaign",
  "matomo_campaign",
  "mibextid",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAM_NAMES.has(lower) || TRACKING_PARAM_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/** Strips known tracking query params from a URL. Returns the input unchanged if it isn't a parseable absolute URL. */
export function stripTrackingParams(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }

  const toDelete: string[] = [];
  url.searchParams.forEach((_value, key) => {
    if (isTrackingParam(key)) toDelete.push(key);
  });
  toDelete.forEach(key => url.searchParams.delete(key));

  return url.toString();
}
