/**
 * User-agent classification for the edge proxy. Pure regex so it runs in
 * the middleware runtime.
 *
 * - Search engines and link previews stay allowed on pages (SEO, iMessage /
 *   Instagram / Facebook link cards) but never reach the public write APIs.
 * - Scrapers, SEO tools, AI training crawlers, headless browsers, and bare
 *   HTTP libraries are blocked everywhere they are checked.
 */

const ALLOWED_CRAWLERS =
  /googlebot|google-inspectiontool|googleother|adsbot-google|mediapartners-google|storebot-google|google-site-verification|bingbot|bingpreview|msnbot|duckduckbot|duckassistbot|applebot|yandex(bot|images)|slurp|facebookexternalhit|facebookcatalog|meta-externalfetcher|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|pinterest|redditbot|skypeuripreview|embedly|iframely|oai-searchbot|chatgpt-user|perplexitybot|perplexity-user|chrome-lighthouse|vercel-screenshot|vercelbot/i;

const BLOCKED_AGENTS =
  /headlesschrome|phantomjs|puppeteer|playwright|selenium|webdriver|electron\/.*headless|python-requests|python-urllib|python-httpx|aiohttp|httpx|scrapy|curl\/|wget\/|go-http-client|java\/|okhttp|apache-httpclient|libwww-perl|lwp::|node-fetch|axios\/|undici|got \(|httpclient|restsharp|guzzle|ahrefsbot|semrushbot|mj12bot|dotbot|blexbot|petalbot|dataforseobot|barkrowler|serpstatbot|seokicks|megaindex|zoominfobot|screaming frog|rogerbot|linkdexbot|sogou|baiduspider|mauibot|seznambot|gptbot|ccbot|claudebot|claude-web|anthropic-ai|bytespider|amazonbot|meta-externalagent|facebookbot|cohere-ai|diffbot|omgili|imagesiftbot|timpibot|youbot|ai2bot|friendlycrawler|velenpublicwebcrawler|iaskspider|scrapingbee|zgrab|masscan|nuclei|censysinspect|expanse|nmap/i;

/** `Name-bot/1.0` or a `+https://…` contact link. Plain `bot` would catch Cubot phones. */
const GENERIC_BOT = /bot\/|\+https?:\/\/|crawler|spider|scraper|uptimerobot|pingdom|statuscake|checkly/i;

export type AgentClass = 'browser' | 'crawler' | 'blocked';

export function classifyUserAgent(userAgent: string | null | undefined): AgentClass {
  const ua = (userAgent ?? '').trim();
  if (!ua) return 'blocked';
  if (ALLOWED_CRAWLERS.test(ua)) return 'crawler';
  if (BLOCKED_AGENTS.test(ua)) return 'blocked';
  if (GENERIC_BOT.test(ua)) return 'blocked';
  return 'browser';
}
