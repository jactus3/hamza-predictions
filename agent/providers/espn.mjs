// agent/providers/espn.mjs
//
// واجهة ESPN غير الرسمية (sports.core.api.espn.com) — مجانية وبدون مفتاح، وتغطي الدوري السعودي (ksa.1)
// بمباريات وترتيب كاملين. ملاحظة: الواجهة غير موثّقة رسميًا وقد تتغيّر، لذلك أي فشل هنا
// يُسجَّل ولا يوقف باقي الدوريات (الوكيل يحتفظ ببيانات المباريات السابقة لهذا الدوري).

import { getJson } from "../lib/http.mjs";

const BASE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues";

const https = (u) => u.replace(/^http:/, "https:");
const yyyymmdd = (d) => d.toISOString().slice(0, 10).replaceAll("-", "");
const idFromRef = (ref) => ref.match(/\/teams\/(\d+)/)?.[1];

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

// الموسم في ESPN يُسمّى بسنة البداية (2026 = موسم 2026-27)
function seasonYear(now) {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

export function mapStandingEntry(entry, teamId, name) {
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
    home: { played: stat.homeGamesPlayed ?? 0, gf: stat.homePointsFor ?? 0, ga: stat.homePointsAgainst ?? 0 },
    away: { played: stat.awayGamesPlayed ?? 0, gf: stat.awayPointsFor ?? 0, ga: stat.awayPointsAgainst ?? 0 },
  };
}

export function createProvider({ get = getJson } = {}) {
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

      const to = new Date(now.getTime() + daysAhead * 86400000);
      const list = await get(`${league}/events?dates=${yyyymmdd(now)}-${yyyymmdd(to)}&limit=100`);

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
      if (!fixtures.length) return { fixtures: [], table: [], results: [], partial: false };

      const st = await get(`${league}/seasons/${seasonYear(now)}/types/1/groups/1/standings/0`);
      const table = await mapLimit(st.standings ?? [], 5, async (entry) => {
        const { id, name } = await teamName(entry.team.$ref);
        return mapStandingEntry(entry, id, name);
      });

      return { fixtures, table, results: [], partial: false };
    },
  };
}
