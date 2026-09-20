// agent/providers/espn.mjs
//
// واجهة ESPN غير الرسمية (sports.core.api.espn.com) — مجانية وبدون مفتاح.
// تغطي الدوري السعودي وبطولات محلية أخرى (تركيا، بلجيكا، اسكتلندا، اليونان، MLS، الأرجنتين، المكسيك، اليابان، الصين).
// ملاحظة: الواجهة غير موثّقة رسميًا وقد تتغيّر، لذلك أي فشل هنا يُسجَّل ولا يوقف باقي الدوريات
// (الوكيل يحتفظ ببيانات المباريات السابقة لهذا الدوري).
//
// اختلاف بنية الجداول بين البطولات (مجموعات/مراحل/سنة تقويمية) يُحَلّ باكتشاف تلقائي:
//   • الموسم الحالي: المرحلة (type) التي يقع تاريخ اليوم داخل مدّتها، وتُدمج كل مجموعاتها.
//   • الموسم السابق (للمستوى المبدئي): المرحلة الأكبر عيّنة (أكثر مباريات) بعد استبعاد الأدوار الإقصائية.

import { getJson } from "../lib/http.mjs";

const BASE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues";
const KNOCKOUT = /play-?off|knockout|final|relegation|promotion|championship/i;

const https = (u) => u.replace(/^http:/, "https:");
const yyyymmdd = (d) => d.toISOString().slice(0, 10).replaceAll("-", "");
const idFromRef = (ref) => ref.match(/\/teams\/(\d+)/)?.[1];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export function mapStandingEntry(entry, teamId, name, groupSize = null) {
  const stat = Object.fromEntries((entry.records?.[0]?.stats ?? []).map((s) => [s.name, s.value]));
  return {
    teamId,
    name,
    newsName: name,
    position: stat.rank ?? 0,
    played: stat.gamesPlayed ?? 0,
    points: stat.points ?? 0,
    gf: stat.pointsFor ?? 0,
    ga: stat.pointsAgainst ?? 0,
    gd: stat.pointDifferential ?? 0,
    groupSize,
    home: { played: stat.homeGamesPlayed ?? 0, gf: stat.homePointsFor ?? 0, ga: stat.homePointsAgainst ?? 0 },
    away: { played: stat.awayGamesPlayed ?? 0, gf: stat.awayPointsFor ?? 0, ga: stat.awayPointsAgainst ?? 0 },
  };
}

// يختار مرحلة الموسم (type) المناسبة من قائمة مراحل مع تواريخها ومجموعاتها.
// mode "current": المرحلة التي تحتوي اليوم؛ وإلا آخر مرحلة بدأت؛ وإلا الأولى.
export function pickCurrentType(types, now) {
  const withGroups = types.filter((t) => t.groups.length);
  const t = now.getTime();
  const inside = withGroups.filter((x) => Date.parse(x.startDate) <= t && t <= Date.parse(x.endDate));
  const byStartDesc = (a, b) => Date.parse(b.startDate) - Date.parse(a.startDate);
  if (inside.length) return inside.sort(byStartDesc)[0];
  const started = withGroups.filter((x) => Date.parse(x.startDate) <= t).sort(byStartDesc);
  return started[0] ?? withGroups[0] ?? null;
}

export function createProvider({ get = (u) => getJson(u, { retries: 1, retryDelayMs: 1500 }) } = {}) {
  const tryGet = async (url) => {
    try {
      return await get(https(url));
    } catch {
      return null;
    }
  };

  return {
    async load(comp, { now, daysAhead }) {
      const league = `${BASE}/${comp.code}`;
      const teamNames = new Map();
      const teamName = async (ref) => {
        const id = idFromRef(ref);
        if (!teamNames.has(id)) {
          const t = await get(https(ref));
          teamNames.set(id, t.displayName ?? t.name);
        }
        return { id, name: teamNames.get(id) };
      };

      // ---- المباريات القادمة ----
      const to = new Date(now.getTime() + daysAhead * 86400000);
      const list = await get(`${league}/events?dates=${yyyymmdd(now)}-${yyyymmdd(to)}&limit=200`);
      const events = await mapLimit(list.items ?? [], 5, (it) => get(https(it.$ref)));
      const fixtures = [];
      for (const ev of events) {
        if (new Date(ev.date) <= now) continue; // بدأت أو انتهت
        const comps = ev.competitions?.[0]?.competitors ?? [];
        const home = comps.find((c) => c.homeAway === "home");
        const away = comps.find((c) => c.homeAway === "away");
        if (!home?.team?.$ref || !away?.team?.$ref) continue;
        const h = await teamName(home.team.$ref);
        const a = await teamName(away.team.$ref);
        fixtures.push({
          id: `espn-${ev.id}`,
          utcDate: new Date(ev.date).toISOString(),
          home: { id: h.id, name: h.name, newsName: h.name },
          away: { id: a.id, name: a.name, newsName: a.name },
        });
      }
      if (!fixtures.length) return { fixtures: [], table: [], results: [], prevTable: null, partial: false };

      // ---- اكتشاف الموسم والجداول ----
      const info = await get(league);
      const season = info.season ? await get(https(info.season.$ref)) : null;
      const year = season?.year;
      if (!year) throw new Error("تعذّر تحديد موسم البطولة في ESPN");

      const loadTypes = async (y) => {
        const typesList = await tryGet(`${league}/seasons/${y}/types?limit=50`);
        const docs = await mapLimit(typesList?.items ?? [], 6, async (it) => {
          const T = await tryGet(it.$ref);
          if (!T?.groups?.$ref) return null;
          const G = await tryGet(T.groups.$ref);
          const groups = (G?.items ?? []).map((g) => g.$ref.match(/groups\/(\d+)/)?.[1]).filter(Boolean);
          return groups.length ? { id: T.id, name: T.name ?? "", startDate: T.startDate, endDate: T.endDate, groups } : null;
        });
        return docs.filter(Boolean);
      };

      const loadTable = async (y, type) => {
        const perGroup = await mapLimit(type.groups, 4, async (gid) => {
          const st = await tryGet(`${league}/seasons/${y}/types/${type.id}/groups/${gid}/standings/0`);
          const entries = st?.standings ?? [];
          return Promise.all(
            entries.map(async (entry) => {
              const { id, name } = await teamName(entry.team.$ref);
              return mapStandingEntry(entry, id, name, entries.length);
            }),
          );
        });
        const seen = new Set();
        return perGroup.flat().filter((r) => (seen.has(r.teamId) ? false : seen.add(r.teamId)));
      };

      const curTypes = await loadTypes(year);
      const curType = pickCurrentType(curTypes, now);
      const table = curType ? await loadTable(year, curType) : [];

      let prevTable = null;
      if (comp.usePrior) {
        try {
          const prevTypes = (await loadTypes(year - 1)).filter((t) => !KNOCKOUT.test(t.name));
          let best = null;
          for (const t of prevTypes) {
            const tbl = await loadTable(year - 1, t);
            const games = tbl.reduce((s, r) => s + num(r.played), 0);
            if (!best || games > best.games) best = { games, tbl };
          }
          prevTable = best?.tbl?.length ? best.tbl : null;
        } catch (err) {
          console.warn(`   (تعذّر جلب جدول الموسم السابق: ${err.message})`);
        }
      }

      return { fixtures, table, results: [], prevTable, partial: false };
    },
  };
}
