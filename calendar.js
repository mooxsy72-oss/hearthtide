// Hearthtide — calendar.js
// Фазы праздника и что попросить у ИИ в следующем ответе.

import { nextOccurrence, dayPart, fromDayNum } from './dates.js';
import { isKin, castBanned } from './cast.js';
import { acceptedExtras, extrasDue } from './invites.js';

// За сколько дней начинается подготовка: ИИ указывает сам для каждого праздника,
// это — запасные значения, если не указал
export const PREP_DEFAULT = { personal: 2, family: 3, fast: 1, memorial: 1, gathering: 1 };
export const PREP_DEFAULT_OTHER = 5;
export function prepWindow(state, h) {
    if (!h) return 0;
    if (h.npc) return h.prep ?? 1;
    if (h.birthday) return state.birthdays?.[h.who]?.prep ?? PREP_DEFAULT.personal;
    if (h.prep != null) return h.prep;
    return PREP_DEFAULT[h.type] ?? PREP_DEFAULT_OTHER;
}

/** Камерный праздник (личный, семейный) или общий — от этого зависит масштаб подготовки */
export function isIntimate(h) {
    return !!h && (h.birthday || h.type === 'personal' || h.type === 'family');
}

/** Ключи названия для запрета: основное название и то, что в скобках */
export function banKeys(name) {
    const n = String(name || '').toLowerCase().replace(/ё/g, 'е');
    const main = n.replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\d]+/gu, ' ').trim();
    const alts = [...n.matchAll(/\(([^)]*)\)/g)].map(m => m[1].replace(/[^\p{L}\d]+/gu, ' ').trim());
    return [main, ...alts].filter(k => k.length >= 3);
}

/** Запрещён ли праздник (пользователь удалил его из списка) */
export function isBanned(state, name) {
    const banned = state.banned || [];
    if (!banned.length) return false;
    const keys = banKeys(name);
    return keys.some(k => banned.some(b => keysMatch(k, b)));
}

/**
 * Один и тот же праздник под чуть другим названием (опечатка, скобки, лишнее слово) — или уже другой.
 * Раньше хватало совпадения первых шести букв: «День рождения Егора» и «День рождения Ани», «Поездка на дачу»
 * и «Поездка в город» считались одним праздником, и второй повод молча пропадал. Теперь каждое значимое слово
 * короткого названия должно найтись в длинном (по основе), а число в названии — совпасть.
 */
const nameWords = (k) => k.split(' ').filter(w => w.length >= 3 || /\d/.test(w)).map(w => (/\d/.test(w) ? w : w.slice(0, Math.min(5, w.length))));
function keysMatch(k, x) {
    if (k === x) return true;
    const A = nameWords(k), B = nameWords(x);
    if (!A.length || !B.length) return false;
    const [s, l] = A.length <= B.length ? [A, B] : [B, A];
    // одно слово против одного — опечатка в длинном слове («Масленица» / «Масленница»)
    if (s.length === 1 && l.length === 1) return s[0] === l[0] || (k.length >= 6 && x.length >= 6 && k.slice(0, 6) === x.slice(0, 6));
    // лишнее слово — только после: «Поездка» и «Поездка на дачу» — одно; «Новый год» и «Старый Новый год» — разное
    return s.every(w => l.includes(w)) && (s.length === l.length || l[0] === s[0]);
}
export function namesMatch(a, b) {
    const A = banKeys(a), B = banKeys(b);
    if (!A.length || !B.length) return false;
    return A.some(k => B.some(x => keysMatch(k, x)));
}

// общие слова в названиях поводов — по ним разные собрания не путаем
const GENERIC_WORD = /^(день|дня|рожд|именин|birth|праздн|вечер|торже|отмеч|посид|тусов|встреч|собра|компа|отдел|колле|друзе|семей|party|celeb|eveni|gathe|night|meeti)/;
/**
 * Тот же повод под другим названием — для поводов почти в тот же день: «День юриста» и «Празднование Дня юриста»,
 * «Посиделки в честь Дня юриста». Хватает одного общего значимого слова (не «день», «праздник», «вечер»…);
 * namesMatch тут строг: лишнее слово впереди и другой падеж («Дня») делали их разными праздниками.
 */
