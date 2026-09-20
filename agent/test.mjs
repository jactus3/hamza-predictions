// agent/test.mjs — اختبارات بلا شبكة:  node --test agent/test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { pickCurrentType } from "./providers/espn.mjs";
import { PARAMS, buildPriors, confidenceLevel, leagueAverages, outcomeProbabilities, predict, formFromResults } from "./lib/model.mjs";
import { scoreHeadlines, parseRss, searchName } from "./lib/news.mjs";
import { buildMatch, resultsByTeam } from "./lib/build.mjs";
import { mapFixtures, mapStandings, mapResults } from "./providers/footballdata.mjs";
import { tableFromResults } from "./providers/sportsdb.mjs";
import { mapStandingEntry } from "./providers/espn.mjs";

const row = (teamId, name, played, points, gf, ga) => ({
  teamId, name, newsName: name, position: teamId, played, points, gf, ga, gd: gf - ga,
  home: { played: Math.ceil(played / 2), gf: Math.round(gf * 0.55), ga: Math.round(ga * 0.45) },
  away: { played: Math.floor(played / 2), gf: Math.round(gf * 0.45), ga: Math.round(ga * 0.55) },
});

test("الاحتمالات الثلاثية مجموعها 1 والقوي أفضل من الضعيف", () => {
  const p = outcomeProbabilities(2.2, 0.7);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
  assert.ok(p.home > p.draw && p.draw > p.away);
});

test("النموذج: فريقان متكافئان → المضيف أفضل قليلًا والتعادل ظاهر", () => {
  const table = [row(1, "A", 10, 15, 14, 10), row(2, "B", 10, 15, 14, 10)];
  const lg = leagueAverages(table);
  const r = predict(table[0], table[1], lg);
  assert.equal(r.pct.home + r.pct.draw + r.pct.away, 100);
  assert.ok(r.pct.home > r.pct.away);
  assert.ok(r.pct.draw >= 20);
});

test("فريق بلا صف في الترتيب لا يكسر الحساب", () => {
  const lg = leagueAverages([]);
  const r = predict(null, null, lg);
  assert.equal(r.pct.home + r.pct.draw + r.pct.away, 100);
  assert.equal(r.minPlayed, 0);
});

test("الأخبار السلبية تخفّض نسبة الفريق وتزيد خصمه", () => {
  const table = [row(1, "A", 10, 20, 18, 8), row(2, "B", 10, 15, 14, 10)];
  const lg = leagueAverages(table);
  const base = predict(table[0], table[1], lg);
  const hurt = predict(table[0], table[1], lg, { homeNews: { atk: 0.9, def: 1.06 } });
  assert.ok(hurt.pct.home < base.pct.home);
  assert.ok(hurt.pct.away > base.pct.away);
});

test("الفورمة: سلسلة انتصارات ترفع المعامل وسقفها محدود", () => {
  const good = formFromResults(["W", "W", "W", "W", "W"], 1.0);
  const bad = formFromResults(["L", "L", "L", "L", "L"], 2.5);
  // الفورمة معطّلة في الإنتاج (لم تُحسّن الدقة في الـbacktest): المعامل محايد
  assert.equal(good.mult, 1);
  assert.equal(bad.mult, 1);
  // ومنطقها سليم عند تفعيلها
  const saved = PARAMS.formCoef;
  PARAMS.formCoef = 0.08;
  const on = formFromResults(["W", "W", "W", "W", "W"], 1.0);
  const off = formFromResults(["L", "L", "L", "L", "L"], 2.5);
  PARAMS.formCoef = saved;
  assert.ok(on.mult > 1 && on.mult <= 1.07);
  assert.ok(off.mult < 1 && off.mult >= 0.929); // سقف السفلي 0.93 (هامش صغير لدقة الفاصلة العائمة)
  assert.equal(formFromResults(["W", "L"], 1).mult, 1);
});

test("تحليل الأخبار: إصابة نجم تُحتسب، وعنوان قديم أو لفريق آخر يُتجاهل", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  const hoursAgo = (h) => new Date(now - h * 3600e3).toUTCString();
  const rss = `<rss><channel>
    <item><title>Arsenal star ruled out for a month with hamstring injury - BBC</title><source>BBC</source><pubDate>${hoursAgo(5)}</pubDate></item>
    <item><title>Arsenal star ruled out for a month with hamstring injury - Sky</title><source>Sky</source><pubDate>${hoursAgo(6)}</pubDate></item>
    <item><title>Chelsea captain doubtful for weekend - Sky</title><source>Sky</source><pubDate>${hoursAgo(7)}</pubDate></item>
    <item><title>Arsenal midfielder suspended - Old</title><source>Old</source><pubDate>${hoursAgo(200)}</pubDate></item>
  </channel></rss>`;
  const s = scoreHeadlines(parseRss(rss), "Arsenal FC", now);
  assert.equal(s.headlines.length, 1); // المكرَّر، الفريق الآخر، والقديم كلها مستبعدة
  assert.equal(s.impact, 1.5);
  assert.ok(s.atk < 1 && s.atk >= 0.9);
  assert.equal(searchName("Manchester City FC"), "Manchester City");
});

