// Hearthtide — invites.js
// Приглашения: на день рождения человека из истории и на дополнительные праздники (собрание по работе, пир гильдии,
// бал, встреча общины — что подходит {{user}} и {{char}} по сеттингу). Праздник появляется в инфоблоке,
// только когда позвали и игрок принял.
//
// Каждый ответ — один бросок: кого из кандидатов позовут. Шанс тем выше, чем ближе день и чем ближе человек
// (у дополнительных праздников — только близость дня). Выпало — основная модель произносит приглашение в следующем
// ответе, проверка «позвали ли вслух» подтверждает, и только тогда — карточка «Принять / Отклонить».

import { nextOccurrence } from './dates.js';
import { isKin, castBanned } from './cast.js';

/** Шанс за ответ в процентах при самом близком человеке и самом близком дне */
export const INVITE_BASE = 55;
/** Насколько заранее зовут: на день рождения — до месяца, на дополнительный праздник — до трёх недель */
export const INVITE_AHEAD = { bday: 30, extra: 21 };
/** Сколько ответов ждать, пока модель произнесёт выпавшее приглашение; потом — пауза для этого человека */
export const INVITE_TRIES = 3;
export const INVITE_COOL = 10;

export const bdKey = (cid, start) => `${cid}@${start}`;
export const extraKey = (xid) => `x:${xid}`;

// чем ближе день, тем вероятнее: за месяц зовут редко, за пару дней — почти наверняка
function urgency(kind, d) {
    if (d <= 3) return 1;
    if (d <= 7) return 0.6;
    if (d <= 14) return kind === 'extra' ? 0.4 : 0.3;
    return kind === 'extra' ? 0.2 : 0.12;
}
// чем ближе человек любому из двоих, тем вероятнее позовёт; в ссоре — почти никогда
function closeness(c) {
    if (isKin(c.group)) return 1;
    const r = Math.max(c.rel?.user ?? 0, c.rel?.char ?? 0);
    if (r >= 60) return 0.9;
    if (r >= 40) return 0.7;
    if (r >= 20) return 0.45;
    if (r >= 0) return 0.2;
    return 0.04;
}

/** Слаг для id дополнительного праздника */
const slug = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);
export const extraId = (x) => `${slug(x.name)}@${x.start}`;

/**
 * Кого можно позвать сейчас: дни рождения людей истории и дополнительные праздники, по которым игрок ещё не решал.
 * all — и те, по которым решение уже есть или стоит пауза (чтобы узнать приглашение, которое прозвучало само или после свайпа)
 */
export function inviteCandidates(state, all = false) {
    const today = state.today;
    if (today == null) return [];
    const dec = state.bdDecisions || {};
    const cool = state.invCool || {};
    const out = [];
    for (const c of state.cast || []) {
        if (!c?.id || !c.bday || c.off || (c.name && castBanned(state, c.name))) continue;
        const start = nextOccurrence({ m: c.bday.m, d: c.bday.d }, today);
        const d = start - today;
        if (d > INVITE_AHEAD.bday) continue;
        const key = bdKey(c.id, start);
        if (!all && (dec[key] || (cool[key] ?? -1) > (state.turn || 0))) continue;
        const name = c.name || c.toU || c.toC;
        if (!name) continue;
        out.push({ kind: 'bday', key, cid: c.id, name, host: name, day: start, d,
            chance: Math.round(INVITE_BASE * urgency('bday', d) * closeness(c)) });
    }
    for (const x of state.extras || []) {
        const d = x.start - today;
        if (d < 0 || d > INVITE_AHEAD.extra) continue;
        const key = extraKey(x.id);
        if (!all && (dec[key] || (cool[key] ?? -1) > (state.turn || 0))) continue;
        out.push({ kind: 'extra', key, xid: x.id, name: x.name, host: x.host || null, whom: x.whom || 'both', day: x.start, d,
            chance: Math.round(INVITE_BASE * urgency('extra', d)) });
    }
    return out.sort((a, b) => b.chance - a.chance || a.d - b.d);
}

/** Праздник в календаре из принятого дополнительного праздника */
export function extraHoliday(x) {
    return { start: x.start, days: x.days || 1, name: x.name, type: 'gathering', extra: true, xid: x.id,
        host: x.host || null, whom: x.whom || 'both', meaning: x.meaning || null, prep: x.prep ?? 1, id: `x-${x.id}` };
}

/** Принятые дополнительные праздники: вчерашний (для «после») и все будущие */
export function acceptedExtras(state) {
    if (state.today == null) return [];
    const out = [];
    for (const x of state.extras || []) {
        if (state.bdDecisions?.[extraKey(x.id)] !== 'accepted') continue;
        // история отменила — праздника нет; перенесла — тот же праздник (тот же id), другой день
        const off = state.cancelled?.[`x-${x.id}`];
        if (off && off.how !== 'moved') continue;
        const start = off?.how === 'moved' && off.to != null ? off.to : x.start;
        if (start + (x.days || 1) - 1 < state.today - 1) continue;
        out.push(extraHoliday({ ...x, start }));
    }
    return out;
}

/** Новые дополнительные праздники от модели → в список: без повторов, без прошедших, не больше шести впереди */
export function mergeExtras(state, list, langOk, namesMatch, sameOccasion = null) {
    let slip = false;
    state.extras = state.extras || [];
    for (const x of list || []) {
        if (![x.name, x.host, x.meaning].every(langOk)) { slip = true; continue; }
        if (state.today != null && (x.start < state.today || x.start - state.today > 90)) continue;
        if (/(день\s*рожд|именин|birthday)/i.test(x.name)) continue;          // дни рождения считаются отдельно
        if (state.extras.some(y => namesMatch(y.name, x.name) && Math.abs(y.start - x.start) <= 7)) continue;
        if ((state.holidays || []).some(h => namesMatch(h.name, x.name) && Math.abs(h.start - x.start) <= 7)) continue;
        // тот же повод уже в календаре под другим названием (из истории: «День юриста» — «Празднование Дня юриста»)
        if (sameOccasion && (state.holidays || []).some(h => Math.abs(h.start - x.start) <= 1 && sameOccasion(h.name, x.name))) continue;
        // отклонённое в этом году под тем же названием — не предлагаем снова
        if ((state.offerSeen || []).some(y => namesMatch(y.name, x.name))) continue;
        const item = { ...x, id: extraId(x) };
        if (state.bdDecisions?.[extraKey(item.id)] === 'declined') continue;
        state.extras.push(item);
    }
    // прошедшие и отклонённые не копим
    state.extras = state.extras
        .filter(x => state.today == null || (state.cancelled?.[`x-${x.id}`]?.to ?? x.start) + (x.days || 1) - 1 >= state.today - 7)
        .filter(x => state.bdDecisions?.[extraKey(x.id)] !== 'declined')
        .sort((a, b) => a.start - b.start).slice(0, 8);
    return slip;
}

/** Нужно ли подобрать дополнительные праздники: впереди нет ни одного нерешённого, давно не спрашивали */
export function extrasDue(state) {
    if (state.today == null || !state.setting?.era) return false;
    if ((state.turn || 0) - (state.lastExtrasTurn ?? -99) < 25) return false;
    return !(state.extras || []).some(x => x.start >= state.today && !state.bdDecisions?.[extraKey(x.id)]);
}
