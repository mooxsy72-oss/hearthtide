// Hearthtide — cast.js
// Люди истории: кто кому кем приходится, дни рождения, отношения с {{user}} и {{char}}.
// ИИ вносит каждого один раз; игрок может поправить или убрать — тогда ИИ его не вернёт.

import { fromDayNum, nextOccurrence } from './dates.js';

// родня {{user}} · родня {{char}} · общая семья (их дети, внуки) · друзья · знакомые · прочие
export const CAST_GROUPS = ['kin_user', 'kin_char', 'kin_both', 'friend', 'acquaintance', 'other'];
export const KIN_GROUPS = ['kin_user', 'kin_char', 'kin_both'];
export const isKin = (g) => KIN_GROUPS.includes(g) || g === 'relative';
// романтика у людей — только вручную, кнопками
export const ROM_KEYS = ['spark', 'love', 'deep', 'ex', 'hate'];

const norm = (n) => String(n || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Один и тот же человек: то же имя или одно имя целиком входит в другое («Млада» и «Млада Гордеевна») */
export function samePerson(a, b) {
    if (!a || !b) return false;
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const wx = x.split(' '), wy = y.split(' ');
    return wx[0].length >= 3 && wx[0] === wy[0] && (wx.length === 1 || wy.length === 1);
}

export const findCast = (state, name) => (state.cast || []).find(c => samePerson(c.name, name)) || null;
// «Мать Алексея», «тёща», «старший брат» — это роль, а не имя
// целое слово (иначе «Братислав» и «Sonya» становились ролями), кроме основ «старш-», «крёстн-», «grand-»
const ROLE_WORD = /^(?:(?:мать|мама|матушка|отец|папа|батюшка|тятя|брат|сестра|сын|дочь|дочка|жена|муж|тёща|теща|тесть|свекровь|свёкор|свекор|золовка|деверь|шурин|сноха|невестка|зять|дед|дедушка|бабка|бабушка|дядя|тётя|тетя|кум|кума|mother|father|mom|dad|brother|sister|son|daughter|wife|husband|aunt|uncle)(?![\p{L}])|старш|младш|крёстн|крестн|grand)/iu;
export const roleName = (n) => !!n && ROLE_WORD.test(String(n).trim());

// безымянный (имя история ещё не назвала) — узнаём по тому, кем он приходится обоим
const sameRoles = (a, b) => !!(a.toU || a.toC) && norm(a.toU) === norm(b.toU) && norm(a.toC) === norm(b.toC);
export const castBanned = (state, name) => (state.castNo || []).some(n => samePerson(n, name));

/** «21.12», «21.12.1123», «1123-12-21» → { d, m, y? } */
export function parseBday(v) {
    const s = String(v ?? '').trim();
    let m = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](-?\d{1,5}))?$/);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return { d: +m[1], m: +m[2], y: m[3] != null ? +m[3] : null };
    m = s.match(/^(-?\d{1,5})-(\d{1,2})-(\d{1,2})$/);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return { d: +m[3], m: +m[2], y: +m[1] };
    return null;
}
export const bdayText = (b) => b ? `${String(b.d).padStart(2, '0')}.${String(b.m).padStart(2, '0')}${b.y != null ? `.${b.y}` : ''}` : '';

/** Через сколько дней день рождения (0 — сегодня) */
export function bdayIn(c, today) {
    if (!c?.bday || today == null) return null;
    return nextOccurrence({ m: c.bday.m, d: c.bday.d }, today) - today;
}
/** Возраст на сегодня, если известен год */
export function ageOf(c, today) {
    if (!c?.bday || c.bday.y == null || today == null) return null;
    const { y, m, d } = fromDayNum(today);
    const age = y - c.bday.y - ((m < c.bday.m || (m === c.bday.m && d < c.bday.d)) ? 1 : 0);
    return age >= 0 && age < 200 ? age : null;
}

/** Отношения −100…100 (0 — ровно; ниже нуля — плохие) → ступень для подписи, если ИИ не дал своих слов */
export function relLevel(n) {
    if (n == null) return null;
    if (n <= -60) return 'enmity';
    if (n <= -25) return 'conflict';
    if (n < -5) return 'cool';
    if (n <= 10) return 'neutral';
    if (n <= 50) return 'warm';
    return 'close';
}
const clampRel = (v) => { const n = parseInt(v); return isNaN(n) ? null : Math.max(-100, Math.min(100, n)); };
export { clampRel };

