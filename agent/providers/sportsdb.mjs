// agent/providers/sportsdb.mjs
//
// TheSportsDB — يغطي الدوري المصري (ESPN وfootball-data.org لا يغطيانه).
// تنبيه مهم: المفتاح المجاني ("3") يقتطع النتائج (حوالي 5 مباريات لكل جولة)، لذلك:
//   • المباريات المجلوبة قد تكون جزءًا من الجولة فقط،
//   • الترتيب يُبنى من النتائج المتاحة فقط، فتُعلَّم التوقعات بثقة "منخفضة" (partial).
// للتغطية الكاملة اضبط THESPORTSDB_KEY بمفتاح مدفوع (Patreon) — الكود نفسه يعمل بلا تعديل.

import { getJson, sleep } from "../lib/http.mjs";

const DELAY_MS = 2200; // المفتاح المجاني: 30 طلبًا/دقيقة

const utcOf = (ev) => {
  if (ev.strTimestamp) return new Date(ev.strTimestamp.endsWith("Z") ? ev.strTimestamp : ev.strTimestamp + "Z");
  if (ev.dateEvent && ev.strTime) return new Date(`${ev.dateEvent}T${ev.strTime}Z`);
  return null;
};

const isFinished = (ev) => ev.intHomeScore != null && ev.intHomeScore !== "" && ev.intAwayScore != null && ev.intAwayScore !== "";

// يبني جدول ترتيب من نتائج مباريات منتهية
export function tableFromResults(results, names) {
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) {
      rows.set(id, {
        teamId: id, name: names.get(id), newsName: names.get(id),
        played: 0, points: 0, gf: 0, ga: 0,
        home: { played: 0, gf: 0, ga: 0 }, away: { played: 0, gf: 0, ga: 0 },
      });
    }
    return rows.get(id);
  };
  for (const r of results) {
    const h = row(r.homeId);
    const a = row(r.awayId);
    h.played++; a.played++;
    h.gf += r.hg; h.ga += r.ag; a.gf += r.ag; a.ga += r.hg;
    h.home.played++; h.home.gf += r.hg; h.home.ga += r.ag;
    a.away.played++; a.away.gf += r.ag; a.away.ga += r.hg;
    if (r.hg > r.ag) h.points += 3;
    else if (r.hg < r.ag) a.points += 3;
    else { h.points++; a.points++; }
  }
  const table = [...rows.values()].sort((x, y) => y.points - x.points || (y.gf - y.ga) - (x.gf - x.ga));
  table.forEach((r, i) => { r.position = i + 1; r.gd = r.gf - r.ga; });
  return table;
}

export function createProvider(key = "3", { get = getJson, wait = sleep } = {}) {
  const api = async (path) => {
    const json = await get(`https://www.thesportsdb.com/api/v1/json/${key}/${path}`);
    await wait(DELAY_MS);
    return json;
  };

  return {
    async load(comp, { now, daysAhead }) {
      const id = comp.code;
      const info = (await api(`lookupleague.php?id=${id}`)).leagues?.[0];
      const season = info?.strCurrentSeason;
      if (!season) throw new Error("لا يوجد موسم حالي في TheSportsDB");

      const next = (await api(`eventsnextleague.php?id=${id}`)).events ?? [];
      const round = Number(next[0]?.intRound ?? 0);
      const events = new Map(next.map((e) => [e.idEvent, e]));

      // جولات قادمة (الحالية + التالية) ثم الجولات السابقة لبناء النتائج
      const wanted = round ? [round, round + 1, ...Array.from({ length: round - 1 }, (_, i) => round - 1 - i)] : [];
      for (const r of wanted.slice(0, 14)) {
        const ev = (await api(`eventsround.php?id=${id}&r=${r}&s=${season}`)).events ?? [];
        ev.forEach((e) => events.set(e.idEvent, e));
      }

      const names = new Map();
      const limit = new Date(now.getTime() + daysAhead * 86400000);
      const fixtures = [];
      const results = [];
      for (const ev of events.values()) {
        names.set(ev.idHomeTeam, ev.strHomeTeam);
        names.set(ev.idAwayTeam, ev.strAwayTeam);
        const when = utcOf(ev);
        if (!when) continue;
        if (isFinished(ev)) {
          results.push({ utcDate: when.toISOString(), homeId: ev.idHomeTeam, awayId: ev.idAwayTeam, hg: Number(ev.intHomeScore), ag: Number(ev.intAwayScore) });
        } else if (when > now && when <= limit) {
          fixtures.push({
            id: `sportsdb-${ev.idEvent}`,
            utcDate: when.toISOString(),
            home: { id: ev.idHomeTeam, name: ev.strHomeTeam, newsName: ev.strHomeTeam },
            away: { id: ev.idAwayTeam, name: ev.strAwayTeam, newsName: ev.strAwayTeam },
          });
        }
      }

      const table = tableFromResults(results, names);
      return { fixtures, table, results, partial: key === "3" };
    },
  };
}