test("الأخبار: عناوين عن الخصم أو عبارات مضللة لا تُنسب للفريق (حالات حقيقية رُصدت)", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  const t = new Date(now - 3600e3).toUTCString();
  const mk = (title) => parseRss(`<item><title>${title} - Src</title><source>Src</source><pubDate>${t}</pubDate></item>`);
  // عن الخصم: الفريق يظهر بعد العبارة
  assert.equal(scoreHeadlines(mk("Mamelodi Sundowns have full squad available for Al Ahli Intercontinental Cup tie"), "Al Ahli", now).headlines.length, 0);
  assert.equal(scoreHeadlines(mk("Sundowns midfielder passed fit ahead of Al Ahli clash"), "Al Ahli", now).headlines.length, 0);
  // "cut out for" ليست غيابًا
  assert.equal(scoreHeadlines(mk("Williams: Sundowns work cut out for Al Ahli"), "Al Ahli", now).headlines.length, 0);
  // الفريق فاعل الخبر
  assert.equal(scoreHeadlines(mk("ZED's Ahmed El Soghairy faces up to two months out with knee injury"), "ZED", now).headlines.length, 1);
  // "ضربة لـ"
  assert.equal(scoreHeadlines(mk("Injury blow for Arsenal as striker misses the derby"), "Arsenal", now).headlines.length, 1);
  // عودة لاعب = إيجابي يقلّل الأثر
  const back = scoreHeadlines(mk("Arsenal midfielder returns from injury ahead of Brighton trip"), "Arsenal", now);
  assert.equal(back.impact, 0);
});

test("football-data: TIMED مقبولة، والفرق غير المحدّدة مستبعدة", () => {
  const fx = mapFixtures([
    { id: 1, utcDate: "2026-09-21T18:00:00Z", status: "TIMED", homeTeam: { id: 10, name: "X" }, awayTeam: { id: 11, name: "Y" } },
    { id: 2, utcDate: "2026-09-21T18:00:00Z", status: "SCHEDULED", homeTeam: { id: 12, name: "Z" }, awayTeam: { id: 13, name: "W" } },
    { id: 3, utcDate: "2026-09-21T18:00:00Z", status: "SCHEDULED", homeTeam: { id: null }, awayTeam: { id: 13, name: "W" } },
    { id: 4, utcDate: "2026-09-19T18:00:00Z", status: "FINISHED", homeTeam: { id: 10, name: "X" }, awayTeam: { id: 11, name: "Y" } },
  ]);
  assert.deepEqual(fx.map((f) => f.id), [1, 2]);
});

test("football-data: دمج مجموعات البطولة + أداء المضيف/الضيف", () => {
  const t = (id, name, p, pts, gf, ga) => ({ position: 1, team: { id, name }, playedGames: p, points: pts, goalsFor: gf, goalsAgainst: ga, goalDifference: gf - ga });
  const table = mapStandings([
    { type: "TOTAL", group: "A", table: [t(1, "A1", 3, 7, 5, 1), t(2, "A2", 3, 4, 3, 3)] },
    { type: "TOTAL", group: "B", table: [t(3, "B1", 3, 9, 8, 0)] },
    { type: "HOME", group: "A", table: [t(1, "A1", 2, 6, 4, 0)] },
  ]);
  assert.equal(table.length, 3); // المجموعتان معًا
  assert.equal(table.find((r) => r.teamId === 1).home.gf, 4);
  assert.equal(table.find((r) => r.teamId === 3).home, null);
});

test("نتائج → فورمة بالترتيب الأحدث أولًا", () => {
  const res = mapResults([
    { status: "FINISHED", utcDate: "2026-09-01T00:00:00Z", homeTeam: { id: 1 }, awayTeam: { id: 2 }, score: { fullTime: { home: 2, away: 0 } } },
    { status: "FINISHED", utcDate: "2026-09-08T00:00:00Z", homeTeam: { id: 2 }, awayTeam: { id: 1 }, score: { fullTime: { home: 1, away: 1 } } },
    { status: "FINISHED", utcDate: "2026-09-15T00:00:00Z", homeTeam: { id: 1 }, awayTeam: { id: 3 }, score: { fullTime: { home: 0, away: 1 } } },
  ]);
  assert.deepEqual(resultsByTeam(res).get(1), ["L", "D", "W"]);
});

test("TheSportsDB: بناء الترتيب من النتائج", () => {
  const names = new Map([["1", "A"], ["2", "B"]]);
  const table = tableFromResults(
    [{ homeId: "1", awayId: "2", hg: 2, ag: 0 }, { homeId: "2", awayId: "1", hg: 1, ag: 1 }],
    names,
  );
  assert.equal(table[0].name, "A");
  assert.equal(table[0].points, 4);
  assert.equal(table[0].position, 1);
  assert.equal(table[1].away.played, 1);
});