export function sameOccasion(a, b) {
    if (namesMatch(a, b)) return true;
    const words = (t) => new Set(String(t || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\d]+/u)
        .filter(w => w.length >= 4 && !GENERIC_WORD.test(w)).map(w => w.slice(0, 5)));
    const B = words(b);
    for (const w of words(a)) if (B.has(w)) return true;
    return false;
}

export function holidayId(h) {
    if (h.npc) return `bday-npc-${h.cid}@${h.start}`;
    if (h.extra) return `x-${h.xid}`;
    if (h.birthday) return `bday-${h.who}-${h.start}`;
    return `${String(h.name).toLowerCase().replace(/\s+/g, '-').slice(0, 40)}@${h.start}`;
}

// ─── День рождения человека из истории — свой, небольшой праздник ───
// Появляется, только когда именинник (или кто-то от него) позвал и игрок принял приглашение (invites.js).
// Пока не звали — праздника нет, даже у родни: модель не должна «сходить» туда раньше приглашения.
export const NPC_BD_AHEAD = 30;
export const npcBdKey = (cid, start) => `${cid}@${start}`;
export function npcBdOn(state, c, start) {
    if (!c?.id || !c.bday || c.off || (c.name && castBanned(state, c.name))) return false;
    return state.bdDecisions?.[npcBdKey(c.id, start)] === 'accepted';
}
export function npcHoliday(c, start) {
    const h = { start, days: 1, name: c.name || c.toU || c.toC || '?', who: `npc:${c.id}`, npc: true, cid: c.id,
        birthday: true, type: 'personal', prep: isKin(c.group) ? 2 : 1 };
    h.id = holidayId(h);
    return h;
}
/**
 * Подарок имениннику от {{char}} и {{user}}: общий или каждый свой.
 * Выбрал игрок — так и есть; иначе общий, если они пара (романтика от 30) или это их общая семья.
 */
export const GIFT_JOINT_ROM = 30;
export function giftJoint(state, h) {
    if (!h?.npc) return false;
    const m = state.giftMode?.[h.id];
    if (m) return m === 'joint';
    const c = (state.cast || []).find(x => x.id === h.cid);
    return (state.pair?.r ?? 0) >= GIFT_JOINT_ROM || c?.group === 'kin_both';
}

/** Дни рождения людей истории, которые отмечаются: вчерашний (для «после») и ближайший */
export function npcBirthdays(state) {
    if (state.today == null) return [];
    const out = [];
    for (const c of state.cast || []) {
        if (!c?.bday) continue;
        for (const from of [state.today - 1, state.today]) {
            const start = nextOccurrence({ m: c.bday.m, d: c.bday.d }, from);
            if (start - state.today > NPC_BD_AHEAD || !npcBdOn(state, c, start)) continue;
            let h = npcHoliday(c, start);
            // история отменила — дня рождения нет; перенесла — тот же человек, другой день (а могли перенести и ещё раз)
            for (let off = state.cancelled?.[h.id], i = 0; h && off && i < 4; off = h && state.cancelled?.[h.id], i++) {
                h = off.how === 'moved' && off.to != null && off.to >= state.today - 1 ? { ...npcHoliday(c, off.to), movedFrom: h.movedFrom || h.id } : null;
            }
            if (h && !out.some(x => x.id === h.id)) out.push(h);
        }
    }
    return out;
}

/** Праздники из календаря + ближайшие дни рождения, по порядку */
export function allHolidays(state) {
    const off = state.cancelled || {};
    const list = (state.holidays || []).filter(h => !isBanned(state, h.name)).map(h => ({ ...h, id: holidayId(h) })).filter(h => !off[h.id]);
    if (state.today != null) {
        for (const who of ['user', 'char']) {
            const md = state.birthdays?.[who];
            if (!md || state.birthdayOff?.[who]) continue;
            // и прошедший вчера (для «после»), и ближайший
            for (const from of [state.today - 1, state.today]) {
                const start = nextOccurrence(md, from);
                const h = { start, days: 1, name: null, who, birthday: true, type: 'personal' };
                h.id = holidayId(h);
                if (!off[h.id] && !list.some(x => x.id === h.id)) list.push(h);
            }
        }
        for (const h of npcBirthdays(state)) if (!list.some(x => x.id === h.id)) list.push(h);
        for (const h of acceptedExtras(state)) if (!list.some(x => x.id === h.id)) list.push(h);
        // повод из истории — то же, что принятое приглашение (помощник заносил его, пока это не сверялось): не дублируем
        const invited = list.filter(h => h.extra || h.npc);
        if (invited.length) for (let i = list.length - 1; i >= 0; i--) {
            const h = list[i];
            if (h.story && invited.some(x => Math.abs(x.start - h.start) <= 1 && sameOccasion(x.name, h.name))) list.splice(i, 1);
        }
    }
    return list.sort((a, b) => a.start - b.start);
}

