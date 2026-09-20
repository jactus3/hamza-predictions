// agent/backtest.mjs
//
// Backtest للنموذج على نتائج تاريخية حقيقية (football-data.co.uk، مجاني، مع أسعار المراهنات).
// walk-forward: كل مباراة تُتوقَّع بما كان معروفًا قبلها فقط (ترتيب الموسم حتى ذلك اليوم)،
// تمامًا كما يعمل الوكيل فعليًا، ثم تُقارن بالنتيجة الفعلية وبسعر المراهنات كمعيار مرجعي.
//
// الاستخدام:  node agent/backtest.mjs <مجلد-CSV>
//   الملفات: <موسم>-<دوري>.csv  مثل 2425-E0.csv (حمّلها من https://www.football-data.co.uk/data.php)
//   البحث عن أفضل المعاملات يتم على الموسم الأول فقط، والتقييم النهائي على الموسم الثاني.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PARAMS, buildPriors, formFromResults, leagueAverages, outcomeProbabilities, predict } from "./lib/model.mjs";

function loadCsv(file) {
  const [head, ...lines] = readFileSync(file, "utf-8").replace(/^﻿/, "").trim().split(/\r?\n/);
  const cols = head.split(",");
  const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
  const out = [];
  for (const line of lines) {
    const f = line.split(",");
    if (!f[ix.FTR] || f[ix.FTHG] === "") continue;
    const [dd, mm, yy] = f[ix.Date].split("/");
    const date = Date.UTC(yy.length === 2 ? 2000 + +yy : +yy, +mm - 1, +dd);
    const num = (c) => (ix[c] !== undefined && f[ix[c]] !== "" ? Number(f[ix[c]]) : null);
    const oh = num("AvgH") ?? num("B365H");
    const od = num("AvgD") ?? num("B365D");
    const oa = num("AvgA") ?? num("B365A");
    out.push({ date, home: f[ix.HomeTeam], away: f[ix.AwayTeam], hg: +f[ix.FTHG], ag: +f[ix.FTAG], odds: oh && od && oa ? { oh, od, oa } : null });
  }
  return out.sort((a, b) => a.date - b.date);
}

const newRow = (name) => ({ teamId: name, name, played: 0, points: 0, gf: 0, ga: 0, home: { played: 0, gf: 0, ga: 0 }, away: { played: 0, gf: 0, ga: 0 } });

function runSeason(matches, priorOf = null) {
  const rows = new Map();
  const forms = new Map(); // آخر النتائج، الأحدث أولًا
  const get = (n) => rows.get(n) ?? rows.set(n, { ...newRow(n), ...(priorOf ? { prior: priorOf(n) } : {}) }).get(n);
  const records = [];
  const freq = { H: 0, D: 0, A: 0, n: 0 };

  for (const m of matches) {
    const h = get(m.home);
    const a = get(m.away);
    const lg = leagueAverages([...rows.values()]);
    const hf = formFromResults(forms.get(m.home) ?? [], h.played ? h.points / h.played : null);
    const af = formFromResults(forms.get(m.away) ?? [], a.played ? a.points / a.played : null);
    const pred = predict(h, a, lg, { homeForm: hf.mult, awayForm: af.mult });
    const p = outcomeProbabilities(pred.lamHome, pred.lamAway);
    const outcome = m.hg > m.ag ? "H" : m.hg < m.ag ? "A" : "D";

    let book = null;
    if (m.odds) {
      const s = 1 / m.odds.oh + 1 / m.odds.od + 1 / m.odds.oa;
      book = { home: 1 / m.odds.oh / s, draw: 1 / m.odds.od / s, away: 1 / m.odds.oa / s };
    }
    const base = freq.n >= 30 ? { home: freq.H / freq.n, draw: freq.D / freq.n, away: freq.A / freq.n } : { home: 0.44, draw: 0.25, away: 0.31 };
    records.push({ p, outcome, minPlayed: Math.min(h.played, a.played), book, base });

    // تحديث الحالة بعد المباراة
    freq[outcome]++; freq.n++;
    h.played++; a.played++; h.gf += m.hg; h.ga += m.ag; a.gf += m.ag; a.ga += m.hg;
    h.home.played++; h.home.gf += m.hg; h.home.ga += m.ag;
    a.away.played++; a.away.gf += m.ag; a.away.ga += m.hg;
    if (outcome === "H") h.points += 3; else if (outcome === "A") a.points += 3; else { h.points++; a.points++; }
    const push = (n, l) => forms.set(n, [l, ...(forms.get(n) ?? [])]);
    push(m.home, outcome === "H" ? "W" : outcome === "D" ? "D" : "L");
    push(m.away, outcome === "A" ? "W" : outcome === "D" ? "D" : "L");
  }
  return { records, rows };
}

const key = { H: "home", D: "draw", A: "away" };

