// Hearthtide — tag.js
// Разбор скрытых тегов из ответа ИИ.
//   Каждый ответ:   <!-- HT date=1151-02-05 | time=09:30 | when=5 февраля, утро | place=деревня -->
//   По запросу:     <!-- HT-CAL … -->   <!-- HT-PREP … -->   <!-- HT-DAY … -->   <!-- HT-RECAP … -->
//   Повод из истории: <!-- HT-NEW … -->

import { parseDate, parseMonthDay, parseClock } from './dates.js';
import { iconKey } from './icons.js';

const clean = (v, max = 400) => {
    const x = String(v ?? '').replace(/\s+/g, ' ').trim();
    return x && !/^(none|null|нет|-|—|n\/a)$/i.test(x) ? x.slice(0, max) : null;
};
// длинный текст режем по концу предложения, а не на полуслове
const cleanSentences = (v, max) => {
    const x = clean(v, 4000);
    if (!x || x.length <= max) return x;
    const cut = x.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('… '));
    return end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
};

/**
 * Поля «ключ=значение | ключ=значение». keys — известные ключи блока: если модель забыла «|» перед следующим
 * («вечер… night=…»), разрезаем и там, иначе вторая часть дня попадала в текст первой.
 */
function fields(inner, keys = null) {
    const out = {};
    let t = String(inner);
    if (keys) t = t.replace(new RegExp(`([^|\\s])\\s+(?=(?:${keys.join('|')})\\s*=)`, 'gi'), '$1 | ');
    for (const part of t.split('|')) {
        const m = part.match(/^\s*([a-z_]+)\s*[=:]\s*([\s\S]*?)\s*$/i);
        if (m) out[m[1].toLowerCase()] = m[2];
    }
    return out;
}

// Блок по имени: строго (комментарий) или «прощающе» (в ```-блоке, без <!--, без -->)
function findBlock(text, name, loose = true) {
    const t = String(text ?? '');
    const strict = new RegExp(`<!--\\s*${name}(?![\\w-])[\\s:]*([\\s\\S]*?)-->`, 'gi');
    let m, last = null, lastEnd = 0;
    while ((m = strict.exec(t)) !== null) { last = m[1]; lastEnd = strict.lastIndex; }
    // «<!-- HT-CAST -->» пустой, а строки идут после него — берём их до следующего блока
    if (last != null && !last.trim() && loose) {
        const after = t.slice(lastEnd).split(/<!--/)[0];
        if (after.trim()) return after;
    }
    if (last != null || !loose) return last;
    const noFence = t.replace(/```[a-z]*|```/gi, '');
    const open = noFence.match(new RegExp(`(?:<!--\\s*)?${name}(?![\\w-])[\\s:]*([\\s\\S]*?)(?:-->|$)`, 'i'));
    return open && open[1].trim() ? open[1] : null;
}

const SMALL_KEYS = ['date', 'time', 'when', 'place', 'char', 'gift', 'gift_done', 'gift_to', 'ev', 'ev_note', 'mean', 'focus', 'ugift', 'ugift_done', 'bond', 'bond_note', 'bond_kin', 'date_asked', 'invite', 'went', 'went_note', 'who'];
const DAY_KEYS = ['title', 'where', 'morning', 'day', 'evening', 'night'];
/** Маленький тег каждого ответа (HT); у отдельного запроса — тот же набор полей в HT-S */
export function parseSmall(text, name = 'HT') {
    const inner = findBlock(text, name);
    if (inner == null) return null;
    const f = fields(inner, SMALL_KEYS);
    return {
        inner,
        date: parseDate(f.date),
        when: clean(f.when, 80),
        clock: parseClock(f.time),
        place: clean(f.place, 60),
        char: tidyValue(clean(f.char, 160)),                                   // мысль или действие персонажа сейчас
        gift: tidyValue(clean(f.gift, 160)),                                   // мысль персонажа о подарке
        ev: (() => {                                                // статус текущего ивента
            const v = String(f.ev || '').trim().toLowerCase();
            return ['done', 'skipped', 'joined', 'declined'].find(x => v.startsWith(x.slice(0, 4))) || null;
        })(),
        evNote: clean(f.ev_note, 300),
        mean: clean(f.mean, 240),
        focus: clean(f.focus, 80),                                  // какой из сегодняшних праздников празднуют в истории                                   // смысл праздника, который игрок переименовал
        giftDone: /^(true|yes|1|да)$/i.test(String(f.gift_done || '').trim()),
        giftTo: clean(f.gift_to, 60),
        // подарок {{user}} имениннику — только то, что {{user}} сам написал в своём сообщении
        ugift: tidyValue(clean(f.ugift, 160)),
        ugiftDone: /^(true|yes|1|да)$/i.test(String(f.ugift_done || '').trim()),
        // {{char}} и {{user}}: дружба / романтика −100…100 и коротко, как они сейчас
        bond: parseBond(f.bond, inner),
        bondNote: clean(f.bond_note, 60),
        // {{char}} и {{user}} — родня друг другу (брат и сестра, родитель и ребёнок…): без романтики и свиданий
        bondKin: /^(yes|true|да)/i.test(String(f.bond_kin || '').trim()) ? true : /^(no|false|нет)/i.test(String(f.bond_kin || '').trim()) ? false : null,
        // {{char}} в этом ответе позвал на свидание, задуманное помощником
        dateAsked: /^(yes|true|1|да)/i.test(String(f.date_asked || '').trim()),
        // кто-то в этом ответе вслух позвал {{user}}: на день рождения человека NAME или на дополнительный праздник NAME
        invite: clean(f.invite, 80),
        // таймскип перепрыгнул принятое приглашение: пришли (yes) или нет (no), и коротко как
        went: /^(yes|true|да)/i.test(String(f.went || '').trim()) ? true : /^(no|false|нет)/i.test(String(f.went || '').trim()) ? false : null,
        wentNote: clean(f.went_note, 160),
        // один человек праздника: чего он хочет теперь — «Имя: желание»
        who: (() => {
            const m = String(f.who || '').match(/^\s*(.{2,60}?)\s*(?::|\s[—–-]\s)\s*(.+)$/);
            const name = m && clean(m[1], 60), text = m && tidyValue(clean(m[2], 160));
            return name && text ? { name, text } : null;
        })(),
    };
}