/** Романтика −100…100 → ступень */
export function romLevel(n) {
    if (n == null) return null;
    if (n <= -50) return 'hate';
    if (n < 0) return 'cold';
    if (n === 0) return 'none';
    if (n <= 30) return 'spark';
    if (n <= 65) return 'love';
    return 'deep';
}

/** Образец вместо значения («NAME», «<name>», «TO_USER») */
const STUB = /^(name|имя|group|to[_ ]?user|to[_ ]?char|birthday|with[_ ]?user|with[_ ]?char|how[_ ]?user|how[_ ]?char|<.*>|\?+)$/i;
/** «никто», «нет», «—» в роли — значит связи нет: пустое поле */
const NO_TIE = /^(никто|никем|нет|не родня|чужой|чужая|none|nobody|no one|no tie|n\/a|—|-)$/i;
export const tieOf = (v) => (v && !NO_TIE.test(String(v).trim()) ? v : null);

/** Разобранный HT-CAST → в состояние. Новых — добавить, известных — дополнить пустое и обновить отношения. */
export function mergeCast(state, parsed, langOk, turn, log = null) {
    if (!parsed) return false;
    let slip = false;
    state.cast = state.cast || [];
    const why = (c, w) => log?.push(`${c.name || c.toU || c.toC || '?'} — ${w}`);
    for (const c of parsed.add) {
        // имя бывает на любом языке; описания не на том языке — убираем, а человека всё равно вносим
        for (const k of ['toU', 'toC', 'noteU', 'noteC']) if (c[k] && !langOk(c[k])) { c[k] = null; slip = true; }
        c.toU = tieOf(c.toU); c.toC = tieOf(c.toC);
        if (roleName(c.name)) c.name = null;          // роль вместо имени — считаем безымянным
        if (c.name && castBanned(state, c.name)) { why(c, 'убран игроком'); continue; }
        // тот же человек: по имени — или безымянный с теми же ролями, которому теперь дали имя
        const ex = (c.name && findCast(state, c.name)) || state.cast.find(x => (!x.name || !c.name) && sameRoles(x, c));
        if (ex) {
            if (!ex.edited) {
                if (!ex.name && c.name) ex.name = c.name;
                if (!ex.toU && c.toU) ex.toU = c.toU;
                if (!ex.toC && c.toC) ex.toC = c.toC;
                if (!ex.bday && c.bday) ex.bday = c.bday;
                if (c.group && (ex.group === 'other' || ex.group === 'relative')) ex.group = c.group;
                // общий ребёнок, которого раньше записали в родню одной стороны
                else if (c.group === 'kin_both' && (ex.group === 'kin_user' || ex.group === 'kin_char')) ex.group = 'kin_both';
            }
            why(c, `уже есть (${ex.name || ex.toU || '?'})`);
            continue;
        }
        why(c, 'добавлен');
        state.cast.push({
            id: `c-${turn}-${state.cast.length}-${Math.random().toString(36).slice(2, 6)}`,
            name: c.name || null, group: c.group, toU: c.toU, toC: c.toC, bday: c.bday,
            rel: { user: c.relU ?? 0, char: c.relC ?? 0 }, note: { user: c.noteU || null, char: c.noteC || null },
            rom: { user: null, char: null }, scale: 2, turn,
        });
    }
    for (const u of parsed.upd) {
        const ex = findCast(state, u.name);
        if (!ex || ex.relLock) continue;
        if (u.relU != null) ex.rel.user = u.relU;
        if (u.relC != null) ex.rel.char = u.relC;
        ex.note = ex.note || { user: null, char: null };
        if (u.noteU && langOk(u.noteU)) ex.note.user = u.noteU;
        if (u.noteC && langOk(u.noteC)) ex.note.char = u.noteC;
    }
    if (state.cast.length > 40) state.cast = state.cast.slice(-40);
    return slip;
}