const endOf = (h) => h.start + h.days - 1;

/**
 * Что сейчас в календаре.
 * kind: none | far | prep | today | after
 */
/**
 * Выходные подряд («новогодние каникулы», «майские») — не праздник, а фон: главным они не становятся,
 * иначе восемь дней подряд модель слышит «сегодня праздник, следуй распорядку».
 */
export const isBreak = (h) => !!h && (h.days || 1) >= 3 && !h.birthday && !h.npc && !h.extra && !h.story
    && /каникул|выходные дни|нерабоч|праздничные дни|майские|days off|holiday break|bank holiday/i.test(String(h.name || ''));

export function phaseOf(state) {
    const today = state.today;
    if (today == null) return { kind: 'none', upcoming: [] };
    const list = allHolidays(state).filter(h => !isBreak(h));
    const upcoming = list.filter(h => h.start > today);
    const active = pickActive(state, list.filter(h => today >= h.start && today <= endOf(h)));
    const ended = list.find(h => endOf(h) === today - 1 && !state.recapDone?.[h.id]);

    if (active) {
        return { kind: 'today', h: active, dayIndex: today - active.start + 1, upcoming, ended: null };
    }
    // готовятся к тому, чьё окно подготовки уже открыто — даже если раньше него стоит чей-то день рождения
    const inPrep = upcoming.find(x => x.start - today <= prepWindow(state, x));
    const next = inPrep || upcoming[0] || null;
    const daysTo = next ? next.start - today : null;
    const base = { h: next, daysTo, upcoming, ended: ended || null };
    if (ended) return { kind: 'after', ...base };
    if (!next) return { kind: 'none', ...base };
    return { kind: inPrep ? 'prep' : 'far', ...base };
}

/**
 * В один день несколько праздников (масленичная неделя и 23 февраля): главный — тот, что празднуют в ролплее
 * (state.focusHid — по истории), иначе тот, чей это единственный или первый день, а не «день 2 из 7».
 */
/**
 * Порядок: сначала праздники календаря и дни рождения {{user}} и {{char}}, потом поводы из истории,
 * и только потом встречи и приглашения (чужой день рождения, собрание) — они уходят в «Тоже».
 */
export const occTier = (h) => (h.npc || h.extra ? 2 : h.story ? 1 : 0);
export function pickActive(state, actives) {
    if (actives.length <= 1) return actives[0] || null;
    const top = Math.min(...actives.map(occTier));
    const pool = actives.filter(h => occTier(h) === top);
    const f = pool.find(h => h.id === state.focusHid);
    if (f) return f;
    const today = state.today;
    const rank = (h) => (h.days === 1 ? 0 : h.start === today ? 1 : 2);
    return [...pool].sort((a, b) => rank(a) - rank(b) || a.days - b.days || b.start - a.start)[0];
}
export const activeOccasions = (state) => (state.today == null ? [] : allHolidays(state).filter(h => state.today >= h.start && state.today <= endOf(h)));

/**
 * Что сейчас готовится — несколько поводов сразу: идущий сегодня, те, чьё окно подготовки открыто,
 * и всё, на что игрок уже согласился (приглашение, повод из истории), — за три недели.
 * Раньше следили только за одним праздником: принятый второй вытеснял первый, и его подготовка терялась.
 */
