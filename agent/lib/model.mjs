// agent/lib/model.mjs
//
// نموذج التوقّع: توزيع بواسون للأهداف (هجوم/دفاع كل فريق مقابل متوسط الدوري + أفضلية الأرض)
// ينتج احتمالات ثلاثية: فوز المضيف / تعادل / فوز الضيف.
// عوامل الفورمة والأخبار تُطبَّق كتعديلات صغيرة ومحدودة السقف على الأهداف المتوقعة.

// معاملات النموذج (قابلة للتعديل لأغراض الـbacktest: agent/backtest.mjs)
// القيم مضبوطة بـbacktest على موسم 2024-25 ومُقيَّمة على 2025-26 (5 دوريات، 1752 مباراة)
export const PARAMS = {
  priorGames: 5, // مباريات "افتراضية" بمتوسط الدوري لفريق بلا مستوى سابق (تخفيف ضجيج العيّنات الصغيرة)
  priorGamesWithPrior: 16, // مباريات افتراضية بمستوى الموسم السابق للفريق (وزنه الأكبر في أول الموسم)
  prevWeight: 0.85, // وزن مستوى الموسم السابق مقابل متوسط الدوري داخل ذلك المستوى
  promoAttack: 0.85, // فريق صاعد (غير موجود في جدول الموسم السابق): هجوم أضعف من المتوسط
  promoDefense: 1.15, // ودفاع أضعف
  formCoef: 0, // الفورمة لم تُحسّن الدقة في الـbacktest فعُطّلت (0 = تعطيل)؛ تبقى النتائج تُعرض في التحليل
  formCap: 0.07, // أقصى تأثير للفورمة إن فُعّلت (±7%)
  spread: 1, // <1 يقلّص الفروق بين الفرق
};

// مستوى مبدئي لكل فريق من جدول الموسم السابق: ({teamId, played, gf, ga}[]) → (teamId) => {attack, defense}
export function buildPriors(prevTable) {
  const games = prevTable.reduce((s, r) => s + r.played, 0);
  const avg = games ? prevTable.reduce((s, r) => s + r.gf, 0) / games : 0;
  const w = PARAMS.prevWeight;
  const map = new Map();
  if (avg > 0) {
    for (const r of prevTable) {
      if (!r.played) continue;
      map.set(String(r.teamId), {
        attack: w * (r.gf / r.played / avg) + (1 - w),
        defense: w * (r.ga / r.played / avg) + (1 - w),
      });
    }
  }
  return (teamId) => map.get(String(teamId)) ?? { attack: PARAMS.promoAttack, defense: PARAMS.promoDefense };
}
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
  // مستوى مبدئي للفريق (نسبة إلى متوسط الدوري) من الموسم السابق إن وُجد، وإلا المتوسط نفسه
  const priorAtt = row?.prior?.attack ?? 1;
  const priorDef = row?.prior?.defense ?? 1;
  const k = row?.prior ? PARAMS.priorGamesWithPrior : PARAMS.priorGames;
  return {
    attack: ((gf + k * avgGoals * priorAtt) / (played + k) / avgGoals) ** PARAMS.spread,
    defense: ((ga + k * avgGoals * priorDef) / (played + k) / avgGoals) ** PARAMS.spread,
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
  const mult = clamp(Math.exp(PARAMS.formCoef * (ppg - base)), 1 - PARAMS.formCap, 1 + PARAMS.formCap);
  return { letters: last, ppg, mult };
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

  return {
    lamHome,
    lamAway,
    pct: { home, draw, away },
    minPlayed: Math.min(h.played, a.played),
    hasPrior: Boolean(homeRow?.prior && awayRow?.prior),
  };
}

// مع مستوى الموسم السابق يصبح التقدير جيدًا حتى في أول الموسم (انظر الـbacktest)، فترتفع الثقة
export function confidenceLevel(minPlayed, partialData, hasPrior = false) {
  if (partialData) return "low";
  if (hasPrior) return minPlayed < 4 ? "medium" : "high";
  if (minPlayed < 4) return "low";
  return minPlayed < 8 ? "medium" : "high";
}
