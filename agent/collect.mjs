// agent/collect.mjs
//
// Hamza Predictions — وكيل الجمع والتحليل
// -----------------------------------------
// يجمع المباريات القادمة وترتيب الدوريات من الخطة المجانية لـ API-FOOTBALL،
// ثم يحسب نسبة الفوز بنفسه (نموذج بسيط شفاف) بدل الاعتماد على خدمة تنبؤ مدفوعة.
// يُشغَّل عبر GitHub Actions كل 12 ساعة (انظر .github/workflows/update-predictions.yml)
//
// المتطلبات: متغيّر بيئة API_FOOTBALL_KEY (مفتاح مجاني من dashboard.api-football.com)

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = "https://v3.football.api-sports.io";
const TIMEZONE = "Asia/Riyadh";
const FIXTURES_PER_LEAGUE = 6; // يبقي الاستهلاك ضمن الخطة المجانية (100 طلب/يوم)

if (!API_KEY) {
  console.error("❌ لم يتم ضبط متغيّر البيئة API_FOOTBALL_KEY. أوقفت العملية.");
  process.exit(1);
}

// ---------- أدوات مساعدة عامة ----------

async function apiGet(endpoint, params = {}) {
  const url = new URL(BASE_URL + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, {
    headers: { "x-apisports-key": API_KEY },
  });

  if (!res.ok) {
    throw new Error(`فشل الطلب ${endpoint}: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    console.warn(`⚠️ تحذير من API (${endpoint}):`, json.errors);
  }
  return json.response ?? [];
}

async function readJSON(relPath, fallback) {
  try {
    const raw = await readFile(path.join(ROOT, relPath), "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJSON(relPath, data) {
  await writeFile(path.join(ROOT, relPath), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function arabicWeekday(date) {
  return new Intl.DateTimeFormat("ar", { weekday: "long", timeZone: TIMEZONE }).format(date);
}

function riyadhTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TIMEZONE,
  }).format(date);
}

// ---------- تحديد هويّة الدوري وموسمه الحالي (مع تخزين مؤقت) ----------

async function resolveLeague(cache, league) {
  const cacheKey = `${league.country}::${league.name}`;
  const cached = cache[cacheKey];

  // نعيد الاستخدام إن كان محفوظًا ولم يمضِ أكثر من 25 يومًا، توفيرًا لحصة الطلبات
  if (cached && Date.now() - cached.resolvedAt < 25 * 24 * 60 * 60 * 1000) {
    return cached;
  }

  const results = await apiGet("/leagues", { search: league.name });
  const match = results.find(
    (r) => r.country?.name?.toLowerCase() === league.country.replace("-", " ").toLowerCase()
  ) || results[0];

  if (!match) {
    console.warn(`⚠️ تعذّر العثور على الدوري: ${league.label}`);
    return null;
  }

  const currentSeason = match.seasons.find((s) => s.current) ?? match.seasons.at(-1);
  const resolved = {
    id: match.league.id,
    season: currentSeason.year,
    resolvedAt: Date.now(),
  };
  cache[cacheKey] = resolved;
  return resolved;
}

// ---------- نموذج التحليل الخاص بنا ----------

function formScore(formStr) {
  if (!formStr) return 0.5;
  const map = { W: 1, D: 0.5, L: 0 };
  const chars = formStr.split("");
  let weighted = 0;
  let totalWeight = 0;
  chars.forEach((c, i) => {
    const weight = i + 1; // الأحرف الأخيرة (الأحدث) أثقل وزنًا
    weighted += (map[c] ?? 0.5) * weight;
    totalWeight += weight;
  });
  return totalWeight ? weighted / totalWeight : 0.5;
}

function sidePPG(sideStats) {
  if (!sideStats || !sideStats.played) return null;
  return (sideStats.win * 3 + sideStats.draw) / sideStats.played;
}

function teamStrength(standing, isHome) {
  const overallPPG = standing.all.played ? standing.points / standing.all.played : 1;
  const side = isHome ? standing.home : standing.away;
  const sidePpg = sidePPG(side) ?? overallPPG;
  const gdpg = standing.all.played ? standing.goalsDiff / standing.all.played : 0;
  const form = formScore(standing.form);
  const homeBonus = isHome ? 0.25 : 0;

  return 0.35 * overallPPG + 0.35 * sidePpg + 0.15 * (form * 3) + 0.1 * gdpg + homeBonus;
}

function predictMatch(homeStanding, awayStanding) {
  const strengthHome = teamStrength(homeStanding, true);
  const strengthAway = teamStrength(awayStanding, false);
  const diff = strengthHome - strengthAway;
  const logistic = 1 / (1 + Math.exp(-diff));

  const favoredSide = logistic >= 0.5 ? "home" : "away";
  const rawProb = favoredSide === "home" ? logistic : 1 - logistic;
  const prob = Math.min(92, Math.max(50, Math.round(rawProb * 100)));

  return { favoredSide, prob };
}

function buildAnalysis(favoredStanding, otherStanding, favoredIsHome) {
  const favoredForm = favoredStanding.form ?? "";
  const otherForm = otherStanding.form ?? "";
  const favoredWins = (favoredForm.match(/W/g) || []).length;
  const otherWins = (otherForm.match(/W/g) || []).length;

  const formLine = favoredForm
    ? `${favoredStanding.team.name} حقق ${favoredWins} انتصارات من آخر ${favoredForm.length} مباريات، مقابل ${otherWins} لفريق ${otherStanding.team.name}.`
    : `لا تتوفر بيانات فورمة كافية حاليًا لفريق ${favoredStanding.team.name}.`;

  const side = favoredIsHome ? favoredStanding.home : favoredStanding.away;
  const sidePpgVal = sidePPG(side);
  const sideLine = sidePpgVal !== null
    ? `${favoredStanding.team.name} يحقق معدل ${sidePpgVal.toFixed(1)} نقطة/مباراة ${favoredIsHome ? "كمضيف" : "كضيف"} هذا الموسم.`
    : `لا توجد مباريات كافية بعد لحساب معدل ${favoredIsHome ? "الاستضافة" : "الزيارة"} لفريق ${favoredStanding.team.name}.`;

  const goalLine = `فارق الأهداف هذا الموسم: ${favoredStanding.goalsDiff >= 0 ? "+" : ""}${favoredStanding.goalsDiff} لفريق ${favoredStanding.team.name}، مقابل ${otherStanding.goalsDiff >= 0 ? "+" : ""}${otherStanding.goalsDiff} لفريق ${otherStanding.team.name}.`;

  return { form: formLine, side: sideLine, goals: goalLine };
}

// ---------- التجميع الرئيسي ----------

async function run() {
  const leagues = await readJSON("agent/leagues.json", []);
  const cache = await readJSON("agent/cache.json", {});
  const matches = [];

  for (const league of leagues) {
    try {
      const resolved = await resolveLeague(cache, league);
      if (!resolved) continue;

      const [fixtures, standingsResponse] = await Promise.all([
        apiGet("/fixtures", {
          league: resolved.id,
          season: resolved.season,
          next: FIXTURES_PER_LEAGUE,
        }),
        apiGet("/standings", { league: resolved.id, season: resolved.season }),
      ]);

      const table = standingsResponse[0]?.league?.standings?.[0] ?? [];
      const byTeamId = Object.fromEntries(table.map((row) => [row.team.id, row]));

      for (const fx of fixtures) {
        const homeStanding = byTeamId[fx.teams.home.id];
        const awayStanding = byTeamId[fx.teams.away.id];
        if (!homeStanding || !awayStanding) continue; // لا نتوقع بلا بيانات ترتيب فعلية

        const { favoredSide, prob } = predictMatch(homeStanding, awayStanding);
        const favoredStanding = favoredSide === "home" ? homeStanding : awayStanding;
        const otherStanding = favoredSide === "home" ? awayStanding : homeStanding;
        const analysis = buildAnalysis(favoredStanding, otherStanding, favoredSide === "home");

        const kickoff = new Date(fx.fixture.date);

        matches.push({
          id: fx.fixture.id,
          teamA: favoredStanding.team.name, // الفريق المفضّل بالتوقع
          teamB: otherStanding.team.name,
          venue: favoredSide, // هل الفريق المفضّل يلعب على أرضه أم كضيف
          league: league.label,
          country: league.country.replace("-", " "),
          day: arabicWeekday(kickoff),
          time: riyadhTime(kickoff),
          kickoffISO: fx.fixture.date,
          prob,
          analysis,
        });
      }
    } catch (err) {
      console.warn(`⚠️ تعذّر جلب بيانات دوري "${league.label}":`, err.message);
    }
  }

  matches.sort((a, b) => b.prob - a.prob);

  await writeJSON("agent/cache.json", cache);
  await writeJSON("data/matches.json", {
    generatedAt: new Date().toISOString(),
    matches,
  });

  console.log(`✅ تم تحديث ${matches.length} مباراة.`);
}

run().catch((err) => {
  console.error("❌ فشل تشغيل الوكيل:", err);
  process.exit(1);
});