/**
 * Дружба и романтика: «40/20», «40 / −20», «F40 R20», «40, 20»; если второе число ушло за «|» — берём и его.
 * Минусы бывают типографскими (−, –) — модель копирует их из промпта.
 */
function parseBond(v, inner) {
    const norm = (x) => String(x ?? '').replace(/[−–—]/g, '-');
    const nums = norm(v).match(/[+-]?\d{1,3}/g) || [];
    if (nums.length === 1) {
        const parts = String(inner || '').split('|');
        const i = parts.findIndex(x => /^\s*bond\s*[=:]/i.test(x));
        const next = i >= 0 ? norm(parts[i + 1]).trim() : '';
        if (/^[+-]?\d{1,3}$/.test(next)) nums.push(next);
    }
    if (nums.length < 2) return null;
    const c = (x) => Math.max(-100, Math.min(100, parseInt(x, 10)));
    return { f: c(nums[0]), r: c(nums[1]) };
}

/** Календарь: S | эпоха | вера | место  ·  H | дата | дней | название | смысл | тип  ·  B | user/char | ММ-ДД  ·  X | дата | название | тип (прошёл во время скипа) */
export function parseCalendar(text) {
    const inner = findBlock(text, 'HT-CAL');
    if (inner == null) return null;
    const res = { setting: null, holidays: [], birthdays: {}, passed: [] };
    for (const raw of inner.split(/\n+/)) {
        const cols = raw.split('|').map(x => x.trim());
        const kind = (cols[0] || '').toUpperCase();
        if (kind === 'S') {
            const mode = String(cols[4] || '').toLowerCase();
            res.setting = { era: clean(cols[1], 120), faith: clean(cols[2], 120), place: clean(cols[3], 60),
                mode: /^pres|^modern|^совр|^наш/.test(mode) ? 'modern' : /^past|^anc|^hist|^fant|^прош|^древ/.test(mode) ? 'ancient' : null };
        } else if (kind === 'H') {
            const start = parseDate(cols[1]);
            const days = Math.max(1, Math.min(14, parseInt(cols[2]) || 1));
            const name = clean(cols[3], 80);
            if (start == null || !name) continue;
            const prep = parseInt(cols[6]);
            res.holidays.push({ start, days, name, meaning: clean(cols[4], 240), type: normType(cols[5]),
                prep: isNaN(prep) ? null : Math.max(0, Math.min(45, prep)), icon: iconKey(cols[7]) });
        } else if (kind === 'X') {
            // праздник, который время перепрыгнуло (скип): X | дата | название | тип
            const start = parseDate(cols[1]);
            const name = clean(cols[2], 80);
            if (start != null && name) res.passed.push({ start, name, type: normType(cols[3]) });
        } else if (kind === 'B') {
            const who = /char|bot|{{char}}/i.test(cols[1] || '') ? 'char' : 'user';
            const md = parseMonthDay(cols[2]);
            const prep = parseInt(cols[3]);
            if (md) res.birthdays[who] = { ...md, prep: isNaN(prep) ? null : Math.max(0, Math.min(14, prep)) };
        }
    }
    return res;
}

