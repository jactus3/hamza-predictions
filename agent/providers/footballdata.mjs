// agent/providers/footballdata.mjs
//
// football-data.org (الخطة المجانية): 10 طلبات/دقيقة، وتدعم الموسم الحالي.
// يعيد الصيغة الموحّدة: { fixtures, table, results, partial }

import { getJson, sleep } from "../lib/http.mjs";

const BASE_URL = "https://api.football-data.org/v4";
const DELAY_BETWEEN_CALLS_MS = 6800; // أقل من 10 طلبات في الدقيقة

const UPCOMING = new Set(["SCHEDULED", "TIMED"]); // TIMED = موعد المباراة مؤكَّد (كان يُهمَل سابقًا)

function splitOf(row) {
  return { played: row.playedGames, gf: row.goalsFor, ga: row.goalsAgainst };
}

export function mapStandings(standings) {
  const total = standings.filter((s) => s.type === "TOTAL");
  const home = standings.filter((s) => s.type === "HOME");
  const away = standings.filter((s) => s.type === "AWAY");

  const homeById = new Map(home.flatMap((s) => s.table).map((r) => [r.team.id, splitOf(r)]));
  const awayById = new Map(away.flatMap((s) => s.table).map((r) => [r.team.id, splitOf(r)]));

  // بعض البطولات (كأس العالم/اليورو) فيها عدّة مجموعات: ندمجها كلها بدل الاكتفاء بأول مجموعة
  const groups = total.length ? total : standings.slice(0, 1);
  return groups.flatMap((s) =>
    s.table.map((r) => ({
      teamId: r.team.id,
      name: r.team.name,
      newsName: r.team.shortName || r.team.name,
      position: r.position,
      played: r.playedGames,
      points: r.points,
      gf: r.goalsFor,
      ga: r.goalsAgainst,
      gd: r.goalDifference,
      home: homeById.get(r.team.id) ?? null,
      away: awayById.get(r.team.id) ?? null,
      groupSize: s.table.length,
    })),
  );
}

export function mapFixtures(matches) {
  return matches
    .filter((m) => UPCOMING.has(m.status) && m.homeTeam?.id && m.awayTeam?.id) // تخطّي الأدوار التي لم تُحدَّد فرقها بعد
    .map((m) => ({
      id: m.id,
      utcDate: m.utcDate,
      home: { id: m.homeTeam.id, name: m.homeTeam.name, newsName: m.homeTeam.shortName || m.homeTeam.name },
      away: { id: m.awayTeam.id, name: m.awayTeam.name, newsName: m.awayTeam.shortName || m.awayTeam.name },
    }));
}

// نتائج مباريات منتهية → قائمة بسيطة (تُستخدم لحساب فورمة آخر 5 مباريات)
export function mapResults(matches) {
  return matches
    .filter((m) => m.status === "FINISHED" && m.score?.fullTime?.home != null)
    .map((m) => ({
      utcDate: m.utcDate,
      homeId: m.homeTeam.id,
      awayId: m.awayTeam.id,
      hg: m.score.fullTime.home,
      ag: m.score.fullTime.away,
    }));
}

export function createProvider(token, { get = getJson, wait = sleep } = {}) {
  const call = (endpoint, params = {}) => {
    const url = new URL(BASE_URL + endpoint);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    return get(url.toString(), { headers: { "X-Auth-Token": token } });
  };

  return {
    async load(comp, { dateFrom, dateTo }) {
      if (!token) throw new Error("FOOTBALL_DATA_TOKEN غير مضبوط");

      const fx = await call(`/competitions/${comp.code}/matches`, { dateFrom, dateTo });
      const fixtures = mapFixtures(fx.matches ?? []);
      if (!fixtures.length) return { fixtures: [], table: [], results: [], partial: false };
      await wait(DELAY_BETWEEN_CALLS_MS);

      const st = await call(`/competitions/${comp.code}/standings`);
      const table = mapStandings(st.standings ?? []);
      await wait(DELAY_BETWEEN_CALLS_MS);

      let results = [];
      try {
        const fin = await call(`/competitions/${comp.code}/matches`, { status: "FINISHED" });
        results = mapResults(fin.matches ?? []);
      } catch (err) {
        console.warn(`   (تعذّر جلب النتائج السابقة لحساب الفورمة: ${err.message})`);
      }
      await wait(DELAY_BETWEEN_CALLS_MS);

      return { fixtures, table, results, partial: false };
    },
  };
}