test("ESPN: قراءة سجل الترتيب", () => {
  const r = mapStandingEntry(
    { records: [{ stats: [{ name: "rank", value: 1 }, { name: "gamesPlayed", value: 7 }, { name: "points", value: 18 }, { name: "pointsFor", value: 23 }, { name: "pointsAgainst", value: 5 }, { name: "homeGamesPlayed", value: 3 }, { name: "homePointsFor", value: 7 }] }] },
    "929",
    "Al Hilal",
  );
  assert.equal(r.played, 7);
  assert.equal(r.gf, 23);
  assert.equal(r.home.gf, 7);
});

test("buildMatch: سجل كامل متوافق مع الواجهة", () => {
  const table = [row(1, "Strong FC", 10, 25, 25, 6), row(2, "Weak FC", 10, 5, 6, 22)];
  const m = buildMatch({
    fx: { id: 99, utcDate: "2026-09-21T18:00:00Z", home: { id: 2, name: "Weak FC", newsName: "Weak" }, away: { id: 1, name: "Strong FC", newsName: "Strong" } },
    comp: { label: "دوري", country: "بلد" },
    rowById: new Map(table.map((r) => [String(r.teamId), r])),
    lg: leagueAverages(table),
    formResults: { get: () => [] },
    newsByName: new Map(),
    partialData: false,
  });
  assert.equal(m.teamA, "Strong FC"); // الأقوى هو المرشّح حتى لو ضيف
  assert.equal(m.venue, "away");
  assert.ok(m.prob > 50 && m.prob < 100);
  assert.equal(m.probs.home + m.probs.draw + m.probs.away, 100);
  assert.equal(m.confidence, "high");
  for (const k of ["form", "side", "goals"]) assert.ok(typeof m.analysis[k] === "string" && m.analysis[k].length > 10);
});

test("المستوى المبدئي من الموسم السابق: يفرّق بين فريق قوي وضعيف، والصاعد يبدأ أضعف من المتوسط", () => {
  const prev = [
    { teamId: 1, played: 38, gf: 80, ga: 30 }, // قوي
    { teamId: 2, played: 38, gf: 30, ga: 70 }, // ضعيف
    { teamId: 3, played: 38, gf: 50, ga: 50 },
  ];
  const priorOf = buildPriors(prev);
  assert.ok(priorOf(1).attack > 1 && priorOf(1).defense < 1);
  assert.ok(priorOf(2).attack < 1 && priorOf(2).defense > 1);
  assert.equal(priorOf(99).attack, PARAMS.promoAttack); // صاعد
  assert.ok(priorOf(99).attack < 1 && priorOf(99).defense > 1);
});

test("بداية الموسم بلا مباريات: المستوى السابق وحده يحدد التوقع (وبدونه التوقع محايد)", () => {
  const empty = (id, prior) => ({ teamId: id, played: 0, points: 0, gf: 0, ga: 0, ...(prior ? { prior } : {}) });
  const lg = leagueAverages([]);
  const neutral = predict(empty(1), empty(2), lg);
  const withPrior = predict(empty(1, { attack: 1.4, defense: 0.7 }), empty(2, { attack: 0.8, defense: 1.2 }), lg);
  assert.ok(withPrior.pct.home > neutral.pct.home + 10);
  assert.equal(withPrior.hasPrior, true);
  assert.equal(neutral.hasPrior, false);
});

test("مستوى الثقة: المستوى السابق يرفعها في أول الموسم، والبيانات الجزئية تبقيها منخفضة", () => {
  assert.equal(confidenceLevel(1, false, false), "low");
  assert.equal(confidenceLevel(1, false, true), "medium");
  assert.equal(confidenceLevel(10, false, true), "high");
  assert.equal(confidenceLevel(10, true, true), "low");
});
test("الأخبار: عناوين من رياضات أخرى تحمل اسم المدينة تُستبعد (حالة حقيقية: San Diego Padres)", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  const t = new Date(now - 3600e3).toUTCString();
  const rss = `<item><title>Padres news: San Diego pitcher gets big injury update amid playoff push - MLB.com</title><source>MLB</source><pubDate>${t}</pubDate></item>`;
  assert.equal(scoreHeadlines(parseRss(rss), "San Diego FC", now).headlines.length, 0);
});

test("ESPN: اختيار مرحلة الموسم الحالية (تحتوي اليوم، وإلا آخر ما بدأ)", () => {
  const types = [
    { id: "1", startDate: "2026-01-01T00:00Z", endDate: "2026-05-30T00:00Z", groups: ["1"] }, // Apertura منتهية
    { id: "6", startDate: "2026-07-01T00:00Z", endDate: "2026-12-15T00:00Z", groups: ["1", "2"] }, // Clausura جارية
    { id: "9", startDate: "2026-12-16T00:00Z", endDate: "2026-12-30T00:00Z", groups: [] }, // بلا مجموعات
  ];
  assert.equal(pickCurrentType(types, new Date("2026-09-20T00:00Z")).id, "6");
  assert.equal(pickCurrentType(types, new Date("2026-06-15T00:00Z")).id, "1"); // بين المرحلتين: آخر ما بدأ
  assert.equal(pickCurrentType([], new Date()), null);
});