function metrics(records, pick = (r) => r.p) {
  let brier = 0, ll = 0, hit = 0;
  for (const r of records) {
    const p = pick(r);
    for (const o of ["H", "D", "A"]) brier += (p[key[o]] - (o === r.outcome ? 1 : 0)) ** 2;
    ll += -Math.log(Math.max(1e-9, p[key[r.outcome]]));
    const top = p.home >= p.draw && p.home >= p.away ? "H" : p.away >= p.draw ? "A" : "D";
    if (top === r.outcome) hit++;
  }
  const n = records.length;
  return { n, brier: brier / n, logloss: ll / n, accuracy: hit / n };
}

const fmt = (m) => `Brier ${m.brier.toFixed(4)} | LogLoss ${m.logloss.toFixed(4)} | دقة الاختيار الأول ${(m.accuracy * 100).toFixed(1)}% (n=${m.n})`;

const dir = process.argv[2];
if (!dir) { console.error("usage: node agent/backtest.mjs <csv-dir>"); process.exit(1); }
const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
const seasons = [...new Set(files.map((f) => f.split("-")[0]))].sort();
const leagues = [...new Set(files.map((f) => f.split("-")[1].replace(".csv", "")))];
const [s0, trainSeason, testSeason] = seasons; // s0 يُستخدم كمستوى مبدئي لموسم الضبط، وtrain كمستوى مبدئي لموسم الاختبار

const csvCache = new Map();
const csv = (s, l) => { const k = s + l; if (!csvCache.has(k)) csvCache.set(k, loadCsv(path.join(dir, `${s}-${l}.csv`))); return csvCache.get(k); };

const PROD = { ...PARAMS }; // القيم الافتراضية في الإنتاج
const LEGACY = { ...PARAMS, formCoef: 0.08 }; // النسخة الأولى: بلا مستوى سابق وبفورمة

// يشغّل موسمًا كاملًا لكل الدوريات؛ prev = موسم المستوى المبدئي (أو null لتعطيله)
function season(s, prev, params) {
  Object.assign(PARAMS, params);
  return leagues.flatMap((l) => {
    const priorOf = prev ? buildPriors([...runSeason(csv(prev, l)).rows.values()]) : null;
    return runSeason(csv(s, l), priorOf).records;
  });
}
const withBook = (rs) => rs.filter((r) => r.book);

console.log(`=== ضبط المعاملات على موسم ${trainSeason} فقط (مستوى مبدئي من ${s0}) ===`);
let best = null;
for (const priorGamesWithPrior of [8, 12, 16, 24]) {
  for (const prevWeight of [0.7, 0.85, 1]) {
    for (const spread of [1, 0.9]) {
      for (const formCoef of [0, 0.08]) {
        const params = { ...PROD, priorGamesWithPrior, prevWeight, spread, formCoef };
        const m = metrics(season(trainSeason, s0, params));
        if (!best || m.brier < best.m.brier) best = { params, m };
      }
    }
  }
}
const pick = ({ priorGamesWithPrior, prevWeight, spread, formCoef }) => ({ priorGamesWithPrior, prevWeight, spread, formCoef });
console.log("الأفضل:", JSON.stringify(pick(best.params)), "→", fmt(best.m));
console.log("المعتمد في الإنتاج:", JSON.stringify(pick(PROD)));

console.log(`\n=== تقييم على موسم ${testSeason} (لم يُستخدم في الضبط؛ مستوى مبدئي من ${trainSeason}) ===`);
const legacy = season(testSeason, null, LEGACY);
const prod = season(testSeason, trainSeason, PROD);
console.log("النسخة الأولى (بلا مستوى سابق):", fmt(metrics(legacy)));
console.log("الإنتاج الآن                   :", fmt(metrics(prod)));
console.log("مراجع (تكرار تاريخي)           :", fmt(metrics(prod, (r) => r.base)));
console.log("سعر المراهنات (المعيار)        :", fmt(metrics(withBook(prod), (r) => r.book)));

console.log("\n=== حسب مرحلة الموسم ===");
for (const [name, lo, hi] of [["أول 5 مباريات لكل فريق", 0, 4], ["من 5 إلى 12", 5, 12], ["بعد 12", 13, 99]]) {
  const f = (rs) => rs.filter((r) => r.minPlayed >= lo && r.minPlayed <= hi);
  console.log(name);
  console.log("   الأولى   :", fmt(metrics(f(legacy))));
  console.log("   الإنتاج  :", fmt(metrics(f(prod))));
  console.log("   المراهنات:", fmt(metrics(withBook(f(prod)), (r) => r.book)));
}

console.log("\n=== معايرة (الإنتاج): فوز الفريق المرشّح ===");
for (const [lo, hi] of [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]]) {
  const sub = prod.filter((r) => { const f = Math.max(r.p.home, r.p.away); return f >= lo && f < hi; });
  if (!sub.length) continue;
  const avgP = sub.reduce((s, r) => s + Math.max(r.p.home, r.p.away), 0) / sub.length;
  const wins = sub.filter((r) => (r.p.home >= r.p.away ? r.outcome === "H" : r.outcome === "A")).length;
  console.log(`متوقع ${(lo * 100) | 0}–${Math.min(100, (hi * 100) | 0)}%: n=${String(sub.length).padStart(4)} | متوسط المتوقع ${(avgP * 100).toFixed(1)}% | الفوز الفعلي ${((wins / sub.length) * 100).toFixed(1)}%`);
}