const TYPES = ['religious', 'folk', 'seasonal', 'state', 'personal', 'family', 'supernatural', 'fast', 'memorial', 'gathering'];
function normType(v) {
    const x = String(v || '').toLowerCase();
    return TYPES.find(t => x.startsWith(t.slice(0, 4))) || 'folk';
}

/**
 * Новый повод из истории — предложение, которое игрок принимает или отклоняет:
 *   <!-- HT-NEW ЧТО_СЛУЧИЛОСЬ | YYYY-MM-DD | ДНЕЙ | НАЗВАНИЕ | СМЫСЛ | ТИП | PREP | КТО_ЛИЧНО_ПОЗВАЛ | AGREED -->
 */
export function parseOffers(text) {
    const inner = findBlock(text, 'HT-NEW');
    if (inner == null) return [];
    const out = [];
    for (const raw of inner.split(/\n+/)) {
        const cols = raw.split('|').map(x => x.trim());
        if (/^H$/i.test(cols[0] || '')) cols.shift();               // вдруг пришло в формате строки H
        const start = parseDate(cols[1]);
        const name = clean(cols[3], 80);
        if (start == null || !name) continue;
        const prep = parseInt(cols[6]);
        out.push({
            cause: clean(cols[0], 120), start, name,
            days: Math.max(1, Math.min(14, parseInt(cols[2]) || 1)),
            meaning: clean(cols[4], 240), type: normType(cols[5]),
            prep: isNaN(prep) ? null : Math.max(0, Math.min(45, prep)),
            host: /[<>]|^(host|none|nobody|никто|нет)$/i.test(String(cols[7] || '').trim()) ? null : clean(cols[7], 60),
            // {{user}} уже согласился своими словами (или сам предложил), или они уже там — без карточки
            agreed: /^(yes|true|1|да)/i.test(String(cols[8] || '').trim()),
        });
    }
    return out.slice(0, 2);
}

/**
 * Дополнительные праздники — собрания, на которые {{user}} или {{char}} могут позвать по их жизни и сеттингу:
 *   E | YYYY-MM-DD | ДНЕЙ | НАЗВАНИЕ | КТО_ЗОВЁТ | КОГО: user|char|both | СМЫСЛ
 * Приходят отдельным блоком HT-EXTRA или строками E в календаре HT-CAL.
 */
export function parseExtras(text) {
    const out = [];
    for (const name of ['HT-EXTRA', 'HT-CAL']) {
        const inner = findBlock(text, name, name === 'HT-EXTRA');
        if (inner == null) continue;
        for (const raw of inner.split(/\n+/)) {
            const cols = raw.split('|').map(x => x.trim());
            if ((cols[0] || '').replace(/^[\s\-*•]+/, '').toUpperCase() !== 'E') continue;
            const start = parseDate(cols[1]);
            const xname = clean(cols[3], 80);
            if (start == null || !xname || /[<>]/.test(xname)) continue;
            const w = String(cols[5] || '').toLowerCase();
            out.push({ start, days: Math.max(1, Math.min(3, parseInt(cols[2]) || 1)), name: xname, host: clean(cols[4], 80),
                whom: /^user/.test(w) ? 'user' : /^char/.test(w) ? 'char' : 'both', meaning: clean(cols[6], 240) });
        }
    }
    return out.slice(0, 3);
}

/** Подготовка: people / mood / char */
export function parsePrep(text) {
    const inner = findBlock(text, 'HT-PREP');
    if (inner == null) return null;
    const f = fields(inner, ['people', 'mood', 'gifts', 'gift_to', 'care']);
    const g = String(f.gifts || '').trim().toLowerCase();
    const c = String(f.care || '').trim().toLowerCase();
    const r = {
        people: tidyValue(clean(f.people)), mood: tidyValue(clean(f.mood)),
        giftTo: clean(f.gift_to, 60),                               // кому по обычаю дарят
        gifts: /^(yes|true|да|1)/.test(g) ? true : /^(no|false|нет|0)/.test(g) ? false : null,
        care: /^(high|важ|выс)/.test(c) ? 'high' : /^(low|низ|мал|прох)/.test(c) ? 'low' : /^(norm|mid|обыч|сред)/.test(c) ? 'normal' : null,
    };
    return r.people || r.mood ? r : null;
}

/** День праздника: title / where / morning / day / evening / night */
export function parseDay(text) {
    const inner = findBlock(text, 'HT-DAY');
    if (inner == null) return null;
    const f = fields(inner, DAY_KEYS);
    // where — где отмечают (у дня рождения человека из истории: чей дом или какое место)
    const r = { title: tidyValue(clean(f.title, 120)), where: tidyValue(clean(f.where, 80)), morning: tidyValue(clean(f.morning)), day: tidyValue(clean(f.day)), evening: tidyValue(clean(f.evening)), night: tidyValue(clean(f.night)) };
    return r.morning || r.day || r.evening || r.night ? r : null;
}