export const TRACK_AHEAD = 21;
export const TRACK_MAX = 4;
export function trackedOccasions(state) {
    const today = state.today;
    if (today == null) return [];
    const out = [];
    for (const h of allHolidays(state)) {
        if (h.start + h.days - 1 < today) continue;
        const d = h.start - today;
        const chosen = h.npc || h.extra || h.story;            // позвали и игрок принял, или повод из самой истории
        if (d <= 0 || d <= prepWindow(state, h) || (chosen && d <= TRACK_AHEAD) || (h.birthday && !h.npc && d <= 7)) out.push(h);
        if (out.length >= TRACK_MAX) break;
    }
    return out;
}

/**
 * Можно ли подталкивать мир к этому поводу (BEAT, «пусть подготовка покажется», кто-то заходит).
 * Отслеживаем принятое приглашение за три недели — но только чтобы записывать сделанное по истории.
 * Толкать к нему — лишь в окне подготовки (у встреч и приглашений — за пару дней) и в сам день:
 * иначе посиделки в кафе через две недели всплывали почти в каждом ответе.
 */
export const GATHER_PUSH = 2;
export function pushable(state, h) {
    if (!h || state.today == null) return false;
    const d = h.start - state.today;
    if (h.start + h.days - 1 < state.today) return false;
    if (d <= 0) return true;
    if (h.npc || h.extra || h.story) return d <= Math.max(prepWindow(state, h), GATHER_PUSH);
    return d <= prepWindow(state, h) || (h.birthday && d <= 7);
}
/** Отслеживаемое, к которому сейчас можно подталкивать */
export const pushTracked = (state) => trackedOccasions(state).filter(h => pushable(state, h));
/** Сколько ответов минимум между двумя подталкиваниями (BEAT, упоминание, кто-то заходит) */
export const PUSH_GAP = { today: 2, other: 3 };

/**
 * Что из отслеживаемого показывать как «готовятся»: у кого открыто окно подготовки или к кому история уже готовится
 * (есть сделанное, подарок). Принятое приглашение через две недели без единого шага — это «Дальше», а не «готовятся».
 * Идущее сегодня — тоже не «готовятся»: это «Сегодня также».
 */
export function preparingNow(state, h) {
    const d = h.start - state.today;
    if (d <= 0) return false;
    if (d <= prepWindow(state, h)) return true;
    const r = state.ready?.[h.id];
    return !!(r?.sum || r?.log?.length || Object.keys(r?.gifts || {}).length || state.charGifts?.[h.id]?.text || state.userGift?.[h.id]?.text);
}

/** Подарок {{char}} к этому празднику (у каждого праздника — свой) */
export const charGiftOf = (state, hid) => (hid ? state.charGifts?.[hid] || null : null);

/** Этот праздник в текущем году уже прошёл — повторно не предлагаем; в следующем году — снова можно */
export function passedThisYear(state, name, start) {
    const log = state.yearLog;
    if (!log || !name) return false;
    const { y } = fromDayNum(start);
    // тот же праздник недавно — но 31 декабря после 1 января того же года уже другой Новый год
    return y === log.y && (log.items || []).some(i => !i.birthday && i.name && Math.abs(i.start - start) <= 120 && namesMatch(i.name, name));
}

/** Нужен ли календарь: нет эпохи, нет даты или впереди меньше двух праздников */
export function needsCalendar(state) {
    if (state.forceCal || !state.setting?.era || state.today == null) return true;
    // Эпоха без единого слова («6658, 1150-12-05») — просим описать её словами
    if (!/\p{L}{3,}/u.test(state.setting.era)) return true;
    const ahead = (state.holidays || []).filter(h => h.start + h.days - 1 >= state.today && !isBanned(state, h.name));
    return ahead.length < 2;
}

// ═══ Отдельный запрос (API) ═══
// Основная модель пишет только дату и время; всё остальное собирает отдельный запрос
// по истории. Здесь — что в нём спросить и когда его отправлять.