/** Старые записи (до вкладки-галереи): «relative» → родня {{user}} или {{char}}, «who» → роли, шкала романтики → кнопки */
export function migrateCast(state, userName, charName) {
    // дружба {{char}} и {{user}}: старая шкала 0–100 → −100…100
    if (state.pair && state.pair.scale !== 2) { state.pair.f = (state.pair.f - 50) * 2; state.pair.scale = 2; }
    const stem = (n) => norm(n).slice(0, 4);
    for (const c of state.cast || []) {
        if (c.group === 'relative') {
            const w = norm(c.who);
            c.group = stem(charName) && w.includes(stem(charName)) && !(stem(userName) && w.indexOf(stem(userName)) < w.indexOf(stem(charName)) && w.includes(stem(userName))) ? 'kin_char' : 'kin_user';
        }
        if (c.toU == null && c.toC == null && c.who) c.toU = c.who;
        if (roleName(c.name)) c.name = null;          // «Мать Алексея» — роль; имя появится, когда история его назовёт
        // старая шкала 0–100 (50 — ровно) → −100…100 (0 — ровно)
        if (c.scale !== 2) {
            c.rel = { user: ((c.rel?.user ?? 50) - 50) * 2, char: ((c.rel?.char ?? 50) - 50) * 2 };
            c.scale = 2;
        }
        if (!c.note) c.note = { user: null, char: null };
        c.toU = tieOf(c.toU); c.toC = tieOf(c.toC);
        if (STUB.test(String(c.name || '').trim())) c.name = null;
        for (const k of ['toU', 'toC']) if (STUB.test(String(c[k] || '').trim())) c[k] = null;
        if (c.rom && typeof c.rom.user === 'number') c.rom = { user: null, char: null };
        if (!c.rom) c.rom = { user: null, char: null };
        // общие дети и внуки (сын или дочь обоим) раньше попадали в родню одной стороны
        if ((state.castVer ?? 0) < 4 && !c.edited && (c.group === 'kin_user' || c.group === 'kin_char') && sharedChild(c)) c.group = 'kin_both';
    }
    // ни имени, ни роли (модель прислала пустую строку образца) — такой записи не место в списке
    if (state.cast) state.cast = state.cast.filter(c => c.edited || c.name || c.toU || c.toC);
    state.castVer = 4;
}

// ребёнок или внук и для {{user}}, и для {{char}}
const CHILD_WORD = /(сын|доч|ребен|ребён|дитя|дети|внук|внучк|son|daughter|child|kid|grand(son|daughter|child))/i;
// пасынок или падчерица для одного — тоже общая семья, если для другого это ребёнок
const STEP_WORD = /(пасын|падчер|приемн|приёмн|step|foster|adopt)/i;
const sharedChild = (c) => {
    const u = c.toU || '', ch = c.toC || '';
    return (CHILD_WORD.test(u) || STEP_WORD.test(u)) && (CHILD_WORD.test(ch) || STEP_WORD.test(ch));
};

// ─── Кого часто называют в истории: подсказка для переписи людей ───
// Слово с заглавной буквы посреди предложения — почти всегда имя (или место). Падежи сводим к общей основе.
const NAME_STOP = new Set(['вы', 'вас', 'вам', 'вами', 'ваш', 'ваша', 'ваше', 'ваши', 'вашего', 'вашей', 'бог', 'бога', 'богу', 'господь', 'господи', 'боже', 'христос', 'христа',
    'god', 'lord', 'sir', 'madam', 'miss', 'mister', 'lady', 'king', 'queen',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const stemOf = (w) => {
    const x = String(w || '').toLowerCase().replace(/ё/g, 'е');
    return x.length <= 4 ? x : x.slice(0, Math.min(5, x.length - 1));
};
/** Часто называемые имена: [{ name, n }], самые частые первыми. exclude — уже известные имена (любые слова из них) */
export function nameCandidates(texts, exclude = [], max = 8, min = 3) {
    const skip = new Set(exclude.flatMap(n => String(n || '').split(/[^\p{L}]+/u)).filter(w => w.length >= 3).map(stemOf));
    const seen = new Map();
    const re = /(?<=[\p{Ll}\d,;)]\s{1,3})(\p{Lu}\p{Ll}{2,})(?![\p{L}])/gu;
    for (const t of texts) {
        const s = String(t || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
        for (const m of s.matchAll(re)) {
            const w = m[1];
            if (NAME_STOP.has(w.toLowerCase())) continue;
            const st = stemOf(w);
            if (skip.has(st)) continue;
            const e = seen.get(st) || { n: 0, forms: new Map() };
            e.n++;
            e.forms.set(w, (e.forms.get(w) || 0) + 1);
            seen.set(st, e);
        }
    }
    return [...seen.values()].filter(e => e.n >= min).sort((a, b) => b.n - a.n).slice(0, max)
        .map(e => ({ name: [...e.forms.entries()].sort((a, b) => b[1] - a[1])[0][0], n: e.n }));
}
