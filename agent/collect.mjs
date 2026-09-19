// agent/collect.mjs
//
// Hamza Predictions — وكيل الجمع والتحليل (نسخة football-data.org)
// -----------------------------------------------------------------
// يجمع المباريات القادمة وترتيب الدوريات من الخطة المجانية لـ football-data.org
// (تدعم الموسم الحالي فعليًا، على عكس بعض المصادر المجانية الأخرى)،
// ثم يحسب نسبة الفوز بنفسه (نموذج بسيط شفاف من نقاط الترتيب وفارق الأهداف).
//
// يُشغَّل عبر GitHub Actions كل 12 ساعة (انظر .github/workflows/update-predictions.yml)
//
// المتطلبات: متغيّر بيئة FOOTBALL_DATA_TOKEN (مفتاح مجاني من football-data.org/client/register)

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const BASE_URL = "https://api.football-data.org/v4";
const TIMEZONE = "Asia/Riyadh";
const DAYS_AHEAD = 7;
const DELAY_BETWEEN_CALLS_MS = 6800;

if (!TOKEN) {
  console.error("❌ لم يتم ضبط متغيّر البيئة FOOTBALL_DATA_TOKEN. أوقفت العملية.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fdGet(endpoint, params = {}) {
  const url = new URL(BASE_URL + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, {
    headers: { "X-Auth-Token": TOKEN },
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(`فشل الطلب ${endpoint}: ${res.status} ${json?.message ?? res.statusText}`);
  }
  return json;
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

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function teamStrength(row, isHome) {
  const ppg = row.playedGames ? row.points / row.playedGames : 1;
  const gdpg = row.playedGames ? row.goalDifference / row.playedGames : 0;
  const homeBonus = isHome ? 0.3 : 0;
  return ppg + 0.25 * gdpg + homeBonus;
}

function predictMatch(homeRow, awayRow) {
  const strengthHome = teamStrength(homeRow, true);
  const strengthAway = teamStrength(awayRow, false);
  const diff = strengthHome - strengthAway;
  const logistic = 1 / (1 + Math.exp(-diff));

  const favoredSide = logistic >= 0.5 ? "home" : "away";
  const rawProb = favoredSide === "home" ? logistic : 1 - logistic;
  const prob = Math.min(92, Math.max(50, Math.round(rawProb * 100)));

  return { favoredSide, prob };
}

function buildAnalysis(favoredRow, otherRow, totalTeams) {
  const positionLine = `${favoredRow.team.name} يحتل المركز ${favoredRow.position} من ${totalTeams}، برصيد ${favoredRow.points} نقطة من ${favoredRow.playedGames} مباراة — مقابل المركز ${otherRow.position} وبرصيد ${otherRow.points} نقطة لفريق ${otherRow.team.name}.`;

  const favoredGfpg = favoredRow.playedGames ? (favoredRow.goalsFor / favoredRow.playedGames).toFixed(1) : "0.0";
  const favoredGapg = favoredRow.playedGames ? (favoredRow.goalsAgainst / favoredRow.playedGames).toFixed(1) : "0.0";
  const goalsLine = `${favoredRow.team.name} يسجل معدل ${favoredGfpg} هدف ويستقبل ${favoredGapg} هدف لكل مباراة هذا الموسم.`;

  const gdLine = `فارق الأهداف هذا الموسم: ${favoredRow.goalDifference >= 0 ? "+" : ""}${favoredRow.goalDifference} لفريق ${favoredRow.team.name}، مقابل ${otherRow.goalDifference >= 0 ? "+" : ""}${otherRow.goalDifference} لفريق ${otherRow.team.name}.`;

  return { form: positionLine, side: goalsLine, goals: gdLine };
}

async function run() {
  const competitions = await readJSON("agent/leagues.json", []);
  const matches = [];

  const today = new Date();
  const dateFrom = isoDate(today);
  const dateToDate = new Date(today);
  dateToDate.setDate(dateToDate.getDate() + DAYS_AHEAD);
  const dateTo = isoDate(dateToDate);

  for (const comp of competitions) {
    try {
      const fixturesResp = await fdGet(`/competitions/${comp.code}/matches`, {
        dateFrom,
        dateTo,
        status: "SCHEDULED",
      });
      await sleep(DELAY_BETWEEN_CALLS_MS);

      const standingsResp = await fdGet(`/competitions/${comp.code}/standings`);
      await sleep(DELAY_BETWEEN_CALLS_MS);

      const table =
        standingsResp.standings?.find((s) => s.type === "TOTAL")?.table ??
        standingsResp.standings?.[0]?.table ??
        [];
      const totalTeams = table.length;
      const byTeamId = Object.fromEntries(table.map((row) => [row.team.id, row]));

      const fixtures = fixturesResp.matches ?? [];

      for (const fx of fixtures) {
        const homeRow = byTeamId[fx.homeTeam.id];
        const awayRow = byTeamId[fx.awayTeam.id];
        if (!homeRow || !awayRow) continue;

        const { favoredSide, prob } = predictMatch(homeRow, awayRow);
        const favoredRow = favoredSide === "home" ? homeRow : awayRow;
        const otherRow = favoredSide === "home" ? awayRow : homeRow;
        const analysis = buildAnalysis(favoredRow, otherRow, totalTeams);

        const kickoff = new Date(fx.utcDate);

        matches.push({
          id: fx.id,
          teamA: favoredRow.team.name,
          teamB: otherRow.team.name,
          venue: favoredSide,
          league: comp.label,
          country: comp.country,
          day: arabicWeekday(kickoff),
          time: riyadhTime(kickoff),
          kickoffISO: fx.utcDate,
          prob,
          analysis,
        });
      }

      console.log(`✅ ${comp.label}: ${fixtures.length} مباراة قادمة، ${table.length} فريق بالترتيب.`);
    } catch (err) {
      console.warn(`⚠️ تعذّر جلب بيانات دوري "${comp.label}":`, err.message);
    }
  }

  matches.sort((a, b) => b.prob - a.prob);

  await writeJSON("data/matches.json", {
    generatedAt: new Date().toISOString(),
    matches,
  });

  console.log(`\n✅ تم تحديث ${matches.length} مباراة إجمالًا.`);
}

run().catch((err) => {
  console.error("❌ فشل تشغيل الوكيل:", err);
  process.exit(1);
});
