// Builds catalog.json from public YouTube channel feeds and free Twitch status lookups.
// Runs on a schedule in GitHub Actions. No API keys needed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const channels = JSON.parse(readFileSync("data/channels.json", "utf8"));
const CACHE = "data/resolved.json";
const resolved = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA = { "user-agent": "Mozilla/5.0 (compatible; StreamFansCatalog/1.0)", "accept-language": "en-US,en;q=0.9", cookie: "CONSENT=YES+1" };

async function text(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
const decode = s => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ""; };

const GAME_RULES = [
  ["gta6", /\b(gta[\s-]*(6|vi)\b|grand theft auto[\s:]*(6|vi)\b|leonida)/i],
  ["gta5", /\b(gta[\s-]*(5|v|online)\b|grand theft auto[\s:]*(5|v|online)\b)/i],
  ["elden", /elden ring|nightreign/i],
  ["mine", /minecraft/i],
  ["fc", /\b(ea\s*(sports)?\s*fc|fifa|ultimate team)\b/i],
  ["fort", /fortnite/i],
  ["bg3", /baldur'?s gate|\bbg3\b/i],
];
const classify = (s, fallback) => (GAME_RULES.find(([, re]) => re.test(s)) || [fallback])[0];
const STORY = /\b(walkthrough|story|playthrough|campaign|mission|longplay|part\s*\d+|episode\s*\d+)\b/i;
const SPOILER = /\b(ending|endings|finale|final mission|final boss|spoilers?|plot|twist|who dies|death scene|full movie|all cutscenes)\b/i;
const LEAK = /\b(leaks?|leaked|datamine[ds]?|stolen|pre-?release)\b/i;
const NOT_GAMING = /just chatting|irl|music|talk shows|slots|casino|virtual casino|sports betting|poker/i;
const SPOILER_GAMES = new Set(["gta6", "elden", "bg3"]);
const SERIES_RE = /^(.*?)[\s\-–—:|#(\[]*\b(?:part|episode|ep\.?|pt\.?)\s*#?(\d{1,3})\b/i;

async function resolveHandle(handle) {
  if (resolved[handle]) return resolved[handle];
  let id = null;
  try {
    const html = await text(`https://www.youtube.com/@${encodeURIComponent(handle)}`);
    id = (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) || [])[1] || null;
  } catch (e) { console.log(`page lookup failed for @${handle}: ${e.message}`); }
  if (!id) {
    try {
      const out = (await text(`https://decapi.me/youtube/channelid/@${encodeURIComponent(handle)}`)).trim();
      if (/^UC[\w-]{22}$/.test(out)) id = out;
    } catch (e) { console.log(`DecAPI lookup failed for @${handle}: ${e.message}`); }
  }
  if (id) resolved[handle] = id;
  return id;
}

const creators = {}, videos = [], grouped = {}, failed = [];
for (const c of channels) {
  creators[c.key] = { id: c.key, name: c.name || c.handle, lang: c.lang, mood: c.mood, handle: c.handle || null, twitch: c.twitch || null };
  if (!c.handle) continue;
  const id = await resolveHandle(c.handle);
  if (!id) { failed.push(`youtube:@${c.handle} (no channel id)`); continue; }
  let xml;
  try { xml = await text(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`); }
  catch (e) { failed.push(`youtube:@${c.handle} (${e.message})`); continue; }
  const author = tag(xml.split("<entry>")[0], "name");
  if (author) creators[c.key].name = author;
  creators[c.key].youtubeChannel = id;
  let kept = 0;
  for (const entry of xml.split("<entry>").slice(1)) {
    const link = (entry.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || "";
    if (link.includes("/shorts/")) continue;
    const youtubeId = tag(entry, "yt:videoId"), title = tag(entry, "title"), published = tag(entry, "published");
    const views = +(entry.match(/<media:statistics views="(\d+)"/) || [])[1] || 0;
    if (!youtubeId || !title) continue;
    const game = classify(title, c.game);
    if (game === "gta6" && LEAK.test(title)) continue;
    const story = STORY.test(title);
    const item = { youtubeId, creator: c.key, game, title, mood: story ? "story" : c.mood, published, views, mins: null,
      spoiler: SPOILER.test(title) || (story && SPOILER_GAMES.has(game)) };
    kept++;
    const m = title.match(SERIES_RE);
    if (m && m[1].trim().length > 3) {
      const key = `${c.key}|${m[1].trim().toLowerCase()}`;
      (grouped[key] = grouped[key] || { name: m[1].trim(), c, items: [] }).items.push({ ...item, n: +m[2] });
    } else videos.push(item);
  }
  console.log(`@${c.handle} -> ${id} -> ${author} (${kept} videos)`);
  await wait(250);
}

const series = [];
for (const [key, g] of Object.entries(grouped)) {
  if (g.items.length < 3) { g.items.forEach(({ n, ...v }) => videos.push(v)); continue; }
  const eps = g.items.sort((a, b) => a.n - b.n).map(({ youtubeId, title, n, published, mins }) => ({ youtubeId, title, n, published, mins }));
  const game = classify(g.name, g.items[0].game);
  series.push({ id: key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60), creator: g.c.key, game, title: g.name, mood: "story",
    spoiler: SPOILER_GAMES.has(game) || g.items.some(i => i.spoiler), eps });
}

const live = [];
for (const c of channels.filter(c => c.twitch)) {
  const u = encodeURIComponent(c.twitch);
  try {
    const up = (await text(`https://decapi.me/twitch/uptime/${u}`)).trim();
    await wait(400);
    console.log(`twitch ${c.twitch}: ${up.slice(0, 80)}`);
    if (/offline|not found|error|no user/i.test(up) || !/\d/.test(up)) continue;
    const [views, gameName, title] = [await text(`https://decapi.me/twitch/viewercount/${u}`), await text(`https://decapi.me/twitch/game/${u}`), await text(`https://decapi.me/twitch/title/${u}`)].map(s => s.trim());
    await wait(400);
    if (NOT_GAMING.test(gameName)) continue;
    const viewers = parseInt(views.replace(/\D/g, ""), 10) || 0;
    const game = classify(`${gameName} ${title}`, "other");
    live.push({ id: `live-${c.key}`, twitch: c.twitch, creator: c.key, game, gameName, title, viewers, mood: c.mood,
      spoiler: SPOILER_GAMES.has(game) && (STORY.test(title) || SPOILER.test(title)) });
  } catch (e) { failed.push(`twitch:${c.twitch} (${e.message})`); }
}

videos.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
console.log(`\n${videos.length} videos, ${series.length} series, ${live.length} live. Failed: ${failed.length}`);
failed.forEach(f => console.log("FAILED", f));
if (!videos.length && !live.length) { console.error("Nothing fetched. Keeping the previous catalog."); process.exit(1); }
writeFileSync(CACHE, JSON.stringify(resolved, null, 1) + "\n");
writeFileSync("catalog.json", JSON.stringify({ updated: new Date().toISOString(), creators, videos, series, live, failed }) + "\n");
