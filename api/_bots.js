// Server-side bot detection by User-Agent only. No IPs or personal data are read or stored.
// Order matters: specific names before generic ones.
export const BOTS = [
  ["OAI-SearchBot", /OAI-SearchBot/i],
  ["ChatGPT-User", /ChatGPT-User/i],
  ["GPTBot", /GPTBot/i],
  ["Claude-SearchBot", /Claude-SearchBot/i],
  ["Claude-User", /Claude-User/i],
  ["ClaudeBot", /ClaudeBot/i],
  ["anthropic-ai", /anthropic-ai/i],
  ["Perplexity-User", /Perplexity-User/i],
  ["PerplexityBot", /PerplexityBot/i],
  ["Google-Extended", /Google-Extended/i],
  ["Google-InspectionTool", /Google-InspectionTool/i],
  ["GoogleOther", /GoogleOther/i],
  ["Googlebot", /Googlebot|Storebot-Google|AdsBot-Google|Mediapartners-Google|APIs-Google|FeedFetcher-Google/i],
  ["Bingbot", /bingbot|BingPreview|msnbot|adidxbot/i],
  ["Applebot", /Applebot/i],
  ["Bytespider", /Bytespider/i],
  ["CCBot", /CCBot/i],
  ["Amazonbot", /Amazonbot/i],
  ["meta-externalagent", /meta-externalagent/i],
  ["meta-externalfetcher", /meta-externalfetcher/i],
  ["facebookexternalhit", /facebookexternalhit|facebookcatalog/i],
  ["DuckAssistBot", /DuckAssistBot/i],
  ["DuckDuckBot", /DuckDuckBot|DuckDuckGo-Favicons-Bot/i],
  ["YandexBot", /Yandex/i],
  ["Baiduspider", /Baiduspider/i],
  ["MistralAI-User", /MistralAI-User/i],
  ["cohere-ai", /cohere-ai|cohere-training-data-crawler/i],
  ["YouBot", /YouBot/i],
  ["Diffbot", /Diffbot/i],
  ["PetalBot", /PetalBot/i],
  ["Timpibot", /Timpibot/i],
  ["SemrushBot", /SemrushBot/i],
  ["AhrefsBot", /AhrefsBot/i],
  ["Twitterbot", /Twitterbot/i],
  ["LinkedInBot", /LinkedInBot/i],
  ["Slackbot", /Slackbot/i],
  ["Discordbot", /Discordbot/i],
  ["TelegramBot", /TelegramBot/i],
  ["archive.org", /ia_archiver|archive\.org_bot/i],
];
const GENERIC = /bot\b|bot\/|bot;|crawl|spider|slurp|fetcher|scraper/i;

export function botName(ua) {
  if (!ua) return null;
  for (const [name, re] of BOTS) if (re.test(ua)) return name;
  return GENERIC.test(ua) ? "other-bot" : null;
}

// ET calendar date (America/New_York), YYYY-MM-DD.
export function etDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function cleanPath(p) {
  let s = String(p || "/").split("?")[0].split("#")[0];
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/").slice(0, 200);
  return s;
}