/** Что спросить в отдельном запросе после этого ответа. Статус ивента пишет основная модель в своём теге. */
export function sideNeeds(state, phase) {
    const n = new Set();
    const turn = state.turn || 0;
    if (phase.kind === 'after' && phase.ended && !state.recapDone?.[phase.ended.id]) n.add('recap');
    if (needsCalendar(state)) n.add('cal');
    const h = phase.h;
    const active = (phase.kind === 'prep' || phase.kind === 'today') && h;
    if (phase.kind === 'prep' && h) {
        const p = state.prep;
        if (!p || p.hid !== h.id || p.day !== state.today || turn - (p.turn ?? -99) >= SIDE_EVERY.prep) n.add('prep');
        n.add('people');
    }
    if (phase.kind === 'today' && h) {
        const key = `${h.id}#${phase.dayIndex}`;
        const part = dayPart(state.clock);
        if (!state.days?.[key]) n.add('day');
        else if (part && state.planPart?.[key] && state.planPart[key] !== part) n.add('replan');
        else n.add('plancheck');       // история могла уйти от плана раньше смены части суток
        n.add('people');
        const ev = openEvent(state, h.id);
        if (ev?.kind === 'party' && ev.status === 'joined') n.add('moments');
    }
    if (active && !h.birthday && !state.giftTo?.[h.id] && state.gifts?.[h.id]) n.add('giftto');
    // подготовка по истории: что сделано, подарки, отменили ли — для всех праздников, которые сейчас готовятся
    if (trackedOccasions(state).length) n.add('ready');
    // подсказка миру — только когда к поводу можно подталкивать: идущий, окно подготовки, далёкий праздник календаря;
    // принятая встреча через неделю записывается (ready), но не подталкивается
    const chosenH = !!(h && (h.npc || h.extra || h.story));
    if ((active && pushable(state, h)) || (phase.kind === 'far' && h && !chosenH && phase.daysTo <= 14) || pushTracked(state).length) n.add('beat');
    if ((state.holidays || []).some(x => x.needMeaning && !isBanned(state, x.name))) n.add('mean');
    n.add('new');   // поводы из истории ищем при каждом запросе — это почти ничего не стоит
    n.add('cast');  // новые люди истории и перемены в отношениях — тоже
    if (extrasDue(state)) n.add('extras');
    // сегодня несколько праздников — какой из них празднуют в истории
    if (activeOccasions(state).length > 1) n.add('focus');
    // таймскип перепрыгнул принятое приглашение — пришли ли туда
    if ((state.skipAsk || []).length) n.add('went');
    // перепись: изредка — по большому окну сообщений, сначала родня обеих сторон и те, кого чаще называют
    const sinceCensus = turn - (state.lastCensusTurn ?? -99);
    if (sinceCensus >= CENSUS_EVERY || ((state.cast || []).length < 3 && sinceCensus >= 6)) n.add('census');
    // пара {{char}} и {{user}}: не ясна — начальные значения по карточке и персоне; ясна — обновить, если изменилась
    n.add('bond');
    // мысль {{char}} о празднике и его подарок — тоже помощник, основная модель только пишет историю
    if (charDue(state, phase)) n.add('char');
    // свой подарок {{user}} имениннику — из его же слов
    if (h?.npc && (phase.kind === 'prep' || phase.kind === 'today') && !state.userGift?.[h.id]?.done && !giftJoint(state, h)) n.add('ugift');
    // свидание: заметить, если история сама к нему пришла (предлагает его основная модель — прямо в ответе)
    const ds = state.date?.status;
    if (!state.dateRoll && (!state.date || ds === 'ended' || ds === 'missed')) n.add('datewatch');
    // ход свидания, его начало и итог — отдельным коротким запросом каждый ответ (runDateSide), не здесь
    // приглашение пришло от основной модели — помощник проверяет, что позвали вслух, а не только подумали
    // кубик выпал — план свидания составляет помощник: по карточке, персоне, лорбуку и истории
    if (state.dateRoll && !state.datePlan && !['active', 'offered', 'scheduled', 'pending'].includes(ds)) n.add('dateplan');
    // выпал шанс ивента — что именно случится, придумывает помощник (основная модель абстрактную просьбу пропускает)
    if (state.evRoll && !state.evPlan) n.add('evplan');
    return n;
}

/** Как часто ходит отдельный запрос (в ответах бота): в праздник чаще, издали реже */
export const SIDE_EVERY = { prep: 3, today: 2, far: 5 };
/** Перепись людей истории — раз в столько ответов; сколько сообщений она читает */
export const CENSUS_EVERY = 15;
export const CENSUS_DEPTH = 30;

