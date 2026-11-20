// Hearthtide — dates.js
// Дни считаются здесь, а не ИИ: ИИ сообщает дату числом (ГГГГ-ММ-ДД)
// в календаре своего мира, расширение считает разницу в днях.

/** Номер дня (целое) для Y-M-D. Работает и для древних годов (100, 1151 и т.д.). */
export function dayNum(y, m, d) {
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    dt.setUTCHours(0, 0, 0, 0);
    return Math.round(dt.getTime() / 86400000);
}

/** Обратно: номер дня → { y, m, d } */
export function fromDayNum(n) {
    const dt = new Date(n * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** «1151-02-05», «1151.02.05», «05.02.1151» → номер дня или null */
export function parseDate(v) {
    const s = String(v ?? '').trim();
    let m = s.match(/^(-?\d{1,5})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/);
    if (m) return valid(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](-?\d{3,5})(?!\d)/);
    if (m) return valid(+m[3], +m[2], +m[1]);
    return null;
}

function valid(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return dayNum(y, mo, d);
}

/** «05-14» / «14.05» (день рождения) → { m, d } */
export function parseMonthDay(v) {
    const s = String(v ?? '').trim();
    let m = s.match(/^(\d{1,2})-(\d{1,2})$/);
    if (m && +m[1] <= 12) return { m: +m[1], d: +m[2] };
    m = s.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (m && +m[2] <= 12) return { m: +m[2], d: +m[1] };
    return null;
}

/** Ближайшее наступление даты «месяц-день» начиная с сегодняшнего дня (включительно) */
export function nextOccurrence(md, today) {
    const { y } = fromDayNum(today);
    for (const yy of [y, y + 1]) {
        const n = dayNum(yy, md.m, md.d);
        if (n >= today) return n;
    }
    return dayNum(y + 1, md.m, md.d);
}

export function isoOf(n) {
    const { y, m, d } = fromDayNum(n);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Часть дня по часам: утро 5–11, день 11–17, вечер 17–22, ночь 22–5 */
export function dayPart(hours) {
    if (hours == null) return null;
    const h = ((hours % 24) + 24) % 24;
    if (h >= 5 && h < 11) return 'morning';
    if (h >= 11 && h < 17) return 'day';
    if (h >= 17 && h < 22) return 'evening';
    return 'night';
}

/** «09:30» → 9.5 */
export function parseClock(v) {
    const m = String(v ?? '').match(/(\d{1,2})[:.hч](\d{2})?/);
    if (!m) return null;
    const h = +m[1], mi = +(m[2] || 0);
    return h <= 24 && mi < 60 ? (h % 24) + mi / 60 : null;
}

export function plural(n, forms) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
}

// ─── Пасха: считаем сами, чтобы ИИ не ошибался с переходящими праздниками ───
const JDN_EPOCH = 2440588;   // юлианский день для 1970-01-01, от него считается dayNum
function jdnOf(y, m, d, julian) {
    const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
    const base = d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4);
    return julian ? base - 32083 : base - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}
/** Православная Пасха (юлианская пасхалия): { julian: 'ММ-ДД' по старому стилю, day: номер дня по григорианскому } */
export function easterJulian(y) {
    const a = y % 4, b = y % 7, c = y % 19;
    const d = (19 * c + 15) % 30, e = (2 * a + 4 * b - d + 34) % 7;
    const m = Math.floor((d + e + 114) / 31), dd = ((d + e + 114) % 31) + 1;
    return { julian: `${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, day: jdnOf(y, m, dd, true) - JDN_EPOCH };
}
/** Западная Пасха (григорианская пасхалия) → номер дня */
export function easterGregorian(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mo = Math.floor((h + l - 7 * m + 114) / 31), dd = ((h + l - 7 * m + 114) % 31) + 1;
    return dayNum(y, mo, dd);
}