/**
 * Люди вокруг:
 *   P | ИМЯ | relative|friend|acquaintance | ЧЕМ ЗАНЯТ | ПОДАРОК  — активные
 *   D | ИМЯ | ЧТО СДЕЛАЛ                                         — своё отыграли, уходят из списка, но помнятся
 */
const GROUPS = ['relative', 'friend', 'acquaintance'];
export function parsePeople(text) {
    const inner = findBlock(text, 'HT-PEOPLE');
    if (inner == null) return null;
    const out = [];
    const done = [];
    for (const raw of inner.split(/\n+/)) {
        const cols = raw.split('|').map(x => x.trim());
        const kind = (cols[0] || '').toUpperCase();
        if (kind === 'D') {
            const name = clean(cols[1], 60), text = clean(cols[2], 160);
            if (name && text) done.push({ name, text: tidyValue(text) });
            continue;
        }
        if (kind !== 'P') continue;
        const name = clean(cols[1], 60);
        if (!name) continue;
        const g = String(cols[2] || '').toLowerCase();
        out.push({
            name,
            group: GROUPS.find(x => g.startsWith(x.slice(0, 4))) || (/(род|сем|famil|kin)/.test(g) ? 'relative' : /(друг|подруг)/.test(g) ? 'friend' : 'acquaintance'),
            now: tidyValue(clean(cols[3], 160)),
            gift: tidyValue(clean(cols[4], 120)),
        });
    }
    if (!out.length && !done.length) return null;
    return { active: out.slice(0, 8), done: done.slice(0, 8) };
}

/**
 * Ивенты: <!-- HT-EV kind=event|party|moment | title=… | who=… -->
 * event — небольшое событие в сцене; party — мероприятие (сначала приглашение); moment — что-то на мероприятии
 */
export function parseEvents(text) {
    const t = String(text ?? '');
    const out = [];
    const re = /<!--\s*HT-EV(?![\w-])[\s:]*([\s\S]*?)-->/gi;
    let m;
    while ((m = re.exec(t)) !== null) {
        const f = fields(m[1]);
        const title = clean(f.title, 160);
        if (!title) continue;
        const k = String(f.kind || '').toLowerCase();
        out.push({ kind: k.startsWith('part') ? 'party' : k.startsWith('mom') ? 'moment' : 'event', title, who: clean(f.who, 80), hook: clean(f.hook, 240) });
    }
    return out;
}

/** Подсказка основной модели на следующий ответ (от отдельного запроса); «none» — ничего */
export function parseBeat(text) {
    const inner = findBlock(text, 'HT-BEAT', false);
    return inner == null ? null : clean(inner, 300);
}

/**
 * Люди истории (по одному разу):
 *   C | ИМЯ (или ?) | kin_user|kin_char|kin_both|friend|acquaintance|other | КЕМ ДЛЯ USER | КЕМ ДЛЯ CHAR | ДР | С USER −100…100 | С CHAR | КАК С USER | КАК С CHAR
 *   R | ИМЯ | С USER | С CHAR | КАК С USER | КАК С CHAR   — отношения заметно изменились
 */
export function parseCast(text) {
    const inner = findBlock(text, 'HT-CAST');
    if (inner == null) return null;
    const add = [], upd = [];
    const rel = (v) => { const n = parseInt(v); return isNaN(n) ? null : Math.max(-100, Math.min(100, n)); };
    for (const raw of inner.split(/\n+/)) {
        const cols = raw.split('|').map(x => x.trim());
        const kind = (cols[0] || '').replace(/^[\s\-*•]+/, '').replace(/[:.]+$/, '').toUpperCase();   // «- C», «C:» — тоже C
        // модель иногда переписывает образец как есть: «NAME», «<name or ?>», «TO_USER» — это пусто, а не имя
        const stub = (v) => !v || /^[?？]+$/.test(v) || /[<>]/.test(v) || /^(name|имя|group|to[_ ]?user|to[_ ]?char|birthday|with[_ ]?user|with[_ ]?char|how[_ ]?user|how[_ ]?char|none|n\/a|unknown|неизвестно)$/i.test(String(v).trim());
        const nm = clean(cols[1], 60);
        const name = stub(nm) ? null : nm;
        if (kind === 'C') {
            const g = String(cols[2] || '').toLowerCase().replace(/[\s-]+/g, '_');
            const group = /^kin_?b|both|общ|shared/.test(g) ? 'kin_both' : /^kin_?c|char/.test(g) ? 'kin_char' : /^kin|^rel|род|сем|famil/.test(g) ? 'kin_user'
                : /^fri|друг|подруг/.test(g) ? 'friend' : /^acq|знак/.test(g) ? 'acquaintance' : 'other';
            const bd = String(cols[5] || '').trim().match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](-?\d{1,5}))?$/);
            const toU = stub(clean(cols[3], 60)) ? null : clean(cols[3], 60), toC = stub(clean(cols[4], 60)) ? null : clean(cols[4], 60);
            if (!name && !toU && !toC) continue;
            add.push({
                name, group, toU, toC,
                bday: bd && +bd[2] >= 1 && +bd[2] <= 12 && +bd[1] >= 1 && +bd[1] <= 31 ? { d: +bd[1], m: +bd[2], y: bd[3] != null ? +bd[3] : null } : null,
                relU: rel(cols[6]), relC: rel(cols[7]), noteU: clean(cols[8], 50), noteC: clean(cols[9], 50),
            });
        } else if (kind === 'R' && name) {
            upd.push({ name, relU: rel(cols[2]), relC: rel(cols[3]), noteU: clean(cols[4], 50), noteC: clean(cols[5], 50) });
        }
    }
    return add.length || upd.length ? { add: add.slice(0, 10), upd: upd.slice(0, 10) } : null;
}