/** Отправлять ли отдельный запрос после этого ответа */
export function sideDue(state, phase, needs) {
    // то, без чего инфоблок пустой или неверный, — сразу
    if (['recap', 'cal', 'mean', 'day', 'replan', 'census', 'date', 'daterecap', 'dateplan', 'evplan', 'went'].some(k => needs.has(k))) return true;
    // пара ещё не ясна — спросить сразу, но не чаще раза в 5 ответов, если помощник её не дал
    if (needs.has('bond') && !state.pair && (state.turn || 0) - (state.bondSide ?? -99) >= 5) return true;
    const since = (state.turn || 0) - (state.lastSideTurn ?? -99);
    // чем ближе ближайший из готовящихся праздников, тем чаще помощник читает историю (за пару дней — через ответ)
    const near = trackedOccasions(state).reduce((m, x) => Math.min(m, Math.max(0, x.start - state.today)), 99);
    if (since >= readyEvery(near)) return true;
    if (phase.kind === 'prep') return needs.has('prep') || since >= SIDE_EVERY.prep;   // новый день — тоже
    if (phase.kind === 'today') return since >= SIDE_EVERY.today;
    return since >= SIDE_EVERY.far;
}

/** Как часто читать подготовку по истории: сегодня и за 3 дня — через ответ, за неделю — раз в 3, дальше — раз в 4 */
export function readyEvery(daysTo) {
    if (daysTo == null || daysTo >= 99) return 99;
    if (daysTo <= 3) return 2;
    if (daysTo <= 7) return 3;
    if (daysTo <= 14) return 4;
    return 6;
}

/** Как часто упоминать подготовку: чем ближе праздник, тем чаще (в ответах) */
export function mentionEvery(daysTo) {
    if (daysTo == null) return 99;
    if (daysTo >= 14) return 7;      // долгая подготовка (Новый год за месяц) — изредка
    if (daysTo >= 5) return 4;
    if (daysTo >= 2) return 3;
    return 2;
}

/** Предполагает ли праздник подарки: день рождения — всегда, остальное отмечает ИИ */
export function hasGifts(state, h) {
    if (!h) return false;
    if (h.birthday) return true;
    return state.gifts?.[h.id] === true;
}

/** Нужно ли в этом ответе обновить мысль/действие персонажа: зависит от важности праздника для него */
export function charDue(state, phase) {
    if (!phase.h || (phase.kind !== 'prep' && phase.kind !== 'today')) return false;
    const care = state.care?.[phase.h.id];
    // мысль — не в каждом ответе: важный праздник — раз в 2 ответа, обычный — раз в 4
    const every = care === 'high' ? 2 : care === 'normal' ? 4 : 0;
    if (every) {
        const cur = state.charNow?.hid === phase.h.id ? state.charNow : null;
        return !cur || (state.turn || 0) - (cur.turn || 0) >= every;
    }
    return false;
}

/** Ивент, который сейчас в игре (или приглашение, на которое ещё не ответили) */
export const OPEN_STATUSES = ['active', 'invited', 'joined'];
export function openEvent(state, hid) {
    return (state.evts || []).find(e => e.hid === hid && OPEN_STATUSES.includes(e.status)) || null;
}
/** Ивент, предложенный игроку и ждущий решения (кнопки «Принять» / «Отклонить») */
export function offeredEvent(state) {
    return (state.evts || []).find(e => e.status === 'offered') || null;
}
/** Шанс случайного ивента после ответа, в процентах (по умолчанию; меняется в настройках).
 *  Ивенты — только на идущих мероприятиях: праздник в сам день, день рождения, свидание */
export const EVENT_CHANCE_DEFAULT = 20;
export const EVENT_COOLDOWN = 3;

/** Сколько часов до намеченного свидания (отрицательное — срок прошёл); null — неизвестно */
export function dateHoursLeft(state) {
    const at = state.date?.at;
    if (!at || state.today == null) return null;
    const day = at.day ?? state.today;
    return (day - state.today) * 24 + (at.clock ?? 18) - (state.clock ?? 12);
}
