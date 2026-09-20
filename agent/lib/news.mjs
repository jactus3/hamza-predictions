// agent/lib/news.mjs
//
// أخبار الفرق (إصابات / إيقافات / عودة لاعبين) من Google News RSS — مجاني وبدون مفتاح.
// التحليل بالكلمات المفتاحية على عناوين آخر 72 ساعة فقط، والتأثير على النموذج صغير ومحدود السقف
// (بحد أقصى -10% على هجوم الفريق و+6% على ما يستقبله)، والعناوين المستخدمة تُحفظ وتُعرض للمستخدم.

const MAX_AGE_MS = 72 * 3600 * 1000;
const UA = "Mozilla/5.0 (compatible; hamza-predictions-agent)";

// عبارات محددة عمدًا (وليس كلمات عامة مثل "out") لتفادي التقاط عناوين لا علاقة لها بالغيابات
const NEGATIVE = /\b(injur\w*|ruled out|sidelined|suspend\w*|suspension|doubtful|doubt for|banned|will miss|to miss|misses (?:the )?(?:game|match|clash|derby|weeks?|months?|rest)|out for (?:\d+|several|weeks?|months?|the (?:rest|season|next))|fitness (?:concern|worry|scare)\w*|hamstring|knee|ankle|groin|muscle (?:injury|strain))\b/i;
const POSITIVE = /\b(returns? from (?:injury|suspension)|returns? to (?:training|the squad|action|the lineup)|back in training|fit again|passed fit|cleared to play|recovered from|available for selection)\b/i;
const KEY_ROLE = /\b(star|captain|key|top scorer|striker|goalkeeper|keeper|talisman|talismanic)\b/i;
// "ضربة/دفعة لـ<الفريق>": الفريق يأتي بعد الكلمة المفتاحية لكنه هو المعنيّ بالخبر
const BLOW_FOR = /\b(blow|boost|setback|worry|concern|scare|crisis)\s+(?:for|at|to)\s+$/i;

const NAME_NOISE = /\b(FC|AFC|CF|SC|AC|AS|SK|BV|FK|CD|UD|SSC|1\.|RC|RCD)\b\.?/gi;

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : "";
}

export function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: tag(m[1], "title"),
    source: tag(m[1], "source"),
    pubDate: Date.parse(tag(m[1], "pubDate")) || 0,
  }));
}

export function searchName(name) {
  return name.replace(NAME_NOISE, " ").replace(/\s+/g, " ").trim();
}

// يحوّل عناوين الأخبار إلى معاملات تعديل للنموذج
export function scoreHeadlines(items, teamName, now = Date.now()) {
  const key = searchName(teamName).toLowerCase();
  const seen = new Set();
  const kept = [];
  let impact = 0;

  for (const it of items) {
    if (!it.title || now - it.pubDate > MAX_AGE_MS) continue;
    const title = it.title.replace(/\s+-\s+[^-]+$/, ""); // إزالة اسم المصدر الملحق بالعنوان
    const lower = title.toLowerCase();
    const teamIdx = lower.indexOf(key);
    if (teamIdx === -1) continue;

    const negMatch = title.match(NEGATIVE);
    const posMatch = title.match(POSITIVE);
    const neg = Boolean(negMatch);
    const pos = Boolean(posMatch);
    if (neg === pos) continue; // لا إشارة واضحة (أو إشارة متعارضة)

    // الفريق يجب أن يكون فاعل الخبر: يظهر قبل عبارة الإصابة/العودة، أو بصيغة "blow for <team>".
    // هذا يمنع نسب خبر عن الخصم ("...available for Al Ahli") إلى الفريق نفسه.
    const signalIdx = (negMatch ?? posMatch).index;
    const isSubject = teamIdx < signalIdx || BLOW_FOR.test(title.slice(0, teamIdx));
    if (!isSubject) continue;

    const dedupeKey = lower.replace(/[^a-z0-9]/g, "").slice(0, 50);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const weight = KEY_ROLE.test(title) ? 1.5 : 1;
    impact += neg ? weight : -weight;
    kept.push({ title, source: it.source, sentiment: neg ? "negative" : "positive" });
  }

  impact = Math.min(4, Math.max(0, impact));
  return {
    impact,
    atk: 1 - 0.025 * impact,
    def: 1 + 0.015 * impact,
    headlines: kept.slice(0, 3),
  };
}

export const NEUTRAL_NEWS = { impact: 0, atk: 1, def: 1, headlines: [] };

export async function fetchTeamNews(teamName) {
  const q = `"${searchName(teamName)}" (injury OR injured OR suspended OR "ruled out" OR doubtful OR sidelined OR returns) when:3d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`news ${res.status}`);
  return scoreHeadlines(parseRss(await res.text()), teamName);
}