/**
 * Свидание: <!-- HT-DATE title=… | goal=… | hook=… | where=… | at=YYYY-MM-DD HH:MM | started=yes -->
 * at — на когда назначено (now — прямо сейчас); started=yes — история уже его начала (не предложение);
 * agreed=yes — {{user}} уже согласился в своём сообщении (или сам позвал): без карточки «Принять / Отклонить»
 */
export function parseDateBlock(text) {
    const inner = findBlock(text, 'HT-DATE');
    if (inner == null) return null;
    const f = fields(inner);
    const title = clean(f.title, 120);
    if (!title) return null;
    const steps = String(f.steps || '').split(/;|\n/).map(x => x.trim()).filter(Boolean).slice(0, 3).map(x => {
        const who = /\((?:\s*)(user|юзер|игрок)/i.test(x) ? 'user' : /\((?:\s*)(both|оба|вместе)/i.test(x) ? 'both' : 'char';
        return { t: clean(x.replace(/\s*\([^)]*\)\s*$/, ''), 120), who };
    }).filter(s => s.t);
    const k = String(f.kind || '').trim().toLowerCase();
    return { title, goal: clean(f.goal, 160), hook: clean(f.hook, 240), where: clean(f.where, 80), at: parseAt(f.at), steps,
        kind: /^(out|friend|друж|встреч|прогул)/.test(k) ? 'friendly' : /^(date|rom|свид)/.test(k) ? 'romantic' : null,
        started: /^(yes|true|1|да)/i.test(String(f.started || '').trim()),
        // {{user}} уже согласился своими словами (или сам позвал) — карточка не нужна
        agreed: /^(yes|true|1|да)/i.test(String(f.agreed || '').trim()) };
}

/** «1151-02-06 18:00», «06.02.1151 18:00», «18:00» (сегодня), «now» → { day, clock } | { now: true } | null */
export function parseAt(v) {
    const s = String(v ?? '').trim();
    if (!s || /^(none|null|нет|-|—)$/i.test(s)) return null;
    if (/^(now|right now|сейчас|прямо сейчас|сразу)/i.test(s)) return { now: true };
    const day = parseDate(s);
    const t = s.match(/(?:^|[\sT,])(\d{1,2})[:.](\d{2})(?![.\d])/) || s.match(/(?:^|\s)(\d{1,2})\s*ч/);
    const clock = t && +t[1] <= 24 && +(t[2] || 0) < 60 ? (+t[1] % 24) + (+(t[2] || 0)) / 60 : null;
    return day != null || clock != null ? { day, clock } : null;
}

/**
 * Ход свидания (помощник или основная модель):
 *   START                         — намеченное свидание началось
 *   STATE | on|ending|over | ПОЧЕМУ — идёт / подходит к концу / закончилось
 *   STEP | N | done|failed|open | что вышло — вердикт по каждому открытому шагу
 *   NEW | шаг | char|both         — новый шаг на освободившееся место
 *   MOMENT | что было             — признание, поцелуй, смелый или нежный жест
 *   GIFT | КТО | ЧТО              — вещь, которую кто-то вручил (не действие)
 *   MOOD | up|down|same · VIBE · THOUGHT · GOAL | yes · RECAP | итог | лучший момент
 * Строки образца, переписанные как есть («GOAL», «END», «MOOD | up|down», «STEP | N | done|failed|open»), не засчитываются.
 */
export function parseDateUp(text) {
    const inner = findBlock(text, 'HT-DATE-UP');
    if (inner == null) return null;
    const up = { start: false, phase: null, why: null, done: [], fail: [], missed: [], add: [], moments: [], gifts: [], learn: [], missteps: [], know: null, mood: 0, vibe: null, thought: null, goal: false, recap: null, best: null };
    const num = (v) => { const m = String(v || '').match(/^\s*(?:№|#|s)?\s*(\d{1,3})\b/i); return m ? +m[1] : null; };
    const yes = (v) => /^(yes|true|да|1)\b/i.test(String(v || '').trim());
    // «done|failed|open», «up|down», «on|ending|over» — образец, а не ответ
    const echo = (raw) => /\b(done\s*\|\s*failed|up\s*\|\s*down|on\s*\|\s*ending|ending\s*\|\s*over|char\s*\|\s*both|small\s*\|\s*big)\b/i.test(raw) || /<[^>]*>/.test(raw);
    for (const raw of inner.split(/\n+/)) {
        if (echo(raw)) continue;
        const cols = raw.split('|').map(x => x.trim());
        const k = (cols[0] || '').replace(/^[\s\-*•]+/, '').replace(/[:.]+$/, '').toUpperCase();
        if (k === 'START') up.start = true;
        else if (k === 'STATE') {
            const v = String(cols[1] || '').toLowerCase();
            up.phase = /^(over|ended|done|конч|законч|окончен)/.test(v) ? 'over' : /^(ending|closing|winding|подход|заверш)/.test(v) ? 'ending' : /^(on|going|ongoing|идёт|идет|продолж)/.test(v) ? 'on' : up.phase;
            up.why = stepText(cols[2], 160) || up.why;
        } else if (k === 'END') {
            // прежний вид: END засчитываем только с явным «yes» и причиной
            if (yes(cols[1]) && stepText(cols[2], 160)) { up.phase = 'over'; up.why = stepText(cols[2], 160); }
        } else if (k === 'STEP') {
            const n = num(cols[1]), v = String(cols[2] || '').toLowerCase();
            if (n == null) continue;
            if (/^(done|yes|сделан|выполн|да)/.test(v)) up.done.push({ n, note: stepText(cols[3], 160) });
            else if (/^(fail|failed|no|сорв|провал|нет)/.test(v)) up.fail.push({ n, note: stepText(cols[3], 160) });
            // момент упущен: сцена ушла дальше, шаг больше не к месту
            else if (/^(miss|missed|passed|gone|drop|stale|упущ|прош|неакту)/.test(v)) up.missed.push({ n });
        } else if (k === 'DONE' || k === 'FAIL') {
            const n = num(cols[1]);
            if (n != null) (k === 'DONE' ? up.done : up.fail).push({ n, note: stepText(cols[2], 160) });
            else if (stepText(cols[1], 120)) (k === 'DONE' ? up.done : up.fail).push({ byText: stepText(cols[1], 120), note: stepText(cols[2], 160) });
        } else if (k === 'NEW') {
            // «NEW | 2 | шаг | char» — номер впереди не текст шага
            let rest = cols.slice(1);
            if (rest.length > 1 && /^\s*\d{1,3}\s*$/.test(rest[0])) rest = rest.slice(1);
            const t = stepText(rest[0], 120);
            // NEW | шаг | мысль {{char}} (прежний вид: NEW | шаг | char|both)
            const who = /^(char|both|user|чар|оба|вместе)$/i.test(String(rest[1] || '').trim());
            if (t) up.add.push({ t, thought: stepText(who ? rest[2] : rest[1], 140) });
        } else if (k === 'MISSTEP') {
            // MISSTEP | что сделал {{char}} | small|big — {{user}} это явно не понравилось
            const t = stepText(cols[1], 140);
            if (t) up.missteps.push({ t, big: /^(big|serious|bad|сильн|серьёз|серьез|круп)/i.test(String(cols[2] || '').trim()) });
        } else if (k === 'KNOW') {
            // KNOW | char|user | факт — новая сжатая сводка того, что они знают друг о друге (заменяет прежнюю)
            const w = String(cols[1] || '').toLowerCase();
            const fact = stepText(cols[2], 120);
            if (fact && /^(char|user|чар|юзер)/.test(w)) {
                up.know = up.know || { char: [], user: [] };
                up.know[/^(char|чар)/.test(w) ? 'char' : 'user'].push(fact);
            }
        } else if (k === 'LEARN') {
            // LEARN | char | что {{char}} узнал о {{user}} · LEARN | user | что {{user}} узнал о {{char}}
            // кто узнал: char / user — или имя (сверяется с именами при разборе в index.js)
            const fact = stepText(cols[2], 120);
            if (fact && cols[1] && !/[<>]/.test(cols[1])) up.learn.push({ whoRaw: clean(cols[1], 40), t: fact });
        } else if (k === 'MOMENT') {
            const t = stepText(cols.slice(1).join(' — '), 160);
            if (t) up.moments.push(t);
        } else if (k === 'GIFT') {
            // GIFT | КТО | ЧТО — или GIFT | ЧТО
            const what = stepText(cols[2] ?? cols[1], 120);
            const from = cols[2] != null ? clean(cols[1], 40) : null;
            if (what) up.gifts.push({ from, what });
        } else if (k === 'MOOD') {
            const v = String(cols[1] || '').trim();
            up.mood = /^(up|better|лучш|\+)/i.test(v) ? 1 : /^(down|worse|хуж|-)/i.test(v) ? -1 : 0;
        } else if (k === 'VIBE') up.vibe = stepText(cols[1], 60);
        else if (k === 'THOUGHT') up.thought = stepText(cols[1], 160);
        else if (k === 'GOAL') up.goal = yes(cols[1]);
        else if (k === 'RECAP') { up.recap = cleanSentences(cols[1], 400); up.best = stepText(cols[2], 120); }
    }
    return up;
}

/** Текст шага или пометки: живые слова, а не «2», «…», «STEP» или кусок образца */
export function stepText(v, max = 120) {
    const t = clean(v, max);
    if (!t) return null;
    const letters = (t.match(/\p{L}/gu) || []).length;
    if (letters < 4 || !/\p{L}{3,}/u.test(t)) return null;
    if (/^(step|note|new|done|fail|vibe|thought|recap|best|text|char|user|both|n\/a|none|нет|—)$/i.test(t)) return null;
    if (/[|<>]|-->|\{\{|\}\}/.test(t)) return null;
    return t;
}

/**
 * Подготовка по истории — что уже сделано к каждому из готовящихся праздников (номер — из списка в запросе):
 *   DONE | № | КТО | ЧТО СДЕЛАНО
 *   GIFT | № | char|user|both|ИМЯ | ПОДАРОК | idea|got|given
 *   OFF  | № | cancelled|moved|missed | YYYY-MM-DD (если перенесли) | ПОЧЕМУ   — missed: {{char}} и {{user}} не пришли
 *   SUM  | № | всё сделанное к нему одним предложением (сжатие журнала)
 */
export function parseReady(text) {
    const inner = findBlock(text, 'HT-READY');
    if (inner == null) return null;
    const r = { done: [], gifts: [], off: [], sum: [] };
    const num = (v) => { const m = String(v || '').match(/^\s*#?(\d{1,2})\b/); return m ? +m[1] : null; };
    for (const raw of inner.split(/\n+/)) {
        if (/<[^>]*>/.test(raw)) continue;                            // образец, переписанный как есть
        const cols = raw.split('|').map(x => x.trim());
        const k = (cols[0] || '').replace(/^[\s\-*•]+/, '').replace(/[:.]+$/, '').toUpperCase();
        const i = num(cols[1]);
        if (i == null) continue;
        if (k === 'DONE') {
            const t = tidyValue(stepText(cols[3], 140));
            if (t) r.done.push({ i, who: clean(cols[2], 40), t });
        } else if (k === 'GIFT') {
            const t = tidyValue(stepText(cols[3], 120));
            const w = String(cols[2] || '').trim();
            const st = String(cols[4] || '').toLowerCase();
            if (t && w && !/^(who|кто)$/i.test(w)) r.gifts.push({ i, who: w, t,
                stage: /^(given|gave|вруч|подар|отдал)/.test(st) ? 'given' : /^(got|bought|made|ready|куп|сдел|готов|есть)/.test(st) ? 'got' : 'idea' });
        } else if (k === 'OFF') {
            const how = /^(mov|перен)/i.test(cols[2] || '') ? 'moved' : /^(miss|skip|didn|не пришл|не пош|пропуст)/i.test(cols[2] || '') ? 'missed' : /^(cancel|off|отмен|сорв|не будет)/i.test(cols[2] || '') ? 'cancelled' : null;
            if (!how) continue;
            const to = parseDate(cols[3]);
            r.off.push({ i, how: how === 'moved' && to == null ? 'cancelled' : how, to, why: tidyValue(stepText(to == null ? cols[3] || cols[4] : cols[4], 120)) });
        } else if (k === 'SUM') {
            const t = tidyValue(stepText(cols[2], 220));
            if (t) r.sum.push({ i, t });
        }
    }
    return r.done.length || r.gifts.length || r.off.length || r.sum.length ? r : null;
}

/**
 * Значение для инфоблока: без служебных пометок («идея:», «шаг:», «stage —»), без кавычек вокруг, с заглавной буквы.
 * Модель любит начинать подарок с этапа («идея: купить шарф») — этап и так виден, а фраза должна быть сразу по делу.
 */
export function tidyValue(v) {
    let x = String(v ?? '').trim();
    if (!x) return null;
    for (let i = 0; i < 2; i++) x = x.replace(/^(?:идея|задумка|мысль|план|этап|шаг|стадия|статус|сейчас|idea|plan|stage|step|status|now)\s*[:—–-]\s*/i, '').trim();
    x = x.replace(/^[«"“'*_]+|[»"”'*_]+$/g, '').trim();
    return x ? x.charAt(0).toUpperCase() + x.slice(1) : null;
}

const RECAP_KEYS = ['text', 'done', 'gifts', 'best', 'went'];
/** Итог прошедшего праздника — одна строка */
export function parseRecap(text) {
    const inner = findBlock(text, 'HT-RECAP');
    if (inner == null) return null;
    if (!/\btext\s*[=:]/i.test(inner)) return cleanSentences(inner, 700);      // старый вид — просто текст
    return cleanSentences(fields(inner, RECAP_KEYS).text, 700);
}
/** Короткий итог по пунктам: что сделали, подарки, лучший момент */
export function parseRecapParts(text) {
    const inner = findBlock(text, 'HT-RECAP');
    if (inner == null || !/\btext\s*[=:]/i.test(inner)) return null;
    const f = fields(inner, RECAP_KEYS);
    const list = (v) => String(v || '').split(';').map(x => clean(x, 90)).filter(Boolean).slice(0, 5);
    const w = String(f.went || '').trim();
    // у приглашения (день рождения, дополнительный праздник): пришли ли {{char}} и {{user}}
    const r = { done: list(f.done), gifts: list(f.gifts), best: clean(f.best, 120), went: /^(yes|да)/i.test(w) ? true : /^(no|нет)/i.test(w) ? false : null };
    return r.done.length || r.gifts.length || r.best || r.went != null ? r : null;
}

/**
 * Маленький тег в тексте сообщения → только дата, время, «когда» и место. Остальные поля (who=Имя, char=, invite=, gift=…)
 * уже разобраны и сохранены; в тексте их читал бы лорбук и срабатывал на имена.
 */
export function slimSmallTag(text) {
    return String(text ?? '').replace(/<!--\s*HT(?![\w-])([\s\S]*?)-->/gi, (all, inner) => {
        const f = fields(inner);
        const keep = ['date', 'time', 'when', 'place'].filter(k => f[k] != null && String(f[k]).trim()).map(k => `${k}=${String(f[k]).trim()}`);
        return keep.length ? `<!-- HT ${keep.join(' | ')} -->` : '';
    });
}

/**
 * Скрытый <!-- HT … --> в конце ответа — на ту же строку, что и последний текст.
 * Отдельной строкой он разрывал абзац: то, что другие расширения дописывают после ответа (ExtBlocks с картинкой),
 * оказывалось в собственном абзаце, и отступ первой строки из темы сдвигал картинку вправо за край чата.
 * Не клеим после ограды кода, таблицы и пустого текста — там строка должна остаться своей.
 */
export function glueTag(text) {
    const s = String(text ?? '');
    // HT-строка на своей строке (в конце ответа или перед дописанным блоком) — к концу предыдущей строки текста
    return s.replace(/\n[ \t]*(?:\n[ \t]*)*(<!--\s*HT(?![\w-])[^\n]*?-->)[ \t]*(?=\n|$)/g, (all, tag, off) => {
        const lastLine = s.slice(0, off).split('\n').pop() || '';
        if (!lastLine.trim() || /^\s*(```|~~~|\|)/.test(lastLine)) return all;
        return tag;
    });
}

/**
 * Убирает из текста сообщения крупные блоки (они уже разобраны и сохранены)
 * и «неправильные» формы маленького тега. Правильный скрытый <!-- HT … --> остаётся
 * как образец формата.
 */
export function stripBlocks(text) {
    let t = String(text ?? '');
    t = t.replace(/```[a-z]*\s*(?:<!--\s*)?HT(?:-[A-Z]+)?\b[\s\S]*?```/gi, '');
    t = t.replace(/\s*<!--\s*HT-(?:CAL|PREP|DAY|RECAP|EVENT|PEOPLE|EV|NEW|S|BEAT|CAST|DATE-UP|DATE|EXTRA|READY)\b[\s\S]*?-->/gi, '');
    t = t.replace(/\s*<!--\s*HT-(?:CAL|PREP|DAY|RECAP|EVENT|PEOPLE|EV|NEW|S|BEAT|CAST|DATE-UP|DATE|EXTRA|READY)\b(?![\s\S]*-->)[\s\S]*$/i, '');
    t = t.replace(/^\s*HT(?:-[A-Z]+)?\b[\s:]+[^\n]*$/gim, '');
    return t.replace(/\s+$/, '');
}
