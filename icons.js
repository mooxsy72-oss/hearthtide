// Hearthtide — icons.js
// Значок праздника: модель выбирает слово из короткого списка (строка H календаря), иначе — по названию и типу.
// Только иконки Font Awesome 6 free.

export const ICONS = {
    tree: 'fa-tree', snow: 'fa-snowflake', star: 'fa-star', egg: 'fa-egg', sun: 'fa-sun', heart: 'fa-heart',
    flower: 'fa-seedling', shield: 'fa-shield-halved', flag: 'fa-flag', ghost: 'fa-ghost', moon: 'fa-moon',
    leaf: 'fa-leaf', wheat: 'fa-wheat-awn', fire: 'fa-fire', bell: 'fa-bell', church: 'fa-church', cross: 'fa-cross',
    dove: 'fa-dove', gift: 'fa-gift', glass: 'fa-champagne-glasses', music: 'fa-music', mask: 'fa-masks-theater',
    ring: 'fa-ring', cake: 'fa-cake-candles', book: 'fa-book', crown: 'fa-crown', work: 'fa-briefcase',
    school: 'fa-graduation-cap', beach: 'fa-umbrella-beach', candy: 'fa-candy-cane', mug: 'fa-mug-hot',
    skull: 'fa-skull', feather: 'fa-feather', cookie: 'fa-cookie', tent: 'fa-campground', car: 'fa-car-side',
};
export const ICON_WORDS = Object.keys(ICONS);

/** Слово-значок от модели → ключ из списка (или null) */
export function iconKey(v) {
    const x = String(v || '').trim().toLowerCase().replace(/^fa-/, '');
    if (ICONS[x]) return x;
    const hit = Object.entries(ICONS).find(([, fa]) => fa === `fa-${x}`);
    return hit ? hit[0] : null;
}

// По названию: самые узнаваемые праздники и виды встреч (русские и английские основы)
const BY_NAME = [
    [/(нов(ый|ого|ым)\s+год|new\s*year|hogmanay|сочельник)/i, 'tree'],
    [/(рождеств|christmas|xmas|yule|святки)/i, 'star'],
    [/(пасх|easter|велик(ий|ая)\s+день)/i, 'egg'],
    [/(маслениц|масленн|блин|pancake|shrovetide)/i, 'sun'],
    [/(валентин|valentine|влюбл)/i, 'heart'],
    [/(8\s*марта|женск|women'?s\s*day|mother'?s\s*day|день\s*матер)/i, 'flower'],
    [/(защитник|отечеств|defender|армии|veteran)/i, 'shield'],
    [/(побед|victory|память\s+павш|remembrance)/i, 'star'],
    [/(росси|независим|единств|independence|national|republic|конституц)/i, 'flag'],
    [/(хэллоуин|halloween|самайн|samhain|дзяды|день\s*мёртв|day\s*of\s*the\s*dead)/i, 'ghost'],
    [/(купал|солнцеворот|солнцестоя|midsummer|solstice)/i, 'fire'],
    [/(урожа|жатв|harvest|осенин|покров|thanksgiving)/i, 'wheat'],
    [/(троиц|whitsun|pentecost)/i, 'leaf'],
    [/(свадьб|венчан|wedding|годовщин\S*\s+свадьб|anniversary)/i, 'ring'],
    [/(день\s*рожд|именин|birthday)/i, 'cake'],
    [/(знани|выпускн|школ|university|graduation|school)/i, 'school'],
    [/(корпоратив|работ|офис|corporate|office|company)/i, 'glass'],
    [/(вечеринк|тусовк|party|бал\b|ball\b|пир|feast|банкет)/i, 'glass'],
    [/(концерт|фестивал|concert|festival|музык)/i, 'music'],
    [/(маскарад|карнавал|carnival|masquerade|театр)/i, 'mask'],
    [/(поминк|поминал|радониц|родительск|memorial|funeral|похорон)/i, 'feather'],
    [/(пост\b|fast|lent|рамадан|ramadan)/i, 'moon'],
    [/(поездк|путешеств|дач|пикник|trip|picnic|outing|вылазк)/i, 'tent'],
    [/(чаепит|посиделк|чай|tea)/i, 'mug'],
];
const BY_TYPE = {
    religious: 'church', folk: 'wheat', seasonal: 'leaf', state: 'flag', personal: 'cake', family: 'ring',
    supernatural: 'ghost', fast: 'moon', memorial: 'feather', gathering: 'glass', date: 'heart',
};

/** Класс иконки для праздника: выбор модели → по названию → по типу */
export function holidayIcon(h) {
    if (!h) return 'fa-calendar-days';
    if (h.icon && ICONS[h.icon]) return ICONS[h.icon];
    if (h.birthday) return ICONS.cake;
    const name = `${h.raw || h.name || ''} ${h.meaning || ''}`;
    for (const [re, k] of BY_NAME) if (re.test(name)) return ICONS[k];
    return ICONS[BY_TYPE[h.type]] || 'fa-star';
}
