// agent/lib/build.mjs — يحوّل (مباراة + ترتيب + نتائج + أخبار) إلى سجل جاهز للواجهة

import { confidenceLevel, formFromResults, predict } from "./model.mjs";
import { NEUTRAL_NEWS } from "./news.mjs";

const TIMEZONE = "Asia/Riyadh";
const LETTER_AR = { W: "فوز", D: "تعادل", L: "خسارة" };

const arabicWeekday = (date) => new Intl.DateTimeFormat("ar", { weekday: "long", timeZone: TIMEZONE }).format(date);
const riyadhTime = (date) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIMEZONE }).format(date);

// آخر النتائج لكل فريق (الأحدث أولًا): { teamId: ["W","D","L",...] }
export function resultsByTeam(results) {
  const byTeam = new Map();
  const push = (id, letter) => {
    if (!byTeam.has(id)) byTeam.set(id, []);
    byTeam.get(id).push(letter);
  };
  const sorted = [...results].sort((a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate));
  for (const r of sorted) {
    const h = r.hg > r.ag ? "W" : r.hg === r.ag ? "D" : "L";
    push(r.homeId, h);
    push(r.awayId, h === "W" ? "L" : h === "L" ? "W" : "D");
  }
  return byTeam;
}

// صياغة عربية سليمة للعدد والمعدود
const plural = (n, one, two, few, many) => (n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`);
const matchesWord = (n) => plural(n, "مباراة واحدة", "مباراتين", "مباريات", "مباراة");
const pointsWord = (n) => plural(n, "نقطة واحدة", "نقطتان", "نقاط", "نقطة");

function teamLine(row, name, formInfo, total) {
  if (!row) return `${name}: لا تتوفر بيانات ترتيب كافية.`;
  const rank = row.position ? `المركز ${row.position}${total ? ` من ${total}` : ""}، ` : "";
  const form = formInfo.letters.length >= 3 ? `، آخر ${formInfo.letters.length} مباريات: ${formInfo.letters.map((l) => LETTER_AR[l]).join(" · ")}` : "";
  return `${name}: ${rank}${pointsWord(row.points)} في ${matchesWord(row.played)}${form}.`;
}

function splitLine(name, split, where) {
  if (!split || !split.played) return null;
  return `${name} ${where}: سجّل ${split.gf} واستقبل ${split.ga} في ${matchesWord(split.played)}.`;
}

export function buildMatch({ fx, comp, rowById, lg, formResults, newsByName, partialData }) {
  const homeRow = rowById.get(String(fx.home.id)) ?? null;
  const awayRow = rowById.get(String(fx.away.id)) ?? null;

  const seasonPpg = (row) => (row && row.played ? row.points / row.played : null);
  const homeForm = formFromResults(formResults.get(fx.home.id) ?? [], seasonPpg(homeRow));
  const awayForm = formFromResults(formResults.get(fx.away.id) ?? [], seasonPpg(awayRow));
  const homeNews = newsByName.get(fx.home.newsName) ?? NEUTRAL_NEWS;
  const awayNews = newsByName.get(fx.away.newsName) ?? NEUTRAL_NEWS;

  const p = predict(homeRow, awayRow, lg, {
    homeForm: homeForm.mult,
    awayForm: awayForm.mult,
    homeNews,
    awayNews,
  });

  const favoredHome = p.pct.home >= p.pct.away;
  const kickoff = new Date(fx.utcDate);
  const total = homeRow?.groupSize ?? null;

  const newsParts = [];
  for (const [name, n] of [[fx.home.name, homeNews], [fx.away.name, awayNews]]) {
    if (n.headlines.length) {
      newsParts.push(`${name}: ${n.headlines.map((h) => `${h.sentiment === "negative" ? "⚠️" : "✅"} ${h.title}`).join(" | ")}`);
    }
  }

  const goalsLine =
    `الأهداف المتوقعة: ${fx.home.name} ${p.lamHome.toFixed(1)} – ${p.lamAway.toFixed(1)} ${fx.away.name}. ` +
    `احتمال فوز ${fx.home.name} ${p.pct.home}% · تعادل ${p.pct.draw}% · فوز ${fx.away.name} ${p.pct.away}%.` +
    (p.hasPrior && p.minPlayed < 12 ? " (يُدمج مستوى الفريقين الموسم الماضي مع نتائج هذا الموسم لأن العيّنة ما زالت صغيرة.)" : "");

  const sideLine =
    [splitLine(fx.home.name, homeRow?.home, "على أرضه"), splitLine(fx.away.name, awayRow?.away, "خارج أرضه")]
      .filter(Boolean)
      .join(" ") || "لا تتوفر بيانات الأداء كمضيف/كضيف بعد.";

  return {
    id: fx.id,
    teamA: favoredHome ? fx.home.name : fx.away.name,
    teamB: favoredHome ? fx.away.name : fx.home.name,
    venue: favoredHome ? "home" : "away",
    league: comp.label,
    country: comp.country,
    day: arabicWeekday(kickoff),
    time: riyadhTime(kickoff),
    kickoffISO: fx.utcDate,
    prob: favoredHome ? p.pct.home : p.pct.away,
    probs: p.pct,
    homeTeam: fx.home.name,
    awayTeam: fx.away.name,
    xg: { home: +p.lamHome.toFixed(2), away: +p.lamAway.toFixed(2) },
    confidence: confidenceLevel(p.minPlayed, partialData, p.hasPrior),
    analysis: {
      form: `${teamLine(homeRow, fx.home.name, homeForm, total)} ${teamLine(awayRow, fx.away.name, awayForm, total)}`,
      side: sideLine,
      goals: goalsLine,
      news: newsParts.length ? newsParts.join("\n") : null,
    },
  };
}
