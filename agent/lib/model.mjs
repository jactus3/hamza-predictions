// agent/lib/model.mjs
//
// نموذج التوقّع: توزيع بواسون للأهداف (هجوم/دفاع كل فريق مقابل متوسط الدوري + أفضلية الأرض)
// ينتج احتمالات ثلاثية: فوز المضيف / تعادل / فوز الضيف.
// عوامل الفورمة والأخبار تُطبَّق كتعديلات صغيرة ومحدودة السقف على الأهداف المتوقعة.

const PRIOR_GAMES = 5; // عدد مباريات "افتراضية" بمتوسط الدوري لتخفيف ضجيج العيّنات الصغيرة
const DEFAULT_AVG_GOALS = 1.35; // أهداف الفريق في المباراة إن لم تتوفر بيانات
const DEFAULT_HOME_FACTOR = 1.15;
const DEFAULT_AWAY_FACTOR = 0.87;
const MAX_GOALS = 10;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function leagueAverages(table) {
  let goals = 0;
  let played = 0;
  let homeGoals = 0;
  let homePlayed = 0;
  let awayGoals = 0;
  let awayPlayed = 0;

  for (const row of table) {
    goals += row.gf ?? 0;
    played += row.played ?? 0;
    if (row.home && row.away) {
      homeGoals += row.home.gf;
      homePlayed += row.home.played;
      awayGoals += row.away.gf;
      awayPlayed += row.away.played;
    }
  }

  const avgGoals = played >= 10 ? goals / played : DEFAULT_AVG_GOALS;

  let homeFactor = DEFAULT_HOME_FACTOR;
  let awayFactor = DEFAULT_AWAY_FACTOR;
  if (homePlayed >= 10 && awayPlayed >= 10) {
    const w = homePlayed / (homePlayed + 30); // كلما زادت العيّنة اعتمدنا على الدوري نفسه
    homeFactor = w * (homeGoals / homePlayed / avgGoals) + (1 - w) * DEFAULT_HOME_FACTOR;
    awayFactor = w * (awayGoals / awayPlayed / avgGoals) + (1 - w) * DEFAULT_AWAY_FACTOR;
  }

  return { avgGoals, homeFactor, awayFactor, gamesInTable: played / 2 };
}

export function teamRates(row, avgGoals) {
  const played = row?.played ?? 0;
  const gf = row?.gf ?? 0;
  const ga = row?.ga ?? 0;
  return {
    attack: (gf + PRIOR_GAMES * avgGoals) / (played + PRIOR_GAMES) / avgGoals,
    defense: (ga + PRIOR_GAMES * avgGoals) / (played + PRIOR_GAMES) / avgGoals,
    played,
  };
}

// من نتائج الفريق الأخيرة (الأحدث أولًا) → { letters, ppg, mult }
export function formFromResults(results, seasonPpg) {
  const last = results.slice(0, 5);
  if (last.length < 3) return { letters: last, ppg: null, mult: 1 };
  const pts = last.reduce((s, r) => s + (r === "W" ? 3 : r === "D" ? 1 : 0), 0);
  const ppg = pts / last.length;
  const base = seasonPpg ?? 1.35;
  return { letters: last, ppg, mult: clamp(Math.exp(0.08 * (ppg - base)), 0.93, 1.07) };
}

function poissonPmf(lambda) {
  const pmf = [Math.exp(-lambda)];
  for (let k = 1; k <= MAX_GOALS; k++) pmf.push((pmf[k - 1] * lambda) / k);
  return pmf;
}

export function outcomeProbabilities(lamHome, lamAway) {
  const ph = poissonPmf(lamHome);
  const pa = poissonPmf(lamAway);
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j];
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
    }
  }
  const total = home + draw + away;
  return { home: home / total, draw: draw / total, away: away / total };
}

// modifiers: { homeForm, awayForm, homeNews:{atk,def}, awayNews:{atk,def} }
export function predict(homeRow, awayRow, lg, modifiers = {}) {
  const h = teamRates(homeRow, lg.avgGoals);
  const a = teamRates(awayRow, lg.avgGoals);

  const homeNews = modifiers.homeNews ?? { atk: 1, def: 1 };
  const awayNews = modifiers.awayNews ?? { atk: 1, def: 1 };
  const homeForm = modifiers.homeForm ?? 1;
  const awayForm = modifiers.awayForm ?? 1;

  // هجوم المضيف × ضعف دفاع الضيف (وتأثير أخبار الضيف على دفاعه) ... وهكذا
  const lamHome = clamp(
    lg.avgGoals * h.attack * a.defense * lg.homeFactor * homeForm * homeNews.atk * awayNews.def,
    0.2,
    4.5,
  );
  const lamAway = clamp(
    lg.avgGoals * a.attack * h.defense * lg.awayFactor * awayForm * awayNews.atk * homeNews.def,
    0.2,
    4.5,
  );

  const p = outcomeProbabilities(lamHome, lamAway);

  // تقريب إلى نسب صحيحة مجموعها 100
  const home = Math.round(p.home * 100);
  const away = Math.round(p.away * 100);
  const draw = Math.max(0, 100 - home - away);

  return { lamHome, lamAway, pct: { home, draw, away }, minPlayed: Math.min(h.played, a.played) };
}

export function confidenceLevel(minPlayed, partialData) {
  if (partialData || minPlayed < 4) return "low";
  if (minPlayed < 8) return "medium";
  return "high";
}
