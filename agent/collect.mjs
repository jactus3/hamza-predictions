// agent/collect.mjs
//
// Hamza Predictions — وكيل الجمع والتحليل
// ----------------------------------------
// 1) يجلب المباريات القادمة وترتيب/نتائج كل دوري من مصدره (agent/leagues.json يحدد المصدر لكل دوري):
//      • footballdata : football-data.org (يحتاج FOOTBALL_DATA_TOKEN)
//      • espn         : الدوري السعودي (بدون مفتاح)
//      • sportsdb     : الدوري المصري (THESPORTSDB_KEY اختياري؛ المفتاح المجاني يعطي بيانات جزئية)
// 2) يجلب أخبار الفرق (إصابات/إيقافات/عودة لاعبين) من آخر 72 ساعة ويعدّل بها الأهداف المتوقعة تعديلًا محدودًا.
// 3) يحسب احتمالات (فوز / تعادل / فوز الضيف) بنموذج بواسون، ويكتب data/matches.json.
//
// قواعد الأمان: فشل دوري واحد لا يوقف الباقي (نحتفظ بمبارياته السابقة)، ولا نكتب ملفًا فارغًا فوق بيانات سليمة.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMatch, resultsByTeam } from "./lib/build.mjs";
import { buildPriors, leagueAverages } from "./lib/model.mjs";
import { fetchTeamNews, NEUTRAL_NEWS } from "./lib/news.mjs";
import { sleep } from "./lib/http.mjs";
import { createProvider as footballData } from "./providers/footballdata.mjs";
import { createProvider as espn } from "./providers/espn.mjs";
import { createProvider as sportsDb } from "./providers/sportsdb.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD) || 7; // للاختبار فقط: DAYS_AHEAD=30
const NEWS_DELAY_MS = 500;

const providers = {
  footballdata: footballData(process.env.FOOTBALL_DATA_TOKEN),
  espn: espn(),
  sportsdb: sportsDb(process.env.THESPORTSDB_KEY || "3"),
};

async function readJSON(relPath, fallback) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, relPath), "utf-8"));
  } catch {
    return fallback;
  }
}

async function writeJSON(relPath, data) {
  await writeFile(path.join(ROOT, relPath), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function run() {
  const leagues = await readJSON("agent/leagues.json", []);
  const previous = await readJSON("data/matches.json", { matches: [] });
  const now = new Date();
  const dateFrom = now.toISOString().slice(0, 10);
  const dateTo = new Date(now.getTime() + DAYS_AHEAD * 86400000).toISOString().slice(0, 10);

  // ---- 1) جلب البيانات من كل دوري ----
  const loaded = [];
  const status = {};
  for (const comp of leagues) {
    const provider = providers[comp.provider ?? "footballdata"];
    try {
      const data = await provider.load(comp, { now, daysAhead: DAYS_AHEAD, dateFrom, dateTo });
      loaded.push({ comp, data });
      status[comp.label] = { ok: true, fixtures: data.fixtures.length, teams: data.table.length, partial: data.partial };
      console.log(`✅ ${comp.label}: ${data.fixtures.length} مباراة قادمة، ${data.table.length} فريق في الترتيب${data.partial ? " (بيانات جزئية)" : ""}.`);
    } catch (err) {
      status[comp.label] = { ok: false, error: err.message };
      console.warn(`⚠️ تعذّر جلب بيانات "${comp.label}": ${err.message}`);
    }
  }

  const failedLabels = Object.entries(status).filter(([, s]) => !s.ok).map(([label]) => label);
  if (!loaded.length) {
    console.error("❌ فشل جلب كل الدوريات — لن أكتب فوق البيانات الحالية.");
    process.exit(1);
  }

  // ---- 2) أخبار الفرق التي تلعب فعلًا هذا الأسبوع ----
  const newsNames = [...new Set(loaded.flatMap(({ data }) => data.fixtures.flatMap((f) => [f.home.newsName, f.away.newsName])))];
  const newsByName = new Map();
  let newsFailures = 0;
  for (const name of newsNames) {
    try {
      newsByName.set(name, await fetchTeamNews(name));
    } catch {
      newsByName.set(name, NEUTRAL_NEWS);
      newsFailures++;
    }
    await sleep(NEWS_DELAY_MS);
  }
  const withNews = [...newsByName.values()].filter((n) => n.headlines.length).length;
  console.log(`📰 الأخبار: ${newsNames.length} فريق، ${withNews} منها فيها أخبار مؤثرة، ${newsFailures} تعذّر جلبها.`);

  // ---- 3) الحساب ----
  const matches = [];
  for (const { comp, data } of loaded) {
    // مستوى الموسم السابق لكل فريق (للدوريات المحلية فقط)؛ الفرق الصاعدة تأخذ قيمة افتراضية أضعف
    const priorOf = data.prevTable?.length ? buildPriors(data.prevTable) : null;
    if (priorOf) data.table.forEach((r) => { r.prior = priorOf(r.teamId); });
    const rowById = new Map(data.table.map((r) => [String(r.teamId), r]));
    // فريق يلعب لكن غير موجود في الجدول بعد (مثلًا أول جولة): صف فارغ يحمل مستواه السابق
    for (const fx of data.fixtures) {
      for (const t of [fx.home, fx.away]) {
        if (priorOf && !rowById.has(String(t.id))) {
          rowById.set(String(t.id), { teamId: t.id, name: t.name, newsName: t.newsName, position: 0, played: 0, points: 0, gf: 0, ga: 0, gd: 0, home: null, away: null, prior: priorOf(t.id) });
        }
      }
    }
    const lg = leagueAverages(data.table);
    const formResults = resultsByTeam(data.results);
    const byId = new Map([...formResults].map(([id, v]) => [String(id), v]));
    const formLookup = { get: (id) => byId.get(String(id)) };

    for (const fx of data.fixtures) {
      matches.push(buildMatch({ fx, comp, rowById, lg, formResults: formLookup, newsByName, partialData: data.partial }));
    }
  }

  // دوريات فشل جلبها هذه المرة: نُبقي مبارياتها السابقة (التي لم تبدأ بعد) بدل حذفها
  const carried = (previous.matches ?? [])
    .filter((m) => failedLabels.includes(m.league) && Date.parse(m.kickoffISO) > now.getTime())
    .map((m) => ({ ...m, stale: true }));
  if (carried.length) console.log(`↩️ إبقاء ${carried.length} مباراة سابقة من دوريات تعذّر تحديثها.`);

  const all = [...matches, ...carried].sort((a, b) => Date.parse(a.kickoffISO) - Date.parse(b.kickoffISO));

  await writeJSON("data/matches.json", {
    generatedAt: now.toISOString(),
    sources: status,
    matches: all,
  });

  console.log(`\n✅ تم تحديث ${matches.length} مباراة (+${carried.length} محتفَظ بها).`);
}

run().catch((err) => {
  console.error("❌ فشل تشغيل الوكيل:", err);
  process.exit(1);
});
