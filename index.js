// Hearthtide — index.js
// Праздники, которые живут в ролплее: календарь эпохи, подготовка, сам праздник с утра до ночи.
// Основная модель пишет историю и короткий скрытый тег (дата, время, место); всё остальное по истории собирает
// помощник — отдельный запрос через профиль подключения. Расширение считает дни и хранит память.

import {
    chat, chat_metadata, this_chid, characters,
    setExtensionPrompt, extension_prompt_types, extension_prompt_roles,
    saveChatDebounced, name1,
} from '../../../../script.js';
import { eventSource, event_types } from '../../../../scripts/events.js';

import { dayPart, plural, parseDate, fromDayNum, isoOf, dayNum } from './dates.js';
import { parseAt, slimSmallTag, glueTag, parseReady, parseExtras, parseSmall, parseCalendar, parsePrep, parseDay, parseRecap, parsePeople, parseEvents, parseOffers, parseBeat, parseCast, parseDateBlock, parseDateUp, parseRecapParts, stripBlocks } from './tag.js';
import { PAIR_DEFAULT, bondCap, dateKindFor, isFriendlyDate, newDate, startDate, applyDateUp, openSteps, goalOpen, doneCount, toggleStep, finishDate, dateChanceInfo, migrateDate, DATE_MISS_HOURS, DATE_OPEN, DATE_SKIP_END, DATE_SKIP_HARD, DATE_CLOSE_TURNS, DATE_QUIET, goalNeed, paceAuto, stepKinds, MISS_PAIR } from './romance.js';
import { CAST_GROUPS, KIN_GROUPS, ROM_KEYS, isKin, samePerson, findCast, castBanned, parseBday, bdayText, bdayIn, ageOf, relLevel, romLevel, clampRel, mergeCast, migrateCast, nameCandidates } from './cast.js';
import { phaseOf, mentionEvery, holidayId, allHolidays, banKeys, isBanned, namesMatch, passedThisYear, sameOccasion, hasGifts, openEvent, offeredEvent, EVENT_CHANCE_DEFAULT, EVENT_COOLDOWN, OPEN_STATUSES, sideNeeds, sideDue, CENSUS_DEPTH, dateHoursLeft, npcBdKey, npcBdOn, npcHoliday, giftJoint, trackedOccasions, charGiftOf, activeOccasions, occTier, preparingNow, pushable, pushTracked, PUSH_GAP } from './calendar.js';
import { owning, buildStatePrompt, buildTagPrompt, buildSideMessages, buildDateReview, buildDateSideMessages, buildDateRefillMessages, giftTarget, hName, isGathering } from './prompts.js';
import { inviteCandidates, bdKey, extraKey, mergeExtras, INVITE_TRIES, INVITE_COOL, INVITE_AHEAD } from './invites.js';
import { listProfiles, gatherSources, loreFor, sendSide, reasonOf, withNote, canDirect, directActive } from './side.js';
import { strings } from './i18n.js';
import { holidayIcon } from './icons.js';

// ═══════════════════════════════════════════════════════════════
// НАСТРОЙКИ
// ═══════════════════════════════════════════════════════════════
const META_KEY = 'hearthtide';
const PROMPT_STATE = 'hearthtide_state';
const PROMPT_TAG = 'hearthtide_tag';
const LS = {
    enabled: 'hearthtide_enabled',
    position: 'hearthtide_position',   // top | middle | bottom — внутри ответа бота
    showPrev: 'hearthtide_showPrev',   // показывать в предыдущих ответах
    lang: 'hearthtide_lang',           // ru | en — язык инфоблока
    api: 'hearthtide_api',             // профиль подключения для отдельного запроса: auto — тот, что выбран в таверне
    depth: 'hearthtide_depth',         // сколько последних сообщений читает отдельный запрос
    eraMap: 'hearthtide_era_map',      // прошлые версии: эпоха для каждого персонажа (теперь — в самом чате)
    dateChance: 'hearthtide_date_chance', // шанс, что чар сам позовёт на свидание после ответа (%)
    dateLevel: 'hearthtide_date_level',   // сложность свиданий: easy | hard
    evChance: 'hearthtide_ev_chance',     // шанс случайного ивента на идущем мероприятии после ответа (%)
    datePace: 'hearthtide_date_pace',     // темп романтики: auto (по истории) | slow | fast
};
const lsGet = (k, d) => { const v = localStorage.getItem(k); return v === null ? d : v; };
const isEnabled = () => lsGet(LS.enabled, 'true') !== 'false';
const position = () => lsGet(LS.position, 'bottom');
const showPrev = () => lsGet(LS.showPrev, 'true') !== 'false';
// Профиль: по умолчанию тот, что выбран в Connection Manager; не выбран (или профилей нет) — текущее подключение таверны
const apiChoice = () => lsGet(LS.api, 'auto');
function apiProfile() {
    const v = apiChoice();
    if (v !== 'auto') return v;
    return globalThis.SillyTavern?.getContext?.()?.extensionSettings?.connectionManager?.selectedProfile || '';
}
// помощник есть: выбран профиль Connection Manager — или «текущий профиль» без профиля, тогда текущее подключение таверны
const apiOn = () => isEnabled() && (!!apiProfile() || (apiChoice() === 'auto' && canDirect()));
const sideDepth = () => Number(lsGet(LS.depth, '10')) || 10;
const dateLevel = () => (lsGet(LS.dateLevel, 'easy') === 'hard' ? 'hard' : 'easy');
const datePaceSetting = () => { const v = lsGet(LS.datePace, 'auto'); return ['slow', 'fast'].includes(v) ? v : 'auto'; };
/** Темп романтики пары: выбран в настройках или «по сюжету» — по нынешней романтике (до 30 — slow burn, от 70 — fast burn) */
const pairPace = (r) => { const v = datePaceSetting(); return v !== 'auto' ? v : paceAuto(r); };
const evChanceSetting = () => { const n = Number(lsGet(LS.evChance, String(EVENT_CHANCE_DEFAULT))); return isNaN(n) ? EVENT_CHANCE_DEFAULT : Math.max(0, Math.min(50, n)); };
const dateChanceSetting = () => { const n = Number(lsGet(LS.dateChance, '6')); return isNaN(n) ? 6 : Math.max(0, Math.min(30, n)); };

// ─── Эпоха — своя у каждого чата (хранится в состоянии чата); вера — определяется сама по началу чата ───
function charKey() {
    const gid = globalThis.SillyTavern?.getContext?.()?.groupId;
    if (gid) return `g:${gid}`;
    const ch = this_chid !== undefined ? characters[this_chid] : null;
    return ch?.avatar ? `c:${ch.avatar}` : null;
}
function eraMap() {
    try { return JSON.parse(localStorage.getItem(LS.eraMap) || '{}') || {}; } catch (e) { return {}; }
}
function setChatEra(value) {
    if (!state) return;
    state.eraMode = ['ancient', 'modern'].includes(value) ? value : 'auto';
    saveState();
}
// Эпоху нового чата определяет ИИ по началу чата в первом календаре (auto), пока игрок не выберет сам
const eraMode = () => state?.eraMode || 'auto';
const langMode = () => lsGet(LS.lang, 'ru');
const L = () => strings(langMode());

const KEEP_TAGS_IN_PROMPT = 3;

// Модуль таверны целиком — для main_api и updateMessageBlock (динамически, чтобы не падать)
let stModule = null;
import('../../../../script.js').then(m => { stModule = m; }).catch(() => {});
const isChatCompletion = () => stModule?.main_api === 'openai';

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Число из состояния чата: в HTML попадает только настоящее число (файл чата могли подправить руками) */
const num = (v, d = 0) => (v !== null && v !== '' && Number.isFinite(+v) ? +v : d);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ═══════════════════════════════════════════════════════════════
// СОСТОЯНИЕ ЧАТА
// ═══════════════════════════════════════════════════════════════
let state = null;

function defaultState() {
    return {
        version: 1,
        setting: null,          // { era, faith, place }
        place: null,            // текущее место (меняется по тегу place=)
        today: null,            // номер дня в календаре мира
        when: null,             // дата так, как её говорит история
        clock: null,            // часы
        holidays: [],           // { start, days, name, meaning, type }
        birthdays: {},          // { user: {m,d}, char: {m,d} }
        prep: null,             // { hid, day, people, mood, char }
        days: {},               // `${hid}#${n}` → { title, morning, day, evening, night }
        recaps: [],             // { hid, name, text }
        recapDone: {},
        people: [],             // [{ name, group, now, gift }] — текущий список, заменяется целиком
        activeHid: null,        // праздник, к которому относятся люди и мысли персонажа
        highlights: {},         // hid → [{ name, text }] — кто чем отличился, помним до конца праздника
        backoff: {},            // тип запроса → ход, до которого его не повторяем (ИИ проигнорировал)
        evts: [],               // ивенты и мероприятия: { id, hid, kind, title, who, status, turn, lastUpdate, note, moments }
        lastEventEnd: -99,
        evRoll: false,          // выпал шанс: в следующем ответе (или запросе помощника) предложить случайный ивент
        evDecisions: {},        // решения игрока по ивентам (по названию): accepted | declined — переживают свайпы
        pair: null,             // {{char}} и {{user}}: { f: дружба −100…100, r: романтика −100…100, note }; null — ещё не ясно
        pairDrop: -99,          // когда дружба заметно упала (ссора) — шанс свидания выше
        pairSet: null,          // правка игрока: { pair, at } — ответы до at включительно её не перезаписывают
        lastBondTurn: -99,      // когда основная модель (или помощник) последний раз прислали bond
        bondMiss: 0,            // сколько ответов подряд без bond, пока пара не ясна
        bondSide: -99,          // когда помощника последний раз просили начальные значения пары
        dateRollTry: 0,         // выпавшее свидание модель пропустила — просим ещё раз, настойчивее
        inv: null,              // приглашение в пути: { kind: bday|extra, key, cid|xid, name, host, whom, day, status: offered|accepted|declined, turn, msg }
        invRoll: null,          // выпал бросок: в следующем ответе кто-то зовёт — { kind, key, name, host, whom, day, tries }
        invCool: {},            // ключ → ход, до которого его не бросаем (модель так и не позвала)
        invDeclined: null,      // { name, host, turn } — игрок только что отказался
        extras: [],             // дополнительные праздники от модели: { id, start, days, name, host, whom, meaning }
        lastExtrasTurn: -99,
        skipAsk: [],            // таймскип перепрыгнул принятое приглашение — спросить, пришли ли: { id, kind, key, cid, what, host, day, turn }
        hurt: [],               // обещали прийти и не пришли: { who, what, turn }
        decMsg: {},             // решение игрока → номер сообщения, к которому оно относится (удалили сообщение — решение снимается)
        datePlan: null,         // план свидания от помощника: { title, goal, hook, where, at } — основная модель зовёт по нему
        dateRecapFor: null,     // id закончившегося свидания, к которому ещё нужен итог
        dateRecapTurn: null,
        dateMissed: null,       // { title, turn } — намеченное свидание не состоялось (одна строка в промпт)
        dateSeenMsg: null,      // до какого сообщения помощник уже судил ход свидания
        date: null,             // свидание: { id, title, goal, hook, steps [{t, who, done}], score, status offered|active|ended, … }
        dateRoll: false,        // выпал шанс: предложить свидание
        lastDateEnd: -99,
        datesDone: [],          // прошедшие свидания: { title, result, score }
        dateDecisions: {},      // решения игрока по предложенным свиданиям (по названию) — переживают свайпы
        cast: [],               // люди истории: { id, name, group, who, bday {d,m,y}, rel {user, char}, edited, relLock }
        castNo: [],             // убранные игроком — ИИ их не вернёт
        lastCastTurn: -99,
        lastCensusTurn: -99,    // перепись людей истории по большому окну сообщений
        flashbacks: [],         // воспоминания: { id, title, text, when, kind } — в контекст только по кнопке
        recall: null,           // id воспоминания, которое уйдёт в следующий ответ
        planPart: {},           // `${hid}#${день}` → часть дня, к которой распорядок уже подстроен
        lastPeopleTurn: -99,
        care: {},               // hid → high | normal | low — насколько праздник важен персонажу
        gifts: {},              // hid → true/false — предполагает ли праздник подарки
        giftTo: {},             // hid → кому по обычаю дарят (виновник торжества)
        charNow: null,          // { hid, text, turn } — мысль или действие персонажа сейчас
        charLog: {},            // hid → [{ text, turn }] — цепочка шагов персонажа, чтобы действия были последовательны
        charGifts: {},          // hid → { text, got, done, turn } — подарок {{char}} к этому празднику (у каждого свой)
        ready: {},              // hid → { log: [{ t, who, turn }], sum, gifts: { имя: { text, stage } } } — подготовка, как её показала история
        cancelled: {},          // hid → { how: cancelled|moved, to, why, turn, name } — история отменила или перенесла праздник
        offNote: null,          // { name, how, to, why, turn } — сказать основной модели, что праздника больше нет (или он позже)
        readySeenMsg: null,     // до какого сообщения помощник уже записал подготовку
        userGift: {},           // hid → { text, done, by: hand|story } — подарок {{user}} имениннику: вписал игрок или {{user}} сам сказал
        giftMode: {},           // hid → joint|own — подарок имениннику общий или каждый свой (выбор игрока)
        langSlip: false,        // в прошлом ответе значения пришли не на том языке
        forceCal: false,
        banned: [],             // ключи названий праздников, которые игрок удалил
        bannedNames: [],        // сами названия — для промпта
        birthdayOff: {},        // удалённые дни рождения { user: true }
        offers: [],             // поводы из истории, ждут решения игрока: { id, cause, name, start, days, meaning, type, prep, turn }
        offerNo: [],            // названия отклонённых поводов — больше не предлагаем
        offerSeen: [],          // отклонённые (или так и не решённые) за год: { name, cause, start, y } — помощник их больше не предлагает
        bdayAsked: false,       // дни рождения {{user}} и {{char}} уже спрашивали: нет в карточке — не выдумываем
        diag: null,             // почему нет календаря: notag | nocal | lang
        diagNames: [],          // что пришло не на том языке — показать игроку
        calMiss: 0,             // сколько раз подряд ИИ пропустил календарь
        yearLog: null,          // текущий год: { y, from, items: [{ id, name, birthday, who, type, start, days, kept }] }
        lived: {},              // hid → true: история застала этот праздник (не перепрыгнула скипом)
        skipFrom: null,         // день, с которого время прыгнуло далеко вперёд — спросить, какие праздники проскочили
        beat: null,             // что праздник может принести в следующий ответ (от отдельного запроса)
        beatLog: [],            // последние такие подсказки — чтобы не повторялись
        lastSideTurn: -99,      // когда отдельный запрос последний раз дошёл
        nudge: null,            // кто из людей праздника может зайти в следующий ответ
        nudgeIdx: 0,
        whoIdx: 0,              // чьё желание основная модель обновляет в этом ответе (по очереди)
        missed: 0,
        turn: 0,
        lastMention: -99,
        mentionNow: false,
        snapshots: [],          // состояние ДО обработки ответа — для свайпов и удалений
    };
}

/** «Узнал, что вечером будут гуляния» — это обстановка, а не что-то личное о человеке */
const SITUATION = /(сегодня|завтра|этим вечером|(?:вечером|ночью|днём|днем)\s+(?:будут|будет|пройд|состоит|начн)|(?:будут|будет|пройдут|пройдёт|пройдет)\s+(?:\S+\s+)?(?:гулян|праздн|вечерин|концерт|салют|ярмарк|фестивал)|tonight|today|tomorrow|this evening|there will be)/i;
const PLAN_KEYS = ['title', 'where', 'morning', 'day', 'evening', 'night'];
/** «Тёщины вечёрки… night=Застолья стихают» в одном поле → две части дня */
function splitPlan(plan) {
    if (!plan || typeof plan !== 'object') return plan;
    const re = /\s+(title|where|morning|day|evening|night)\s*=\s*/i;
    for (let round = 0; round < 4; round++) {
        let moved = false;
        for (const k of PLAN_KEYS) {
            const v = plan[k];
            const m = typeof v === 'string' ? v.match(re) : null;
            if (!m) continue;
            plan[k] = v.slice(0, m.index).trim();
            const key = m[1].toLowerCase(), rest = v.slice(m.index + m[0].length).trim();
            if (rest && !plan[key]) plan[key] = rest.charAt(0).toUpperCase() + rest.slice(1);
            moved = true;
        }
        if (!moved) break;
    }
    return plan;
}
function loadState() {
    if (!chat_metadata[META_KEY]) chat_metadata[META_KEY] = defaultState();
    state = chat_metadata[META_KEY];
    const def = defaultState();
    for (const k of Object.keys(def)) if (state[k] === undefined) state[k] = def[k];
    // эпоха — теперь своя у каждого чата: старый чат берёт ту, что была у персонажа, новый определяет сам
    if (state.eraMode === undefined) state.eraMode = state.setting ? (eraMap()[charKey()]?.era || 'auto') : 'auto';
    // до 1.0.8 переименованный праздник мог попасть под запрет собственного старого названия и пропасть из инфоблока:
    // праздник, поправленный игроком и всё ещё лежащий в календаре, важнее запрета — снимаем его
    for (const h of (state.holidays || []).filter(x => x.edited && isBanned(state, x.name))) {
        const keys = banKeys(h.name);
        state.banned = (state.banned || []).filter(b => !keys.some(k => namesMatch(k, b)));
        state.bannedNames = (state.bannedNames || []).filter(n => !namesMatch(n, h.name));
        console.info(`[Hearthtide] «${h.name}»: снят запрет, из-за которого переименованный праздник пропал`);
    }
    // распорядок, где модель забыла «|» и следующая часть дня осталась в тексте («…вечер. night=…»)
    for (const k of Object.keys(state.days || {})) state.days[k] = splitPlan(state.days[k]);
    // старые итоги праздников → в воспоминания
    if (!state.flashbacks.length && state.recaps?.length) {
        state.flashbacks = state.recaps.map((r, i) => ({ id: `fb-old-${i}`, title: r.name, text: r.text, when: null, kind: 'holiday' }));
    }
    // подарок {{char}} был один на всё — теперь у каждого праздника свой
    if (state.charGift?.hid) {
        if (!state.charGifts[state.charGift.hid]) state.charGifts[state.charGift.hid] = { text: state.charGift.text, got: !!state.charGift.done, done: !!state.charGift.done, turn: state.turn };
        delete state.charGift;
    }
    for (const sn of state.snapshots || []) {
        const d = sn.data;
        if (d?.charGift?.hid) { d.charGifts = { ...(d.charGifts || {}), [d.charGift.hid]: { text: d.charGift.text, got: !!d.charGift.done, done: !!d.charGift.done } }; delete d.charGift; }
        if (d) for (const k of ['charGifts', 'ready', 'cancelled']) if (!d[k]) d[k] = {};
    }
    // место, сохранённое вместе с английским словом-типом («settlement Деревня Березовка»)
    if (state.place) state.place = tidyPlace(state.place);
    if (state.setting?.place) state.setting.place = tidyPlace(state.setting.place);
    // люди из старых версий: роли, родня по сторонам, романтика — кнопками
    migrateCast(state, getUserName(), getCharName());
    // свидание из прошлой версии: шаги разом и шкала с 35 % → живые шаги
    migrateDate(state);
    // узнанное друг о друге — теперь общее для пары; из прошлой версии берём то, что было в последнем свидании
    if (!state.pairKnown) state.pairKnown = { char: [...(state.date?.learned?.char || [])], user: [...(state.date?.learned?.user || [])] };
    // из прошлых версий там могло остаться не личное («вечером будут гуляния») — убираем
    for (const who of ['char', 'user']) {
        state.pairKnown[who] = (state.pairKnown[who] || []).filter(t => !SITUATION.test(t));
        if (state.date?.learned?.[who]) state.date.learned[who] = state.date.learned[who].filter(t => !SITUATION.test(t));
    }
    // приглашение на день рождения из прошлой версии → общее приглашение
    if (state.bdInv) {
        const b = state.bdInv;
        if (!state.inv && b.cid) state.inv = { kind: 'bday', key: bdKey(b.cid, b.day), cid: b.cid, name: b.name, host: b.name, whom: 'both', day: b.day, status: b.status === 'pending' ? 'offered' : b.status, turn: b.turn };
        delete state.bdInv;
    }
}

// ИИ иногда пишет тип места словом из промпта на другом языке: «settlement Деревня Березовка» → «Деревня Березовка»
function tidyPlace(v) {
    const s = String(v ?? '').trim();
    const m = langMode() === 'en'
        ? s.match(/^[а-яё][а-яё' -]*?\s+(?=[a-z])/i)
        : s.match(/^[a-z][a-z' -]*?\s+(?=[а-яё])/i);
    return m ? s.slice(m[0].length) : s;
}

function saveState() {
    chat_metadata[META_KEY] = state;
    saveChatDebounced();
}

const getUserName = () => name1 || 'User';
function getCharName() {
    const c = this_chid !== undefined ? characters[this_chid] : null;
    return c?.name || 'the characters';
}

// пару сверяем, если bond не приходил столько ответов
/** Личные, семейные поводы и встречи — не общий календарь: только через карточку «Принять / Отклонить» */
const STORY_TYPES = ['family', 'personal', 'gathering'];

// «деревня», «город», «village» без собственного имени — просим ИИ назвать место
const GENERIC_PLACES = /^(деревня|село|сельцо|город|городок|посад|слобода|усадьба|двор|монастырь|лагерь|стан|дорога|лес|поле|village|town|city|court|monastery|camp|road|wilds|forest|hamlet|estate|castle|замок|крепость|острог)$/i;

/** Принятые приглашения (дни рождения людей истории, дополнительные праздники), ещё не прошедшие */
function acceptedAhead() {
    if (state?.today == null) return [];
    return allHolidays(state).filter(h => (h.npc || h.extra) && h.start + h.days - 1 >= state.today);
}
function ctxFor() {
    const phase = phaseOf(state);
    const placeName = state.place || state.setting?.place || null;
    return {
        state, phase,
        tracked: trackedOccasions(state),
        userName: getUserName(), charName: getCharName(),
        part: dayPart(state.clock),
        placeName,
        placeUnnamed: !!placeName && GENERIC_PLACES.test(String(placeName).trim()),
        // сохранённые раньше значения не на том языке — попросить переписать
        fixPlace: !!placeName && !langOk(placeName),
        fixSetting: !!state.setting && (!langOk(state.setting.era) || !langOk(state.setting.faith)),
        banned: state.bannedNames || [],
        // игрок переименовал праздник в другой — ИИ дописывает новый смысл
        meaningFor: (state.holidays || []).find(h => h.needMeaning && !isBanned(state, h.name))?.name || null,
        // чтобы ИИ не предлагал одно и то же: ждущие решения и недавно отклонённые
        // скип: какие праздники проскочили; и что в этом году уже было — только для запроса календаря
        skipGap: state.skipFrom != null && state.today != null
            ? { from: isoOf(Math.max(state.skipFrom, state.yearLog?.y === fromDayNum(state.today).y ? state.yearLog.from : dayNum(fromDayNum(state.today).y, 1, 1))), to: isoOf(state.today - 1) } : null,
        passed: (state.yearLog?.items || []).filter(i => !i.birthday && i.name && !isBanned(state, i.name)).slice(-10).map(i => i.name),
        offerNames: (state.offers || []).map(o => o.name).slice(0, 4),
        // отклонённые игроком за этот год — помощник их больше не предлагает, даже под другим названием
        offerSeen: offerSeenThisYear().map(x => (x.cause && !namesMatch(x.cause, x.name) ? `${x.name} (${x.cause})` : x.name)),
        peopleSeen: peopleSeen(),
        ...castForPrompt(),
        dateLevel: dateLevel(),
        // где могут случиться ивенты; принятые приглашения впереди (чтобы модель не «сходила» туда раньше дня)
        evTarget: evTarget(phase),
        acceptedAhead: acceptedAhead(),
        // {{char}} сам вспоминал свидание в последних ответах — не подталкивать
        dateMentioned: dateMentioned(),
        castHint: [],
        eraMode: eraMode(),
        lang: L().promptLang,
    };
}

// ─── Снимки: пересчёт при свайпе и правке, откат при удалении ───
function takeSnapshot(beforeMsg) {
    state.snapshots = state.snapshots.filter(s => s.beforeMsg < beforeMsg);
    const { snapshots, ...rest } = state;
    state.snapshots.push({ beforeMsg, data: clone(rest) });
    if (state.snapshots.length > 20) state.snapshots = state.snapshots.slice(-20);
}
// Решения игрока (удалённые праздники) переживают откаты
const USER_FIELDS = ['readyNo', 'banned', 'bannedNames', 'birthdayOff', 'calIgnore', 'offerNo', 'offerSeen', 'evDecisions', 'castNo', 'dateDecisions', 'pairSet', 'bdDecisions', 'userGift', 'giftMode', 'decMsg'];

function restoreSnapshot(snap) {
    const keep = state.snapshots;
    const user = Object.fromEntries(USER_FIELDS.map(k => [k, clone(state[k] ?? null)]));
    Object.assign(state, clone(snap.data));
    for (const [k, v] of Object.entries(user)) if (v != null) state[k] = v;
    state.snapshots = keep;
    // пару, выставленную игроком, снимок из времени до правки не отменяет (более поздние уже ведут её дальше)
    if (state.pairSet?.pair && snap.beforeMsg <= state.pairSet.at) state.pair = clone(state.pairSet.pair);
    // удалённые игроком праздники не возвращаются вместе со старым снимком
    state.holidays = (state.holidays || []).filter(h => !isBanned(state, h.name));
    // и решённые поводы тоже: отклонённые и уже принятые
    state.offers = (state.offers || []).filter(o => !offerKnown(o));
}

// «Подобрать заново» — тоже решение игрока: применяем и к сохранённым снимкам,
// чтобы свайп не вернул старый календарь
function applyToSnapshots(fn) {
    for (const snap of state.snapshots) fn(snap.data);
}
const lastProcessedMsg = () => state.snapshots.reduce((m, s) => Math.max(m, s.beforeMsg), -1);

// ═══════════════════════════════════════════════════════════════
// ОБРАБОТКА ОТВЕТА ИИ
// ═══════════════════════════════════════════════════════════════
function hashText(t) {
    let h = 0;
    const s = String(t || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}
/**
 * Отпечаток самого текста ответа — без картинок, разметки и пробелов. Расширения картинок дописывают <img> прямо
 * в сообщение; раньше от этого менялся отпечаток, и ответ помощника молча выбрасывался (людей не добавлялось,
 * шаги свидания не засчитывались). Теперь картинка отпечаток не меняет.
 */
const coreText = (t) => String(t || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ').trim();
function coreHash(t) { return hashText(coreText(t)); }
/** Какой это свайп сообщения: ответы помощника привязаны к свайпу, а не к точному тексту */
const swOf = (msg) => msg?.swipe_id ?? 0;
/**
 * Записи помощника к сообщению (ht_side, ht_date, ht_confirm): сначала по точному тексту; если текст поправило
 * другое расширение (перевод, картинки, форматирование) или сам игрок — по тому же свайпу. Раньше любая чужая
 * правка текста «отвязывала» ответ помощника: карточки «Принять / Отклонить», распорядок, люди пропадали
 * при повторной обработке.
 */
function recOf(msg, field, text) {
    const map = msg?.extra?.[field];
    if (!map) return null;
    const exact = map[coreHash(text)] || map[hashText(text)];
    if (exact) return exact;
    const same = Object.values(map).filter(r => r && typeof r === 'object' && r.swipe != null && r.swipe === swOf(msg));
    return same.length ? same[same.length - 1] : null;
}
const sideOf = (msg, text) => recOf(msg, 'ht_side', text);
/** Уже есть ответ к этому тексту — или к почти тому же (чужая правка), а не к сильно дописанному («продолжить») */
function recFresh(msg, field, text) {
    const r = recOf(msg, field, text);
    if (!r) return false;
    if (msg.extra[field][coreHash(text)] || msg.extra[field][hashText(text)]) return true;
    return r.len == null || coreText(text).length - r.len < 300;
}
/** Сообщение всё то же: тот же номер и свайп (текст другое расширение могло поправить — это не повод выбрасывать ответ) */
const sameReply = (N, swipe) => { const m = chat[N]; return !!m && swOf(m) === swipe && N === lastProcessedMsg(); };

// ─── Был ли человек в ролплее: имя в последних сообщениях (с учётом падежей) ───
function recentStoryText(n = 8) {
    return chat.slice(-n).filter(m => m?.mes && !m.is_system)
        .map(m => String(m.mes).replace(/<!--[\s\S]*?-->/g, ' '))
        .join(' ').toLowerCase().replace(/ё/g, 'е');
}
function nameStem(name) {
    // «бабка Агафья» → по последнему слову; «Любава» → «люба» (ловит Любаву, Любавы)
    const words = String(name || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}]+/u).filter(w => w.length >= 3);
    const w = words[words.length - 1] || '';
    return w.length > 4 ? w.slice(0, w.length - 2) : w;
}
function seenInStory(name, text) {
    const st = nameStem(name);
    return !!st && new RegExp(`(?<![\\p{L}])${st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(text);
}
/** Люди, которые действительно есть в последних сообщениях — только их показываем и отправляем ИИ */
// Люди истории для промпта: кто сейчас рядом (имя в последних сообщениях) и у кого скоро день рождения
function castForPrompt() {
    // «глазок» выключен — человек не попадает в промпт (но и не вносится заново)
    const cast = (state.cast || []).filter(c => !c.off && !castBanned(state, c.name));
    if (!cast.length) return { castSeen: [] };
    // только те, кто в последних 4 сообщениях, — не больше четырёх; люди праздника уже описаны своей строкой
    const text = recentStoryText(4);
    const near = new Set([state.inv?.cid, state.invRoll?.cid].filter(Boolean));
    const holiday = new Set((state.people || []).map(p => String(p.name || '').toLowerCase()));
    const castSeen = cast.filter(c => near.has(c.id) || ((!c.name || !holiday.has(c.name.toLowerCase()))
        && (c.name ? seenInStory(c.name, text) : [c.toU, c.toC].some(r => r && seenInStory(r, text))))).slice(0, 4);
    return { castSeen };
}

// ─── Кого часто называют в истории — подсказка для переписи людей (по всему чату, с кэшем) ───
let hintCache = { key: null, list: [] };
function castHint() {
    const key = `${chat.length}|${hashText(chat[chat.length - 1]?.mes)}|${(state.cast || []).length}|${(state.castNo || []).length}`;
    if (hintCache.key === key) return hintCache.list;
    const texts = chat.slice(-400).filter(m => m?.mes && !m.is_system).map(m => m.mes);
    const exclude = [getUserName(), getCharName(), ...(state.cast || []).map(c => c.name), ...(state.castNo || []),
        ...(state.holidays || []).map(h => h.name), state.place, state.setting?.place].filter(Boolean);
    let list = [];
    try { list = nameCandidates(texts, exclude); } catch (e) { console.warn('[Hearthtide] частые имена:', e); }
    hintCache = { key, list };
    return list;
}

function peopleSeen() {
    const text = recentStoryText(6);
    return (state.people || []).filter(p => seenInStory(p.name, text));
}

// ─── Воспоминания ───
function addFlashback(title, text, kind, parts = null) {
    state.flashbacks.push({ id: `fb-${state.turn}-${state.flashbacks.length}`, title, text, when: state.when, kind, parts });
    if (state.flashbacks.length > 40) state.flashbacks = state.flashbacks.slice(-40);
}

// ─── Ивенты: только на идущем мероприятии — свидание, праздник в сам день, день рождения ───
/** Где сейчас могут случиться ивенты: идущее свидание важнее праздника вокруг */
function evTarget(phase) {
    const d = state?.date;
    if (d?.status === 'active') return { hid: d.id, name: `the date "${d.title}"`, kind: 'date' };
    if (phase?.kind === 'today' && phase.h) return { hid: phase.h.id, name: hName(phase.h, { userName: getUserName(), charName: getCharName() }), kind: 'holiday' };
    return null;
}
function processEvents(target, small, evs, N) {
    const cur = target?.hid || null;
    for (const e of state.evts) {
        if ((OPEN_STATUSES.includes(e.status) || e.status === 'offered') && e.hid !== cur) e.status = e.status === 'offered' ? 'missed' : 'faded';
    }
    if (!cur) return;
    let ev = openEvent(state, cur);

    // Статус от ИИ: чем кончилось
    if (ev && small?.ev) {
        const note = small.evNote && langOk(small.evNote) ? small.evNote : null;
        if (ev.status === 'invited' && (small.ev === 'joined' || small.ev === 'declined')) {
            ev.status = small.ev;
            ev.lastUpdate = state.turn;
            if (small.ev === 'declined') state.lastEventEnd = state.turn;
        } else if (small.ev === 'done' || small.ev === 'skipped') {
            ev.status = small.ev;
            ev.note = note;
            state.lastEventEnd = state.turn;
            if (small.ev === 'done' && note) addFlashback(ev.title, note, ev.kind);
        }
        ev = openEvent(state, cur);
    }
    // Новые: случайный ивент только предлагается — в историю он войдёт, если игрок примет
    for (const e of evs || []) {
        if (!langOk(e.title) || (e.hook && !langOk(e.hook))) continue;
        if (e.kind === 'moment') {
            if (ev?.kind === 'party' && ev.status === 'joined') {
                ev.moments = ev.moments || [];
                if (!ev.moments.some(m => m.title === e.title)) ev.moments.push({ title: e.title, turn: state.turn });
                if (ev.moments.length > 8) ev.moments = ev.moments.slice(-8);
                ev.lastMoment = state.turn;
                ev.lastUpdate = state.turn;
            }
            continue;
        }
        if (ev || offeredEvent(state)) continue;   // одновременно — только одно
        const item = {
            id: `ev-${state.turn}`, hid: cur, kind: e.kind, title: e.title, who: e.who, hook: e.hook || null,
            status: 'offered', turn: state.turn, lastUpdate: state.turn, note: null, moments: [], msg: N,
        };
        // игрок уже решал по этому ивенту (свайп, пересборка) — его решение в силе
        const d = state.evDecisions?.[evKey(item)];
        if (d) applyEventDecision(item, d);
        state.evts.push(item);
        state.evRoll = false;
    }
    // Забытые: долго без решения или без конца — тихо закрываем
    for (const e of state.evts) {
        const idle = state.turn - (e.lastUpdate ?? e.turn);
        if (e.status === 'offered' && idle > 4) { e.status = 'missed'; state.lastEventEnd = state.turn; continue; }
        if (!OPEN_STATUSES.includes(e.status)) continue;
        if ((e.status === 'invited' && idle > 6) || (e.status === 'active' && idle > 8) || (e.status === 'joined' && idle > 25)) {
            e.status = e.status === 'invited' ? 'missed' : 'faded';
            state.lastEventEnd = state.turn;
        }
    }
    if (state.evts.length > 30) state.evts = state.evts.slice(-30);
}

// ─── Решение игрока по ивенту: принять / отклонить ───
const evKey = (e) => `${e.hid}|${String(e.title || '').toLowerCase()}`;
function applyEventDecision(e, d) {
    if (d === 'accepted') e.status = e.kind === 'party' ? 'joined' : 'active';
    else e.status = 'declined';
    e.lastUpdate = state?.turn ?? e.lastUpdate;
}
// ─── Решения игрока помнят, к какому сообщению относятся: удалили сообщение — решение снимается ───
// (свайп длину чата не меняет — там решения остаются)
function noteDecision(kind, key, msg) {
    if (msg == null) return;
    state.decMsg = { ...(state.decMsg || {}), [`${kind}:${key}`]: msg };
}
function dropDecisionsFrom(len) {
    const maps = { bd: 'bdDecisions', ev: 'evDecisions', date: 'dateDecisions' };
    const gone = [];
    for (const [k, m] of Object.entries(state.decMsg || {})) {
        if (m < len) continue;
        const i = k.indexOf(':');
        const map = maps[k.slice(0, i)], key = k.slice(i + 1);
        if (map && state[map]) { delete state[map][key]; gone.push(key); }
        delete state.decMsg[k];
    }
    if (gone.length) console.info(`[Hearthtide] удалены сообщения — сняты решения: ${gone.join(', ')}`);
}
function decideEvent(id, d) {
    const e = (state.evts || []).find(x => x.id === id);
    if (!e || e.status !== 'offered') return;
    state.evDecisions = { ...(state.evDecisions || {}), [evKey(e)]: d };
    noteDecision('ev', evKey(e), e.msg);
    const apply = (st) => {
        const x = (st.evts || []).find(y => y.id === id && y.status === 'offered');
        if (!x) return;
        if (d === 'accepted') x.status = x.kind === 'party' ? 'joined' : 'active';
        else x.status = 'declined';
        x.turn = st.turn ?? x.turn;              // «только что принят» — основная модель введёт его сразу
        x.lastUpdate = st.turn ?? x.lastUpdate;
        if (d === 'declined') st.lastEventEnd = st.turn;
    };
    apply(state);
    applyToSnapshots(apply);
    saveState();
    injectPrompts();
    renderAll();
}

// Детерминированный бросок по тексту ответа: пересборка того же ответа даёт тот же результат, свайп — новый
function rollFor(text, turn) {
    let x = 2166136261 ^ turn;
    const t = String(text || '');
    for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 16777619); }
    return (x >>> 0) % 100;
}

// Значение на нужном языке? Для русского — есть кириллица (или вовсе нет букв), для английского — латиница
function langOk(v) {
    if (!v) return true;
    const s = String(v);
    const cyr = /[а-яё]/i.test(s), lat = /[a-z]/i.test(s);
    return langMode() === 'en' ? (lat || !cyr) : (cyr || !lat);
}

/** Приветствие (до первого сообщения игрока): его свайпы ничего не запускают — всё начинается с первого ответа бота */
const isOpening = (N) => !chat.slice(0, N).some(m => m?.is_user);

/** Для разбора тегов: необычные пробелы и «[ ]» между словами — обычный пробел */
const normSpaces = (t) => String(t || '').replace(/\[[\u2000-\u200b\u2800\u00a0\u202f\u3000 ]\]/g, ' ').replace(/[\u2000-\u200b\u2800\u202f\u3000]/g, ' ');

function processReply(N) {
    const msg = chat[N];
    if (!state || !msg || msg.is_user || msg.is_system || !msg.mes) return;
    if (isOpening(N)) return;

    const snap = state.snapshots.find(s => s.beforeMsg === N);
    if (snap) restoreSnapshot(snap);
    takeSnapshot(N);
    const hadDateRoll = !!state.dateRoll;     // в промпте этого ответа была просьба позвать на свидание
    const hadDateRemind = state.dateRemind || null;   // и напоминание о намеченном свидании — оно звучит один раз
    const hadInvRoll = state.invRoll ? { ...state.invRoll } : null;   // и просьба произнести приглашение
    const hadEvRoll = state.evRoll ? { plan: state.evPlan ? { ...state.evPlan } : null, tries: state.evTry || 0 } : null;   // и просьба начать ивент
    state.turn += 1;
    state.beat = null;      // подсказка ушла в этот ответ

    // Крупные блоки после первого разбора вырезаются из текста и живут в extra —
    // при свайпе назад или повторной обработке берём их оттуда
    let text = msg.mes;
    const saved = msg.extra?.ht_raw;
    const source = saved && (saved.hash === coreHash(text) || saved.hash === hashText(text) || (saved.swipe != null && saved.swipe === swOf(msg))) ? saved.raw : text;

    // Модели с «думалкой» иногда пишут теги в рассуждениях, а в ответ не переносят — тогда берём оттуда
    const think = String(msg.extra?.reasoning || '');
    const fromThink = !/<!--\s*HT/i.test(source) && /<!--\s*HT/i.test(think);
    // странные пробелы (U+2800, U+2007, «[ ]» — модели копируют их из первого сообщения карточки) ломают разбор тегов
    const src = normSpaces(fromThink ? think : source);

    // Чистим текст сообщения от крупных блоков и «неправильных» форм тега
    // в тексте остаётся только дата, время и место: имена из who=, char=, invite= и прочего лорбук читает по ключам,
    // а всё это уже разобрано (полный ответ — в extra.ht_raw)
    const cleaned = glueTag(slimSmallTag(stripBlocks(text)));
    if (cleaned !== text && cleaned.trim()) {
        msg.mes = cleaned;
        if (Array.isArray(msg.swipes) && msg.swipe_id != null) msg.swipes[msg.swipe_id] = cleaned;
        text = cleaned;
        if (typeof msg.extra?.display_text === 'string') msg.extra.display_text = glueTag(msg.extra.display_text);
        try { stModule?.updateMessageBlock?.(N, msg); } catch (e) { /* пусто */ }
    }
    msg.extra = msg.extra || {};
    if (source !== text || !saved) msg.extra.ht_raw = { raw: source, hash: coreHash(text), swipe: swOf(msg) };

    // Ответ отдельного запроса к этому тексту (если уже пришёл): те же блоки, читаем вместе с ответом
    const sideRec = sideOf(msg, text);
    const sideText = sideRec?.text || '';
    const sideAsked = sideRec?.asked || [];
    const askedCal = sideAsked.includes('cal');
    const both = (fn) => fn(src) ?? (sideText ? fn(sideText) : null);
    const small = parseSmall(src);
    const sideSmall = sideText ? parseSmall(sideText, 'HT-S') : null;
    // поля о персонаже, подарке, ивенте, смысле и паре — из ответа; чего в ответе нет — из отдельного запроса.
    // Пустые значения помощника (0, [], false) не затирают отметки основной модели (шаги свидания, bond)
    const has = (v) => v != null && v !== false && v !== 0 && !(Array.isArray(v) && !v.length);
    const sm = small || sideSmall ? { ...(small || {}) } : null;
    for (const [k, v] of Object.entries(sideSmall || {})) {
        if (!['inner', 'date', 'clock', 'when', 'place'].includes(k) && has(v) && !has(sm[k])) sm[k] = v;
    }
    if (small?.bond && sideSmall?.bond) sm.bondNote = small.bondNote || null;   // пометка — от той же модели, что и числа
    const calRaw = (state.calIgnore || []).includes(hashText(src)) ? null : parseCalendar(src);
    const calSide = sideText && !(state.calIgnore || []).includes(hashText(sideText)) ? parseCalendar(sideText) : null;
    const cal = calRaw || calSide;
    const prep = both(parsePrep);
    // подготовка по истории: номера — из списка, который ушёл с запросом помощника
    const readySide = sideText && sideAsked.includes('ready') ? parseReady(sideText) : null;
    const day = both(parseDay);
    const recap = both(parseRecap);
    const recapParts = both(parseRecapParts);
    const people = both(parsePeople);
    const evs = [...parseEvents(src), ...(sideText ? parseEvents(sideText) : [])];
    const offersIn = [...parseOffers(src), ...(sideText ? parseOffers(sideText) : [])];
    const castIn = [parseCast(src), sideText ? parseCast(sideText) : null].filter(Boolean);
    const extrasIn = [...parseExtras(src), ...(sideText ? parseExtras(sideText) : [])];
    const planIn = sideText && sideAsked.includes('dateplan') ? parseDateBlock(sideText) : null;
    let dateIn = parseDateBlock(src) || (sideText && sideAsked.includes('datewatch') ? parseDateBlock(sideText) : null);
    // Позвали ли вслух — короткий отдельный запрос «да/нет» (при помощнике). Нет ответа — ждём его; запрос упал — верим основной модели
    const conf = recOf(msg, 'ht_confirm', text);
    // {{char}} позвал по плану помощника — приглашение из плана: место и время тоже из плана.
    // Отметку date_asked модели часто забывают — поэтому годится и подтверждение «да» из проверки
    const plan = hadDateRoll ? state.datePlan : null;
    if (plan && !dateIn?.started && (dateIn || small?.dateAsked || conf?.date === true)) {
        dateIn = { ...plan, steps: [], started: false, ...(dateIn ? { title: dateIn.title || plan.title, hook: dateIn.hook || plan.hook, kind: plan.kind || dateIn.kind } : {}) };
    }
    // время из самой истории важнее плана: «завтра к шести» — значит завтра к шести, а не «сегодня в 18:00» из плана
    if (dateIn && !dateIn.started && conf?.when && (conf.when.now || conf.when.day != null || conf.when.clock != null)) {
        const w = conf.when;
        dateIn = { ...dateIn, at: w.now ? { now: true } : { day: w.day ?? dateIn.at?.day ?? null, clock: w.clock ?? dateIn.at?.clock ?? null } };
    }
    // проверка сказала «только подумал» — приглашения нет, кубик остаётся (позовёт позже)
    if (dateIn && !dateIn.started && !dateIn.agreed && conf?.date === false) {
        console.info('[Hearthtide] свидание: проверка — персонаж только подумал о нём, приглашения нет');
        dateIn = null;
    }
    // ещё ждём проверку — карточку не показываем, но и кубик не перебрасываем
    const dateWait = !conf && !!dateIn && !dateIn.started && !dateIn.agreed;
    const beat = sideText ? parseBeat(sideText) : null;
    // Строки H, пришедшие без запроса календаря, — тоже повод из истории: решает игрок
    // и личные, семейные, встречи из календаря — тоже: в календарь сами по себе идут только общие праздники
    if (cal && !askedCal && !cal.setting && cal.holidays.length) {
        offersIn.push(...cal.holidays.map(h => ({ ...h, cause: null })));
        cal.holidays = [];
    }
    if (cal?.holidays.length) {
        const own = cal.holidays.filter(h => STORY_TYPES.includes(h.type));
        if (own.length) {
            console.info(`[Hearthtide] календарь: ${own.map(h => h.name).join(', ')} — не общий праздник, предложу карточкой`);
            offersIn.push(...own.map(h => ({ ...h, cause: null })));
            cal.holidays = cal.holidays.filter(h => !own.includes(h));
        }
    }
    if (sideRec) state.lastSideTurn = state.turn;
    if (beat && !/^none\b/i.test(beat)) {
        state.beat = beat;
        state.beatLog = [...(state.beatLog || []), beat].slice(-3);
    }

    // ── Дата, время, место ──
    let slip = false;
    const prevToday = state.today;
    if (small) {
        state.missed = 0;
        // Скип через несколько дней: праздники внутри скипа молча пропускаем (без итога)
        if (small.date != null && state.today != null && small.date - state.today > 1) {
            for (const h of allHolidays(state)) {
                const end = h.start + h.days - 1;
                if (end >= state.today && end < small.date) {
                    state.recapDone[h.id] = true;
                    // принятое приглашение проскочили — решит модель: пришли или нет (и чем это обернулось)
                    if (isGathering(h) && !state.lived?.[h.id] && !(state.skipAsk || []).some(x => x.id === h.id)) {
                        state.skipAsk = [...(state.skipAsk || []), { ...invItemOf(h), turn: state.turn }];
                        console.info(`[Hearthtide] таймскип перепрыгнул принятое приглашение: ${invItemOf(h).what} — спрошу, пришли ли`);
                    }
                }
            }
            // Большой скип: календарь знает только ближайшие праздники — спросим, какие ещё проскочили
            if (small.date - state.today > 14) {
                if (state.skipFrom == null) state.skipFrom = state.today + 1;
                state.forceCal = true;
            }
        }
        if (small.date != null) state.today = small.date;
        if (small.clock != null) state.clock = small.clock;
        slip = slip || !langOk(small.when) || !langOk(small.place);
        if (small.when && langOk(small.when)) state.when = small.when;
        if (small.place && langOk(small.place)) state.place = tidyPlace(small.place);
    } else {
        state.missed = (state.missed || 0) + 1;
    }

    // ── Календарь ──
    if (cal) {
        const before = cal.holidays.length;
        const wrong = cal.holidays.filter(h => !langOk(h.name)).map(h => h.name);
        cal.holidays = cal.holidays.filter(h => langOk(h.name));
        if (before && !cal.holidays.length) {                        // календарь пришёл, но весь не на том языке
            state.diag = 'lang';
            state.diagNames = wrong.slice(0, 4);
        }
        if (cal.holidays.length < before) slip = true;
        // эпоха «по карточке»: ИИ сказал, наши это дни или нет — запоминаем для персонажа
        if (cal.setting?.mode && eraMode() === 'auto') { setChatEra(cal.setting.mode); syncCharSettings(); }
        if (cal.setting) {
            for (const k of ['era', 'faith', 'place']) if (cal.setting[k] && !langOk(cal.setting[k])) { cal.setting[k] = null; slip = true; }
            state.setting = { ...(state.setting || {}), ...Object.fromEntries(Object.entries(cal.setting).filter(([, v]) => v)) };
            if (cal.setting.place) state.place = state.setting.place = tidyPlace(cal.setting.place);
            syncCharSettings();                     // вера в настройках — та, что определила модель
        }
        // «Подобрать заново»: старые будущие праздники убираем только теперь, когда пришли новые, —
        // раньше их стирали сразу по нажатию, и если ответ не доходил, в календаре оставались одни дни рождения
        if (state.rebuild && cal.holidays.length) {
            dropFutureHolidays(state);
            state.rebuild = false;
            if (N === lastBotIndex()) rebuiltNames = cal.holidays.map(h => h.name);
        }
        mergeHolidays(cal.holidays);
        for (const [who, md] of Object.entries(cal.birthdays)) state.birthdays[who] = md;
        // пустой календарь при пересборке — спросим ещё раз, но не бесконечно: после двух пустых оставляем прежний
        if (state.rebuild && askedCal) state.rebuildTries = (state.rebuildTries || 0) + 1;
        if (state.rebuild && state.rebuildTries >= 2) { state.rebuild = false; console.info('[Hearthtide] «Подобрать заново»: модель дважды не прислала праздников — календарь остаётся прежним'); }
        if (!state.rebuild) state.rebuildTries = 0;
        state.forceCal = !!state.rebuild;
        if (askedCal) state.bdayAsked = true;       // не прислал строку B — дня рождения не знаем, не переспрашиваем
        if (cal.passed.some(x => !langOk(x.name))) slip = true;
        logSkipped(cal.passed.filter(x => langOk(x.name)));
        state.skipFrom = null;
    }
    // Прошедшие праздники — в «Текущий год» (до того, как старые уйдут из календаря)
    logPast();
    pruneHolidays();
    // ── Новый смысл переименованного праздника ──
    if (sm?.mean) {
        const target = state.holidays.find(h => h.needMeaning && !isBanned(state, h.name));
        if (target && langOk(sm.mean)) { target.meaning = sm.mean; delete target.needMeaning; }
        else if (target) slip = true;
    }
    // ── Поводы из истории — ждут решения игрока ──
    offersAgreed = [];
    if (takeOffers(offersIn)) slip = true;
    // согласились в самой истории — без карточки, но игрок должен заметить (один раз)
    for (const h of offersAgreed) {
        const k = holidayId(h);
        if (N !== lastBotIndex() || offerAgreedToasted.has(k)) continue;
        offerAgreedToasted.add(k);
        window.toastr?.info?.(`${L().exPlanned}: ${h.name}`, 'Hearthtide');
    }
    // ── Дополнительные праздники: на них позовут (бросок), в календаре — только принятые ──
    for (const x of extrasIn) x.name = occasionName(x.name, x.meaning, x.host);
    if (extrasIn.length && mergeExtras(state, extrasIn, langOk, namesMatch, sameOccasion)) slip = true;
    if (extrasIn.length) console.info(`[Hearthtide] дополнительные праздники: ${extrasIn.map(x => `${x.name} (${isoOf(x.start)}, зовёт: ${x.host || '?'})`).join('; ')}`);
    if (askedCal || sideAsked.includes('extras')) state.lastExtrasTurn = state.turn;
    // ── Таймскип перепрыгнул принятое приглашение: пришли или нет ──
    if (state.skipAsk?.length) {
        const x = state.skipAsk[0];
        if (sm?.went != null) { state.skipAsk = state.skipAsk.slice(1); applyWent(x, sm.went, sm.wentNote && langOk(sm.wentNote) ? sm.wentNote : null); }
        else if (state.turn - x.turn > 3) { state.skipAsk = state.skipAsk.slice(1); applyWent(x, null, null); }   // не ответили — без последствий
    }
    // ── Люди истории: новые — один раз, известные — только отношения ──
    const castLog = [];
    for (const c of castIn) if (mergeCast(state, c, langOk, state.turn, castLog)) slip = true;
    if (castIn.length) console.info(`[Hearthtide] люди истории: ${castLog.join('; ') || 'пустой блок'} · всего ${state.cast.length}`);
    else if (sideAsked.includes('cast')) console.info('[Hearthtide] люди истории: помощник не прислал HT-CAST (если ответ обрезан — см. ответ выше)');
    if (sideAsked.includes('cast')) state.lastCastTurn = state.turn;
    if (sideAsked.includes('census')) state.lastCensusTurn = state.turn;
    if (sideAsked.includes('bond')) state.bondSide = state.turn;

    // ── {{char}} и {{user}}: дружба и романтика ──
    if (sm?.bond) {
        if (sm.bondNote && !langOk(sm.bondNote)) slip = true;
        const prev = state.pair;
        if (prev && sm.bond.f <= prev.f - 15) state.pairDrop = state.turn;       // заметно поссорились
        // родня друг другу — романтики нет; отметка держится, пока модель или игрок её не снимут
        const kin = sm.bondKin != null ? sm.bondKin : !!prev?.kin;
        // за один ответ пара сдвигается понемногу: романтика — по темпу, дружба — по сложности
        let { f, r } = sm.bond;
        if (prev) {
            const c = bondCap(dateLevel(), pairPace(prev.r));
            const step = (from, to, cap) => from + Math.max(-cap * 2, Math.min(cap, to - from));
            if (f !== step(prev.f, f, c.f) || r !== step(prev.r, r, c.r)) console.info(`[Hearthtide] пара: модель дала ${f}/${r}, принято ${step(prev.f, f, c.f)}/${step(prev.r, r, c.r)} (шаг не больше +${c.f}/+${c.r} за ответ)`);
            f = step(prev.f, f, c.f); r = step(prev.r, r, c.r);
        }
        const freshNote = sm.bondNote && langOk(sm.bondNote) && !owning(sm.bondNote) ? sm.bondNote : null;
        if (sm.bondNote && owning(sm.bondNote)) console.info(`[Hearthtide] подпись пары отброшена — собственническая: ${sm.bondNote}`);
        state.pair = { scale: 2, f, r: kin ? 0 : r, kin, note: freshNote || prev?.note || null, noteTurn: freshNote && freshNote !== prev?.note ? state.turn : (prev?.noteTurn ?? state.turn) };
        state.lastBondTurn = state.turn;
        state.bondMiss = 0;
    } else if (!state.pair && (small || sideRec)) {
        state.bondMiss = (state.bondMiss || 0) + 1;                              // напомним в следующем ответе
    }
    // игрок поправил пару сам — ответы до его правки её не перезаписывают (свайп, повторная обработка)
    if (state.pairSet && N <= state.pairSet.at) {
        state.pair = clone(state.pairSet.pair);
        state.lastBondTurn = state.turn;
    }
    // ── Свидание: намечено → началось → шаги (помощник или основная модель) → итог ──
    let dateEnded = null;
    const lvl = dateLevel();
    // ход свидания: при помощнике — из отдельного запроса о свидании (каждый ответ), без него — из ответа основной модели
    const dateRec = apiOn() ? recOf(msg, 'ht_date', text) : null;
    let upRaw = (dateRec ? parseDateUp(dateRec.text) : null) || (apiOn() ? null : parseDateUp(src));
    // новые шаги, дозапрошенные у помощника, когда в оценке их не хватило
    const refill = dateRec?.refill ? parseDateUp(`<!-- HT-DATE-UP\n${dateRec.refill}\n-->`) : null;
    if (refill?.add?.length) upRaw = { ...(upRaw || parseDateUp('<!-- HT-DATE-UP -->')), add: [...(upRaw?.add || []), ...refill.add] };
    const up = upRaw ? tidyDateUp(upRaw) : null;
    if (dateRec) state.dateSeenMsg = N;
    const endNow = () => { const e = finishDate(state, state.turn, dateLevel()); if (e) recordDate(state, e); return e; };
    let dd = state.date;
    // намеченное началось — в срок или раньше: только теперь шкала и шаги
    // перенесли или отменили в самой истории («давай в воскресенье в пять») — до проверки «не состоялось»
    if (dd?.status === 'scheduled' && up?.move && !up.start) {
        const m = up.move;
        dd.at = m.now ? { day: state.today, clock: state.clock ?? 18 } : { day: m.day ?? dd.at?.day ?? state.today, clock: m.clock ?? dd.at?.clock ?? 18 };
        dd.reminded = false;
        console.info(`[Hearthtide] свидание перенесли в истории: ${isoOf(dd.at.day)} ${Math.floor(dd.at.clock ?? 18)}:${String(Math.round(((dd.at.clock ?? 18) % 1) * 60)).padStart(2, '0')}`);
    }
    if (dd?.status === 'scheduled' && up?.cancel && !up.start) {
        dd.status = 'cancelled';
        dd.endWhy = up.cancel;
        state.lastDateEnd = state.turn;
        console.info(`[Hearthtide] свидание отменили в истории: ${up.cancel}`);
        dd = null;
    }
    if (dd?.status === 'scheduled' && (up?.start || dateIn?.started)) { startDate(dd, state.turn); markStart(dd); }
    if (dd?.status === 'scheduled') {
        const left = dateHoursLeft(state);
        if (left != null && left < -DATE_MISS_HOURS) {
            dd.status = 'missed';
            state.dateMissed = { title: dd.title, turn: state.turn };
            state.lastDateEnd = state.turn;
            recordDate(state, dd, true);
        }
    }
    // напоминание о намеченном свидании: один раз, когда срок близко, а {{char}} о нём молчит; после срока — не напоминаем
    if (hadDateRemind && dd?.id === hadDateRemind) dd.reminded = true;
    state.dateRemind = null;
    if (dd?.status === 'scheduled' && !dd.reminded) {
        const left = dateHoursLeft(state);
        if (left != null && left <= 4 && left >= 0 && !dateMentioned()) state.dateRemind = dd.id;
    }
    if (dd?.status === 'active') {
        // темп (слоуберн / обычный / фастберн): выбран в настройках или по романтике пары в начале свидания
        const ps = datePaceSetting();
        dd.pace = ps !== 'auto' ? ps : (dd.paceAuto ?? (dd.paceAuto = paceAuto(state.pair?.r)));
        dd.need = goalNeed(lvl, dd.pace);
        // один раз: открытые шаги из прошлых версий — не задачи («Петя уберёт…») или повторы одного вида — убираем, места дозапросим
        // шагов теперь открыто меньше (DATE_OPEN): лишние из прошлой версии уходят; цель-название — в настоящую цель
        if ((dd.taskV || 0) < 3) {
            for (const st of openSteps(dd)) if (st.slot >= DATE_OPEN) st.state = 'dropped';
            dd.goal = goalForm(dd.goal, dd.kind);
        }
        if ((dd.taskV || 0) < 2) {
            const c = getCharName(), u = getUserName();
            const kept = [];
            for (const st of openSteps(dd)) {
                const kinds = stepKinds(st.t);
                const dup = kinds.length && kept.some(k => stepKinds(k.t).some(x => kinds.includes(x)));
                const short = taskForm(st.t, c, u);
                if (short && !dup) { st.t = short; kept.push(st); }
                else { st.state = 'dropped'; console.info(`[Hearthtide] свидание: старый шаг убран (${dup ? 'повтор' : 'не задача'}): ${st.t}`); }
            }
        }
        dd.taskV = 3;
        // Конец свидания — только по истории: «подходит к концу» → конец, или таймскип. Одно «over» без предпосылок
        // лишь помечает «подходит к концу»; конец — если следующий ответ его подтвердит. Так свидание не обрывается.
        const nowAt = { day: state.today, clock: state.clock };
        dd.startAt = dd.startAt || nowAt;
        const jump = hoursBetween(dd.seenAt || dd.startAt, nowAt);
        const why = (w) => { dd.endWhy = w; console.info(`[Hearthtide] свидание закончилось: ${w}`); return endNow(); };
        if (up) {
            // узнанное — общее для пары, переживает свидание: известное раньше не «узнают» заново
            const pk = state.pairKnown || (state.pairKnown = { char: [], user: [] });
            const nk = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d ]+/gu, ' ').replace(/\s+/g, ' ').trim();
            const known = (who, t) => (pk[who] || []).some(y => nk(y) === nk(t) || nk(y).includes(nk(t)) || nk(t).includes(nk(y)));
            const dup = (up.learn || []).filter(x => known(x.who, x.t));
            if (dup.length) console.info(`[Hearthtide] свидание: уже известно — пропущено: ${dup.map(x => x.t).join(' / ')}`);
            up.learn = (up.learn || []).filter(x => !known(x.who, x.t));
            for (const x of up.learn) { (pk[x.who] = pk[x.who] || []).push(x.t); if (pk[x.who].length > 30) pk[x.who] = pk[x.who].slice(-30); }
            const r = applyDateUp(dd, up, state.turn, lvl);
            if (r.ignoredGoal) console.info('[Hearthtide] свидание: цель ещё закрыта — GOAL пропущен');
            // промах {{char}} — {{user}} не понравилось: отношения пары тоже ниже, сразу (а не только по итогу)
            for (const m of r.missteps || []) {
                const p = state.pair;
                if (!p) continue;
                const k0 = MISS_PAIR[m.big ? 'big' : 'small'], hk = lvl === 'hard' ? 1.5 : 1;
                const k = { f: Math.round(k0.f * hk), r: Math.round(k0.r * hk) };
                p.f = Math.max(-100, p.f + k.f);
                if (!p.kin) p.r = Math.max(-100, p.r + k.r);
                console.info(`[Hearthtide] свидание: промах (${m.big ? 'серьёзный' : 'небольшой'}) — ${m.t} · дружба ${k.f}, романтика ${k.r}`);
            }
            console.info(`[Hearthtide] свидание: ${up.phase || 'без STATE'}${up.why ? ` (${up.why})` : ''} · ${dd.score}% · сделано ${doneCount(dd)} · открыто ${openSteps(dd).length}${jump ? ` · прошло ${jump.toFixed(1)} ч` : ''}`);
            dd.lastSeen = state.turn;
            dd.seenAt = nowAt;
            if (up.phase === 'on') dd.closing = null;
            else if (up.phase === 'ending') dd.closing = dd.closing ?? state.turn;
            else if (up.phase === 'over') {
                if (dd.closing != null && dd.closing < state.turn) dateEnded = why(`подтвердилось: ${up.why || 'закончилось в истории'}`);
                else if ((jump ?? 0) >= DATE_SKIP_END) dateEnded = why(`таймскип ${jump.toFixed(1)} ч: ${up.why || ''}`);
                else { dd.closing = dd.closing ?? state.turn; console.info('[Hearthtide] свидание: помощник считает, что оно кончилось — пока «подходит к концу», ждём подтверждения следующим ответом'); }
            }
        }
        if (!dateEnded && (jump ?? 0) >= DATE_SKIP_HARD) dateEnded = why(`таймскип ${jump.toFixed(1)} ч`);
        if (!dateEnded && dd.closing != null && state.turn - dd.closing >= DATE_CLOSE_TURNS) dateEnded = why('подходило к концу и закончилось');
        if (!dateEnded && dd.closing == null && state.turn - (dd.lastSeen ?? dd.lastUpdate ?? dd.startTurn ?? dd.turn) > DATE_QUIET) {
            dd.closing = state.turn;
            console.info(`[Hearthtide] свидание: ${DATE_QUIET} ответов без оценки — «подходит к концу»`);
        }
    }
    // итог, дописанный после конца свидания
    if (up?.recap && state.dateRecapFor && !dateEnded) applyDateRecap(state, state.dateRecapFor, up.recap, up.best);
    // после второго и дальше свиданий: «что знают друг о друге» — сжатая сводка вместо длинного списка
    if (up?.know && (up.know.char.length || up.know.user.length)) {
        const pk = state.pairKnown || (state.pairKnown = { char: [], user: [] });
        for (const who of ['char', 'user']) {
            const list = up.know[who].slice(0, 6);
            if (!list.length) continue;
            console.info(`[Hearthtide] что знают друг о друге (${who === 'char' ? getCharName() : getUserName()}): ${(pk[who] || []).length} → ${list.length} — ${list.join('; ')}`);
            pk[who] = list;
        }
    }
    if (state.dateRecapFor && state.turn - (state.dateRecapTurn ?? state.turn) > 3) state.dateRecapFor = null;   // не дождались — без итога
    if (['offered', 'pending'].includes(state.date?.status) && state.turn - state.date.turn > 4) state.date = null;   // не ответили — забылось
    if (dateIn && !['active', 'offered', 'scheduled', 'pending'].includes(state.date?.status)
        && [dateIn.title, dateIn.goal, dateIn.hook, dateIn.where].every(langOk)) {
        const fixed = tidyDateUp({ add: dateIn.steps.map(x => ({ t: x.t })), done: [], fail: [] }).add;
        // свидание или дружеская встреча: по романтике пары, а при нуле — как решили модель и история
        const kind = dateKindFor(state.pair, dateIn.kind);
        const d = newDate({ ...dateIn, goal: goalForm(dateIn.goal, kind), steps: fixed, kind }, state.turn, dateIn.started);
        d.msg = N;
        if (d.at && !d.at.now && d.at.day == null) d.at.day = state.today;
        const dec = !dateIn.started && state.dateDecisions?.[String(d.title).toLowerCase()];
        if (dec === 'declined') d.status = 'declined';
        else if (dec === 'accepted') acceptInto(state, d);
        // договорились на потом и {{user}} уже сам сказал «да» (или сам позвал) — сразу намечено;
        // {{char}} только позвал, ответа ещё нет — карточка «Принять / Отклонить», как при броске
        else if (!dateIn.started && dateIn.agreed && (state.dateDecisions?.[String(d.title).toLowerCase()] === undefined) && sideAsked.includes('datewatch') && d.at && !d.at.now) d.status = 'scheduled';
        else if (!dateIn.started && dateIn.agreed && sideAsked.includes('datewatch') && d.at?.now) acceptInto(state, d);
        // при помощнике карточка и уведомление — только когда проверка ответила (или упала)
        else if (dateWait && d.status === 'offered') d.status = 'pending';
        if (d.status === 'active') markStart(d);
        if (d.status !== 'declined') state.date = d;
        state.dateRoll = false;
        // свидание договорили в самой истории — карточки «Пойти» не нужно (уже согласились), но игрок должен заметить
        if (sideAsked.includes('datewatch') && ['scheduled', 'active'].includes(d.status) && N === lastBotIndex() && !storyDateToasted.has(d.id)) {
            storyDateToasted.add(d.id);
            const fr = isFriendlyDate(d);
            window.toastr?.info?.(`${d.status === 'active' ? (fr ? L().outingWord : L().dateWord) : (fr ? L().outingPlanned : L().datePlanned)}: ${d.title}`, 'Hearthtide');
        }
    }

    // ── Приглашение (день рождения, дополнительный праздник): прозвучало вслух — по проверке или по invite= ──
    handleInvite(small, conf, N, text);
    // что проверить коротким запросом после этого ответа: позвал ли {{char}} на свидание, позвал ли кто-то на праздник
    // карточка приглашения ждёт ответа, а игрок с тех пор написал своё — не ответил ли он прямо в ролплее
    const userMsg = (() => { for (let i = N - 1; i >= 0; i--) if (chat[i]?.is_user) return i; return null; })();
    const pend = state.inv?.status === 'offered' && userMsg != null && state.inv.msg != null && userMsg > state.inv.msg
        ? { key: state.inv.key, user: userMsg, host: state.inv.host || null, label: state.inv.kind === 'bday' ? `${state.inv.name}'s birthday` : state.inv.name } : null;
    confirmNeed = apiOn() && !conf ? {
        N, hash: coreHash(text), pend,
        date: !!(dateIn && !dateIn.started && !dateIn.agreed) || (hadDateRoll && !!state.datePlan && state.date?.status !== 'active'),
        inv: inviteWatch(text, hadInvRoll, small?.invite),
        // просили начать ивент по плану, а отметки нет — спросить, начался ли он в тексте
        ev: hadEvRoll?.plan && !evs.some(e => e.kind !== 'moment') ? hadEvRoll.plan : null,
    } : null;
    if (confirmNeed && !confirmNeed.date && !confirmNeed.inv.length && !confirmNeed.pend && !confirmNeed.ev) confirmNeed = null;

    // ── Сегодня несколько праздников: главный — тот, что празднуют в ролплее ──
    updateFocus(sm?.focus);

    // ── Подготовка по истории: что сделано, подарки, отменили или перенесли ──
    if (readySide && applyReady(readySide, sideRec.occ || trackedOccasions(state).map(h => h.id))) slip = true;
    if (sideAsked.includes('ready')) state.readySeenMsg = N;

    // ── Подготовка, день праздника, итог — привязываем к текущей фазе ──
    let phase = phaseOf(state);
    if (prep && phase.h && (phase.kind === 'prep' || phase.kind === 'far' || phase.kind === 'today')) {
        if (langOk(prep.people) && langOk(prep.mood)) {
            state.prep = { hid: phase.h.id, day: state.today, turn: state.turn, people: prep.people, mood: prep.mood };
        } else slip = true;
        if (prep.gifts != null) state.gifts[phase.h.id] = prep.gifts;
        if (prep.giftTo && langOk(prep.giftTo) && giftToName(prep.giftTo)) state.giftTo[phase.h.id] = giftToName(prep.giftTo);
        if (prep.care) state.care[phase.h.id] = prep.care;
    }
    // Люди: список заменяется целиком — один человек, одна строка
    if (people && phase.h && (phase.kind === 'prep' || phase.kind === 'today')) {
        const hid = phase.h.id;
        // Отыгравшие своё — в «отличились» (одна строка на человека, новая заменяет старую)
        const recent = recentStoryText(10);
        const doneLang = people.done.filter(d => langOk(d.text));
        if (doneLang.length < people.done.length) slip = true;
        const doneOk = doneLang.filter(d => seenInStory(d.name, recent));   // выдуманные не принимаем
        if (doneOk.length) {
            const hl = state.highlights[hid] || (state.highlights[hid] = []);
            for (const d of doneOk) {
                const i = hl.findIndex(x => x.name.toLowerCase() === d.name.toLowerCase());
                if (i >= 0) hl[i] = d; else hl.push(d);
            }
            if (hl.length > 8) state.highlights[hid] = hl.slice(-8);
        }
        const doneNames = new Set(doneOk.map(d => d.name.toLowerCase()));
        // в списке — только те, кто уже был в истории: иначе инфоблок «показывает» людей раньше, чем они появились
        const story = recentStoryText(40);
        const unseen = people.active.filter(p => !seenInStory(p.name, story)).map(p => p.name);
        if (unseen.length) console.info(`[Hearthtide] люди праздника: ${unseen.join(', ')} — ещё не появлялись в истории, пропущены`);
        const active = people.active.filter(p => !doneNames.has(p.name.toLowerCase()) && !unseen.includes(p.name));
        const ok = active.filter(p => langOk(p.now) && langOk(p.gift));
        if (ok.length < active.length) slip = true;
        state.people = ok;
        state.lastPeopleTurn = state.turn;
    }
    // Один человек праздника за ответ: его желание теперь (по очереди, дёшево — прямо в маленьком теге)
    if (sm?.who && phase.h && (phase.kind === 'prep' || phase.kind === 'today')) {
        const p = (state.people || []).find(x => samePerson(x.name, sm.who.name));
        if (p && langOk(sm.who.text)) {
            if (!echoes(p.now, sm.who.text)) { p.now = sm.who.text; p.turn = state.turn; }
        } else if (p) slip = true;
        state.whoIdx = (state.whoIdx || 0) + 1;
    } else if ((phase.kind === 'prep' || phase.kind === 'today') && (state.people || []).length) {
        state.whoIdx = (state.whoIdx || 0) + 1;                                  // пропустил — следующий по очереди
    }
    // Мысль/действие персонажа и его подарок — из маленького тега
    if (sm && phase.h && (phase.kind === 'prep' || phase.kind === 'today')) {
        if (sm.giftTo && langOk(sm.giftTo) && !phase.h.birthday && giftToName(sm.giftTo)) state.giftTo[phase.h.id] = giftToName(sm.giftTo);
        // шаг, почти повторяющий прошлые словами, не принимаем — цепочка должна идти дальше
        const echo = (t) => (state.charLog[phase.h.id] || []).slice(-3).some(x => echoes(x.text, t));
        if (sm.char && echo(sm.char)) sm.char = null;
        if (sm.char && owning(sm.char)) { console.info(`[Hearthtide] мысль персонажа отброшена — собственническая: ${sm.char}`); sm.char = null; }
        if (sm.char) {
            if (langOk(sm.char)) {
                state.charNow = { hid: phase.h.id, text: sm.char, turn: state.turn };
                const log = state.charLog[phase.h.id] || (state.charLog[phase.h.id] = []);
                if (log[log.length - 1]?.text !== sm.char) log.push({ text: sm.char, turn: state.turn });
                if (log.length > 6) state.charLog[phase.h.id] = log.slice(-6);
            }
            else slip = true;
        }
        if (sm.gift || sm.giftDone) {
            if (sm.gift && !langOk(sm.gift)) slip = true;
            const prev = charGiftOf(state, phase.h.id);
            state.charGifts = { ...(state.charGifts || {}), [phase.h.id]: {
                text: sm.gift && langOk(sm.gift) ? sm.gift : prev?.text || null,
                got: !!(prev?.got || sm.giftDone), done: !!(sm.giftDone || prev?.done), turn: state.turn,
            } };
        }
        // подарок {{user}} имениннику — то, что {{user}} сам написал; вписанное игроком не перезаписываем
        if (phase.h.npc && (sm.ugift || sm.ugiftDone) && !giftJoint(state, phase.h)) {
            const hid = phase.h.id, prev = state.userGift?.[hid];
            if (sm.ugift && !langOk(sm.ugift)) slip = true;
            const text = prev?.by === 'hand' && prev.text ? prev.text : (sm.ugift && langOk(sm.ugift) ? sm.ugift : prev?.text || null);
            state.userGift = { ...(state.userGift || {}), [hid]: { text, got: !!prev?.got, done: !!(sm.ugiftDone || prev?.done), by: prev?.by === 'hand' ? 'hand' : 'story' } };
        }
    }
    if (day && phase.kind === 'today' && ['title', 'where', 'morning', 'day', 'evening', 'night'].some(k => day[k] && !langOk(day[k]))) { slip = true; }
    else if (day && (phase.kind === 'today' || sideRec?.dayKey)) {
        // Распорядок дополняется: пришедшие части заменяют старые, прошедшие остаются.
        // Ключ — праздник, о котором помощника спрашивали (если сегодня их несколько, главный мог смениться в этом же ответе)
        const askedKey = sideRec?.dayKey && !parseDay(src) && activeOccasions(state).some(h => sideRec.dayKey.startsWith(`${h.id}#`)) ? sideRec.dayKey : null;
        const key = askedKey || (phase.kind === 'today' ? `${phase.h.id}#${phase.dayIndex}` : null);
        if (key) {
            const prevPlan = state.days[key] || {};
            for (const k of Object.keys(day)) if (day[k] == null) delete day[k];
            Object.assign(day, { ...prevPlan, ...day });
            state.planPart[key] = dayPart(state.clock) || 'morning';
            state.days[key] = day;
        }
    }
    if (recap && !langOk(recap)) slip = true;
    if (recap && phase.ended && langOk(recap)) {
        const parts = recapParts && [...recapParts.done, ...recapParts.gifts, recapParts.best].filter(Boolean).every(langOk) ? recapParts : null;
        addFlashback(displayName(phase.ended), recap, 'holiday', parts);
        // приглашение: пришли ли на самом деле
        if (isGathering(phase.ended) && recapParts?.went != null) applyWent(invItemOf(phase.ended), recapParts.went, null);
        state.recaps.push({ hid: phase.ended.id, name: displayName(phase.ended), text: recap, parts });
        if (state.recaps.length > 30) state.recaps = state.recaps.slice(-30);
        state.recapDone[phase.ended.id] = true;
    }
    // ── Ивенты и мероприятия ──
    // основная модель начала ивент, но отметку HT-EV не поставила — проверка подтвердила, что он начался: берём план помощника
    const evPlanNow = hadEvRoll?.plan;
    if (evPlanNow && !evs.some(e => e.kind !== 'moment') && conf?.ev === true) {
        evs.push({ kind: evPlanNow.kind === 'party' ? 'party' : 'event', title: evPlanNow.title, who: evPlanNow.who || null, hook: conf.evHook || evPlanNow.hook || null });
        console.info(`[Hearthtide] ивент начался в ответе без отметки — по проверке: ${evPlanNow.title}`);
    }
    processEvents(evTarget(phase), sm, evs, N);
    const evStarted = (state.evts || []).some(e => e.turn === state.turn && e.kind !== 'moment');
    // помощника просили переписать распорядок, а он не прислал — значит, план в силе: до следующей части дня не переспрашиваем
    if (sideAsked.includes('replan') && !day && phase.kind === 'today' && phase.h) {
        state.planPart[`${phase.h.id}#${phase.dayIndex}`] = dayPart(state.clock) || 'morning';
    }
    // воспоминание по кнопке ушло в этот ответ — больше не повторяем
    if (state.recall) {
        const fb = state.flashbacks.find(f => f.id === state.recall);
        if (fb) fb.recalled = (fb.recalled || 0) + 1;
        state.recall = null;
    }

    phase = phaseOf(state);
    // история застала праздник — в «Текущем году» он будет отмеченным, а не прошедшим мимо
    if (phase.kind === 'today' && phase.h) state.lived[phase.h.id] = true;
    if (small || cal || prep || people || day || recap || offersIn.length) state.langSlip = slip;
    // Праздник сменился или был скип на несколько дней — люди и мысли прошлого праздника больше не актуальны
    const curHid = phase.h && (phase.kind === 'prep' || phase.kind === 'today') ? phase.h.id : null;
    const jumped = prevToday != null && state.today != null && state.today - prevToday > 1;
    if (curHid !== state.activeHid || jumped) {
        if (!people) {                       // свежий список, пришедший в этом же ответе, не трогаем
            state.people = [];
            state.lastPeopleTurn = -99;
        }
        if (state.charNow?.hid !== curHid) state.charNow = null;
        state.activeHid = curHid;
    }
    // Праздник прошёл — люди и мысли персонажа к нему больше не относятся
    if (!phase.h || (phase.kind !== 'prep' && phase.kind !== 'today')) {
        if (state.charNow && state.charNow.hid !== phase.h?.id) state.charNow = null;
    }

    // ── Случайный ивент: только на идущем мероприятии (свидание, праздник в сам день, день рождения); шанс — из настроек ──
    state.evRoll = false;
    const tgt = evTarget(phase);
    const evChance = evChanceSetting();
    // просили начать ивент, а модель не начала (и проверка не нашла) — ещё одна попытка с тем же планом, без нового броска
    const evRetry = hadEvRoll && !evStarted && hadEvRoll.tries < 1 && tgt && (!hadEvRoll.plan || hadEvRoll.plan.hid === tgt.hid) && !openEvent(state, tgt.hid) && !offeredEvent(state);
    if (evRetry) {
        state.evRoll = true;
        state.evTry = hadEvRoll.tries + 1;
        console.debug('[Hearthtide] ивент: модель не начала — пробую ещё раз в следующем ответе');
    } else if (tgt && evChance > 0 && !openEvent(state, tgt.hid) && !offeredEvent(state)
        && state.turn - (state.lastEventEnd ?? -99) >= EVENT_COOLDOWN
        && state.turn - Math.max(-99, ...(state.evts || []).filter(e => e.hid === tgt.hid).map(e => e.turn)) >= EVENT_COOLDOWN) {
        const r = rollFor(text, state.turn);
        state.evRoll = r < evChance;
        console.debug(`[Hearthtide] ивент (${tgt.kind}): бросок ${r} ${state.evRoll ? '<' : '≥'} ${evChance}%`);
    }
    if (!evRetry) state.evTry = 0;
    // план ивента: пришёл от помощника к этому ответу — держим, пока бросок в силе; иначе сбрасываем
    const evPlanRec = recOf(msg, 'ht_evplan', text);
    const evPlanIn = (sideText && sideAsked.includes('evplan') ? parseEvPlan(sideText) : null) || (evPlanRec ? parseEvPlan(evPlanRec.text) : null);
    if (state.evRoll && tgt) {
        if (evPlanIn && langOk(evPlanIn.title)) state.evPlan = { ...evPlanIn, hid: tgt.hid, turn: state.turn };
        else if (state.evPlan && state.evPlan.hid !== tgt.hid) state.evPlan = null;
    } else state.evPlan = null;

    // ── Приглашения: бросок после ответа — кого из близких позовут (чем ближе день и человек, тем вероятнее) ──
    rollInvite(text, hadInvRoll, conf);

    // ── Свидание: бросок после ответа (есть романтика; после ссоры шанс выше) ──
    // Выпало, а модель промолчала — просим ещё раз, настойчивее (один раз); потом — новый бросок
    // свободно — всё, кроме идущего, предложенного и намеченного (раньше «не состоялось» навсегда блокировало броски)
    const free = !['active', 'offered', 'scheduled', 'pending'].includes(state.date?.status);
    const di = dateChanceInfo(state, state.turn, dateChanceSetting());
    if (free && hadDateRoll && !dateIn && !conf && state.datePlan && di.chance > 0) {
        // проверка «позвали ли вслух» ещё не ответила — ответ обработается заново, когда она придёт
        state.dateRoll = true;
    } else if (free && hadDateRoll && !dateIn && !(state.dateRollTry > 0) && di.chance > 0) {
        state.dateRoll = true;
        state.dateRollTry = 1;
        console.info('[Hearthtide] свидание: выпало, но модель не позвала — прошу ещё раз');
    } else {
        state.dateRollTry = 0;
        const roll = free && di.chance > 0 ? rollFor(text, state.turn + 7919) : null;
        state.dateRoll = roll != null && roll < di.chance;
        state.datePlan = null;
        if (roll != null) console.info(`[Hearthtide] свидание: бросок ${roll} ${state.dateRoll ? '<' : '≥'} ${di.chance}% — ${state.dateRoll ? 'выпало, позовёт в следующем ответе' : 'не выпало'}`);
        else if (free) console.debug(`[Hearthtide] свидание: шанса нет (${di.why}${di.left ? `, ещё ${di.left}` : ''}${di.r != null ? `, романтика ${di.r}` : ''})`);
    }

    // план от помощника — к выпавшему свиданию (при повторе просьбы старый план остаётся)
    if (state.dateRoll && planIn && [planIn.title, planIn.goal, planIn.hook, planIn.where].every(langOk)) {
        state.datePlan = { title: planIn.title, goal: goalForm(planIn.goal, dateKindFor(state.pair, planIn.kind)), hook: planIn.hook, where: planIn.where, at: planIn.at, kind: dateKindFor(state.pair, planIn.kind), turn: state.turn };
        console.info('[Hearthtide] свидание: план помощника —', state.datePlan.title, '·', state.datePlan.where || '', '·', JSON.stringify(state.datePlan.at));
    }
    if (!state.dateRoll || !free) state.datePlan = null;

    // ── Упоминать ли подготовку в следующем ответе (чем ближе, тем чаще) ──
    state.mentionNow = false;
    // и когда готовятся к принятому приглашению или поводу из истории — чем ближе день, тем чаще
    const nearTracked = pushTracked(state).filter(x => x.start > state.today).reduce((m, x) => (m == null ? x.start - state.today : Math.min(m, x.start - state.today)), null);
    const mentionDays = phase.kind === 'prep' ? phase.daysTo : nearTracked;
    if ((phase.kind === 'prep' || (phase.kind !== 'today' && nearTracked != null)) && state.turn - state.lastMention >= mentionEvery(mentionDays)) {
        state.mentionNow = true;
        state.lastMention = state.turn;
    }
    // ── Кто из людей праздника может зайти в следующий ответ: по очереди, не толпой ──
    state.nudge = null;
    const nudgeNow = phase.kind === 'today' ? state.turn % 2 === 0 : state.mentionNow;
    if (phase.h && nudgeNow && pushable(state, phase.h)) {
        const ppl = (state.people || []).filter(p => p.now);   // список людей сбрасывается при смене праздника
        if (ppl.length) {
            const p = ppl[(state.nudgeIdx || 0) % ppl.length];
            state.nudgeIdx = (state.nudgeIdx || 0) + 1;
            state.nudge = { name: p.name, now: p.now };
        } else state.nudge = { name: null };
    }
    gatePushes(phase, text);

    // ── Снимок для инфоблока этого сообщения ──
    // Почему нет праздников — подсказка в инфоблоке, чтобы было видно, чья это проблема
    if (!small) state.diag = 'notag';
    else if (cal && cal.holidays.length) state.diag = null;
    else if (askedCal && !cal) state.diag = 'nocal';                          // просили календарь — не прислал
    else if (state.diag === 'notag') state.diag = null;

    msg.extra.ht = viewSnapshot(phase);
    if (rebuiltNames) {
        window.toastr?.success?.(L().rebuiltToast(rebuiltNames.slice(0, 4).join(', ')), 'Hearthtide');
        rebuiltNames = null;
    }
    // свидание закончилось в этом ответе — уведомление посреди экрана (один раз)
    if (dateEnded) showDateToast(dateEnded);
    // {{char}} зовёт на свидание — короткое уведомление сверху (один раз на приглашение)
    if (state.date?.status === 'offered' && state.date.turn === state.turn && N === lastBotIndex()) showDateInvite(state.date);
    // новый повод из истории (позвали на встречу, вечеринку, поездку) — тоже уведомление сверху: решение за игроком
    const of = (state.offers || [])[0];
    if (of && of.turn === state.turn && N === lastBotIndex() && state.date?.status !== 'offered') {
        showDateInvite({ id: `of-${of.id}`, title: of.name, head: of.host ? L().offerHost(of.host) : L().offerHol, icon: holidayIcon(of), target: '.ht-cards .ht-offer' });
    }
    const iv = state.inv;
    if (iv?.status === 'offered' && iv.turn === state.turn && N === lastBotIndex()) {
        showDateInvite({ id: `inv-${iv.key}`, title: iv.kind === 'bday' ? L().bdInviteToast(iv.name) : L().exInviteToast(iv.name), head: iv.kind === 'bday' ? L().bdInvite : L().exInvite, icon: iv.kind === 'bday' ? 'fa-gift' : 'fa-champagne-glasses', target: '.ht-cards .ht-bdinv' });
    }

    saveState();
    injectPrompts();
    scheduleRenderAll();
}

// ═══ Подготовка по истории ═══
// Инфоблок не придумывает подготовку: инджект подталкивает мир (BEAT), основная модель показывает это в ролплее,
// помощник читает историю и записывает сделанное (HT-READY). Только потом это появляется в инфоблоке.
const factKey = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d ]+/gu, ' ').replace(/\s+/g, ' ').trim();
/** Тот же факт другими словами: совпадает, входит один в другой или почти все основы слов общие */
function sameFact(a, b) {
    const x = factKey(a), y = factKey(b);
    if (!x || !y) return false;
    if (x === y || x.includes(y) || y.includes(x)) return true;
    const st = (t) => new Set(t.split(' ').filter(w => w.length >= 4).map(w => w.slice(0, 5)));
    const A = st(x), B = st(y);
    if (!A.size || !B.size) return false;
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    return n / Math.min(A.size, B.size) >= 0.6;
}
/** Слово из имени без падежа: «Егору», «Егора» — это Егор */
function stemEq(word, name) {
    const w = String(word || '').toLowerCase().replace(/ё/g, 'е'), n = String(name || '').toLowerCase().replace(/ё/g, 'е');
    if (n.length < 3 || w.length < 3) return false;
    const st = n.length > 4 ? n.slice(0, n.length - 2) : n.slice(0, 3);
    return w.startsWith(st) && w.length <= n.length + 3;
}
/**
 * Кому дарят — имя, а не «имениннику Егору» или «для Егора»: снимаем предлог и роль, падеж сводим к имени
 * из списка людей (или {{user}} / {{char}}). Длинное описание вместо имени не принимаем.
 */
function giftToName(v) {
    let x = String(v || '').trim().replace(/^(?:для|ко?|to|for)\s+/i, '');
    x = x.replace(/(?<![\p{L}])(?:именинни(?:к|ку|ка|ком|це|ца|цу|цы)|виновни(?:к|ку|ка|це|ца|цу)(?:\s+торжества)?|юбиляр\S*|the\s+birthday\s+(?:boy|girl|person)|the\s+guest\s+of\s+honou?r|the\s+host(?:ess)?)(?![\p{L}])/giu, ' ').replace(/\s+/g, ' ').trim();
    if (!x) return null;
    const known = [getUserName(), getCharName(), ...(state?.cast || []).map(c => c.name)].filter(Boolean);
    const words = x.split(' ');
    for (const k of known) if (words.some(w => stemEq(w, String(k).split(/\s+/)[0]))) return k;
    if (words.length > 3) return null;
    // незнакомое имя в дательном: «Егору» → «Егор», «Андрею» → «Андрей» (женские формы не трогаем — их не угадать)
    if (words.length === 1 && /^[А-ЯЁ]/.test(x)) x = x.replace(/^(.{2,}[бвгджзклмнпрстфхцчшщ])у$/u, '$1').replace(/^(.{2,})ею$/u, '$1ей');
    return x.charAt(0).toUpperCase() + x.slice(1);
}
/** Кто это в строке подготовки: user / char / оба / имя */
function whoOf(v) {
    const w = String(v || '').trim(), l = w.toLowerCase().replace(/ё/g, 'е');
    if (!w) return { kind: 'none', name: null };
    if (/^(both|оба|обе|вместе|together|они|they)$/.test(l) || (stemEq(l.split(/\s+/)[0], getCharName()) && l.split(/\s+/).some(x => stemEq(x, getUserName())))) return { kind: 'both', name: `${getCharName()} и ${getUserName()}` };
    if (/^(user|юзер|игрок|\{\{user\}\})$/.test(l) || stemEq(l.split(/\s+/)[0], getUserName().split(/\s+/)[0])) return { kind: 'user', name: getUserName() };
    if (/^(char|чар|\{\{char\}\})$/.test(l) || stemEq(l.split(/\s+/)[0], getCharName().split(/\s+/)[0])) return { kind: 'char', name: getCharName() };
    return { kind: 'other', name: w.charAt(0).toUpperCase() + w.slice(1) };
}
/** Игрок убрал пункт из «Уже сделано» (не о том празднике, ошибка): больше не записываем — и после свайпа */
function removeReady(hid, t) {
    if (!hid || !t) return;
    state.readyNo = { ...(state.readyNo || {}), [hid]: [...(state.readyNo?.[hid] || []), t].slice(-30) };
    const drop = (st) => { const r = st.ready?.[hid]; if (r) r.log = (r.log || []).filter(x => x.t !== t); };
    drop(state);
    applyToSnapshots(drop);
    saveState();
    injectPrompts();
    renderAll();
}

/** Блок HT-READY → в состояние. occ — id праздников в том порядке, в каком модель видела их номера */
function applyReady(r, occ) {
    if (!r) return false;
    let slip = false;
    const all = allHolidays(state);
    const byI = (i) => { const id = occ?.[i - 1]; return id ? all.find(h => h.id === id) || null : null; };
    state.ready = state.ready || {};
    const rec = (hid) => state.ready[hid] || (state.ready[hid] = { log: [], sum: null, gifts: {} });
    const log = [];
    for (const s of r.sum) {
        const h = byI(s.i);
        if (!h) continue;
        if (!langOk(s.t)) { slip = true; continue; }
        const R = rec(h.id);
        R.sum = s.t;
        R.log = R.log.slice(-3);                                  // сжали: старое — в одну фразу, последние — как были
        log.push(`${displayName(h)}: сводка`);
    }
    for (const d of r.done) {
        const h = byI(d.i);
        if (!h) { log.push(`№${d.i} — нет такого праздника, пропущено`); continue; }
        // подготовка — только до начала: то, что происходит на самом празднике, — не «уже сделано»
        if (h.start <= state.today) { log.push(`${displayName(h)} уже идёт — «${d.t}» не подготовка, пропущено`); continue; }
        // шаг подготовки — коротко; длинная фраза — это пересказ сцены, а не «что сделано»
        if (d.t.split(/\s+/).length > 9) { log.push(`«${d.t}» — пересказ, а не шаг подготовки, пропущено`); continue; }
        if (!langOk(d.t)) { slip = true; continue; }
        const R = rec(h.id);
        if ([R.sum, ...R.log.map(x => x.t)].some(t => t && sameFact(t, d.t))) continue;   // уже записано
        if ((state.readyNo?.[h.id] || []).some(t => sameFact(t, d.t))) continue;            // игрок убрал этот пункт
        const who = whoOf(/^(неизвестн|незнаком|кто-?то|unknown|someone|nobody|\?)/i.test(String(d.who || '').trim()) ? '' : d.who);
        R.log.push({ t: d.t, who: who.kind === 'none' ? null : who.name, turn: state.turn });
        if (R.log.length > 12) R.log = R.log.slice(-12);
        log.push(`${displayName(h)}: ${d.t}`);
    }
    for (const g of r.gifts) {
        const h = byI(g.i);
        if (!h) continue;
        if (!langOk(g.t)) { slip = true; continue; }
        const who = whoOf(g.who);
        const got = g.stage !== 'idea', done = g.stage === 'given';
        if (who.kind === 'char' || who.kind === 'both') {
            const prev = charGiftOf(state, h.id);
            state.charGifts = { ...(state.charGifts || {}), [h.id]: { text: g.t, got: got || !!prev?.got, done: done || !!prev?.done, turn: state.turn } };
        }
        if (who.kind === 'user' || who.kind === 'both') {
            // свой подарок {{user}} — то, что {{user}} сам написал; вписанное игроком не перезаписываем, только этап
            const prev = state.userGift?.[h.id];
            const hand = prev?.by === 'hand' && prev.text;
            state.userGift = { ...(state.userGift || {}), [h.id]: { text: hand ? prev.text : g.t, got: got || !!prev?.got, done: done || !!prev?.done, by: hand ? 'hand' : 'story' } };
        }
        if (who.kind === 'other') rec(h.id).gifts[who.name] = { text: g.t, stage: g.stage };
        log.push(`${displayName(h)}: подарок (${who.name || '?'}) — ${g.t}, ${g.stage}`);
    }
    for (const o of r.off) {
        const h = byI(o.i);
        if (!h) continue;
        // «не пришли» бывает только у мероприятия; праздник календаря идёт и без них
        if (o.how === 'missed' && !isGathering(h)) { log.push(`${displayName(h)}: «не пришли» — у праздника календаря не бывает, пропущено`); continue; }
        cancelOccasion(h, o.how, o.to, o.why && langOk(o.why) ? o.why : null);
    }
    if (log.length) console.info(`[Hearthtide] подготовка по истории: ${log.join('; ')}`);
    return slip;
}
/**
 * История отменила праздник или перенесла его на другой день. Отменённый пропадает из инфоблока вместе с подготовкой,
 * людьми и мыслями {{char}}, в «Текущем году» — «отменили»; перенесённый уходит на новую дату со всем, что к нему готовили.
 */
function cancelOccasion(h, how, to, why) {
    // уже отменён — всё; уже перенесён — можно перенести ещё раз или отменить (у дополнительного праздника id тот же)
    if (!h || (state.cancelled?.[h.id] && state.cancelled[h.id].how !== 'moved')) return;
    if (state.cancelled?.[h.id]?.how === 'moved' && state.cancelled[h.id].to === to && how === 'moved') return;
    if (how === 'moved' && (to == null || to === h.start || (h.birthday && !h.npc))) return;   // свой день рождения не переносится
    const name = displayName(h);
    state.cancelled = { ...(state.cancelled || {}), [h.id]: { how, to: how === 'moved' ? to : null, why: why || null, turn: state.turn, name } };
    if (how === 'moved') {
        let newId = h.id;                                         // дополнительный праздник: тот же id, другой день
        if (h.npc) newId = holidayId({ npc: true, cid: h.cid, start: to });
        else if (!h.extra) {
            const x = (state.holidays || []).find(y => holidayId(y) === h.id);
            if (x) { x.start = to; x.edited = true; newId = holidayId(x); state.holidays.sort((a, b) => a.start - b.start); }
        }
        if (newId !== h.id) {
            renameHidIn(state, h.id, newId);
            for (const map of ['userGift', 'giftMode', 'readyNo']) if (state[map]?.[h.id]) { state[map] = { ...state[map], [newId]: state[map][h.id] }; delete state[map][h.id]; }
        }
    } else {
        forgetHolidayIn(state, h.id);
        if (state.activeHid === h.id) { state.people = []; state.lastPeopleTurn = -99; state.nudge = null; }
        state.beat = null;                                         // подсказка могла быть о нём
        const log = ensureYear();
        if (log) logItem(log, { id: h.id, name: h.npc || h.birthday ? name : h.name, birthday: !!h.birthday, npc: !!h.npc, who: h.who, type: h.type, start: h.start, days: h.days, kept: false, result: how === 'missed' ? 'missed' : 'cancelled' });
        // не пришли, хотя звали лично, — обида и отношения ниже (у того, кто звал)
        if (how === 'missed') applyWent(invItemOf(h), false, null);
    }
    state.offNote = { name, how, to: how === 'moved' ? to : null, why: why || null, turn: state.turn };
    console.info(`[Hearthtide] ${name}: ${how === 'moved' ? `перенесли на ${isoOf(to)}` : how === 'missed' ? 'не пришли — мероприятие пропущено' : 'отменили'} по истории${why ? ` (${why})` : ''}`);
}

/**
 * Какой из сегодняшних праздников празднуют в истории: что сказал помощник, иначе — чьё название звучит
 * в последних сообщениях. Пока ни то ни другое — прежний выбор (если он ещё идёт).
 */
function updateFocus(said) {
    const all = activeOccasions(state);
    // выбираем только среди праздников первого ряда: встреча или приглашение не перебивают праздник календаря
    const top = all.length ? Math.min(...all.map(occTier)) : 0;
    const act = all.filter(h => occTier(h) === top);
    if (act.length < 2) { state.focusHid = act[0]?.id || null; return; }
    let pick = said ? act.find(h => namesMatch(hName(h, { userName: getUserName(), charName: getCharName() }), said) || (h.name && namesMatch(h.name, said))) : null;
    if (!pick) {
        const text = recentStoryText(3);
        const hits = act.map(h => {
            // «день», «праздник», «неделя» есть у многих — по ним не различить
            // по именам людей не судим — они звучат в истории всё время
            const names = [getUserName(), getCharName(), ...(state.cast || []).map(c => c.name)].filter(Boolean)
                .flatMap(n => String(n).toLowerCase().replace(/ё/g, 'е').split(/\s+/)).map(w => w.slice(0, 5));
            const words = String(h.name || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\d]+/u)
                .filter(w => (w.length >= 4 || /^\d+$/.test(w)) && !/^(день|праздн|недел|international|holiday|week|great)/.test(w) && !names.includes(w.slice(0, 5)));
            return { h, n: words.filter(w => text.includes(/^\d+$/.test(w) ? w : w.slice(0, 5))).length };
        }).sort((a, b) => b.n - a.n);
        if (hits[0].n >= 1 && hits[0].n > (hits[1]?.n ?? 0)) pick = hits[0].h;
    }
    if (pick && pick.id !== state.focusHid) console.info(`[Hearthtide] сегодня в истории празднуют: ${displayName(pick)}`);
    if (pick) state.focusHid = pick.id;
    else if (!act.some(h => h.id === state.focusHid)) state.focusHid = null;
}

// Повторяет ли фраза прошлую: хотя бы 3 общих слова (по корням длиной 5) и это 40% и больше
function echoes(a, b) {
    const set = (t) => new Set(String(t || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}]+/u).filter(w => w.length >= 4).map(w => w.slice(0, 5)));
    const A = set(a), B = set(b);
    if (!A.size || !B.size) return false;
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    return n >= 3 && n / Math.min(A.size, B.size) >= 0.4;
}

// ─── Свидание: служебное ───
/** Сколько часов прошло в истории между двумя отметками { day, clock } (null — неизвестно) */
const hoursBetween = (a, b) => (!a || !b || a.day == null || b.day == null ? null : (b.day - a.day) * 24 + (b.clock ?? 12) - (a.clock ?? 12));
const hoursUntil = (st, at) => (!at || at.now || st.today == null ? null : ((at.day ?? st.today) - st.today) * 24 + (at.clock ?? 18) - (st.clock ?? 12));
/** Игрок сказал «да»: назначено на потом — намечено (без шкалы и шагов), прямо сейчас — началось */
function acceptInto(st, d) {
    const left = hoursUntil(st, d.at);
    if (left != null && left > 0.75) d.status = 'scheduled';
    else { startDate(d, st.turn); markStart(d, st); }
}
/** Свидание началось — с этой минуты истории считаем, сколько оно идёт и не перескочил ли его таймскип */
function markStart(d, st = state) {
    if (!d || !st || st.today == null) return;
    const at = { day: st.today, clock: st.clock };
    d.startAt = at;
    d.seenAt = at;
}
/**
 * Главная цель свидания — к чему они должны прийти («Сблизиться», «Помириться»), а не название свидания
 * («Первое настоящее свидание»). По-русски — с глагола в неопределённой форме; не так — берём общую цель по виду встречи.
 */
function goalForm(g, kind) {
    const x = String(g || '').trim().replace(/[.;!]+$/, '');
    const fallback = L().goalDefault[kind === 'friendly' ? 'friendly' : 'romantic'];
    if (!x) return fallback;
    const words = x.split(/\s+/);
    const ok = /[а-яё]/i.test(x)
        ? [words[0], words[1]].some(w => /(ть|ться|тись|ти|чь|чься)$/i.test(String(w || '').replace(/[,:]$/, '')))
        : !/^(a|an|the|first|our|my|their|date|dinner|lunch|walk|evening|night|outing|trip)\b/i.test(x);
    if (!ok) console.info(`[Hearthtide] свидание: «${x}» — не цель, а название; цель — «${fallback}»`);
    return ok ? x.charAt(0).toUpperCase() + x.slice(1) : fallback;
}
/**
 * Шаг свидания — в форме задачи: глагол в неопределённой форме впереди (можно после наречия), без имени {{char}} в начале.
 * Не подходит — null (такой шаг не принимаем, на его место дозапрашиваем новый).
 */
function taskForm(t, charName, userName = '') {
    let x = String(t || '').trim().replace(/[.;!]+$/, '');
    if (!x) return null;
    // подробности «как именно» после запятой — пусть решает {{char}} в ролплее: «Коснуться пальцев, пододвигая…» → «Коснуться пальцев»
    // режем только хвост-подробность (деепричастие, «чтобы», «-ing»); «что / как / почему» — это суть шага, остаётся
    const m = x.match(/^(.+?)\s*[,—–:(]\s*(\S+)/);
    if (m && m[1].split(/\s+/).length >= 2
        && (/^(чтобы|while|so|to|by)$/i.test(m[2]) || /[а-яё]+(?:я|ясь|ав|ив|ыв|яв|вши|вшись)$/i.test(m[2]) || /^[a-z]+ing$/i.test(m[2]))) x = m[1].trim();
    // имя {{user}} в каждом шаге не нужно: «Коснуться пальцев Нины» → «Коснуться пальцев»
    const un = String(userName || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/)[0];
    if (un.length >= 3) {
        const stem = un.length > 3 ? un.slice(0, -1) : un;
        const isName = (w) => { const v = w.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}]/gu, ''); return v.startsWith(stem) && v.length <= stem.length + 3; };
        // только в конце шага — из середины имя не вырезаем, иначе ломается смысл
        const out = x.split(/\s+/);
        if (isName(out[out.length - 1])) {
            out.pop();
            if (/^(к|ко|с|со|у|для|о|об|обо|на|за|от|перед|to|with|for)$/i.test(out[out.length - 1] || '')) out.pop();   // «рядом с Ниной» → «рядом»
            if (out.length >= 2) x = out.join(' ');
        }
    }
    const words = x.split(/\s+/);
    if (words.length > 6) return null;                     // шаг — коротко и общо
    const first = words[0].toLowerCase().replace(/ё/g, 'е');
    const cname = String(charName || '').toLowerCase().replace(/ё/g, 'е');
    if (cname && first.startsWith(cname.slice(0, Math.max(3, cname.length - 2)))) return null;
    if (/[а-яё]/i.test(x)) {
        const inf = (w) => /(ть|ться|тись|ти|чь|чься)$/i.test(String(w || '').replace(/[,:]$/, ''));
        if (!inf(words[0]) && !inf(words[1])) return null;
    } else if (/^(he|she|they|i|we|will|is|was|has|had)\b/i.test(x)) return null;
    return x.charAt(0).toUpperCase() + x.slice(1);
}
/** Ответ модели о свидании: имена вместо {{user}} / (user), язык, шаги — задачи {{char}} */
function tidyDateUp(up) {
    const u = getUserName(), c = getCharName();
    const stem = (n) => String(n || '').toLowerCase().replace(/ё/g, 'е').slice(0, 4);
    const fix = (t) => (t ? String(t).replace(/\{\{user\}\}/gi, u).replace(/\{\{char\}\}/gi, c)
        .replace(/\s*\((?:user|char|both|юзер|чар|оба|вместе|игрок)\)\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim() || null : null);
    const ok = (t) => (t && langOk(t) ? t : null);
    // шаг — задача для {{char}}: «Подарить Анне венок», а не «Ярослав дарит / подарит / подарил»
    // шаг или мысль «прижать к себе, никому не отдавать», «моя» — не берём: свидание про близость, а не про обладание
    const added = (up.add || []).map(a => ({ t: owning(a.t) ? null : ok(fix(a.t)), thought: owning(a.thought) ? null : ok(fix(a.thought)) })).filter(a => a.t);
    up.add = added.map(a => ({ t: taskForm(a.t, c, u), thought: a.thought ? a.thought.replace(/^[«"“*_]+|[»"”*_]+$/g, '') : null, who: 'char' })).filter(a => a.t);
    const bad = added.filter(a => !taskForm(a.t, c, u)).map(a => a.t);
    if (bad.length) console.info(`[Hearthtide] свидание: шаги не в форме задачи — пропущены, дозапрошу: ${bad.join(' / ')}`);
    for (const x of [...(up.done || []), ...(up.fail || [])]) x.note = ok(fix(x.note));
    for (const k of ['vibe', 'thought', 'recap', 'best', 'why']) up[k] = owning(up[k]) && k !== 'why' ? null : ok(fix(up[k]));
    up.moments = (up.moments || []).map(m => ok(fix(m))).filter(Boolean);
    up.gifts = (up.gifts || []).map(g => ({ from: fix(g.from), what: ok(fix(g.what)) })).filter(g => g.what);
    // купленное на месте и съеденное, выпитое, выкуренное — не подарок (модели это путают)
    const SPENT = /(кофе|чай|кака[оу]|напит|сок|лимонад|газировк|вод[аыуе]\b|пив|вин[оау]\b|коктейл|водк|виск|пончик|булк|булоч|пирож|сэндвич|бургер|шаурм|хот-?дог|морожен|перекус|еда\b|обед|ужин|завтрак|снек|чипс|сигарет|сигар|зажигалк|жвачк|coffee|tea\b|drink|soda|beer|wine|cocktail|donut|doughnut|bun\b|snack|sandwich|burger|ice cream|meal|lunch|dinner|cigarette|cigar|lighter|gum\b)/i;
    const spent = up.gifts.filter(g => SPENT.test(g.what));
    if (spent.length) console.info(`[Hearthtide] свидание: не подарки (еда, напитки, сигареты) — пропущены: ${spent.map(g => g.what).join(' / ')}`);
    up.gifts = up.gifts.filter(g => !SPENT.test(g.what));
    const learner = (w) => {
        const x = String(w || '').toLowerCase().replace(/ё/g, 'е');
        if (/^(char|чар)/.test(x) || (stem(c).length >= 3 && x.startsWith(stem(c)))) return 'char';
        if (/^(user|юзер|игрок)/.test(x) || (stem(u).length >= 3 && x.startsWith(stem(u)))) return 'user';
        return null;
    };
    up.learn = (up.learn || []).map(x => ({ who: x.who || learner(x.whoRaw), t: ok(fix(x.t)) })).filter(x => x.t && x.who);
    // «узнали» — только о самом человеке; планы на вечер, новости и обстановка — не личное
    const sit = up.learn.filter(x => SITUATION.test(x.t));
    if (sit.length) console.info(`[Hearthtide] свидание: не личное — в «узнали» не пошло: ${sit.map(x => x.t).join(' / ')}`);
    up.learn = up.learn.filter(x => !SITUATION.test(x.t));
    up.missteps = (up.missteps || []).map(m => ({ ...m, t: ok(fix(m.t)) })).filter(m => m.t);
    if (up.know) for (const who of ['char', 'user']) up.know[who] = (up.know[who] || []).map(t => ok(fix(t))).filter(Boolean);
    return up;
}
const dateParts = (d) => ({
    done: (d.notes || []).filter(n => n.ok).map(n => n.t).slice(-5),
    // подарки — только вещи; поцелуи, признания и прочее — моменты
    gifts: (d.gifts || []).map(g => (g.from ? `${g.from}: ${g.what}` : g.what)).slice(-4),
    moments: (d.log || []).filter(x => x.kind === 'moment').map(x => x.t).slice(-4),
    learned: [...(d.learned?.char || []).slice(-3), ...(d.learned?.user || []).slice(-3)],
    goal: d.goal ? `${d.goal} — ${d.goalDone ? L().goalState.done : L().goalMissed}` : null,
    best: d.best || null,
});
/** Свидание кончилось (или не состоялось) — в «Текущий год», в итоги и воспоминания */
function recordDate(st, d, missed = false) {
    const fr = isFriendlyDate(d);
    const name = `${fr ? L().outingWord : L().dateWord}: ${d.title}`;
    const result = missed ? 'missed' : d.result;
    if (st === state) ensureYear();
    const log = st.yearLog;
    if (log && st.today != null && fromDayNum(st.today).y === log.y && !log.items.some(i => i.id === d.id)) {
        log.items.push({ id: d.id, name, birthday: false, type: 'date', friendly: fr, start: st.today, days: 1, kept: !missed, result });
        log.items.sort((a, b) => a.start - b.start);
    }
    st.recaps = st.recaps || [];
    if (!st.recaps.some(r => r.hid === d.id)) st.recaps.push({ hid: d.id, name, text: missed ? L().dateMissed : d.recap || null, parts: missed ? null : dateParts(d), result });
    st.flashbacks = st.flashbacks || [];
    if (!st.flashbacks.some(f => f.id === `fb-${d.id}`)) st.flashbacks.push({ id: `fb-${d.id}`, title: name, text: missed ? (fr ? L().outingMissed : L().dateMissed) : d.recap || L().dateResult[d.result], when: st.when, kind: 'date', friendly: fr, parts: missed ? null : dateParts(d), result });
    if (!missed && !d.recap) { st.dateRecapFor = d.id; st.dateRecapTurn = st.turn; }
}
function applyDateRecap(st, id, text, best) {
    const r = (st.recaps || []).find(x => x.hid === id);
    if (r) { r.text = text; r.parts = { ...(r.parts || { done: [], gifts: [] }), best: best || r.parts?.best || null }; }
    const f = (st.flashbacks || []).find(x => x.id === `fb-${id}`);
    if (f) { f.text = text; if (r) f.parts = r.parts; }
    if (st.date?.id === id) { st.date.recap = text; if (best) st.date.best = best; }
    st.dateRecapFor = null;
}
// ─── Приглашения: на день рождения человека из истории и на дополнительный праздник ───
/** Что именно позвали: для итогов, обид и вопроса «пришли ли» */
function invItemOf(h) {
    if (h.npc) return { id: h.id, kind: 'bday', key: bdKey(h.cid, h.start), cid: h.cid, what: displayName(h), host: h.name, day: h.start };
    if (h.extra) return { id: h.id, kind: 'extra', key: extraKey(h.xid), xid: h.xid, what: h.name, host: h.host || null, day: h.start };
    // повод из истории: обида — только если кто-то лично позвал (HOST в HT-NEW)
    return { id: h.id, kind: 'story', what: displayName(h), host: h.host || null, day: h.start };
}
/** Кто тот, кого позвали: кандидат по имени (имя человека, его роль, название праздника или кто зовёт) */
function inviteMatch(name) {
    const n = String(name || '').toLowerCase().replace(/ё/g, 'е').trim();
    if (!n) return null;
    const all = inviteCandidates(state, true);
    return all.find(c => c.kind === 'bday' && (samePerson(c.name, name) || [c.name, c.host].some(v => v && String(v).toLowerCase().replace(/ё/g, 'е') === n)))
        || all.find(c => c.kind === 'extra' && (namesMatch(c.name, name) || (c.host && namesMatch(c.host, name))))
        || null;
}
function handleInvite(small, conf, N, text = '') {
    const old = state.inv;
    if (old && state.today != null && state.today > old.day) state.inv = null;                       // день прошёл
    // игрок ответил на приглашение своей репликой в ролплее, а не кнопкой — то же решение, что по кнопке
    // (удаление его сообщения решение снимает: decMsg)
    if (state.inv?.status === 'offered' && conf?.reply && conf.pend === state.inv.key) {
        const iv = state.inv, yes = conf.reply === 'yes';
        state.bdDecisions = { ...(state.bdDecisions || {}), [iv.key]: yes ? 'accepted' : 'declined' };
        noteDecision('bd', iv.key, conf.userMsg ?? N);
        iv.status = yes ? 'accepted' : 'declined';
        if (!yes) {
            state.invDeclined = { name: iv.kind === 'bday' ? L().birthday(iv.name) : iv.name, host: iv.host, turn: state.turn };
            if (iv.kind === 'extra') rememberDeclined({ name: iv.name, cause: iv.host, start: iv.day });
        } else if (N === lastBotIndex() && !offerAgreedToasted.has(iv.key)) {
            offerAgreedToasted.add(iv.key);
            window.toastr?.info?.(`${iv.kind === 'bday' ? L().bdPlanned : L().exPlanned}: ${iv.name}`, 'Hearthtide');
        }
        console.info(`[Hearthtide] приглашение «${iv.name}»: ответ ${getUserName()} в самой истории — ${yes ? '«да», принято' : '«нет», отклонено'} без кнопки`);
    }
    if (state.inv?.status === 'offered' && state.turn - state.inv.turn > 6) {                       // не ответили — забылось
        // и больше не зовём на это же до его дня: раньше через 6 ответов приглашение снова бросалось, и чем ближе
        // день, тем вернее (за 3 дня — 55 % каждый ответ) — звали на один и тот же праздник раз за разом
        state.invCool = { ...(state.invCool || {}), [state.inv.key]: INV_FORGOT };
        console.info(`[Hearthtide] приглашение «${state.inv.name}» осталось без ответа — забылось, больше не зовём`);
        state.inv = null;
    }
    if (state.inv?.status === 'offered') return;
    // При помощнике — только по проверке «позвали ли вслух»: пока она не ответила, карточки нет
    // (основная модель ставит invite= заранее, раз её попросили позвать, — отсюда карточки раньше приглашения в тексте).
    // Без помощника или если проверка упала — по отметке, но только если в самом тексте есть имя и слова приглашения.
    if (apiOn() && !conf) { if (small?.invite) console.info(`[Hearthtide] приглашение «${small.invite}»: жду проверку «позвали ли вслух»`); return; }
    const byCheck = apiOn() && !conf.failed;
    const said = byCheck ? conf.inv : small?.invite;
    if (!said) return;
    const c = inviteMatch(said);
    if (!c) { console.info(`[Hearthtide] приглашение «${said}» пропущено: ${INVITE_AHEAD.bday} дней вперёд нет такого дня рождения или праздника`); return; }
    if (!byCheck && !textInvites(text, c)) { console.info(`[Hearthtide] приглашение «${said}» пропущено: в тексте ответа его нет (имя и слова приглашения), только отметка модели`); return; }
    const inv = { kind: c.kind, key: c.key, cid: c.cid || null, xid: c.xid || null, name: c.name, host: c.host, whom: c.whom || 'both', day: c.day, status: 'offered', turn: state.turn, msg: N };
    const dec = state.bdDecisions?.[c.key];
    if (dec) inv.status = dec;                                // игрок уже решал (свайп, пересборка) — его решение в силе
    else if (byCheck && conf.agreed) {
        // {{user}} сам напросился или уже сказал «да» в своей реплике — карточка не нужна, как у свидания
        inv.status = 'accepted';
        state.bdDecisions = { ...(state.bdDecisions || {}), [c.key]: 'accepted' };
        noteDecision('bd', c.key, N);
        if (N === lastBotIndex() && !offerAgreedToasted.has(c.key)) { offerAgreedToasted.add(c.key); window.toastr?.info?.(`${c.kind === 'bday' ? L().bdPlanned : L().exPlanned}: ${c.name}`, 'Hearthtide'); }
        console.info(`[Hearthtide] приглашение «${c.name}»: ${getUserName()} уже согласился в истории — принято без карточки`);
    }
    state.inv = inv;
    if (state.invRoll?.key === c.key) state.invRoll = null;
    console.info(`[Hearthtide] приглашение: ${c.kind === 'bday' ? 'день рождения' : 'праздник'} «${c.name}» на ${isoOf(c.day)}${dec ? ` (решение уже было: ${dec})` : ''}`);
}
/** Приглашение осталось без ответа — пауза «навсегда» (до его дня: ключ привязан к дате) */
const INV_FORGOT = 1e9;
/** Кого проверить «позвали ли вслух»: выпавшее приглашение и тех, о ком в ответе говорят вместе со словами о приглашении */
const INVITE_WORDS = /(пригла|зов[уеё]|позов|позвал|ждём|ждем|жду\b|придёшь|придешь|придёте|придете|приходи|invit|come to|join us|expect you)/i;
/** В тексте ответа и правда зовут: есть имя (именинника, праздника или того, кто зовёт) и слова приглашения */
function textInvites(text, c) {
    const t = String(text || '').replace(/<!--[\s\S]*?-->/g, ' ').toLowerCase().replace(/ё/g, 'е');
    return INVITE_WORDS.test(t) && [c.name, c.host].some(v => v && seenInStory(v, t));
}
function inviteWatch(text, rolled, marked = null) {
    if (state.inv?.status === 'offered') return [];
    const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
    const asks = INVITE_WORDS.test(t);
    const out = [];
    for (const c of inviteCandidates(state, true)) {
        if (state.bdDecisions?.[c.key] && c.key !== rolled?.key) continue;
        if ((state.invCool?.[c.key] ?? -1) >= INV_FORGOT) continue;              // игрок так и не ответил — не переспрашиваем
        const named = [c.name, c.host].some(v => v && seenInStory(v, t));
        // проверяем выпавшее, отмеченное моделью (invite=) и тех, кого в ответе называют вместе со словами приглашения
        if (c.key === rolled?.key || (marked && inviteMatch(marked)?.key === c.key) || (asks && named)) out.push({ value: c.name, label: c.kind === 'bday' ? `${c.name}'s birthday` : `${c.name}${c.host ? ` (held by ${c.host})` : ''}` });
    }
    return out.slice(0, 4);
}
/** Бросок после ответа: кого позовут в следующем ответе. Выпавшее, но не прозвучавшее — повтор, потом пауза */
function rollInvite(text, had, conf = null) {
    // проверка «позвали ли вслух» ещё не ответила — ответ обработается заново, когда она придёт; попытку не тратим
    if (had && !conf && apiOn() && state.inv?.status !== 'offered' && state.inv?.key !== had.key && !state.bdDecisions?.[had.key]) { state.invRoll = had; return; }
    if (had && state.inv?.key !== had.key && !state.bdDecisions?.[had.key]) {
        if ((had.tries || 0) + 1 < INVITE_TRIES) {
            state.invRoll = { ...had, tries: (had.tries || 0) + 1 };
            console.info(`[Hearthtide] приглашение «${had.name}»: модель не позвала — прошу ещё раз`);
            return;
        }
        state.invCool = { ...(state.invCool || {}), [had.key]: state.turn + INVITE_COOL };
        console.info(`[Hearthtide] приглашение «${had.name}»: модель так и не позвала — пауза ${INVITE_COOL} ответов`);
    }
    state.invRoll = null;
    if (state.inv?.status === 'offered' || state.today == null) return;
    const c = inviteCandidates(state).find(x => x.key !== state.inv?.key);
    if (!c || c.chance <= 0) return;
    const r = rollFor(text, state.turn + 3571);
    console.info(`[Hearthtide] приглашение: ${c.kind === 'bday' ? `день рождения ${c.name}` : c.name} через ${c.d} дн. — бросок ${r} ${r < c.chance ? '<' : '≥'} ${c.chance}%`);
    if (r < c.chance) state.invRoll = { kind: c.kind, key: c.key, cid: c.cid || null, xid: c.xid || null, name: c.name, host: c.host, whom: c.whom || 'both', day: c.day, tries: 0,
        meaning: c.kind === 'extra' ? (state.extras || []).find(x => x.id === c.xid)?.meaning || null : null };
}
/** Пришли ли по принятому приглашению: да — теплее и «отметили»; нет — обида и холоднее; null — не узнали, без последствий */
function applyWent(x, went, note) {
    if (!x) return;
    const c = x.kind === 'bday' ? (state.cast || []).find(p => p.id === x.cid) : (x.host ? findCast(state, x.host) : null);
    // позвал сам {{char}} — обида ложится на пару
    const byChar = !c && x.host && samePerson(x.host, getCharName());
    const bump = (du, dc) => { if (!c) return; c.rel = c.rel || { user: 0, char: 0 }; c.rel.user = clampRel((c.rel.user ?? 0) + du) ?? 0; c.rel.char = clampRel((c.rel.char ?? 0) + dc) ?? 0; };
    const log = state.yearLog?.items?.find(i => i.id === x.id);
    if (went === true) {
        state.lived = { ...(state.lived || {}), [x.id]: true };
        if (log) log.kept = true;
        bump(5, 5);
        if (note) addFlashback(x.what, note, 'holiday');
    } else if (went === false) {
        state.lived = { ...(state.lived || {}), [x.id]: false };
        if (log) log.kept = false;
        if (x.kind === 'bday') bump(-15, -10); else bump(-8, -8);
        if (byChar && state.pair) { state.pair.f = Math.max(-100, state.pair.f - 8); if (!state.pair.kin) state.pair.r = Math.max(-100, state.pair.r - 4); }
        // обида — только у того, кто лично звал; повод без хозяина просто прошёл мимо
        if (c || x.host) state.hurt = [...(state.hurt || []), { who: c?.name || x.host, what: x.what, turn: state.turn }].slice(-3);
    }
    console.info(`[Hearthtide] ${x.what}: ${went === true ? 'пришли' : went === false ? (c || x.host ? `не пришли — ${x.host || c?.name} обижен, отношения ниже` : 'не пришли — без последствий (никто лично не звал)') : 'не узнали, пришли ли — без последствий'}${note ? ` (${note})` : ''}`);
}
function decideInv(yes) {
    const inv = state.inv;
    if (!inv || inv.status !== 'offered') return;
    const key = inv.key;
    state.bdDecisions = { ...(state.bdDecisions || {}), [key]: yes ? 'accepted' : 'declined' };
    noteDecision('bd', key, inv.msg);
    if (!yes) state.invDeclined = { name: inv.kind === 'bday' ? L().birthday(inv.name) : inv.name, host: inv.host, turn: state.turn };
    if (!yes && inv.kind === 'extra') rememberDeclined({ name: inv.name, cause: inv.host, start: inv.day });
    const fn = (st) => { if (st.inv?.key === key) st.inv.status = yes ? 'accepted' : 'declined'; };
    fn(state);
    applyToSnapshots(fn);
    saveState();
    injectPrompts();
    renderAll();
}
function invCardHtml() {
    const inv = state?.inv;
    if (!inv || inv.status !== 'offered') return '';
    const bd = inv.kind === 'bday';
    const c = bd ? (state.cast || []).find(x => x.id === inv.cid) : null;
    const x = bd ? null : (state.extras || []).find(e => e.id === inv.xid);
    const fresh = freshFor(`inv:${inv.key}`);
    const days = state.today != null ? inv.day - state.today : null;
    const ties = bd ? [c?.toU && `${L().toWhom(getUserName())}: ${c.toU}`, c?.toC && `${L().toWhom(getCharName())}: ${c.toC}`].filter(Boolean).join(' · ')
        : [inv.host && `${L().exHost}: ${inv.host}`, x?.meaning].filter(Boolean).join(' · ');
    const pic = bd ? avaHtml(avatars()[inv.cid], inv.name) : `<span class="ht-ava ht-ava-none ht-ava-icon"><i class="fa-solid fa-champagne-glasses"></i></span>`;
    return `<div class="ht-offer ht-bdinv${fresh ? ' ht-offer-new' : ''}">
        <div class="ht-dhead"><span class="ht-portrait">${pic}</span><div class="ht-dmain">
            <span class="ht-dinvite"><i class="fa-solid ${bd ? 'fa-gift' : 'fa-champagne-glasses'}"></i>${esc(bd ? L().bdInvite : L().exInvite)}</span>
            <b class="ht-dtitle">${esc(inv.name)}</b>
            <span class="ht-dwhen">${esc([days != null ? L().dateAt(days, '') : '', (({ m, d }) => L().dayMonth(d, m))(fromDayNum(inv.day))].filter(Boolean).join(' · '))}</span>
            ${ties ? `<span class="ht-dwhen">${esc(ties)}</span>` : ''}</div></div>
        <div class="ht-offer-actions ht-two">
            <button class="ht-btn ht-btn-main" data-act="inv-yes"><i class="fa-solid ${bd ? 'fa-gift' : 'fa-check'}"></i><span>${L().evGo}</span></button>
            <button class="ht-btn ht-btn-quiet" data-act="inv-no"><i class="fa-solid fa-xmark"></i><span>${L().decline}</span></button>
        </div>
    </div>`;
}

/**
 * Подталкивания миру (BEAT помощника, «пусть подготовка покажется», «кто-то заходит») — не чаще раза в PUSH_GAP ответов.
 * И не сразу после ответа, где этот повод уже звучал: иначе персонажи напоминали о встрече в каждом сообщении.
 * В сам день праздник и есть сцена — там упоминание не мешает, только пауза.
 */
function gatePushes(phase, text) {
    const any = () => !!(state.beat || state.mentionNow || state.nudge);
    if (!any()) return;
    const gap = phase.kind === 'today' ? PUSH_GAP.today : PUSH_GAP.other;
    let why = null;
    if ((state.turn || 0) - (state.lastPush ?? -99) < gap) why = 'пауза после прошлой подсказки';
    else if (phase.kind !== 'today') {
        const names = pushTracked(state).filter(h => h.start > state.today).map(h => hName(h, { userName: getUserName(), charName: getCharName() }));
        if (phase.h && phase.kind === 'prep') names.push(hName(phase.h, { userName: getUserName(), charName: getCharName() }));
        if (occasionMentioned(text, names)) { why = 'повод уже звучал в этом ответе'; state.lastPush = state.turn; }
    }
    if (why) {
        console.debug(`[Hearthtide] подсказка миру пропущена: ${why}`);
        state.beat = null; state.mentionNow = false; state.nudge = null;
        return;
    }
    state.lastPush = state.turn;
}
/** Звучит ли повод в тексте: по основам значимых слов названия (как с названием свидания) */
const OCC_STOP = new Set(['празднование', 'праздник', 'вечеринка', 'встреча', 'новый', 'большой', 'святой', 'великий', 'международный', 'held', 'birthday', 'party', 'great', 'national', 'international']);
function occasionMentioned(text, names) {
    const t = String(text || '').replace(/<!--[\s\S]*?-->/g, ' ').toLowerCase().replace(/ё/g, 'е');
    if (!t.trim()) return false;
    return names.some(n => {
        const words = String(n || '').toLowerCase().replace(/ё/g, 'е').replace(/\([^)]*\)/g, ' ').split(/[^\p{L}\d]+/u)
            .filter(w => w.length >= 5 && !OCC_STOP.has(w)).map(w => w.slice(0, Math.max(4, w.length - 2)));
        return words.length && words.some(w => t.includes(w));
    });
}

/** {{char}} думал о свидании в последних ответах? Тогда не подталкиваем */
function dateMentioned() {
    const d = state?.date;
    if (!d || d.status !== 'scheduled') return false;
    const bots = chat.filter(m => m && !m.is_user && !m.is_system && m.mes).slice(-2).map(m => String(m.mes).replace(/<!--[\s\S]*?-->/g, ' ')).join(' ').toLowerCase().replace(/ё/g, 'е');
    if (/свидан|\bdate\b/.test(bots)) return true;
    const words = String(d.title || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}]+/u).filter(w => w.length >= 5).map(w => w.slice(0, w.length - 2));
    return words.some(w => bots.includes(w));
}

// ─── Текущий год: все прошедшие праздники, отмеченные и прошедшие мимо ───
// Хранится только в состоянии; в инджект не идёт. Новый год — чистый лист.
function ensureYear() {
    if (state.today == null) return null;
    const y = fromDayNum(state.today).y;
    if (state.yearLog?.y !== y) {
        const prev = state.yearLog;
        // год сменился по ходу истории — с 1 января; первый год истории — с её первого дня
        state.yearLog = { y, from: prev && prev.y < y ? dayNum(y, 1, 1) : state.today, items: [] };
        state.lived = {};
    }
    return state.yearLog;
}

function logItem(log, it) {
    if (fromDayNum(it.start).y !== log.y || it.start < log.from) return;
    const same = log.items.find(i => i.id === it.id
        || (!i.birthday && !it.birthday && i.type !== 'date' && it.type !== 'date' && namesMatch(i.name, it.name) && Math.abs(i.start - it.start) <= 3)
        || (i.birthday && it.birthday && i.who === it.who));
    if (same) { same.kept = same.kept || it.kept; return; }
    log.items.push(it);
    log.items.sort((a, b) => a.start - b.start);
    if (log.items.length > 40) log.items = log.items.slice(-40);
}

function logPast() {
    const log = ensureYear();
    if (!log) return;
    // Отмеченные раньше (до появления вкладки или до начала учёта) — по итогам этого года
    for (const r of state.recaps || []) {
        if (String(r.hid || '').startsWith('d-')) continue;          // свидания вносятся сами, при завершении
        const m = String(r.hid || '').match(/(?:@|-)(-?\d+)$/);   // «название@день» или «bday-user-день»
        const start = m ? Number(m[1]) : NaN;
        if (!Number.isFinite(start) || start >= state.today || fromDayNum(start).y !== log.y) continue;
        if (log.items.some(i => i.id === r.hid)) continue;
        const h = (state.holidays || []).find(x => holidayId(x) === r.hid);
        const bday = String(r.hid).match(/^bday-(user|char)-/);
        // день рождения человека из истории: имя уже в итоге («День рождения · …»), who — свой у каждого
        const npc = String(r.hid).match(/^bday-npc-(.+)@-?\d+$/);
        log.items.push({ id: r.hid, name: bday ? null : r.name, birthday: !!bday || !!npc, npc: !!npc, who: npc ? `npc:${npc[1]}` : bday?.[1], type: npc ? 'personal' : h?.type || 'folk', start, days: h?.days || 1, kept: true });
        log.items.sort((a, b) => a.start - b.start);
    }
    const list = allHolidays(state);
    // дни рождения этого года, которые скип мог перепрыгнуть (в календаре их уже нет)
    for (const who of ['user', 'char']) {
        const md = state.birthdays?.[who];
        if (!md || state.birthdayOff?.[who]) continue;
        const h = { start: dayNum(log.y, md.m, md.d), days: 1, name: null, who, birthday: true, type: 'personal' };
        h.id = holidayId(h);
        if (!list.some(x => x.id === h.id)) list.push(h);
    }
    // и дни рождения людей истории, которые отмечаются (родня, близкие, принятые приглашения)
    for (const c of state.cast || []) {
        if (!c?.bday) continue;
        const start = dayNum(log.y, c.bday.m, c.bday.d);
        if (start >= state.today || !npcBdOn(state, c, start)) continue;
        const h = npcHoliday(c, start);
        if (!list.some(x => x.id === h.id)) list.push(h);
    }
    for (const x of state.extras || []) {
        if (state.bdDecisions?.[extraKey(x.id)] !== 'accepted' || x.start + (x.days || 1) - 1 >= state.today) continue;
        const id = `x-${x.id}`;
        if (!list.some(h => h.id === id)) list.push({ start: x.start, days: x.days || 1, name: x.name, type: 'gathering', extra: true, xid: x.id, id });
    }
    for (const h of list) {
        if (h.start + h.days - 1 >= state.today) continue;
        logItem(log, { id: h.id, name: h.npc ? displayName(h) : h.name, birthday: !!h.birthday, npc: !!h.npc, who: h.who, type: h.type, start: h.start, days: h.days, kept: !!state.lived?.[h.id] });
    }
}

/** Праздники, которые проскочил скип, — со слов ИИ (строки X календаря) */
function logSkipped(list) {
    const log = ensureYear();
    if (!log) return;
    for (const x of list || []) {
        if (x.start >= state.today || isBanned(state, x.name) || birthdayOwner(x.name)) continue;
        logItem(log, { id: holidayId({ name: x.name, start: x.start }), name: x.name, birthday: false, type: x.type, start: x.start, days: 1, kept: false });
    }
}

// ─── Поводы из истории: ИИ предлагает, игрок решает ───
/** Отклонённые (или так и не решённые) поводы этого года — их помнят, чтобы не предлагать то же самое снова */
function offerSeenThisYear() {
    const y = state.today != null ? fromDayNum(state.today).y : null;
    return (state.offerSeen || []).filter(x => y == null || x.y == null || x.y === y).slice(-12);
}
function rememberDeclined(o) {
    if (!o?.name) return;
    const y = o.start != null ? fromDayNum(o.start).y : null;
    const item = { name: o.name, cause: o.cause || o.host || null, start: o.start ?? null, y };
    state.offerSeen = [...(state.offerSeen || []).filter(x => !(namesMatch(x.name, item.name) && x.y === y)), item].slice(-30);
}
/** Тот же повод, что уже отклоняли: то же название — или почти та же причина и почти тот же день, под другим именем */
function offerDeclined(o) {
    return offerSeenThisYear().some(x => namesMatch(x.name, o.name)
        || (x.cause && o.cause && sameFact(x.cause, o.cause))
        || (x.start != null && Math.abs(x.start - o.start) <= 3 && [o.name, o.cause].some(t => t && (sameFact(x.name, t) || (x.cause && sameFact(x.cause, t))))));
}
/** Повод уже не нужен: отклонён, удалён или такой праздник уже в календаре */
function offerKnown(o) {
    if (passedThisYear(state, o.name, o.start)) return true;
    if (isBanned(state, o.name) || (state.offerNo || []).some(n => namesMatch(n, o.name)) || offerDeclined(o)) return true;
    // тот же повод: в календаре (и принятые приглашения), уже позвали или он ждёт приглашения как дополнительный праздник —
    // то же название в пределах месяца или похожее (sameOccasion) почти в тот же день. Раньше сверялся только календарь:
    // приглашение на «Празднование Дня юриста» помощник заносил ещё раз поводом «День юриста»
    const same = (name, day) => day != null && ((namesMatch(name, o.name) && Math.abs(day - o.start) <= 30) || (Math.abs(day - o.start) <= 1 && sameOccasion(name, o.name)));
    if (state.inv && state.inv.status !== 'declined' && same(state.inv.name, state.inv.day)) return true;
    if ((state.extras || []).some(x => same(x.name, x.start))) return true;
    return allHolidays(state).some(h => same(h.name, h.start));
}

/** Принять новые поводы из ответа; вернуть true, если что-то пришло не на том языке */
function takeOffers(list) {
    let slip = false;
    state.offers = state.offers || [];
    for (const o of list || []) {
        if (![o.name, o.meaning, o.cause].every(langOk)) { slip = true; continue; }
        if (!/(день\s*рожд|днюх|именин|birthday)/i.test(o.name)) o.name = occasionName(o.name, o.cause, o.meaning);
        if (state.today != null && (o.start < state.today || o.start - state.today > 180)) continue;
        const owner = birthdayOwner(o.name);
        if (owner && (state.birthdays?.[owner] || state.birthdayOff?.[owner])) continue;   // уже известен или удалён игроком
        if (owner) o.bday = owner;                                                         // день рождения узнали из истории
        // день рождения человека из «Людей» — это его день рождения, а не отдельный праздник: подарки, круг именинника
        const bp = owner ? null : birthdayPerson(o.name);
        if (bp) {
            if (state.bdDecisions?.[bdKey(bp.id, o.start)] || state.cancelled?.[holidayId({ npc: true, cid: bp.id, start: o.start })]) continue;
            o.npcCid = bp.id;
        }
        if (offerKnown(o)) { console.info(`[Hearthtide] повод «${o.name}» пропущен: уже в календаре, прошёл или отклонён в этом году`); continue; }
        if (state.offers.some(x => namesMatch(x.name, o.name) && Math.abs(x.start - o.start) <= 14)) continue;
        // {{user}} уже согласился в ролплее (или сам предложил, или они уже там) — карточка не нужна, повод сразу в календаре,
        // как у свидания; кто ещё не ответил — карточка «Принять / Отклонить». Дни рождения — всегда карточкой
        if (o.agreed && !o.bday && !o.npcCid) {
            const h = { start: o.start, days: o.days, name: o.name, type: o.type, prep: o.prep, meaning: o.meaning || null, edited: true, story: true, cause: o.cause || null, host: o.host || null };
            if (!(state.holidays || []).some(x => holidayId(x) === holidayId(h))) {
                state.holidays = [...(state.holidays || []), h].sort((a, b) => a.start - b.start);
                offersAgreed.push(h);
                console.info(`[Hearthtide] повод «${o.name}»: ${getUserName()} уже согласился в истории — сразу в календаре, без карточки`);
            }
            continue;
        }
        state.offers.push({ ...o, id: `of-${state.turn}-${Date.now().toString(36)}-${state.offers.length}`, turn: state.turn });
    }
    // устаревшие: дата прошла, игрок давно не решает — так и не решённое тоже помним (снова не предложим)
    for (const o of state.offers) if (state.turn - o.turn > 20 && !offerKnown(o)) rememberDeclined(o);
    state.offers = state.offers
        .filter(o => !offerKnown(o) && (state.today == null || o.start >= state.today) && state.turn - o.turn <= 20)
        .slice(-3);
    return slip;
}

const dropOfferIn = (st, oid) => { st.offers = (st.offers || []).filter(o => o.id !== oid); };

/** Игрок принял повод (возможно, поправив его) — праздник в календаре, переживает свайпы и «подобрать заново» */
function acceptOffer(oid, edit = null) {
    const o = (state.offers || []).find(x => x.id === oid);
    if (!o) return false;
    let start = o.start;
    if (edit) {
        start = parseDate(edit.date);
        if (start == null) { window.toastr?.warning?.(L().badDate, 'Hearthtide'); return false; }
    }
    const toBday = String(edit?.type || '').startsWith('bday_') ? edit.type.slice(5) : (!edit?.type && o.bday) || null;
    if (!toBday && o.npcCid && (!edit || namesMatch(String(edit.name || '').trim() || o.name, o.name))) {
        // день рождения человека из «Людей»: записываем ему дату и считаем приглашение принятым
        const md = fromDayNum(start);
        const apply = (st) => {
            const c = (st.cast || []).find(x => x.id === o.npcCid);
            if (c && (!c.bday || c.bday.m !== md.m || c.bday.d !== md.d)) c.bday = { d: md.d, m: md.m, y: c.bday?.y ?? null };
            dropOfferIn(st, oid);
        };
        apply(state);
        applyToSnapshots(apply);
        const key = bdKey(o.npcCid, start);
        state.bdDecisions = { ...(state.bdDecisions || {}), [key]: 'accepted' };
        noteDecision('bd', key, lastProcessedMsg());
        saveState();
        injectPrompts();
        window.toastr?.success?.(L().offerAdded, 'Hearthtide');
        return true;
    }
    if (toBday) {
        const md = fromDayNum(start);
        const apply = (st) => {
            st.birthdays = { ...(st.birthdays || {}), [toBday]: { ...(st.birthdays?.[toBday] || {}), m: md.m, d: md.d } };
            if (st.birthdayOff) delete st.birthdayOff[toBday];
            dropOfferIn(st, oid);
        };
        apply(state);
        applyToSnapshots(apply);
    } else {
        const name = String(edit?.name || '').trim() || o.name;
        const meanIn = edit ? String(edit.meaning ?? '').trim() : null;
        const h = { start, days: o.days, name, type: edit?.type || o.type, prep: o.prep, edited: true, story: true, cause: o.cause || null, host: o.host || null };
        if (meanIn && meanIn !== (o.meaning || '')) h.meaning = meanIn;              // игрок сам написал смысл
        else if (namesMatch(name, o.name)) h.meaning = o.meaning;
        else { h.meaning = null; h.needMeaning = true; }                             // переименовал в другое — смысл допишет ИИ
        // игрок явно хочет этот праздник — снимаем с него старый запрет
        const keys = banKeys(name);
        state.banned = state.banned.filter(b => !keys.includes(b));
        state.bannedNames = state.bannedNames.filter(n => !namesMatch(n, name));
        const id = holidayId(h);
        const apply = (st) => {
            st.holidays = st.holidays || [];
            if (!st.holidays.some(x => holidayId(x) === id)) st.holidays.push(clone(h));
            st.holidays.sort((a, b) => a.start - b.start);
            dropOfferIn(st, oid);
        };
        apply(state);
        applyToSnapshots(apply);
    }
    saveState();
    injectPrompts();
    window.toastr?.success?.(L().offerAdded, 'Hearthtide');
    return true;
}

/** Игрок отклонил повод — больше его не предлагаем */
function declineOffer(oid) {
    const o = (state.offers || []).find(x => x.id === oid);
    if (!o) return;
    state.offerNo = [...(state.offerNo || []).filter(n => !namesMatch(n, o.name)), o.name].slice(-30);
    rememberDeclined(o);
    dropOfferIn(state, oid);
    applyToSnapshots(st => dropOfferIn(st, oid));
    saveState();
    injectPrompts();
    window.toastr?.info?.(L().offerDropped, 'Hearthtide');
}

/** Название повода — что это, а не имя человека: «Иван Петров» вместо «Бани» меняем на описание */
function occasionName(name, ...alt) {
    const n = String(name || '').trim();
    const person = [getUserName(), getCharName(), ...(state.cast || []).map(c => c.name)].filter(Boolean).some(p => samePerson(p, n))
        || alt.some(a => a && samePerson(a, n));
    if (!person) return n;
    const better = alt.map(a => String(a || '').trim()).find(a => a && !samePerson(a, n));
    if (!better) return n;
    const short = better.split(/[.;,—–]/)[0].trim();
    return (short.length > 60 ? `${short.slice(0, 60).replace(/\s+\S*$/, '')}…` : short).replace(/^\p{Ll}/u, c => c.toUpperCase());
}

/** «День рождения Егора», «Именины Ани» — чей это день рождения из «Людей» (или null) */
function birthdayPerson(name) {
    const n = String(name || '');
    if (!/(день\s*рожд|днюх|именин|birthday)/i.test(n)) return null;
    const words = n.replace(/(день\s*рождения|днюх\S*|именин\S*|birthday|'s)/gi, ' ').split(/[^\p{L}]+/u).filter(w => w.length >= 3);
    if (!words.length) return null;
    return (state.cast || []).find(c => c.name && !c.off && words.some(w => stemEq(w, String(c.name).split(/\s+/)[0]))) || null;
}

// «День рождения Нины» строкой праздника — это дубль дня рождения из B-строк
function birthdayOwner(name) {
    if (!/(день\s*рожд|днюх|именинн|birthday)/i.test(String(name))) return null;
    const n = String(name).toLowerCase();
    const stem = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е').slice(0, Math.max(3, String(x || '').length - 2));
    if (n.replace(/ё/g, 'е').includes(stem(getUserName()))) return 'user';
    if (n.replace(/ё/g, 'е').includes(stem(getCharName()))) return 'char';
    return null;
}

function mergeHolidays(list) {
    for (const h of list) {
        if (isBanned(state, h.name) || passedThisYear(state, h.name, h.start)) continue;
        const owner = birthdayOwner(h.name);
        const bp = owner ? null : birthdayPerson(h.name);
        if (bp) {
            // день рождения человека из «Людей» — дата ему, праздник появится, когда позовут и игрок примет
            if (!bp.bday && !bp.edited) { const md = fromDayNum(h.start); bp.bday = { d: md.d, m: md.m, y: null }; }
            continue;
        }
        if (owner) {
            if (!state.birthdays[owner]) {
                const d = new Date(h.start * 86400000);
                state.birthdays[owner] = { m: d.getUTCMonth() + 1, d: d.getUTCDate(), prep: h.prep ?? null };
            }
            continue;
        }
        // праздник, который игрок поправил руками, календарь ИИ не перезаписывает
        if (state.holidays.some(x => x.edited && (holidayId(x) === holidayId(h) || (namesMatch(x.name, h.name) && Math.abs(x.start - h.start) <= 30)))) continue;
        const id = holidayId(h);
        const i = state.holidays.findIndex(x => holidayId(x) === id
            || (x.name.toLowerCase() === h.name.toLowerCase() && Math.abs(x.start - h.start) <= 3));
        if (i >= 0) state.holidays[i] = h;
        else state.holidays.push(h);
    }
    state.holidays.sort((a, b) => a.start - b.start);
}

// Держим прошедшие праздники ещё неделю (для «после»), остальное — в прошлое
function pruneHolidays() {
    // убрать уже попавшие в список дубли дней рождения
    state.holidays = (state.holidays || []).filter(h => !birthdayOwner(h.name));
    if (state.today == null) return;
    state.holidays = state.holidays.filter(h => h.start + h.days - 1 >= state.today - 7).slice(0, 20);
    // журнал подготовки праздников, которых больше нет, не копим
    const live = new Set(allHolidays(state).map(h => h.id));
    for (const k of Object.keys(state.ready || {})) if (!live.has(k)) delete state.ready[k];
    for (const k of Object.keys(state.highlights || {})) {
        if (!state.holidays.some(h => holidayId(h) === k) && !k.startsWith('bday-')) delete state.highlights[k];
    }
    for (const k of Object.keys(state.charLog || {})) {
        if (!state.holidays.some(h => holidayId(h) === k) && !k.startsWith('bday-')) delete state.charLog[k];
    }
    for (const k of Object.keys(state.days)) {
        const hid = k.split('#')[0];
        if (!state.holidays.some(h => holidayId(h) === hid) && !hid.startsWith('bday-')) delete state.days[k];
    }
}

// ─── Смена эпохи или веры: будущие праздники подбираются заново ───
/** Будущие праздники из календаря — прочь; идущий сегодня и поводы из истории остаются */
function dropFutureHolidays(st) {
    // повод из истории, поправленный игроком праздник и сегодняшний — остаются: это решения игрока и то, что уже идёт
    const keep = (h) => h.story || h.edited || (st.today != null && h.start <= st.today && h.start + h.days - 1 >= st.today);
    const gone = (st.holidays || []).filter(h => !keep(h)).map(h => holidayId(h));
    st.holidays = (st.holidays || []).filter(keep);
    if (gone.includes(st.prep?.hid)) st.prep = null;
}
let rebuiltNames = null;
const storyDateToasted = new Set();
// поводы, на которые {{user}} уже согласился в истории (в этом ответе), — для уведомления «Намечено: …»
let offersAgreed = [];
const offerAgreedToasted = new Set();     // свидания, договорённые в самой истории, о которых уже сказали     // праздники, подобранные заново, — показать уведомлением, когда придут

function rebuildCalendar() {
    if (!state) loadState();
    // ничего не стираем сразу: старый календарь живёт, пока не придёт новый (processReply)
    const mark = (st) => { st.rebuild = true; st.rebuildTries = 0; st.forceCal = true; };
    mark(state);
    applyToSnapshots(mark);
    // Календари из уже пришедших ответов больше не принимаем (при правке или повторной обработке);
    // новый свайп — новый текст, его календарь примется
    state.calIgnore = state.calIgnore || [];
    for (const m of chat) {
        const raws = [m?.extra?.ht_raw?.raw, ...Object.values(m?.extra?.ht_side || {}).map(x => x?.text)];
        for (const raw of raws) {
            if (!raw || !/HT-CAL/i.test(raw)) continue;
            const hsh = hashText(raw);
            if (!state.calIgnore.includes(hsh)) state.calIgnore.push(hsh);
        }
    }
    if (state.calIgnore.length > 200) state.calIgnore = state.calIgnore.slice(-200);
    saveState();
    injectPrompts();
    renderAll();
    // с помощником запрос уходит сразу, шапка показывает «обновляю», итог — уведомлением, когда праздники придут;
    // без помощника (или пока бот пишет) — подберутся в следующем ответе
    if (apiOn() && !generating && lastProcessedMsg() >= 0) maybeSide(lastProcessedMsg(), true);
    else window.toastr?.info?.(L().rebuildToast, 'Hearthtide');
}

// ─── Правка праздника игроком ───
// Праздник опознаётся по «название@дата»: при правке переносим на новое имя всё, что к нему привязано
function renameHidIn(st, oldId, newId) {
    if (oldId === newId) return;
    if (st.prep?.hid === oldId) st.prep.hid = newId;
    for (const k of Object.keys(st.days || {})) {
        if (k.startsWith(`${oldId}#`)) { st.days[k.replace(oldId, newId)] = st.days[k]; delete st.days[k]; }
    }
    for (const k of Object.keys(st.planPart || {})) {
        if (k.startsWith(`${oldId}#`)) { st.planPart[k.replace(oldId, newId)] = st.planPart[k]; delete st.planPart[k]; }
    }
    for (const map of ['charLog', 'highlights', 'care', 'gifts', 'giftTo', 'recapDone', 'lived', 'charGifts', 'ready']) {
        if (st[map] && oldId in st[map]) { st[map][newId] = st[map][oldId]; delete st[map][oldId]; }
    }
    // решения игрока, привязанные к празднику: свой подарок, «общий / каждый свой», убранные пункты подготовки
    for (const map of ['userGift', 'giftMode', 'readyNo']) {
        if (st[map] && oldId in st[map]) { st[map] = { ...st[map], [newId]: st[map][oldId] }; delete st[map][oldId]; }
    }
    if (st.charNow?.hid === oldId) st.charNow.hid = newId;
    for (const e of st.evts || []) if (e.hid === oldId) e.hid = newId;
    if (st.activeHid === oldId) st.activeHid = newId;
    if (st.focusHid === oldId) st.focusHid = newId;
}

// Праздник подменили другим: подготовку, распорядок и шаги персонажа ИИ соберёт заново
function forgetHolidayIn(st, id) {
    if (st.prep?.hid === id) st.prep = null;
    for (const map of ['days', 'planPart']) {
        for (const k of Object.keys(st[map] || {})) if (k.startsWith(`${id}#`)) delete st[map][k];
    }
    for (const map of ['charLog', 'care', 'gifts', 'giftTo', 'charGifts', 'ready']) if (st[map]) delete st[map][id];
    if (st.charNow?.hid === id) st.charNow = null;
}

function saveHolidayEdit(hid, name, dateStr, type, meaning = null) {
    const h = allHolidays(state).find(x => x.id === hid);
    if (!h) return false;
    const start = parseDate(dateStr);
    if (start == null) { window.toastr?.warning?.(L().badDate, 'Hearthtide'); return false; }
    const md = fromDayNum(start);
    const toBday = String(type || '').startsWith('bday_') ? type.slice(5) : null;

    if (h.extra) {
        // принятая встреча хранится в state.extras: название и смысл — там; другая дата — как перенос (id и решение те же)
        const newName = String(name || '').trim() || h.name;
        const meanIn = meaning == null ? null : String(meaning).trim();
        const apply = (st) => {
            const x = (st.extras || []).find(y => y.id === h.xid);
            if (!x) return;
            x.name = newName;
            if (meanIn != null) x.meaning = meanIn || null;
            if (start !== x.start) st.cancelled = { ...(st.cancelled || {}), [h.id]: { how: 'moved', to: start, why: null, turn: st.turn, name: newName } };
            else if (st.cancelled?.[h.id]?.how === 'moved') delete st.cancelled[h.id];
        };
        apply(state);
        applyToSnapshots(apply);
        saveState();
        injectPrompts();
        return true;
    }
    if (h.birthday || toBday) {
        // день рождения: хранится как «месяц-день» в карточке персонажа
        const who = toBday || h.who;
        const apply = (st) => {
            st.birthdays = { ...(st.birthdays || {}), [who]: { ...(st.birthdays?.[who] || {}), m: md.m, d: md.d } };
            if (st.birthdayOff) delete st.birthdayOff[who];
            if (!h.birthday) st.holidays = (st.holidays || []).filter(x => holidayId(x) !== hid);
        };
        apply(state);
        applyToSnapshots(apply);
        if (!h.birthday) {
            // бывший праздник больше не предлагать
            for (const k of banKeys(h.name)) if (!state.banned.includes(k)) state.banned.push(k);
            if (!state.bannedNames.includes(h.name)) state.bannedNames.push(h.name);
        }
    } else {
        const newName = String(name || '').trim() || h.name;
        const fixed = { start, name: newName, type: type || h.type, edited: true };
        // Другой праздник, а не поправленное название: старый смысл и подготовка к нему больше не подходят
        const other = !namesMatch(h.name, newName);
        const meanIn = meaning == null ? null : String(meaning).trim();
        if (meanIn && meanIn !== (h.meaning || '')) { fixed.meaning = meanIn; fixed.needMeaning = false; }
        else if (other) { fixed.meaning = null; fixed.needMeaning = true; }
        const newId = holidayId({ ...h, ...fixed });
        const apply = (st) => {
            const x = (st.holidays || []).find(y => holidayId(y) === hid);
            if (x) { Object.assign(x, fixed); if (!x.needMeaning) delete x.needMeaning; }
            renameHidIn(st, hid, newId);
            if (other) forgetHolidayIn(st, newId);
            st.holidays?.sort((a, b) => a.start - b.start);
        };
        apply(state);
        applyToSnapshots(apply);
        // заменили на другой праздник — старое название ИИ больше не предлагает. Поправили то же название (опечатка,
        // лишнее слово) — ничего не запрещаем: запрет сверяется «примерно» и задевал новое название, праздник пропадал
        if (other) {
            for (const k of banKeys(h.name)) if (!state.banned.includes(k) && !banKeys(newName).includes(k)) state.banned.push(k);
            if (!state.bannedNames.includes(h.name)) state.bannedNames.push(h.name);
        }
        // новое название игрок выбрал сам — если оно было под запретом (удалял раньше), запрет снимаем
        const keys = banKeys(newName);
        state.banned = state.banned.filter(b => !keys.some(k => namesMatch(k, b)));
        state.bannedNames = state.bannedNames.filter(n => !namesMatch(n, newName));
    }
    saveState();
    injectPrompts();
    return true;
}

function savePlaceEdit(value) {
    const v = String(value || '').trim();
    if (!v) return false;
    state.place = v;
    if (state.setting) state.setting.place = v;
    applyToSnapshots(st => { st.place = v; if (st.setting) st.setting.place = v; });
    saveState();
    injectPrompts();
    return true;
}

// ─── Подарки имениннику: свой подарок {{user}} и «общий / каждый свой» — решения игрока (USER_FIELDS) ───
function npcPhase() {
    const ph = phaseOf(state);
    return ph.h?.npc && (ph.kind === 'prep' || ph.kind === 'today') ? ph.h : null;
}
function saveUserGift(text, done) {
    const h = npcPhase();
    if (!h) return;
    const t = String(text || '').trim().slice(0, 120);
    const map = { ...(state.userGift || {}) };
    if (t || done) map[h.id] = { text: t || null, done: !!done, by: 'hand' };
    else delete map[h.id];
    state.userGift = map;
    saveState();
    injectPrompts();
    window.toastr?.success?.(L().saved, 'Hearthtide');
}
function toggleGiftMode() {
    const h = npcPhase();
    if (!h) return;
    state.giftMode = { ...(state.giftMode || {}), [h.id]: giftJoint(state, h) ? 'own' : 'joint' };
    saveState();
    injectPrompts();
    renderAll();
}

// ─── Удаление праздника игроком: больше не предлагается и нигде не показывается ───
function deleteHoliday(hid) {
    const h = allHolidays(state).find(x => x.id === hid);
    if (!h) return;
    // чужой день рождения: «не пойдём» — тот же отказ, что и кнопкой приглашения; человек остаётся в списке
    const npcKey = h.npc ? npcBdKey(h.cid, h.start) : null;
    if (h.extra) {
        // принятый дополнительный праздник: «не пойдём»
        const k = extraKey(h.xid);
        state.bdDecisions = { ...(state.bdDecisions || {}), [k]: 'declined' };
        const off = (st) => { if (st.inv?.key === k) st.inv.status = 'declined'; };
        off(state);
        applyToSnapshots(off);
    }
    const npcOff = (st) => { if (st.inv?.key === npcKey) st.inv.status = 'declined'; };
    if (h.extra) { /* решено выше */ } else if (h.npc) {
        state.bdDecisions = { ...(state.bdDecisions || {}), [npcKey]: 'declined' };
        npcOff(state);
    } else if (h.birthday) {
        state.birthdayOff = { ...(state.birthdayOff || {}), [h.who]: true };
    } else {
        for (const k of banKeys(h.name)) if (!state.banned.includes(k)) state.banned.push(k);
        if (!state.bannedNames.includes(h.name)) state.bannedNames.push(h.name);
        state.holidays = state.holidays.filter(x => !isBanned(state, x.name));
    }
    // Стираем всё, что с ним связано — и в сохранённых снимках тоже
    applyToSnapshots(st => {
        st.holidays = (st.holidays || []).filter(x => !isBanned(state, x.name));
        if (st.prep?.hid === hid) st.prep = null;
        if (st.charNow?.hid === hid) st.charNow = null;
        if (st.charGifts) delete st.charGifts[hid];
        if (h.npc) npcOff(st);
        else if (h.extra) { /* решено выше */ }
        else if (h.birthday) st.birthdayOff = { ...(st.birthdayOff || {}), [h.who]: true };
    });
    if (state.prep?.hid === hid) state.prep = null;
    for (const k of Object.keys(state.days)) if (k.startsWith(`${hid}#`)) delete state.days[k];
    state.recaps = state.recaps.filter(r => r.hid !== hid);
    if (state.charNow?.hid === hid) state.charNow = null;
    if (state.charGifts) delete state.charGifts[hid];
    if (state.ready) delete state.ready[hid];
    if (state.highlights) delete state.highlights[hid];
    saveState();
    injectPrompts();
    renderAll();
}

// В старых снимках тоже прячем удалённые праздники
function sanitizeView(view) {
    if (!view) return view;
    // чужой день рождения: отказались, убрали человека или выключили глазком
    const npcGone = (id) => {
        const m = String(id || '').match(/^bday-npc-(.+)@(-?\d+)$/);
        if (!m) return false;
        const c = (state.cast || []).find(x => x.id === m[1]);
        return !c || !!c.off || state.bdDecisions?.[npcBdKey(m[1], m[2])] !== 'accepted';
    };
    const exGone = (id) => { const k = String(id).slice(2); return state.bdDecisions?.[extraKey(k)] !== 'accepted'; };
    const gone = (x) => (String(x.id || '').startsWith('x-') ? exGone(x.id) : String(x.id || '').startsWith('bday-npc-') ? npcGone(x.id) : x.birthday ? !!state.birthdayOff?.[x.who] : isBanned(state, x.name));
    const v = { ...view };
    v.upcoming = (v.upcoming || []).filter(u => !gone(u));
    v.recaps = (v.recaps || []).filter(r => !isBanned(state, r.name));
    if (v.h && gone(v.h)) {
        v.h = null; v.kind = 'none'; v.plan = null; v.prep = null; v.daysTo = null;
        v.people = []; v.charNow = null; v.charGift = null; v.care = null; v.gifts = false; v.bdPerson = null;
    }
    if (v.ended && isBanned(state, v.ended.name)) v.ended = null;
    v.year = (v.year || []).filter(i => i.npc || !i.raw || !isBanned(state, i.raw));
    return v;
}

function displayName(h) {
    if (!h) return '';
    if (h.npc) return L().birthday(h.name);
    if (h.extra) return occasionName(h.name, h.meaning, h.host);
    if (h.birthday) return L().birthday(h.who === 'user' ? getUserName() : getCharName());
    // повод из истории, названный именем человека, — по описанию
    return h.story ? occasionName(h.name, h.cause, h.meaning) : h.name;
}

function viewSnapshot(phase) {
    const planFor = (h, n) => (h ? state.days[`${h.id}#${n}`] || null : null);
    return {
        v: 1,
        setting: state.setting, place: state.place, when: state.when, part: dayPart(state.clock),
        kind: phase.kind,
        diag: phase.h ? null : state.diag || null,
        diagNames: phase.h || state.diag !== 'lang' ? [] : state.diagNames || [],
        h: phase.h ? { id: phase.h.id, name: displayName(phase.h), raw: phase.h.name, iso: isoOf(phase.h.start), meaning: phase.h.meaning, type: phase.h.type, days: phase.h.days, birthday: !!phase.h.birthday, who: phase.h.who, npc: !!phase.h.npc, icon: phase.h.icon || null, gathering: isGathering(phase.h) } : null,
        daysTo: phase.daysTo ?? null,
        dayIndex: phase.dayIndex ?? null,
        plan: phase.kind === 'today' ? planFor(phase.h, phase.dayIndex) : null,
        prep: phase.kind === 'prep' && state.prep?.hid === phase.h?.id ? state.prep : null,
        ended: phase.ended ? { name: displayName(phase.ended), raw: phase.ended.name, icon: phase.ended.icon || null, birthday: !!phase.ended.birthday, type: phase.ended.birthday ? 'personal' : phase.ended.type, recap: state.recaps.find(r => r.hid === phase.ended.id)?.text || null } : null,
        // другие праздники, к которым уже готовятся, — своими карточками, чтобы второй не вытеснял первый
        // «Тоже готовятся» — только то, к чему правда готовятся; идущее сегодня — отдельной строкой «Сегодня также»
        // берём из всего, что впереди (а не только из отслеживаемого), — иначе повод с подготовкой пропадал и отсюда, и из «Дальше»
        also: (phase.upcoming || []).filter(x => x.id !== phase.h?.id && preparingNow(state, x)).slice(0, 4).map(trackCard),
        todayAlso: activeOccasions(state).filter(x => x.id !== phase.h?.id)
            .map(x => ({ id: x.id, name: displayName(x), raw: x.name, icon: x.icon || null, birthday: !!x.birthday, dayIndex: state.today - x.start + 1, days: x.days, type: x.birthday ? 'personal' : x.type, invited: !!(x.npc || x.extra) })),
        // праздник в шапке издали, но к нему уже готовятся (приглашение принято) — его подготовка прямо в главном разделе
        hCard: phase.h && phase.kind !== 'prep' && phase.kind !== 'today' && preparingNow(state, phase.h) ? trackCard(phase.h) : null,
        // «Дальше» — всё остальное впереди, и принятые приглашения тоже (с пометкой), пока к ним не начали готовиться
        upcoming: (phase.upcoming || []).filter(x => (!phase.h || x.id !== phase.h.id) && !preparingNow(state, x)).slice(0, 5)
            .map(x => ({ id: x.id, name: displayName(x), raw: x.name, icon: x.icon || null, iso: isoOf(x.start), type: x.type, meaning: x.meaning, daysTo: x.start - state.today, birthday: !!x.birthday, who: x.who, npc: !!x.npc, invited: !!(x.npc || x.extra) })),
        recaps: state.recaps.slice(-3).reverse(),
        year: (state.yearLog?.items || []).map(i => ({
            id: i.id, name: i.npc ? i.name : i.birthday ? L().birthday(i.who === 'user' ? getUserName() : getCharName()) : i.name, raw: i.name, npc: !!i.npc, friendly: !!i.friendly,
            type: i.birthday ? 'personal' : i.type, iso: isoOf(i.start), kept: i.kept, result: i.result || null,
            recap: state.recaps.find(r => r.hid === i.id)?.text || (i.type === 'date' && i.result && i.result !== 'missed' ? L().dateResult[i.result] : null),
            parts: state.recaps.find(r => r.hid === i.id)?.parts || null,
        })),
        flashbacks: clone(state.flashbacks.slice(-10).reverse()),
        pair: state.pair ? clone(state.pair) : null,
        // намеченное свидание — в инфоблоке, праздник сейчас или нет
        planned: state.date?.status === 'scheduled' ? { title: state.date.title, goal: state.date.goal, where: state.date.where, when: dateWhenText(state, state.date.at), friendly: isFriendlyDate(state.date) } : null,
        // принятое приглашение впереди (если это не тот праздник, что сейчас в шапке)
        plannedBd: (() => {
            const cur = phase.kind === 'prep' || phase.kind === 'today' ? phase.h?.id : null;
            const h = acceptedAhead().find(x => x.id !== cur && x.start > state.today);
            return h ? { name: displayName(h), when: L().dateAt(h.start - state.today, ''), extra: !!h.extra } : null;
        })(),
        evts: (() => { const t = evTarget(phase); return t ? clone(state.evts.filter(e => e.hid === t.hid)) : []; })(),
        evFor: evTarget(phase)?.kind || null,
        cast: (state.cast || []).filter(c => !castBanned(state, c.name)).map(c => ({ ...clone(c), bdayIn: bdayIn(c, state.today), age: ageOf(c, state.today) })),
        recall: state.recall,
        // чей день рождения: портрет, кем приходится, сколько исполняется
        bdPerson: phase.h?.npc && (phase.kind === 'prep' || phase.kind === 'today') ? (() => {
            const c = (state.cast || []).find(x => x.id === phase.h.cid);
            return c ? { cid: c.id, name: phase.h.name, toU: c.toU || null, toC: c.toC || null, age: ageOf(c, phase.h.start), kin: isKin(c.group) } : null;
        })() : null,
        ...(() => {
            const act = phase.h && (phase.kind === 'prep' || phase.kind === 'today');
            if (!act) return { people: [], highlights: [], care: null, charNow: null, charSteps: [], charGift: null, gifts: false, ready: null };
            const hid = phase.h.id;
            const cg = charGiftOf(state, hid);
            return {
                ready: readyView(hid),
                userGift: !phase.h.npc && state.userGift?.[hid] ? { ...state.userGift[hid] } : null,
                people: clone(peopleSeen()),
                care: state.care[hid] || null,
                charNow: state.charNow?.hid === hid ? state.charNow.text : null,
                charSteps: (state.charLog?.[hid] || []).slice(-4, -1).map(x => x.text),
                highlights: clone(state.highlights?.[hid] || []),
                charGift: cg ? { ...cg } : null,
                giftTo: giftToName(giftTarget(state, phase.h, getUserName(), getCharName())) || giftTarget(state, phase.h, getUserName(), getCharName()),
                // у чужого дня рождения подарки — своим блоком: общий или от каждого
                npcGifts: phase.h.npc ? {
                    joint: giftJoint(state, phase.h),
                    char: cg ? { ...cg } : null,
                    user: state.userGift?.[hid] ? { ...state.userGift[hid] } : null,
                } : null,
                gifts: !phase.h.npc && hasGifts(state, phase.h) && giftTarget(state, phase.h, getUserName(), getCharName()).toLowerCase() !== getCharName().toLowerCase(),
            };
        })(),
    };
}

function liveView() { return viewSnapshot(phaseOf(state)); }

/** Праздник, к которому готовятся, — карточкой: когда, приглашение, что сделано, подарки */
function trackCard(x) {
    return { id: x.id, name: displayName(x), raw: x.name, icon: x.icon || null, birthday: !!x.birthday, meaning: x.meaning || null, iso: isoOf(x.start), daysTo: x.start - state.today, type: x.birthday ? 'personal' : x.type,
        invited: !!(x.npc || x.extra), host: x.extra || x.story ? x.host || null : null, ready: readyView(x.id),
        charGift: charGiftOf(state, x.id) ? { ...charGiftOf(state, x.id) } : null, userGift: state.userGift?.[x.id] ? { ...state.userGift[x.id] } : null };
}

/** Подготовка к празднику для инфоблока — только то, что показала история */
function readyView(hid) {
    const r = state.ready?.[hid];
    if (!r || (!r.sum && !r.log?.length && !Object.keys(r.gifts || {}).length)) return null;
    return { hid, sum: r.sum || null, log: (r.log || []).slice(-5).map(x => ({ t: x.t, who: x.who || null, fresh: x.turn === state.turn })),
        more: Math.max(0, (r.log || []).length - 5), gifts: Object.entries(r.gifts || {}).map(([who, g]) => ({ who, ...g })) };
}

// ═══════════════════════════════════════════════════════════════
// ИНДЖЕКТ
// Состояние — на глубине 4; правило тега — в самом конце готового промпта
// (после инструкций пресета), для текстовых API — на глубине 0.
// ═══════════════════════════════════════════════════════════════
function injectPrompts() {
    // без профиля подключения помощника нет — расширение молчит (в инфоблоке — подсказка выбрать профиль)
    const on = apiOn() && state;
    const ctx = on ? ctxFor() : null;
    // scan = false: лорбук не читает наши блоки — иначе имена из «Людей» и праздника срабатывают на ключи
    setExtensionPrompt(PROMPT_STATE, on ? buildStatePrompt(ctx) : '', extension_prompt_types.IN_CHAT, 4, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(PROMPT_TAG, on && !isChatCompletion() ? buildTagPrompt(ctx) : '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

// ═══════════════════════════════════════════════════════════════
// ОТДЕЛЬНЫЙ ЗАПРОС
// После ответа бота (в подготовке и в праздник — после каждого, издали — изредка)
// одна модель-помощник читает историю и присылает те же блоки. Они ложатся
// в инфоблок этого ответа, а подсказка (BEAT) уходит основной модели в следующий.
// ═══════════════════════════════════════════════════════════════
let side = null;            // { N, hash, ctl } — запрос в пути
let sideFailTurn = -99;
let sideErr = null;         // { N, why } — последний запрос упал (для кнопки «повторить»)

const sideLoading = () => !!side && side.N === lastProcessedMsg();

// ─── Позвали ли вслух: крошечный запрос «да/нет» после ответа ───
// Раньше это была строчка в большом задании помощника — модель её пропускала, и приглашения тихо пропадали.
let confirmNeed = null;      // { N, hash, date, bd: [имена] } — что проверить после этого ответа
let confirmSide = null;
async function runConfirmSide(N) {
    const need = confirmNeed;
    if (!apiOn() || !isEnabled() || !need || need.N !== N || N !== lastProcessedMsg()) return;
    const msg = chat[N];
    if (!msg || recFresh(msg, 'ht_confirm', msg.mes)) return;
    if (confirmSide?.hash === need.hash) return;                  // уже спрашиваем
    confirmSide?.ctl.abort();
    const me = { N, hash: need.hash, swipe: swOf(msg), ctl: new AbortController() };
    confirmSide = me;
    let res;
    try {
        const text = await sendSide(apiProfile(), buildConfirmMessages(ctxFor(), need, chat.slice(0, N + 1)), me.ctl.signal, 600);
        if (confirmSide !== me) return;
        res = parseConfirm(text, need);
        console.info(`[Hearthtide] проверка «позвали ли вслух»: ${text.trim().replace(/\s+/g, ' ').slice(0, 160)} → свидание ${res.date ?? '—'}, приглашение ${res.inv || 'нет'}${need.pend ? `, ответ на «${need.pend.label}»: ${res.reply || 'нет ответа'}` : ''}`);
    } catch (e) {
        if (me.ctl.signal.aborted || confirmSide !== me) return;
        console.warn('[Hearthtide] проверка «позвали ли вслух» не прошла — верю отметкам основной модели:', reasonOf(e));
        res = { failed: true, date: null, inv: null };
    } finally {
        if (confirmSide === me) confirmSide = null;
    }
    if (!sameReply(N, me.swipe)) return;
    const m = chat[N];
    m.extra = m.extra || {};
    m.extra.ht_confirm = { [coreHash(m.mes)]: { ...res, pend: need.pend?.key || null, userMsg: need.pend?.user ?? null, swipe: me.swipe, len: coreText(m.mes).length } };
    processReply(N);
}

function buildConfirmMessages(ctx, need, msgs) {
    const { userName, charName } = ctx;
    const clean = (t) => String(t || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const last = msgs[msgs.length - 1];
    const prev = msgs.slice(0, -1).reverse().find(m => m?.is_user && m.mes);
    const q = [];
    if (need.date) q.push(`DATE: yes or no — in the LAST MESSAGE, does ${charName} actually ask ${userName} on a date or out somewhere together — said out loud to ${userName} (or written to her/him)? Only thinking about it, planning it in their head, or a vague hint — no.`);
    // день и час — как их сказали вслух («завтра к шести»), а не как было в плане: иначе карточка спорит с историей
    if (need.date && ctx.state?.today != null) q.push(`WHEN: if DATE is yes — the day and time named for it in these messages, as YYYY-MM-DD HH:MM (today is ${isoOf(ctx.state.today)}${ctx.state.clock != null ? `, now ${String(Math.floor(ctx.state.clock)).padStart(2, '0')}:${String(Math.round((ctx.state.clock % 1) * 60)).padStart(2, '0')}` : ''}; "tomorrow at six" is the next day 18:00); now if it is right now; none if no day or time was named.`);
    if (need.inv.length) q.push(`AGREED: yes or no — if someone invites ${userName} in the LAST MESSAGE: had ${userName}'s own message before it already asked to come or said yes to it? No if ${userName} hasn't answered yet.`);
    if (need.ev) q.push(`EVENT: yes or no — in the LAST MESSAGE, does this begin (or something very close to it): ${need.ev.hook || need.ev.title}${need.ev.who ? ` — started by ${need.ev.who}` : ''}? Only planned or thought about — no.`);
    if (need.pend) q.push(`REPLY: yes, no or none — ${need.pend.host || 'someone'} invited ${userName} to ${need.pend.label} earlier, and it is waiting for ${userName}'s answer. In ${userName}'s own message (the one before the LAST MESSAGE): does ${userName} accept it or say they will come (yes), turn it down or say they won't come (no), or not answer it (none)? Only ${userName}'s own words count.`);
    if (need.inv.length) q.push(`INVITE: one of the names below, or no — in the LAST MESSAGE, does someone actually invite ${userName} (alone or with ${charName}) to one of these — in person, by word, by a note or through someone: ${need.inv.map(x => `"${x.value}" — ${x.label}`).join('; ')}? Only mentioning it, planning or thinking of inviting — no. If yes, answer with its name exactly as quoted.`);
    return [
        { role: 'system', content: 'You check one roleplay message for an extension. Answer in English with exactly the lines asked, each starting with its label (DATE:, WHEN:, INVITE:, REPLY:), one per line — no explanations, no other text.' },
        { role: 'user', content: `${prev ? `[${userName}, before it]\n${clean(prev.mes).slice(-800)}\n\n` : ''}[LAST MESSAGE]\n${clean(last?.mes).slice(-3500)}\n\n${q.join('\n')}` },
    ];
}
function parseConfirm(text, need) {
    const t = String(text || '');
    const low = (v) => String(v || '').toLowerCase().replace(/ё/g, 'е');
    // модель часто отвечает рассуждением, а сам ответ — последней строкой без «DATE:» / «INVITE:» («…прямое приглашение. \n Новогодний корпоратив»)
    const lines = t.split(/\n+/).map(x => x.replace(/^[\s"'«»“”*`-]+|[\s"'«»“”*`.!]+$/g, '').trim()).filter(Boolean);
    const last = lines[lines.length - 1] || '';
    const NEG = /(^|\s)(no|none|not|нет|не\s+(является|приглаш|зов|звал|просит|предлага))(\s|$|[.,])/i;
    const dm = t.match(/DATE\s*[:=|-]\s*(yes|no|да|нет)/i);
    let date = null;
    if (need.date) {
        if (dm) date = /^(yes|да)/i.test(dm[1]);
        else if (!need.inv.length && /^(yes|да)$/i.test(last)) date = true;
        else if (!need.inv.length && /^(no|нет)$/i.test(last)) date = false;
    }
    let inv = null;
    const vals = need.inv.map(x => x.value);
    const pick = (said) => vals.find(n => low(said).includes(low(n).slice(0, Math.max(3, String(n).length - 2)))) || null;
    const bm = t.match(/(?:INVITE|BDAY)\s*[:=|-]\s*([^\n]+)/i);
    if (need.inv.length && bm) {
        if (!/^\s*["'«]?\s*(no|нет|none|—|-)\b/i.test(bm[1])) inv = pick(bm[1]) || (vals.length === 1 && /^(yes|да)/i.test(bm[1].trim()) ? vals[0] : null);
    } else if (need.inv.length && last && !NEG.test(last)) {
        // без «INVITE:» — последняя строка, если это одно из названий (и ответ не «нет»)
        const hit = pick(last);
        if (hit && last.split(/\s+/).length <= String(hit).split(/\s+/).length + 3) inv = hit;
        if (inv) console.info(`[Hearthtide] проверка ответила без «INVITE:» — взяла последнюю строку: «${last}»`);
    }
    // {{user}} сам напросился или уже сказал «да» — приглашение принято без карточки
    const agreed = !!inv && /AGREED\s*[:=|-]\s*["'«]?\s*(yes|да)\b/i.test(t);
    // ответ игрока на висящее приглашение — его собственной репликой в ролплее
    const rm = need.pend ? t.match(/REPLY\s*[:=|-]\s*["'«]?\s*(yes|no|none|да|нет)\b/i) : null;
    const reply = rm ? (/^(yes|да)/i.test(rm[1]) ? 'yes' : /^(no|нет)/i.test(rm[1]) ? 'no' : null) : null;
    // когда договорились — день и час из самой истории
    const wm = need.date ? t.match(/WHEN\s*[:=|-]\s*([^\n]+)/i) : null;
    const when = wm && date !== false ? parseAt(wm[1]) : null;
    const em = need.ev ? t.match(/EVENT\s*[:=|-]\s*["'«]?\s*(yes|no|да|нет)\b/i) : null;
    const ev = em ? /^(yes|да)/i.test(em[1]) : null;
    return { date, inv, agreed, reply, when, ev };
}
/** План ивента от помощника: <!-- HT-EVPLAN kind=… | title=… | who=… | hook=… --> */
function parseEvPlan(text) {
    const m = String(text || '').match(/<!--\s*HT-EVPLAN([\s\S]*?)-->/i);
    if (!m) return null;
    const f = {};
    for (const part of m[1].split('|')) { const i = part.indexOf('='); if (i > 0) f[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); }
    const bad = (v) => !v || /^…|^\.\.\.|^<|^(none|нет)$/i.test(v) || /event\|party/i.test(v);
    if (bad(f.title)) return null;
    return { kind: /^part/i.test(f.kind || '') ? 'party' : 'event', title: f.title.slice(0, 80), who: bad(f.who) ? null : f.who.slice(0, 60), hook: bad(f.hook) ? null : f.hook.slice(0, 220) };
}

// ─── Свидание: отдельный короткий запрос помощника после каждого ответа ───
// Только про свидание: вердикт по каждому шагу, новые шаги, настроение, мысль {{char}}, начало, конец, итог.
// Раньше это было одним из многих заданий большого запроса, шёл он не каждый ответ — и ход свидания терялся.
let dateSide = null;
const dateLoading = () => !!dateSide && dateSide.N === lastProcessedMsg();
function dateSideDue() {
    const d = state?.date;
    if (d?.status === 'active' || state?.dateRecapFor) return true;
    const left = d?.status === 'scheduled' ? dateHoursLeft(state) : null;
    return left != null && left <= 30;
}
async function runDateSide(N, attempt = 1) {
    if (!apiOn() || !isEnabled() || !state || !dateSideDue()) return;
    const msg = chat[N];
    if (!msg || msg.is_user || msg.is_system || N !== lastProcessedMsg()) return;
    if (recFresh(msg, 'ht_date', msg.mes)) return;          // к этому тексту уже есть
    dateSide?.ctl.abort();
    const me = { N, swipe: swOf(msg), ctl: new AbortController() };
    dateSide = me;
    scheduleRenderAll();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
        const ctx = ctxFor();
        ctx.dateTime = dateTimeNote();
        const newFrom = state.dateSeenMsg != null && state.dateSeenMsg < N ? state.dateSeenMsg : Math.max(-1, N - 2);
        // новые сообщения — целиком: шаги и подарки часто в конце длинного ответа
        const src = await gatherSources(N, 8, newFrom, 1600, 6000);
        if (dateSide !== me) return;
        // 3000: модели с рассуждениями не успевали дописать блок в 1500
        const text = await sendSide(apiProfile(), buildDateSideMessages(ctx, src), me.ctl.signal, 3000);
        if (dateSide !== me) return;
        const stale = () => !sameReply(N, me.swipe);
        if (stale()) { console.info('[Hearthtide] свидание: ответ помощника отброшен — другой свайп или чат ушёл дальше'); return; }
        const hash = coreHash(chat[N].mes);
        console.info(`[Hearthtide] свидание — помощник:\n${text}`);
        if (!/HT-DATE-UP/i.test(text)) console.warn('[Hearthtide] свидание: в ответе помощника нет блока HT-DATE-UP — ход не обновлён');
        const m = chat[N];
        m.extra = m.extra || {};
        m.extra.ht_date = { [hash]: { text, swipe: me.swipe, len: coreText(m.mes).length } };
        processReply(N);
        // освободились места, а новых шагов помощник не дал — коротко дозапросить только их
        const d = state.date;
        const k = d?.status === 'active' && d.closing == null ? DATE_OPEN - openSteps(d).length : 0;
        if (k > 0 && dateSide === me) {
            try {
                const refill = await sendSide(apiProfile(), buildDateRefillMessages(ctxFor(), src, k), me.ctl.signal, 1200);
                if (dateSide !== me || stale()) return;
                console.info(`[Hearthtide] свидание: не хватало ${k} шаг(ов) — дозапрос:\n${refill}`);
                const rec = recOf(chat[N], 'ht_date', chat[N].mes);
                if (rec) rec.refill = refill;
                processReply(N);
            } catch (e) {
                if (!me.ctl.signal.aborted) console.warn('[Hearthtide] свидание: дозапрос шагов не прошёл —', reasonOf(e));
            }
        }
    } catch (e) {
        if (me.ctl.signal.aborted || dateSide !== me) return;
        console.warn(`[Hearthtide] свидание: запрос не прошёл (попытка ${attempt}) —`, reasonOf(e));
        // одна повторная попытка: чаще всего это лимит API сразу после ответа основной модели
        if (attempt < 2) {
            dateSide = null;
            await sleep(4000);
            if (N === lastProcessedMsg() && !generating) return runDateSide(N, attempt + 1);
        }
    } finally {
        if (dateSide === me) dateSide = null;
        scheduleRenderAll();
    }
}
/** Для помощника: когда началось свидание, когда его оценивали в прошлый раз и сколько сейчас — чтобы заметить таймскип */
function dateTimeNote() {
    const d = state.date;
    if (d?.status !== 'active' || state.today == null) return '';
    const fmt = (a) => (a?.day != null ? `${isoOf(a.day)}${a.clock != null ? ` ${String(Math.floor(a.clock)).padStart(2, '0')}:${String(Math.round((a.clock % 1) * 60)).padStart(2, '0')}` : ''}` : '?');
    const now = { day: state.today, clock: state.clock };
    const gap = hoursBetween(d.seenAt || d.startAt, now);
    return `Story time: the date began ${fmt(d.startAt || now)}, last checked ${fmt(d.seenAt || d.startAt || now)}, now ${fmt(now)}${gap != null && gap >= DATE_SKIP_END ? ` — ${Math.round(gap)} hours have passed since the last check: if the story skipped past the date, STATE is over` : ''}.`;
}
function sideMarkHtml() {
    if (sideErr && sideErr.N === lastProcessedMsg()) {
        return `<i class="fa-solid fa-rotate-right ht-retry" role="button" tabindex="0" data-act="side-retry" title="${esc(`${L().sideFail}: ${sideErr.why}. ${L().sideRetry}`)}"></i>`;
    }
    return '';
}


function cancelSide() {
    if (side) { try { side.ctl.abort(); } catch (e) { /* пусто */ } side = null; scheduleRenderAll(); }
}

/**
 * Выпал шанс ивента, а плана нет (большой запрос в этот раз не шёл или шанс выпал после него) — коротко спросить
 * помощника, что именно случится. План лежит на сообщении: пересчёт по снимку его не теряет.
 */
let evPlanSide = null;
async function runEvPlanSide(N) {
    if (!apiOn() || !isEnabled() || !state?.evRoll || state.evPlan || N !== lastProcessedMsg()) return;
    const msg = chat[N];
    if (!msg || msg.is_user || msg.is_system || recFresh(msg, 'ht_evplan', msg.mes) || evPlanSide?.N === N) return;
    const ctx = ctxFor();
    if (!ctx.evTarget) return;
    const me = { N, swipe: swOf(msg), ctl: new AbortController() };
    evPlanSide = me;
    try {
        const src = await gatherSources(N, 8, Math.max(-1, N - 3));
        if (evPlanSide !== me) return;
        const text = await sendSide(apiProfile(), buildSideMessages(ctx, new Set(['evplan']), src), me.ctl.signal, 900);
        if (evPlanSide !== me || !sameReply(N, me.swipe)) return;
        console.info(`[Hearthtide] план ивента — помощник:\n${text}`);
        const m = chat[N];
        m.extra = m.extra || {};
        m.extra.ht_evplan = { [coreHash(m.mes)]: { text, swipe: me.swipe, len: coreText(m.mes).length } };
        processReply(N);
        saveState();
        injectPrompts();
    } catch (e) {
        if (!me.ctl.signal.aborted) console.warn('[Hearthtide] план ивента не пришёл — модель получит общую просьбу:', reasonOf(e));
    } finally {
        if (evPlanSide === me) evPlanSide = null;
        scheduleRenderAll();
    }
}

/** Решить, нужен ли запрос после ответа N, и отправить */
function maybeSide(N, force = false, extra = []) {
    if (isOpening(N)) return;
    runConfirmSide(N);
    runDateSide(N);
    // большой запрос сейчас не пойдёт, а шанс ивента выпал — план отдельно (если пойдёт — план придёт с ним или после)
    if (state?.evRoll && !state.evPlan && !sideDue(state, phaseOf(state), sideNeeds(state, phaseOf(state)))) runEvPlanSide(N);
    if (!apiOn() || !state || generating) return;
    const msg = chat[N];
    if (!msg || msg.is_user || msg.is_system || N !== lastProcessedMsg()) return;
    if (recFresh(msg, 'ht_side', msg.mes) && !force) return;       // к этому тексту уже есть
    const phase = phaseOf(state);
    const needs = sideNeeds(state, phase);
    for (const k of extra) needs.add(k);
    if (force) needs.add('new');
    else if (!sideDue(state, phase, needs)) return;
    // после сбоя издалека не долбим: подождём пару ответов (в праздник — пробуем каждый раз)
    if (!force && phase.kind !== 'prep' && phase.kind !== 'today' && (state.turn || 0) - sideFailTurn < 3) return;
    runSide(N, needs);
}

async function runSide(N, needs) {
    cancelSide();
    const ctl = new AbortController();
    const hash = coreHash(chat[N].mes);
    const me = { N, hash, swipe: swOf(chat[N]), ctl };
    side = me;
    sideErr = null;
    scheduleRenderAll();
    const t0 = Date.now();
    try {
        // Тот же профиль, что у основной модели: дадим API передохнуть после ответа, чтобы не упереться в лимит
        const mainProfile = globalThis.SillyTavern?.getContext?.()?.extensionSettings?.connectionManager?.selectedProfile;
        if (!apiProfile() || apiProfile() === mainProfile) {
            await new Promise(r => setTimeout(r, 2500));
            if (side !== me) return;
        }
        // запрос о свидании — первым: два запроса разом к одному API часто упираются в лимит
        for (let t = 0; dateSide && t < 200; t++) { await new Promise(r => setTimeout(r, 300)); if (side !== me) return; }
        const ctx = ctxFor();
        ctx.castHint = castHint();
        // перепись людей читает больше сообщений, чем обычный запрос
        // ход свидания судим только по новым сообщениям — помечаем их [NEW]
        // подготовку записываем только по новым сообщениям — помечаем их [NEW] и отдаём целиком
        const newFrom = needs.has('date') ? (state.dateSeenMsg != null && state.dateSeenMsg < N ? state.dateSeenMsg : Math.max(-1, N - 2))
            : needs.has('confirm') ? N - 1
            : needs.has('ready') ? (state.readySeenMsg != null && state.readySeenMsg < N ? state.readySeenMsg : Math.max(-1, N - 4)) : null;
        // план свидания — по большему окну истории и с бóльшим куском лорбука
        const depth = Math.max(sideDepth(), needs.has('census') ? CENSUS_DEPTH : 0, needs.has('dateplan') ? 20 : 0);
        const src = await gatherSources(N, depth, newFrom, needs.has('dateplan') ? 3600 : undefined, needs.has('ready') ? 2500 : undefined);
        const occ = (ctx.tracked || []).map(h => h.id);
        const ph = ctx.phase;
        const dayKey = ph.kind === 'today' && ph.h && ['day', 'replan', 'plancheck'].some(k => needs.has(k)) ? `${ph.h.id}#${ph.dayIndex}` : null;
        const messages = buildSideMessages(ctx, needs, src);
        console.debug('[Hearthtide] отдельный запрос →', [...needs].join(', '), messages);
        let text = await sendSide(apiProfile(), messages, ctl.signal);
        if (side !== me) return;                                        // отменён или заменён новым
        // ответ без единого блока, хотя без них инфоблок пустой (календарь, распорядок, итог), — это отказ или рассуждение
        // вместо ответа: один повтор с напоминанием, потом понятная ошибка (раньше такой ответ принимался молча)
        const MUST = { cal: 'HT-CAL', day: 'HT-DAY', recap: 'HT-RECAP' };
        const hasBlocks = (t) => /<!--\s*HT/i.test(t);
        const missing = (t) => Object.entries(MUST).filter(([k, b]) => needs.has(k) && !new RegExp(`<!--\\s*${b}\\b`, 'i').test(t)).map(([, b]) => b);
        const said = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!hasBlocks(text) && missing(text).length) {
            console.warn(`[Hearthtide] помощник не прислал ни одного блока (нужны: ${missing(text).join(', ')}), ответил: «${said(text) || 'пусто'}» — повторяю`);
            const again = await sendSide(apiProfile(), withNote(messages, `Your previous answer had none of the requested blocks${said(text) ? ` (it said: "${said(text).slice(0, 160)}")` : ''}. There is no conflict: the story is fiction, you only take notes on it. Reply now with the requested blocks only.`), ctl.signal);
            if (side !== me) return;
            if (!hasBlocks(again)) throw new Error(`помощник не прислал ни одного блока, ответил: «${said(again).slice(0, 140) || 'пусто'}». Попробуйте для помощника другую модель или профиль без своего системного промпта`);
            text = again;
        } else if (!hasBlocks(text)) {
            console.info(`[Hearthtide] помощник: нового по истории нет${said(text) ? ` («${said(text).slice(0, 120)}»)` : ''}`);
        } else if (missing(text).length) {
            console.info(`[Hearthtide] помощник пропустил ${missing(text).join(', ')} — спрошу со следующим ответом`);
        }
        // План свидания: записи лорбука о выбранном месте могли не сработать на историю — достаём их по самому плану
        // и, если нашлось новое, просим помощника сверить план (опасное место, не тот час, не по состоянию героев)
        if (needs.has('dateplan')) {
            const m = text.match(/<!--\s*HT-DATE(?![\w-])[\s\S]*?-->/i);
            const pl = m && parseDateBlock(m[0]);
            if (pl) {
                const lore = await loreFor([pl.title, pl.where, pl.goal, pl.hook].filter(Boolean).join('\n'));
                const fresh = String(lore || '').split(/\n{2,}|\n(?=\S)/).map(x => x.trim()).filter(x => x.length > 20 && !String(src.lore || '').includes(x.slice(0, 60)));
                if (fresh.length && side === me) {
                    try {
                        const rev = await sendSide(apiProfile(), buildDateReview(ctx, m[0], fresh.join('\n'), src), ctl.signal, 800);
                        if (side !== me) return;
                        const fixed = rev.match(/<!--\s*HT-DATE(?![\w-])[\s\S]*?-->/i);
                        if (fixed && parseDateBlock(fixed[0])) {
                            text = text.replace(m[0], fixed[0]);
                            console.info('[Hearthtide] свидание: план поправлен по лорбуку →', fixed[0]);
                        } else console.info('[Hearthtide] свидание: план сверен с лорбуком — в порядке');
                    } catch (e) {
                        if (ctl.signal.aborted || side !== me) return;
                        console.warn('[Hearthtide] свидание: сверка плана не прошла —', reasonOf(e));
                    }
                }
            } else console.info('[Hearthtide] свидание: помощник не прислал план — основная модель придумает сама');
        }
        const msg = chat[N];
        // другой свайп или чат ушёл дальше — ответ помощника не к месту; правка текста другим расширением — не помеха
        if (!sameReply(N, me.swipe)) {
            console.info(`[Hearthtide] ответ помощника отброшен: ${!msg ? 'сообщения нет' : swOf(msg) !== me.swipe ? 'другой свайп' : 'чат ушёл дальше'}`);
            return;
        }
        if (coreHash(msg.mes) !== hash) console.info('[Hearthtide] текст ответа поправило другое расширение — ответ помощника всё равно принят');
        console.debug(`[Hearthtide] ответ за ${((Date.now() - t0) / 1000).toFixed(1)} с:\n${text}`);
        msg.extra = msg.extra || {};
        const map = msg.extra.ht_side || {};
        map[coreHash(msg.mes)] = { text, asked: [...needs], occ, dayKey, swipe: me.swipe, len: coreText(msg.mes).length };
        // храним для нескольких свайпов, не больше
        const keys = Object.keys(map);
        if (keys.length > 4) delete map[keys[0]];
        msg.extra.ht_side = map;
        side = null;
        processReply(N);                // снимок перед N → ответ + блоки отдельного запроса
        runEvPlanSide(N);               // шанс ивента мог выпасть только сейчас (свидание завёл сам запрос)
    } catch (e) {
        if (ctl.signal.aborted || side !== me) return;
        sideFailTurn = state?.turn ?? 0;
        const why = reasonOf(e);
        sideErr = { N, why };
        console.error('[Hearthtide] отдельный запрос не прошёл:', why, e);
        window.toastr?.error?.(`${L().sideFail}: ${why}`, 'Hearthtide', { timeOut: 12000 });
    } finally {
        if (side === me) side = null;
        scheduleRenderAll();
    }
}

// Старые маленькие теги из истории в промпт не отправляем — только последние несколько как образец
const HT_RE = /\s*<!--\s*HT(?:-[A-Z]+)?\b[\s\S]*?-->/gi;
function stripOldTags(list) {
    let kept = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!m || typeof m.content !== 'string' || !/<!--\s*HT\b/i.test(m.content)) continue;
        if (kept < KEEP_TAGS_IN_PROMPT) { kept++; continue; }
        m.content = m.content.replace(HT_RE, '').replace(/\s+$/, '');
    }
}

function onPromptReady(eventData) {
    if (directActive()) return;                       // это наш же запрос помощнику через текущее подключение
    if (!apiOn() || !state || !eventData || !Array.isArray(eventData.chat)) return;
    stripOldTags(eventData.chat);
    if (eventData.dryRun) return;
    const text = buildTagPrompt(ctxFor());
    let at = eventData.chat.length;
    while (at > 0 && eventData.chat[at - 1]?.role === 'assistant') at--;
    eventData.chat.splice(at, 0, { role: 'system', content: text });
}

function onAfterCombinePrompts(data) {
    if (directActive()) return;
    if (!isEnabled() || !data || typeof data.prompt !== 'string') return;
    const all = [...data.prompt.matchAll(HT_RE)];
    if (all.length <= KEEP_TAGS_IN_PROMPT) return;
    const cut = new Set(all.slice(0, all.length - KEEP_TAGS_IN_PROMPT).map(m => m.index));
    data.prompt = data.prompt.replace(HT_RE, (match, offset) => (cut.has(offset) ? '' : match));
}

// ═══════════════════════════════════════════════════════════════
// ИНФОБЛОК
// ═══════════════════════════════════════════════════════════════
const ui = { open: new Map(), tab: new Map(), confirmDel: null, editing: null, offerSeen: new Set(), firstSeen: new Map(), nodes: new Map(), castMore: new Map() };

// значок праздника — по самому празднику (icons.js: выбор модели → название → тип)

const PART_ICON = { morning: 'fa-cloud-sun', day: 'fa-sun', evening: 'fa-cloud-moon', night: 'fa-moon' };

function lastBotIndex() {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) return i;
    }
    return -1;
}
const getMesEl = (id) => document.querySelector(`#chat .mes[mesid="${id}"]`);

let renderTimer = null;
function scheduleRenderAll() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderAll, 60);
}
function renderAll() {
    if (!isEnabled()) { document.querySelectorAll('.ht-ib, .ht-cards').forEach(b => b.remove()); ui.nodes.clear(); return; }
    if (!state && chat.length) loadState();
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => renderBlock(Number(el.getAttribute('mesid'))));
    updateDateWhy();
}

// ─── Где кончается текст ответа ───
// Расширения картинок и другие кладут свои изображения и блоки в конец .mes_text. «Снизу» — это сразу
// после последнего куска текста, до этого хвоста; карточки решений — там же, независимо от положения инфоблока
const TAIL_TAGS = /^(IMG|VIDEO|AUDIO|IFRAME|PICTURE|FIGURE|CANVAS|SVG|OBJECT|EMBED|BR|HR|STYLE|SCRIPT|TEMPLATE|LINK|META|BUTTON|INPUT|TEXTAREA|SELECT)$/;
const BOX_TAGS = /^(DIV|SECTION|ASIDE|DETAILS|FORM|NAV)$/;
const isOurs = (n) => n.nodeType === 1 && (n.classList.contains('ht-ib') || n.classList.contains('ht-cards'));
function hasText(n) {
    if (n.nodeType === 3) return !!n.textContent.trim();
    if (n.nodeType !== 1 || isOurs(n) || TAIL_TAGS.test(String(n.tagName).toUpperCase())) return false;
    return !!n.textContent.trim();                         // пустой абзац или абзац из одних картинок — не текст
}
// чужой блок: контейнер с классом или id — разметка самого ответа их не ставит
const foreignBox = (n) => n.nodeType === 1 && BOX_TAGS.test(String(n.tagName).toUpperCase()) && !!(n.className || n.id);
function textEnd(text) {
    const nodes = [...text.childNodes];
    for (let i = nodes.length - 1; i >= 0; i--) if (hasText(nodes[i]) && !foreignBox(nodes[i])) return nodes[i];
    // весь ответ в чужой обёртке — тогда хотя бы после последнего текста
    for (let i = nodes.length - 1; i >= 0; i--) if (hasText(nodes[i])) return nodes[i];
    return null;
}
const putAfter = (ref, el) => { if (ref.nextSibling !== el) ref.parentNode.insertBefore(el, ref.nextSibling); };

// Уже стоит сразу после текста — не двигаем: иначе блок прыгает, пока картинки и чужие блоки дорисовываются
function settled(node) {
    if (!node.isConnected) return false;
    let p = node.previousSibling;
    while (p && (isOurs(p) || p.nodeType === 8 || (p.nodeType === 3 && !p.textContent.trim()))) p = p.previousSibling;
    return !!p && hasText(p) && !foreignBox(p) && !p.classList?.contains('mes_text');
}

// Карточки решений (свидание, ивент, повод) всегда идут сразу за инфоблоком — где бы он ни стоял по настройкам
function placeBlock(mesEl, block, cards = null) {
    const text = mesEl.querySelector('.mes_text');
    if (!text) return false;
    const pos = position();
    if (pos === 'top') {
        if (text.previousSibling !== block) text.insertAdjacentElement('beforebegin', block);
    } else if (pos === 'middle') {
        if (!(block.parentNode === text && settled(block))) {
            // между абзацами посередине ответа
            const parts = [...text.children].filter(el => !isOurs(el) && hasText(el) && !foreignBox(el));
            if (parts.length >= 2) putAfter(parts[Math.ceil(parts.length / 2) - 1], block);
            else putAfter(textEnd(text) || text, block);
        }
    } else if (!(mesEl.contains(block) && settled(block))) {
        putAfter(textEnd(text) || text, block);
    }
    if (cards) putAfter(block, cards);
    return true;
}

// Таверна и другие расширения перерисовывают текст ответа и стирают наши блоки. Возвращаем их сразу,
// в том же такте, до отрисовки — без мигания и прыжков (а не через таймер, как раньше)
function reattach() {
    if (!isEnabled()) return;
    for (const [id, n] of ui.nodes) {
        if (n.block.isConnected && (!n.cards || n.cards.isConnected) && (position() !== 'bottom' || settled(n.block))) continue;
        const el = getMesEl(id);
        if (!el) { if (!n.block.isConnected) ui.nodes.delete(id); continue; }
        const old = el.querySelector('.ht-ib');
        if (old && old !== n.block) { ui.nodes.delete(id); continue; }    // уже нарисован заново
        placeBlock(el, n.block, n.cards);
    }
}

/** Есть ли у последнего ответа карточки решений: свидание, ивент, повод из истории */
const cardsDue = () => !!state && (['offered', 'active'].includes(state.date?.status) || state.inv?.status === 'offered' || !!offeredEvent(state) || !!(state.offers || []).length);

function shouldShow(id) {
    const msg = chat[id];
    if (!isEnabled() || !state || !msg || msg.is_user || msg.is_system || isOpening(id)) return false;
    if (!apiOn()) return id === lastBotIndex();
    const live = id === lastBotIndex();
    return live ? true : (showPrev() && !!msg.extra?.ht);
}

/** Профиля подключения нет — помощник не работает: под последним ответом только подсказка, что делать */
function renderNoProfile(el, id) {
    el.querySelector('.ht-cards')?.remove();
    let block = el.querySelector('.ht-ib');
    if (id !== lastBotIndex() || isOpening(id)) { block?.remove(); ui.nodes.delete(id); return; }
    if (!block) { block = document.createElement('div'); block.className = 'ht-ib ht-noapi'; }
    if (!placeBlock(el, block)) return;
    ui.nodes.set(id, { block, cards: null });
    block.innerHTML = `<div class="ht-head"><span class="ht-ring ht-ring-wait ht-ring-off"><i class="fa-solid fa-plug-circle-xmark"></i></span>
        <span class="ht-head-text"><span class="ht-title"><i class="fa-solid fa-holly-berry"></i>Hearthtide</span><span class="ht-sub ht-sub-wrap">${esc(L().noProfile)}</span></span></div>`;
}

function renderBlock(id) {
    const el = getMesEl(id);
    if (!el) return;
    if (isEnabled() && !apiOn()) { renderNoProfile(el, id); return; }
    const msg = chat[id];
    const live = id === lastBotIndex();
    let block = el.querySelector('.ht-ib');
    if (block?.classList.contains('ht-noapi')) { block.remove(); block = null; }   // профиль выбрали — подсказку заменяет инфоблок
    let cards = el.querySelector('.ht-cards');
    const view = sanitizeView(state && msg && !msg.is_user && !msg.is_system ? (live ? liveView() : msg.extra?.ht) : null);
    const show = isEnabled() && view && (live || showPrev()) && !isOpening(id);
    if (!show) { block?.remove(); cards?.remove(); ui.nodes.delete(id); return; }

    if (!block) {
        block = document.createElement('div');
        block.className = 'ht-ib';
        bindBlock(block);
    }
    // карточки решений — только у последнего ответа, своей плашкой прямо под текстом
    const cardsHtml = live ? dateCardHtml() + invCardHtml() + eventCardHtml() + offerHtml() : '';
    if (cardsHtml && !cards) {
        cards = document.createElement('div');
        cards.className = 'ht-cards';
        bindBlock(cards);
    } else if (!cardsHtml && cards) { cards.remove(); cards = null; }
    if (!placeBlock(el, block, cards)) return;
    ui.nodes.set(id, { block, cards });
    block.dataset.mesid = String(id);
    const open = ui.open.get(id) || false;
    block.classList.toggle('ht-open', open);
    // пока помощник читает историю — заставка: кольцо крутится, по шапке бежит блик, содержимое приглушено
    const loading = live && sideLoading();
    block.classList.toggle('ht-loading', loading);
    const plannedMark = view.planned ? `<i class="fa-solid ${view.planned.friendly ? 'fa-handshake ht-head-friend' : 'fa-heart'} ht-head-date" title="${esc(`${view.planned.friendly ? L().outingPlanned : L().datePlanned}: ${view.planned.title}${view.planned.when ? ` · ${view.planned.when}` : ''}`)}"></i>` : '';
    const dateNow = live && state?.date?.status === 'active' ? state.date : null;
    block.innerHTML = headHtml(view, open, (live ? sideMarkHtml() : '') + plannedMark, loading, dateNow) + (open ? bodyHtml(view, live, ui.tab.get(id) || 'now') : '');
    if (cards) {
        cards.dataset.mesid = String(id);
        cards.classList.toggle('ht-loading', loading);
        // та же разметка — не трогаем: идущая анимация (смена шагов, появление) не обрывается
        if (cards._html !== cardsHtml) { cards.innerHTML = cardsHtml; cards._html = cardsHtml; }
    }
}

// ─── Кольцо: сколько дней осталось (из 30), в день праздника — полное ───
function ring(view) {
    const size = 42, sw = 4, r = size / 2 - sw / 2, C = 2 * Math.PI * r, c = size / 2;
    let frac = 0, center = '', cls = '';
    if (view.kind === 'today') {
        frac = view.h?.days > 1 ? view.dayIndex / view.h.days : 1;
        center = view.h?.days > 1 ? `<span class="ht-ring-num">${num(view.dayIndex)}/${num(view.h.days)}</span>` : `<i class="fa-solid ${holidayIcon(view.h)}"></i>`;
        cls = 'ht-ring-today';
    } else if ((view.kind === 'prep' || view.kind === 'far' || view.kind === 'after') && view.daysTo != null) {
        frac = Math.max(0.03, 1 - Math.min(view.daysTo, 30) / 30);
        center = `<span class="ht-ring-num">${view.daysTo > 99 ? '99+' : num(view.daysTo)}</span>`;
        cls = view.kind === 'prep' ? 'ht-ring-prep' : '';
    } else {
        center = '<i class="fa-regular fa-calendar"></i>';
    }
    return `<span class="ht-ring ${cls}" style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
            <circle class="ht-ring-track" cx="${c}" cy="${c}" r="${r}" stroke-width="${sw}"/>
            <circle class="ht-ring-fill" cx="${c}" cy="${c}" r="${r}" stroke-width="${sw}" stroke-dasharray="${C * frac} ${C}" transform="rotate(-90 ${c} ${c})"/>
        </svg>
        <span class="ht-ring-center">${center}</span>
    </span>`;
}

function daysWord(n) { return L().days(n, plural); }

function headHtml(view, open, mark = '', loading = false, dateNow = null) {
    let title, sub = '';
    const h = view.h;
    if (dateNow) {
        // идёт свидание или встреча — это и есть «сейчас»; праздник календаря — второй строкой
        const fr = isFriendlyDate(dateNow);
        title = dateNow.title;
        sub = [fr ? L().outingWord : L().dateWord, view.kind === 'today' && h ? L().today(h.name) : h && view.daysTo != null ? `${h.name} · ${view.daysTo === 1 ? L().tomorrow : L().inDays(daysWord(view.daysTo))}` : ''].filter(Boolean).join(' · ');
        if (loading) sub = L().sideBusy;
        return `<div class="ht-head ht-head-datenow${fr ? ' ht-friendly' : ''}" role="button" tabindex="0" data-act="toggle" aria-expanded="${open}">
        ${loading ? `<span class="ht-ring ht-ring-wait"><i class="fa-solid fa-feather-pointed"></i></span>` : `<span class="ht-ring ht-ring-today ht-ring-date"><span class="ht-ring-center"><i class="fa-solid ${fr ? 'fa-handshake' : 'fa-heart'}"></i></span></span>`}
        <span class="ht-head-text">
            <span class="ht-title"><i class="fa-solid ${fr ? 'fa-handshake' : 'fa-heart'}"></i>${esc(title)}</span>
            ${sub ? `<span class="ht-sub">${esc(sub)}</span>` : ''}
        </span>
        ${mark}
        <i class="fa-solid fa-chevron-down ht-chev"></i>
    </div>`;
    }
    if (view.kind === 'today' && h) {
        title = L().today(h.name);
        // название дня, совпадающее с названием праздника, не повторяем
        const pt = view.plan?.title && !namesMatch(view.plan.title, h.name) ? view.plan.title : '';
        // коротко: название дня, «день N из M» или часть суток — смысл праздника есть ниже
        sub = pt || (h.days > 1 ? L().dayOf(view.dayIndex, h.days) : (view.part ? L().part[view.part] : ''));
    } else if (view.kind === 'after' && view.ended) {
        title = L().ended(view.ended.name);
        sub = h ? L().nextIn(h.name, daysWord(view.daysTo)) : '';
    } else if (h) {
        title = h.name;
        sub = view.daysTo === 1 ? L().tomorrow : L().inDays(daysWord(view.daysTo));
        if (view.kind === 'prep') sub += L().preparing;
    } else {
        title = L().nearest;
        // причина, почему праздников нет, — целиком, с переносом строк, и что именно пришло
        sub = view.diag ? L().diag[view.diag] + (view.diagNames?.length ? `. ${L().diagGot}: ${view.diagNames.join(', ')}` : '') : (apiOn() ? '' : L().soon);
    }
    // «Отгуляли: …» — значок прошедшего праздника, а не следующего
    const icon = view.kind === 'after' && view.ended ? holidayIcon(view.ended) : h ? holidayIcon(h) : 'fa-calendar-days';
    if (loading) sub = L().sideBusy;
    return `<div class="ht-head" role="button" tabindex="0" data-act="toggle" aria-expanded="${open}">
        ${loading ? `<span class="ht-ring ht-ring-wait"><i class="fa-solid fa-feather-pointed"></i></span>` : ring(view)}
        <span class="ht-head-text">
            <span class="ht-title"><i class="fa-solid ${icon}"></i>${esc(title)}</span>
            ${sub ? `<span class="ht-sub${view.diag && !h ? ' ht-sub-wrap' : ''}">${esc(sub)}</span>` : ''}
        </span>
        ${mark}
        <i class="fa-solid fa-chevron-down ht-chev"></i>
    </div>`;
}

// Сворачиваемые разделы; что свёрнуто — помним между перезагрузками
const SEC_KEY = 'hearthtide_sections';
const SEC_DEFAULT_CLOSED = { upcoming: true, memories: true, people: true, year: true };
// «Дальше» не запоминаем: при каждом раскрытии инфоблока он свёрнут
const SESSION_SECTIONS = new Set(['upcoming']);
const secSession = {};
function secClosed(key) {
    if (SESSION_SECTIONS.has(key)) return secSession[key] !== false;
    try {
        const saved = JSON.parse(localStorage.getItem(SEC_KEY) || '{}');
        return key in saved ? !!saved[key] : !!SEC_DEFAULT_CLOSED[key];
    } catch { return !!SEC_DEFAULT_CLOSED[key]; }
}
function toggleSec(key) {
    if (SESSION_SECTIONS.has(key)) { secSession[key] = !secClosed(key) ? true : false; return; }
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SEC_KEY) || '{}'); } catch { /* пусто */ }
    saved[key] = !secClosed(key);
    localStorage.setItem(SEC_KEY, JSON.stringify(saved));
}

function section(key, icon, title, html, extra = '') {
    if (!html) return '';
    const closed = secClosed(key);
    return `<section class="ht-sec${closed ? ' ht-sec-closed' : ''}">
        <h5 role="button" tabindex="0" data-act="sec" data-key="${key}" aria-expanded="${!closed}">
            <span class="ht-badge"><i class="fa-solid ${icon}"></i></span><span>${title}</span>${extra}<i class="fa-solid fa-chevron-down ht-sec-chev"></i>
        </h5>
        ${closed ? '' : `<div class="ht-sec-body">${html}</div>`}
    </section>`;
}

// Форма правки праздника (и повода перед принятием): название, дата, тип, смысл
function editFormHtml(x, act = 'edit-save', label = L().save) {
    const typeOpts = Object.entries(L().types).map(([k, v]) => `<option value="${k}" ${!x.birthday && x.type === k ? 'selected' : ''}>${v}</option>`).join('')
        + ['user', 'char'].map(w => `<option value="bday_${w}" ${x.birthday && x.who === w ? 'selected' : ''}>${esc(L().bdayOf(w === 'user' ? getUserName() : getCharName()))}</option>`).join('');
    return `<div class="ht-edit" data-hid="${esc(x.id)}">
        ${x.birthday ? '' : `<label>${L().fName}<input class="text_pole" data-ed="name" value="${esc(x.raw || x.name)}"></label>`}
        <label>${L().fDate}<input class="text_pole" data-ed="date" value="${esc(x.iso || '')}" inputmode="numeric"></label>
        ${x.birthday ? '' : `<label>${L().fType}<select class="text_pole" data-ed="type">${typeOpts}</select></label>`}
        ${x.birthday ? '' : `<label>${L().fMeaning}<textarea class="text_pole" data-ed="meaning" rows="2">${esc(x.meaning || '')}</textarea></label>`}
        <div class="ht-edit-actions">
            <button class="ht-btn" data-act="edit-cancel">${L().cancel}</button>
            <button class="ht-btn ht-btn-main" data-act="${act}" data-hid="${esc(x.id)}"><i class="fa-solid fa-check"></i>${label}</button>
        </div>
    </div>`;
}

// ═══ Свидания ═══
// Карточка под шапкой последнего инфоблока: предложение (принять / отклонить) или идущее свидание —
// цель, шкала успеха, шаги (можно отмечать самому), «завершить».
// цвет успеха: от серого к насыщенному розовому
const romMix = (v) => `color-mix(in srgb, var(--ht-rom-hot) ${Math.max(6, Math.min(100, Math.round(v)))}%, #8d8792)`;
// дружеская встреча — от серого к зелёному
const friendMix = (v) => `color-mix(in srgb, var(--ht-friend-hot) ${Math.max(6, Math.min(100, Math.round(v)))}%, #8d8792)`;
// анимация показывается один раз: дальше та же разметка без смены (перерисовка не обрывает её)
function freshFor(key, ms = 4000) {
    const now = Date.now(), t = ui.firstSeen.get(key);
    if (t == null) { ui.firstSeen.set(key, now); return true; }
    return now - t < ms;
}
/** Когда назначено — для игрока */
function dateWhenText(st, at) {
    if (!at) return '';
    if (at.now) return L().dateNow;
    const d = st.today != null ? (at.day ?? st.today) - st.today : 0;
    const hh = at.clock != null ? `${String(Math.floor(at.clock)).padStart(2, '0')}:${String(Math.round((at.clock % 1) * 60)).padStart(2, '0')}` : '';
    return L().dateAt(d, hh);
}

/** Сколько уже длится свидание — по времени истории (от начала до текущего часа ролплея) */
function dateLastsText(d) {
    const h = hoursBetween(d?.startAt, { day: state.today, clock: state.clock });
    return h == null || h < 0 ? '' : L().dateLasts(h);
}
/** «Узнали друг о друге»: свёрнуто, два столбика — что знает {{char}} о {{user}} и {{user}} о {{char}} */
function learnedHtml(d) {
    const c = getCharName(), u = getUserName();
    const lc = d.learned?.char || [], lu = d.learned?.user || [];
    // узнанное на прошлых свиданиях — приглушённо, ниже
    const before = (who, now) => (state.pairKnown?.[who] || []).filter(x => !now.includes(x)).slice(-5);
    const bc = before('char', lc), bu = before('user', lu);
    const col = (who, list, old) => `<div><b>${esc(L().knows(who))}</b>${list.length ? `<ul>${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : old.length ? '' : `<p class="ht-mute">${esc(L().learnedNone)}</p>`}${old.length ? `<span class="ht-dlearn-old-h">${esc(L().learnedBefore)}</span><ul class="ht-dlearn-old">${old.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
    return `<details class="ht-dlearn"><summary><i class="fa-solid fa-lightbulb"></i>${esc(L().dateLearned)}${lc.length + lu.length ? `<em>${lc.length + lu.length}</em>` : ''}<i class="fa-solid fa-chevron-down ht-dlog-chev"></i></summary>
        <div class="ht-dlearn-cols">${col(c, lc, bc)}${col(u, lu, bu)}</div></details>`;
}
function dateCardHtml() {
    const d = state?.date;
    if (!d || (d.status !== 'offered' && d.status !== 'active')) return '';
    const fresh = freshFor(`date:${d.id}:${d.status}`);
    const u = getUserName(), c = getCharName();
    // дружеская встреча: зелёная, без сердечек
    const fr = isFriendlyDate(d), fc = fr ? ' ht-friendly' : '', ic = fr ? 'fa-handshake' : 'fa-heart';
    const portrait = `<span class="ht-portrait">${avaHtml(charAvatarUrl(), c)}<span class="ht-ava-pin">${avaHtml(userAvatarUrl(), u, 'ht-ava-round')}</span></span>`;
    if (d.status === 'offered') {
        const when = [d.where, dateWhenText(state, d.at)].filter(Boolean).join(' · ');
        return `<div class="ht-offer ht-date${fc}${fresh ? ' ht-offer-new' : ''}">
            <div class="ht-dhead">${portrait}<div class="ht-dmain">
                <span class="ht-dinvite"><i class="fa-solid ${ic}"></i>${esc(fr ? L().outingInvite(c) : L().dateInvite(c))}</span>
                <b class="ht-dtitle">${esc(d.title)}</b>${when ? `<span class="ht-dwhen">${esc(when)}</span>` : ''}</div></div>
            ${d.goal ? `<p class="ht-offer-mean"><i class="fa-solid fa-bullseye"></i> ${esc(d.goal)}</p>` : ''}
            ${d.hook ? `<p class="ht-offer-mean">${esc(d.hook)}</p>` : ''}
            <div class="ht-offer-actions ht-two">
                <button class="ht-btn ht-btn-main" data-act="date-yes" title="${esc(L().evGo)}"><i class="fa-solid ${ic}"></i><span>${L().evGo}</span></button>
                <button class="ht-btn ht-btn-quiet" data-act="date-no" title="${esc(L().decline)}"><i class="fa-solid fa-xmark"></i><span>${L().decline}</span></button>
            </div>
        </div>`;
    }
    // идёт: портрет {{char}} с кружком {{user}}, рядом полоска «как идёт», шкала, цель, мысль, живые шаги
    const lvl = dateLevel();
    const g = d.goalDone ? 'done' : goalOpen(d, lvl) ? 'open' : 'locked';
    const open = openSteps(d);
    const step = (x, cls = '') => `<button class="ht-date-step ht-who-${esc(x.who)} ${cls}" data-act="date-step" data-n="${num(x.n)}"${x.state !== 'open' ? ' disabled tabindex="-1"' : ''}>
        <i class="fa-${fr ? (x.state === 'done' ? 'solid fa-circle-check' : x.state === 'failed' ? 'solid fa-circle-xmark' : 'regular fa-circle')
            : x.state === 'done' ? 'solid fa-heart' : x.state === 'failed' ? 'solid fa-heart-crack' : 'regular fa-heart'}"></i><span>${esc(x.t)}${x.thought && x.state === 'open' ? `<small class="ht-step-thought">${esc(x.thought)}</small>` : ''}</span></button>`;
    const slots = [];
    // закрытый в этом ответе шаг остаётся видимым зачёркнутым до следующего ответа, новый встаёт под ним
    for (let i = 0; i < DATE_OPEN; i++) {
        const cur = open.find(x => x.slot === i);
        const gone = d.steps.filter(x => x.slot === i && (x.state === 'done' || x.state === 'failed') && x.endTurn === state.turn);
        if (!cur && !gone.length) continue;
        const anim = gone.length && freshFor(`gone:${d.id}:${gone.map(g => g.n).join(',')}`, 6000);
        const isNew = cur && cur.turn === state.turn && freshFor(`new:${d.id}:${cur.n}`, 6000);
        slots.push(`<div class="ht-slot${anim ? ' ht-slot-anim' : ''}">${gone.map(g => step(g, `ht-step-gone ht-step-${g.state}`)).join('')}${cur ? step(cur, isNew ? 'ht-step-new' : '') : ''}</div>`);
    }
    const hearts = fr ? 0 : Math.min(5, Math.floor(d.score / 18));
    const tone = fr ? friendMix(d.score) : romMix(d.score);
    const L0 = d.need || goalNeed(lvl, d.pace);
    const done = doneCount(d);
    // главная цель: отдельный блок; как открывается — словами и цифрами
    const goalHow = g === 'done' ? L().goalHow.done : g === 'open' ? L().goalHow.open
        : L().goalHow.locked(L0.steps, Math.min(done, L0.steps), L0.score, d.score);
    const goalBox = d.goal ? `<div class="ht-dgoal ht-goal-${g}">
            <div class="ht-dgoal-head"><i class="fa-solid fa-bullseye"></i><span>${L().dateGoalMain}</span><em>${esc(L().goalState[g])}</em></div>
            <p class="ht-dgoal-text">${esc(d.goal.charAt(0).toUpperCase() + d.goal.slice(1))}</p>
            <p class="ht-dgoal-how"><i class="fa-solid ${g === 'done' ? 'fa-circle-check' : g === 'open' ? 'fa-lock-open' : 'fa-lock'}"></i><span>${esc(goalHow)}</span></p>
        </div>` : '';
    // ход свидания в инфоблоке не показываем — его помнит модель (журнал идёт в промпт, пока свидание идёт)
    return `<div class="ht-offer ht-date ht-date-on${fc}${fresh ? ' ht-offer-new' : ''}${dateLoading() ? ' ht-date-busy' : ''}" style="--v:${num(d.score)};--c:${tone}">
        <span class="ht-dhearts" aria-hidden="true">${'<i class="fa-solid fa-heart"></i>'.repeat(hearts)}</span>
        <div class="ht-dhead">${portrait}
            <span class="ht-dstrip" title="${esc(d.vibe || L().dateVibeStart)}"><i></i></span>
            <div class="ht-dmain">
                <b class="ht-dtitle">${esc(d.title)}</b>
                ${d.where ? `<span class="ht-dwhen"><i class="fa-solid fa-location-dot"></i>${esc(d.where)}</span>` : ''}
                ${dateLastsText(d) ? `<span class="ht-dwhen ht-dlasts"><i class="fa-regular fa-clock"></i>${esc(dateLastsText(d))}</span>` : ''}
                <span class="ht-dvibe">${esc(d.vibe || L().dateVibeStart)}</span>
                ${d.closing != null ? `<span class="ht-dclosing"><i class="fa-solid fa-hourglass-end"></i>${esc(L().dateClosing)}</span>` : ''}
            </div>
            <div class="ht-dscore"><b>${num(d.score)}%</b><small>${L().dateSuccess}</small></div>
        </div>
        <div class="ht-date-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${num(d.score)}" aria-label="${esc(L().dateSuccess)}"><i></i></div>
        ${goalBox}
        ${(d.gifts || []).length ? `<p class="ht-dgifts"><i class="fa-solid fa-gift"></i><span>${d.gifts.map(g => esc(g.from ? `${g.from}: ${g.what}` : g.what)).join(' · ')}</span></p>` : ''}
        ${d.thought ? `<p class="ht-dthought"><i class="fa-solid fa-comment-dots"></i><span><b>${L().dateThinks}</b>«${esc(d.thought.replace(/^[«"“]+|[»"”]+$/g, ''))}»</span></p>` : ''}
        ${eventsHtml((state.evts || []).filter(e => e.hid === d.id))}
        <div class="ht-dsec"><i class="fa-solid fa-shoe-prints"></i>${L().dateSteps}</div>
        <div class="ht-date-steps">${slots.join('') || `<p class="ht-mute">${L().dateNoSteps}</p>`}</div>
        ${learnedHtml(d)}
        <div class="ht-offer-actions ht-one"><button class="ht-btn ht-btn-quiet" data-act="date-end"><i class="fa-solid fa-flag-checkered"></i><span>${fr ? L().outingFinish : L().dateFinish}</span></button></div>
    </div>`;
}

// Решения игрока по свиданию — и в снимки, чтобы пережили свайпы
function changeDate(fn) {
    const id = state.date?.id;
    if (!id) return;
    fn(state);
    applyToSnapshots(st => { if (st.date?.id === id) fn(st); });
    saveState();
    injectPrompts();
    renderAll();
}
function decideDate(yes) {
    const d = state.date;
    if (!d || d.status !== 'offered') return;
    state.dateDecisions = { ...(state.dateDecisions || {}), [String(d.title).toLowerCase()]: yes ? 'accepted' : 'declined' };
    noteDecision('date', String(d.title).toLowerCase(), d.msg);
    changeDate(st => {
        // на потом — «намечено» в инфоблоке, без шкалы и шагов; прямо сейчас — начинается
        if (yes) acceptInto(st, st.date);
        else { st.dateDeclined = { title: st.date.title, turn: st.turn }; st.date = null; st.lastDateEnd = st.turn; }
    });
}
function endDateNow() {
    if (state.date?.status !== 'active') return;
    let done = null;
    changeDate(st => {
        const d = finishDate(st, st.turn, dateLevel());
        if (d) recordDate(st, d);
        if (st === state) done = d;
    });
    if (done) {
        saveState();
        renderAll();
        showDateToast(done);
        if (apiOn()) { const N = lastProcessedMsg(); if (chat[N]?.extra?.ht_date) delete chat[N].extra.ht_date; runDateSide(N); }   // итог допишет помощник
    }
}

// Уведомление об итоге свидания — посреди экрана, один раз, закрывается само или по нажатию
const dateToasted = new Set();
function showDateToast(d) {
    if (!d || dateToasted.has(d.id) || typeof document?.createElement !== 'function') return;
    dateToasted.add(d.id);
    const el = document.createElement('div');
    const fr = isFriendlyDate(d);
    el.className = `ht-date-toast ht-date-${d.result}${fr ? ' ht-friendly' : ''}`;
    el.setAttribute('role', 'status');
    const ic = fr ? 'fa-handshake' : 'fa-heart';
    el.innerHTML = `<div class="ht-date-toast-card">
        <div class="ht-date-hearts"><i class="fa-solid ${fr ? 'fa-star' : ic}"></i><i class="fa-solid ${ic}"></i><i class="fa-solid ${fr ? 'fa-star' : ic}"></i></div>
        <span>${esc(fr ? L().outingOver : L().dateOver)}</span>
        <b>${esc(L().dateResult[d.result])}</b>
        <p>${esc(d.title)} · ${num(d.score)}%</p>
    </div>`;
    const close = () => { el.classList.add('ht-out'); setTimeout(() => el.remove(), 300); };
    el.addEventListener('click', close);
    document.body.appendChild(el);
    setTimeout(close, 7000);
}

// ═══ Вкладка «Люди»: галерея карточек ═══
// Сверху — {{char}} и {{user}}; дальше люди по подвкладкам: все · родня {{user}} · родня {{char}} · знакомые.

// Аватарки: бот и персона — из таверны; остальным игрок ставит свою картинку (ужимаем до 112 px, ~5 КБ)
let personaMod = null;
import('../../../personas.js').then(m => { personaMod = m; }).catch(() => { /* старая таверна — возьмём из чата */ });
function charAvatarUrl() {
    const ch = this_chid !== undefined ? characters[this_chid] : null;
    return ch?.avatar && ch.avatar !== 'none' ? `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}` : null;
}
function userAvatarUrl() {
    const f = personaMod?.user_avatar;
    if (f) return `/thumbnail?type=persona&file=${encodeURIComponent(f)}`;
    return document.querySelector?.('.mes[is_user="true"] .avatar img')?.getAttribute('src') || null;
}
const avatars = () => (chat_metadata.ht_avatars = chat_metadata.ht_avatars || {});
async function shrinkImage(file, size = 112) {
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const k = Math.max(size / img.width, size / img.height);
        const w = img.width * k, h = img.height * k;
        c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        return c.toDataURL('image/jpeg', 0.82);
    } finally { URL.revokeObjectURL(url); }
}
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
const avaHtml = (src, name, cls = '') => src
    ? `<span class="ht-ava ${cls}"><img src="${esc(src)}" alt="" loading="lazy" decoding="async"></span>`
    : `<span class="ht-ava ht-ava-none ${cls}">${esc(initials(name))}</span>`;

// маленькая шкала, как в «Симс»: от середины — вправо зелёным (хорошо), влево красным (плохо);
// под ней — как они ладят, своими словами ИИ (или ступень, если слов нет)
const barHtml = (n) => {
    const v = Math.max(-100, Math.min(100, n ?? 0));
    return `<span class="ht-mini-bar${v < 0 ? ' ht-neg' : ''}" role="meter" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="${v}"><i style="--v:${Math.abs(v)};--h:${Math.round((v + 100) * 0.6)}"></i></span>`;
};
const signed = (n) => { const v = num(n); return v > 0 ? `+${v}` : `${v}`; };
function miniBar(src, who, n, note) {
    const words = note || L().rel[relLevel(n ?? 0)];
    return `<div class="ht-mini" title="${esc(`${who}: ${signed(n ?? 0)} · ${words}`)}">
        <span class="ht-mini-row">${avaHtml(src, who, 'ht-ava-xs')}<b>${signed(n ?? 0)}</b></span>${barHtml(n)}</div>`;
}

const CAST_TABS = ['all', 'kin_user', 'kin_char', 'kin_both', 'others'];
const CAST_PAGE = 6;
// общая семья видна и в родне {{user}}, и в родне {{char}}
const inCastTab = (p, t) => t === 'all' || (t === 'others' ? !KIN_GROUPS.includes(p.group)
    : (t === 'kin_user' || t === 'kin_char') ? p.group === t || p.group === 'kin_both' : p.group === t);

function castTabHtml(view, live) {
    const list = view.cast || [];
    const u = getUserName(), c = getCharName();
    const uA = userAvatarUrl(), cA = charAvatarUrl();
    const tab = CAST_TABS.includes(ui.castTab) ? ui.castTab : 'all';
    const tabLabel = { all: L().castAll, kin_user: L().kinOf(u), kin_char: L().kinOf(c), kin_both: L().kinBoth, others: L().castOthers };
    const subtabs = `<div class="ht-subtabs" role="tablist">${CAST_TABS.map(t => {
        const n = list.filter(p => inCastTab(p, t)).length;
        if (t === 'kin_both' && !n && tab !== t) return '';          // общей семьи нет — и подвкладки нет
        return `<button role="tab" class="${t === tab ? 'ht-on' : ''}" data-act="cast-tab" data-tab="${t}" aria-selected="${t === tab}">${esc(tabLabel[t])}${n ? `<em>${n}</em>` : ''}</button>`;
    }).join('')}</div>`;

    // {{char}} и {{user}} — первая карточка, шире остальных, видна всегда; романтика — розовая подсветка и бьющееся сердце.
    // Пока модель не прислала bond — нули и «пока не ясно»; игрок может выставить сам
    const pr = view.pair || { ...PAIR_DEFAULT, unknown: true };
    const rl = romLevel(pr.r);
    const dateLine = live ? dateWhyText() : '';
    // {{char}} — портрет в подсвеченной рамке; {{user}} — маленький круглый значок, прикреплённый сбоку
    const pair = tab === 'all' ? `<div class="ht-cc ht-cc-pair${pr.r > 0 ? ' ht-cc-love' : ''}${pr.unknown ? ' ht-cc-unknown' : ''}">
        <span class="ht-portrait">${avaHtml(cA, c)}<span class="ht-ava-pin" title="${esc(u)}">${avaHtml(uA, u, 'ht-ava-round')}</span>${pr.r > 0 ? '<i class="fa-regular fa-heart ht-pair-mid"></i>' : ''}</span>
        <b class="ht-cc-name">${esc(c)}</b>
        <div class="ht-pair-bars">
            <div class="ht-mini" title="${esc(`${L().friendship}: ${signed(pr.f)} · ${L().rel[relLevel(pr.f)]}`)}"><span class="ht-mini-row"><i class="fa-solid fa-handshake ht-mini-ico"></i>${esc(L().friendship)}<b>${signed(pr.f)}</b></span>${barHtml(pr.f)}</div>
            ${pr.kin ? '' : `<div class="ht-mini ht-mini-rom" title="${esc(`${L().romance}: ${signed(pr.r)} · ${L().rom[rl]}`)}"><span class="ht-mini-row"><i class="fa-solid fa-heart ht-mini-ico"></i>${esc(L().romance)}<b>${signed(pr.r)}</b></span>${barHtml(pr.r)}</div>`}
        </div>
        <details class="ht-cc-status"><summary>${L().status}<i class="fa-solid fa-chevron-down"></i></summary>
            <p>${esc(pr.unknown ? L().pairUnknown : pr.note || `${L().rel[relLevel(pr.f)]} · ${L().rom[rl]}`)}</p>
            ${dateLine ? `<p><b>${esc(L().dateWord)}:</b> ${esc(dateLine)}</p>` : ''}
        </details>
        ${live ? `<div class="ht-cc-tools"><button data-act="pair-edit" title="${esc(L().pairEdit)}" aria-label="${esc(L().pairEdit)}"><i class="fa-solid fa-pen"></i></button></div>` : ''}
    </div>` : '';

    const ava = avatars();
    const card = (p) => {
        const key = `cast:${p.id}`;
        const d = p.bdayIn;
        const near = d != null && d <= 30 ? (d === 0 ? ' ht-bd-today' : d <= 7 ? ' ht-bd-near' : ' ht-bd-soon') : '';
        // имя история ещё не назвала — подпись по роли («Мать Нины»), а не «без имени»
        const byU = !p.name && !!p.toU, byC = !p.name && !p.toU && !!p.toC;
        const name = p.name || (byU ? L().roleOf(p.toU, u) : byC ? L().roleOf(p.toC, c) : L().noName);
        const roles = [!byU && p.toU && `${u}: ${p.toU}`, !byC && p.toC && `${c}: ${p.toC}`].filter(Boolean);
        const romSet = p.rom?.user || p.rom?.char;
        const confirm = ui.confirmDel === key;
        return `<div class="ht-cc${near}${p.off ? ' ht-cc-off' : ''}" data-cid="${esc(p.id)}">
            <div class="ht-cc-top">${avaHtml(ava[p.id], name)}${romSet ? `<i class="fa-solid fa-heart ht-cc-heart" title="${esc([p.rom.user && `${u}: ${L().rom[p.rom.user]}`, p.rom.char && `${c}: ${L().rom[p.rom.char]}`].filter(Boolean).join(' · '))}"></i>` : ''}</div>
            <b class="ht-cc-name${p.name ? '' : ' ht-cc-noname'}"${p.name ? '' : ` title="${esc(L().nameUnknown)}"`}>${esc(name)}</b>
            ${roles.length ? `<span class="ht-cc-role">${roles.map(esc).join('<br>')}</span>` : ''}
            ${d != null && d <= 30 ? `<span class="ht-cc-bd"><i class="fa-solid fa-cake-candles"></i>${esc(L().bdayIn(d, daysWord))}</span>` : ''}
            <div class="ht-cc-bars">${miniBar(uA, u, p.rel?.user ?? 0, p.note?.user)}${miniBar(cA, c, p.rel?.char ?? 0, p.note?.char)}</div>
            <details class="ht-cc-status"><summary>${L().status}<i class="fa-solid fa-chevron-down"></i></summary>
                <p><b>${esc(u)}:</b> ${esc(p.note?.user || L().rel[relLevel(p.rel?.user ?? 0)])}</p>
                <p><b>${esc(c)}:</b> ${esc(p.note?.char || L().rel[relLevel(p.rel?.char ?? 0)])}</p>
            </details>
            ${live ? `<div class="ht-cc-tools">
                <button data-act="cast-eye" data-cid="${esc(p.id)}" title="${esc(p.off ? L().castOn : L().castOff)}" aria-pressed="${!p.off}"><i class="fa-solid ${p.off ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
                <button data-act="cast-edit" data-cid="${esc(p.id)}" title="${esc(L().edit)}"><i class="fa-solid fa-pen"></i></button>
                <button class="${confirm ? 'ht-del-confirm' : ''}" data-act="cast-del" data-cid="${esc(p.id)}" title="${esc(confirm ? L().removeSure : L().remove)}"><i class="fa-solid ${confirm ? 'fa-check' : 'fa-trash-can'}"></i></button>
            </div>` : ''}
        </div>`;
    };
    const shown = list.filter(p => inCastTab(p, tab));
    // в «Все» — общая семья, родня {{user}}, родня {{char}}, потом остальные
    const order = { kin_both: 0, kin_user: 1, kin_char: 2, friend: 3, acquaintance: 4, other: 5 };
    shown.sort((a, b) => (order[a.group] ?? 6) - (order[b.group] ?? 6));
    // первые шесть, дальше — «показать ещё» по шесть; раскрыла всё — «свернуть»
    const limit = ui.castMore.get(tab) || CAST_PAGE;
    const more = shown.length > limit
        ? `<button class="ht-cc-more" data-act="cast-more" data-n="${limit + CAST_PAGE}"><i class="fa-solid fa-chevron-down"></i>${L().castMore(Math.min(CAST_PAGE, shown.length - limit), shown.length - limit)}</button>`
        : limit > CAST_PAGE ? `<button class="ht-cc-more" data-act="cast-more" data-n="${CAST_PAGE}"><i class="fa-solid fa-chevron-up"></i>${L().castLess}</button>` : '';
    const cards = shown.slice(0, limit).map(card).join('');
    // добавить человека самому — последней карточкой галереи
    const addCard = live ? `<button class="ht-cc ht-cc-add" data-act="cast-new" title="${esc(L().castAdd)}"><i class="fa-solid fa-user-plus"></i><span>${L().castAdd}</span></button>` : '';
    return `${subtabs}<div class="ht-gallery">${pair}${cards}${addCard}${!cards && !pair && !addCard ? `<p class="ht-mute ht-gallery-empty">${L().castEmpty}</p>` : ''}</div>${more}`;
}

// Итог праздника — под спойлером «Итог», чтобы список был коротким
function recapSpoiler(text, parts, date = false) {
    if (!text && !parts) return '';
    return `<details class="ht-recap"><summary><i class="fa-solid ${date === 'friendly' ? 'fa-handshake' : date ? 'fa-heart' : 'fa-scroll'}"></i><span>${date === 'friendly' ? L().outingRecapTitle : date ? L().dateRecapTitle : L().recapTitle}</span><i class="fa-solid fa-chevron-down ht-recap-chev"></i></summary>
        ${text ? `<p>${esc(text)}</p>` : ''}${recapPartsHtml(parts)}</details>`;
}

// Короткий итог по пунктам: цель · сделали · моменты · подарки (только вещи) · лучший момент
function recapPartsHtml(p) {
    if (!p) return '';
    const row = (icon, items, title) => items?.length ? `<li title="${esc(title)}"><i class="fa-solid ${icon}"></i><span>${items.map(esc).join(' · ')}</span></li>` : '';
    return `<ul class="ht-recap-parts">${row('fa-bullseye', p.goal ? [p.goal] : [], L().dateGoalMain)}${row('fa-list-check', p.done, L().recapDone)}${row('fa-heart', p.moments, L().moments)}${row('fa-gift', p.gifts, L().gifts)}${row('fa-lightbulb', p.learned, L().dateLearned)}${row('fa-star', p.best ? [p.best] : [], L().recapBest)}</ul>`;
}

// Правка человека — отдельным окном поверх таверны: перерисовки чата его не сбрасывают,
// на телефоне — на весь экран, поля крупные
function closeCastEditor() {
    castDraft = null;
    const d = document.querySelector('.ht-modal');
    if (!d) return;
    try { d.close?.(); } catch (e) { /* пусто */ }
    d.remove();
}
// новый человек, которого игрок добавляет сам: в список попадает только после «Сохранить»
let castDraft = null;
function openCastNew() {
    castDraft = { id: `c-${state.turn}-u-${Math.random().toString(36).slice(2, 6)}`, name: null, group: 'other', toU: null, toC: null, bday: null,
        rel: { user: 0, char: 0 }, note: { user: null, char: null }, rom: { user: null, char: null }, scale: 2, turn: state.turn, byHand: true };
    openCastEditor(castDraft.id);
}
function openCastEditor(cid) {
    try { openCastEditorRaw(cid); } catch (e) {
        console.error('[Hearthtide] окно правки:', e);
        window.toastr?.error?.(`${L().editFail}: ${e?.message || e}`, 'Hearthtide');
    }
}
function openCastEditorRaw(cid) {
    const draft = castDraft;
    closeCastEditor();
    castDraft = draft;
    const p = (state.cast || []).find(c => c.id === cid) || (castDraft?.id === cid ? castDraft : null);
    if (!p) { window.toastr?.warning?.(L().editGone, 'Hearthtide'); return; }
    // <dialog> через showModal() браузер кладёт в «верхний слой» — поверх всего, что есть у таверны
    const native = typeof HTMLDialogElement === 'function' && 'showModal' in HTMLDialogElement.prototype;
    const wrap = document.createElement(native ? 'dialog' : 'div');
    wrap.className = 'ht-modal';
    if (!native) { wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); }
    const draw = () => {
        wrap.innerHTML = `<div class="ht-modal-card">
            <div class="ht-modal-title"><i class="fa-solid fa-user-pen"></i>${esc(p.name || L().noName)}<button type="button" data-act="edit-cancel" aria-label="${esc(L().cancel)}"><i class="fa-solid fa-xmark"></i></button></div>
            ${castFormHtml(p, avatars()[cid])}</div>`;
    };
    draw();
    wrap.addEventListener('click', (e) => {
        if (e.target === wrap) { closeCastEditor(); return; }      // нажали мимо окна
        const t = e.target.closest('[data-act]');
        if (!t) return;
        const f = wrap.querySelector('.ht-edit');
        const val = (k) => f?.querySelector(`[data-ed="${k}"]`)?.value ?? '';
        if (t.dataset.act === 'edit-cancel') closeCastEditor();
        else if (t.dataset.act === 'cast-rom') {
            t.parentElement.querySelectorAll('button').forEach(b => { b.classList.toggle('ht-on', b === t); b.setAttribute('aria-pressed', String(b === t)); });
        } else if (t.dataset.act === 'cast-photo-del') {
            delete avatars()[cid];
            saveChatDebounced();
            wrap.querySelector('.ht-cast-photo .ht-ava')?.replaceWith(Object.assign(document.createElement('span'), { className: 'ht-ava ht-ava-none', textContent: initials(p.name) }));
            t.remove();
            renderAll();
        } else if (t.dataset.act === 'cast-save') {
            const rom = (w) => f?.querySelector(`.ht-rom-pick[data-who="${w}"] .ht-on`)?.dataset.key || '';
            if (saveCast(cid, { name: val('name'), toU: val('toU'), toC: val('toC'), group: groupOf(f), bday: val('bday'), relU: val('relU'), relC: val('relC'), noteU: val('noteU'), noteC: val('noteC'), romU: rom('user'), romC: rom('char') })) {
                closeCastEditor();
                renderAll();
            }
        }
    });
    wrap.addEventListener('change', async (e) => {
        // родня — список «друзья / знакомые / прочие» не нужен
        if (e.target?.dataset?.ed === 'kinU' || e.target?.dataset?.ed === 'kinC') {
            const any = ['kinU', 'kinC'].some(k => wrap.querySelector(`[data-ed="${k}"]`)?.checked);
            const sel = wrap.querySelector('.ht-notkin');
            if (sel) sel.hidden = any;
            return;
        }
        const inp = e.target.closest?.('input[data-act="cast-photo"]');
        if (!inp?.files?.[0]) return;
        try {
            avatars()[cid] = await shrinkImage(inp.files[0]);
            saveChatDebounced();
            const img = document.createElement('span');
            img.className = 'ht-ava';
            img.innerHTML = `<img src="${esc(avatars()[cid])}" alt="">`;
            wrap.querySelector('.ht-cast-photo .ht-ava')?.replaceWith(img);
            renderAll();
        } catch (err) {
            console.error('[Hearthtide] картинка:', err);
            window.toastr?.warning?.(L().badPhoto, 'Hearthtide');
        }
    });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeCastEditor(); } });
    wrap.addEventListener('cancel', (e) => { e.preventDefault(); closeCastEditor(); });
    document.body.appendChild(wrap);
    if (native) wrap.showModal();
}

/** Группа из формы: галочки «родня» (обе — общая семья), иначе — выбор из списка */
function groupOf(f) {
    const on = (k) => !!f?.querySelector(`[data-ed="${k}"]`)?.checked;
    const u = on('kinU'), c = on('kinC');
    if (u && c) return 'kin_both';
    if (u) return 'kin_user';
    if (c) return 'kin_char';
    return f?.querySelector('[data-ed="group"]')?.value || 'other';
}

function castFormHtml(p, photo) {
    const u = getUserName(), c = getCharName();
    const kinU = p.group === 'kin_user' || p.group === 'kin_both', kinC = p.group === 'kin_char' || p.group === 'kin_both';
    const other = ['friend', 'acquaintance', 'other'];
    const groups = other.map(g => `<option value="${g}" ${p.group === g ? 'selected' : ''}>${esc(L().castGroup(g, u, c))}</option>`).join('');
    const romRow = (who, cur) => `<div class="ht-rom-pick" data-who="${who}">${['', ...ROM_KEYS].map(k =>
        `<button type="button" data-act="cast-rom" data-who="${who}" data-key="${k}" class="${(cur || '') === k ? 'ht-on' : ''}" aria-pressed="${(cur || '') === k}">${k ? '<i class="fa-solid fa-heart"></i>' : ''}${esc(k ? L().rom[k] : L().rom.none)}</button>`).join('')}</div>`;
    return `<div class="ht-edit ht-cast-edit" data-cid="${esc(p.id)}">
        <div class="ht-cast-photo">${avaHtml(photo, p.name)}
            <label class="ht-btn"><i class="fa-solid fa-image"></i>${L().photo}<input type="file" accept="image/*" data-act="cast-photo" data-cid="${esc(p.id)}" hidden></label>
            ${photo ? `<button class="ht-btn ht-btn-quiet" data-act="cast-photo-del" data-cid="${esc(p.id)}" title="${esc(L().remove)}"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </div>
        <label>${L().fPersonName}<input class="text_pole" data-ed="name" value="${esc(p.name || '')}"></label>
        <div class="ht-edit-two">
            <label>${esc(L().toWhom(getUserName()))}<input class="text_pole" data-ed="toU" value="${esc(p.toU || '')}"></label>
            <label>${esc(L().toWhom(getCharName()))}<input class="text_pole" data-ed="toC" value="${esc(p.toC || '')}"></label>
        </div>
        <div class="ht-kin-pick"><span>${L().kinWhose}</span>
            <label><input type="checkbox" data-ed="kinU" ${kinU ? 'checked' : ''}>${esc(L().kinOf(u))}</label>
            <label><input type="checkbox" data-ed="kinC" ${kinC ? 'checked' : ''}>${esc(L().kinOf(c))}</label>
        </div>
        <label class="ht-notkin"${kinU || kinC ? ' hidden' : ''}>${L().fGroup}<select class="text_pole" data-ed="group">${groups}</select></label>
        <label>${L().fBday}<input class="text_pole" data-ed="bday" value="${esc(bdayText(p.bday))}" inputmode="numeric" placeholder="${esc(L().unknown)}"></label>
        <div class="ht-edit-two">
            <label>${esc(getUserName())} −100…100<input class="text_pole" data-ed="relU" type="number" min="-100" max="100" value="${num(p.rel?.user)}"></label>
            <label>${esc(getCharName())} −100…100<input class="text_pole" data-ed="relC" type="number" min="-100" max="100" value="${num(p.rel?.char)}"></label>
        </div>
        <div class="ht-edit-two">
            <label>${esc(L().howWith(getUserName()))}<input class="text_pole" data-ed="noteU" value="${esc(p.note?.user || '')}"></label>
            <label>${esc(L().howWith(getCharName()))}<input class="text_pole" data-ed="noteC" value="${esc(p.note?.char || '')}"></label>
        </div>
        ${isKin(p.group) ? '' : `<div class="ht-rom-field"><span><i class="fa-solid fa-heart"></i> ${esc(getUserName())}</span>${romRow('user', p.rom?.user)}
            <span><i class="fa-solid fa-heart"></i> ${esc(getCharName())}</span>${romRow('char', p.rom?.char)}</div>`}
        <div class="ht-edit-actions">
            <button class="ht-btn" data-act="edit-cancel">${L().cancel}</button>
            <button class="ht-btn ht-btn-main" data-act="cast-save" data-cid="${esc(p.id)}"><i class="fa-solid fa-check"></i>${L().save}</button>
        </div>
    </div>`;
}

// Правка человека игроком: переживает свайпы; ИИ после неё не трогает имя, роли и дату, а отношения — если игрок их менял
function saveCast(cid, f) {
    let cur = (state.cast || []).find(c => c.id === cid);
    const name = String(f.name || '').trim() || null;
    // новый человек от игрока: нужно хоть имя или кем приходится
    if (!cur && castDraft?.id === cid) {
        if (!name && !String(f.toU || '').trim() && !String(f.toC || '').trim()) { window.toastr?.warning?.(L().castNeedName, 'Hearthtide'); return false; }
        if (name && findCast(state, name)) { window.toastr?.warning?.(L().castExists(name), 'Hearthtide'); return false; }
        if (name) state.castNo = (state.castNo || []).filter(x => !samePerson(x, name));
        const add = (st) => { st.cast = st.cast || []; if (!st.cast.some(c => c.id === cid)) st.cast.push(clone(castDraft)); };
        add(state);
        applyToSnapshots(add);
        castDraft = null;
        cur = state.cast.find(c => c.id === cid);
    }
    if (!cur) return false;
    const bdayRaw = String(f.bday || '').trim();
    const bday = bdayRaw ? parseBday(bdayRaw) : null;
    if (bdayRaw && !bday) { window.toastr?.warning?.(L().badBday, 'Hearthtide'); return false; }
    const relU = clampRel(f.relU), relC = clampRel(f.relC);
    const relChanged = relU !== (cur.rel?.user ?? 0) || relC !== (cur.rel?.char ?? 0)
        || String(f.noteU || '').trim() !== (cur.note?.user || '') || String(f.noteC || '').trim() !== (cur.note?.char || '');
    const group = CAST_GROUPS.includes(f.group) ? f.group : cur.group;
    const fix = {
        name, toU: String(f.toU || '').trim() || null, toC: String(f.toC || '').trim() || null, group, bday, edited: true,
        rom: isKin(group) ? { user: null, char: null } : { user: ROM_KEYS.includes(f.romU) ? f.romU : null, char: ROM_KEYS.includes(f.romC) ? f.romC : null },
    };
    const apply = (st) => {
        const x = (st.cast || []).find(c => c.id === cid);
        if (!x) return;
        Object.assign(x, fix);
        if (relChanged) {
            x.rel = { user: relU ?? 0, char: relC ?? 0 };
            x.note = { user: String(f.noteU || '').trim() || null, char: String(f.noteC || '').trim() || null };
            x.relLock = true;
        }
    };
    apply(state);
    applyToSnapshots(apply);
    saveState();
    injectPrompts();
    window.toastr?.success?.(L().saved, 'Hearthtide');
    return true;
}

// «Глазок»: выключенный человек не идёт в промпт, но остаётся в списке — ИИ не внесёт его заново
function toggleCastOff(cid) {
    const x = (state.cast || []).find(c => c.id === cid);
    if (!x) return;
    const off = !x.off;
    const apply = (st) => { const y = (st.cast || []).find(c => c.id === cid); if (y) y.off = off; };
    apply(state);
    applyToSnapshots(apply);
    saveState();
    injectPrompts();
    renderAll();
}

function removeCast(cid) {
    const cur = (state.cast || []).find(c => c.id === cid);
    if (!cur) return;
    if (cur.name) state.castNo = [...(state.castNo || []).filter(n => !samePerson(n, cur.name)), cur.name].slice(-60);
    const apply = (st) => { st.cast = (st.cast || []).filter(c => c.id !== cid && !(cur.name && samePerson(c.name, cur.name))); };
    apply(state);
    applyToSnapshots(apply);
    delete avatars()[cid];
    saveChatDebounced();
    saveState();
    injectPrompts();
    renderAll();
}

// ─── Пара {{char}} и {{user}}: правка игроком ───
// Ответы до правки её не перезаписывают (свайп, повторная обработка); дальше модель ведёт пару от новых значений
function savePair(f, r, note, kin = false) {
    const pair = { scale: 2, f: clampRel(f) ?? 0, r: kin ? 0 : clampRel(r) ?? 0, kin: !!kin, note: String(note || '').trim().slice(0, 60) || null };
    state.pairSet = { pair, at: lastProcessedMsg() };
    state.pair = clone(pair);
    state.lastBondTurn = state.turn;
    state.bondMiss = 0;
    saveState();
    injectPrompts();
    window.toastr?.success?.(L().saved, 'Hearthtide');
    renderAll();
}

function openPairEditor() {
    try { openPairEditorRaw(); } catch (e) {
        console.error('[Hearthtide] окно правки пары:', e);
        window.toastr?.error?.(`${L().editFail}: ${e?.message || e}`, 'Hearthtide');
    }
}
function openPairEditorRaw() {
    closeCastEditor();
    const pr = state.pair || { ...PAIR_DEFAULT };
    const u = getUserName(), c = getCharName();
    const native = typeof HTMLDialogElement === 'function' && 'showModal' in HTMLDialogElement.prototype;
    const wrap = document.createElement(native ? 'dialog' : 'div');
    wrap.className = 'ht-modal';
    if (!native) { wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); }
    const word = (k, v) => (k === 'f' ? L().rel[relLevel(v)] : L().rom[romLevel(v)]);
    const range = (k, icon, label, v) => `<label class="ht-range${k === 'r' ? ' ht-range-rom' : ''}">
        <span><i class="fa-solid ${icon}"></i>${esc(label)}<b data-out="${k}">${signed(v)} · ${esc(word(k, v))}</b></span>
        <input type="range" min="-100" max="100" step="1" data-ed="${k}" value="${v}" aria-label="${esc(label)}"></label>`;
    wrap.innerHTML = `<div class="ht-modal-card">
        <div class="ht-modal-title"><i class="fa-solid fa-heart"></i>${esc(L().pairTitle(c, u))}<button type="button" data-act="edit-cancel" aria-label="${esc(L().cancel)}"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="ht-edit ht-pair-edit">
            <span class="ht-portrait ht-portrait-lg">${avaHtml(charAvatarUrl(), c)}<span class="ht-ava-pin">${avaHtml(userAvatarUrl(), u, 'ht-ava-round')}</span></span>
            ${range('f', 'fa-handshake', L().friendship, pr.f)}
            <label class="ht-pair-kin"><input type="checkbox" data-ed="kin" ${pr.kin ? 'checked' : ''}>${esc(L().pairKin)}</label>
            <div class="ht-pair-rom"${pr.kin ? ' hidden' : ''}>${range('r', 'fa-heart', L().romance, pr.r)}</div>
            <label>${esc(L().pairNote)}<input class="text_pole" data-ed="note" value="${esc(pr.note || '')}" maxlength="60"></label>
            <div class="ht-edit-actions">
                <button type="button" class="ht-btn" data-act="edit-cancel">${L().cancel}</button>
                <button type="button" class="ht-btn ht-btn-main" data-act="pair-save"><i class="fa-solid fa-check"></i>${L().save}</button>
            </div>
        </div></div>`;
    const val = (k) => wrap.querySelector(`[data-ed="${k}"]`)?.value ?? '';
    wrap.addEventListener('input', (e) => {
        const k = e.target?.dataset?.ed;
        if (k === 'kin') { const r = wrap.querySelector('.ht-pair-rom'); if (r) r.hidden = e.target.checked; return; }
        if (k !== 'f' && k !== 'r') return;
        const out = wrap.querySelector(`[data-out="${k}"]`);
        if (out) out.textContent = `${signed(+e.target.value)} · ${word(k, +e.target.value)}`;
    });
    wrap.addEventListener('click', (e) => {
        if (e.target === wrap) { closeCastEditor(); return; }
        const t = e.target.closest('[data-act]');
        if (!t) return;
        if (t.dataset.act === 'edit-cancel') closeCastEditor();
        else if (t.dataset.act === 'pair-save') { savePair(val('f'), val('r'), val('note'), !!wrap.querySelector('[data-ed="kin"]')?.checked); closeCastEditor(); }
    });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeCastEditor(); } });
    wrap.addEventListener('cancel', (e) => { e.preventDefault(); closeCastEditor(); });
    document.body.appendChild(wrap);
    if (native) wrap.showModal();
}

/** Будет ли свидание после ответа и почему нет — для карточки пары и настроек */
function dateWhyText() {
    if (!state) return '';
    const di = dateChanceInfo(state, state.turn || 0, dateChanceSetting());
    const w = L().dateWhy;
    if (di.why === 'norom') return w.norom(di.r);
    if (di.why === 'cooldown') return w.cooldown(di.left, plural);
    if (['ok', 'quarrel', 'open', 'friendly'].includes(di.why)) return w[di.why](di.chance);
    return w[di.why] || '';
}
function updateDateWhy() {
    const el = document.getElementById('ht-date-why');
    if (el) el.textContent = state ? dateWhyText() : '';
}

// ─── {{char}} зовёт на свидание: короткое уведомление сверху, по нажатию — к карточке ───
const inviteToasted = new Set();
function showDateInvite(d) {
    if (!d || inviteToasted.has(d.id) || typeof document?.createElement !== 'function') return;
    inviteToasted.add(d.id);
    document.querySelector('.ht-invite-toast')?.remove();
    const el = document.createElement('div');
    const fr = isFriendlyDate(d);
    el.className = `ht-invite-toast${d.icon ? ' ht-party' : fr ? ' ht-friendly' : ''}`;   // приглашение на день рождения / встречу — в тон карточке, а не розовое
    el.setAttribute('role', 'status');
    el.innerHTML = `<button type="button" class="ht-invite-card">
        <span class="ht-invite-hearts" aria-hidden="true">${`<i class="fa-solid ${d.icon || (fr ? 'fa-handshake' : 'fa-heart')}"></i>`.repeat(3)}</span>
        <span class="ht-invite-text"><b>${esc(d.head || (fr ? L().outingInvite(getCharName()) : L().dateInvite(getCharName())))}</b><span>${esc(d.title)}</span><em>${esc(L().dateTap)}</em></span>
    </button>`;
    let gone = false;
    const close = () => { if (gone) return; gone = true; el.classList.add('ht-out'); setTimeout(() => el.remove(), 320); };
    el.querySelector('button').addEventListener('click', () => {
        close();
        const card = document.querySelector(d.target || '.ht-cards .ht-date');
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('ht-pulse');
        void card.offsetWidth;                       // перезапуск анимации
        card.classList.add('ht-pulse');
    });
    document.body.appendChild(el);
    setTimeout(close, 8000);
}

// ─── Случайный ивент: карточка под шапкой последнего инфоблока, видна и в свёрнутом ───
/** Ивенты праздника, мероприятия или свидания — одним выделенным блоком: идущий сверху, прошедшие ниже */
function eventsHtml(evts) {
    const rows = (evts || []).filter(e => e.status !== 'offered' && e.status !== 'missed').slice().reverse().map(e => {
        const st = L().evStatus[e.status] || e.status;
        const open = ['active', 'invited', 'joined'].includes(e.status);
        if (e.kind === 'party') {
            const moments = (e.moments || []).map(m => `<li>${esc(m.title)}</li>`).join('');
            return `<details class="ht-party ht-ev-${esc(e.status)}"${open ? ' open' : ''}>
                <summary><i class="fa-solid fa-champagne-glasses"></i><span><b>${esc(e.title)}</b>${e.who ? ` · ${esc(e.who)}` : ''}</span><em>${esc(st)}</em></summary>
                ${moments ? `<div class="ht-moments"><span>${L().moments}</span><ul>${moments}</ul></div>` : ''}
                ${e.note ? `<p class="ht-ev-note">${esc(e.note)}</p>` : ''}
            </details>`;
        }
        return `<div class="ht-ev ht-ev-${esc(e.status)}"><i class="fa-solid ${open ? 'fa-bolt' : e.status === 'done' ? 'fa-circle-check' : 'fa-circle-minus'}"></i>
            <div><span><b>${esc(e.title)}</b>${e.who ? ` · ${esc(e.who)}` : ''} <em>${esc(st)}</em></span>${e.note ? `<p class="ht-ev-note">${esc(e.note)}</p>` : ''}</div></div>`;
    }).join('');
    return rows ? `<div class="ht-evbox"><div class="ht-evbox-head"><i class="fa-solid fa-dice"></i>${esc(L().events)}</div>${rows}</div>` : '';
}
/** Где идёт ивент: название праздника, мероприятия или свидания */
function eventPlace(e) {
    if (state.date?.id === e.hid) return state.date.title;
    const h = allHolidays(state).find(x => x.id === e.hid);
    return h ? displayName(h) : null;
}

function eventCardHtml() {
    const e = state && offeredEvent(state);
    if (!e) return '';
    const fresh = !ui.offerSeen.has(e.id);
    ui.offerSeen.add(e.id);
    const party = e.kind === 'party';
    return `<div class="ht-offer ht-evcard${party ? ' ht-evcard-party' : ''}${fresh ? ' ht-offer-new' : ''}">
        <div class="ht-offer-cause"><i class="fa-solid ${party ? 'fa-champagne-glasses' : 'fa-dice'}"></i><span>${party ? L().evParty : L().evNew}${eventPlace(e) ? ` · ${esc(L().evAt(eventPlace(e)))}` : ''}${e.who ? ` · ${esc(e.who)}` : ''}</span></div>
        <div class="ht-offer-hol"><span><b>${esc(e.title)}</b></span></div>
        ${e.hook ? `<p class="ht-offer-mean">${esc(e.hook)}</p>` : ''}
        <div class="ht-offer-actions ht-two">
            <button class="ht-btn ht-btn-main" data-act="ev-yes" data-eid="${esc(e.id)}" title="${esc(party ? L().evGo : L().accept)}"><i class="fa-solid fa-check"></i><span>${party ? L().evGo : L().accept}</span></button>
            <button class="ht-btn ht-btn-quiet" data-act="ev-no" data-eid="${esc(e.id)}" title="${esc(L().decline)}"><i class="fa-solid fa-xmark"></i><span>${L().decline}</span></button>
        </div>
    </div>`;
}

// ─── Повод из истории: под шапкой последнего инфоблока, видно и в свёрнутом ───
function offerHtml() {
    const list = state?.offers || [];
    const o = list[0];
    if (!o) return '';
    if (ui.editing === o.id) {
        return `<div class="ht-offer">${editFormHtml({ id: o.id, raw: o.name, iso: isoOf(o.start), type: o.type, meaning: o.meaning, birthday: !!o.bday, who: o.bday }, 'offer-save', L().accept)}</div>`;
    }
    const d = state.today != null ? o.start - state.today : null;
    const when = d == null ? isoOf(o.start) : d <= 0 ? L().offerToday : d === 1 ? L().tomorrow : L().inDays(daysWord(d));
    const fresh = !ui.offerSeen.has(o.id);
    ui.offerSeen.add(o.id);
    return `<div class="ht-offer${fresh ? ' ht-offer-new' : ''}" data-oid="${esc(o.id)}">
        ${o.cause ? `<div class="ht-offer-cause"><i class="fa-solid fa-feather-pointed"></i><span>${L().offerCause}:</span> <b>${esc(o.cause)}</b></div>` : ''}
        <div class="ht-offer-hol"><i class="fa-solid ${holidayIcon(o)}"></i>
            <span>${L().offerHol}: <b>${esc(o.name)}</b> · ${esc(when)}</span>
            ${list.length > 1 ? `<em>${esc(L().offerMore(list.length - 1))}</em>` : ''}</div>
        ${o.meaning ? `<p class="ht-offer-mean">${esc(o.meaning)}</p>` : ''}
        <div class="ht-offer-actions">
            <button class="ht-btn ht-btn-main" data-act="offer-yes" data-oid="${esc(o.id)}" title="${esc(L().accept)}"><i class="fa-solid fa-check"></i><span>${L().accept}</span></button>
            <button class="ht-btn" data-act="offer-edit" data-oid="${esc(o.id)}" title="${esc(L().edit)}"><i class="fa-solid fa-pen"></i><span>${L().edit}</span></button>
            <button class="ht-btn ht-btn-quiet" data-act="offer-no" data-oid="${esc(o.id)}" title="${esc(L().decline)}"><i class="fa-solid fa-xmark"></i><span>${L().decline}</span></button>
        </div>
    </div>`;
}

const NO_FAITH = /(none|no faith|not stated|not specified|unknown|unstated|secular|^n\/a|не указ|не упомин|неизвест|нет\b|нету|без веры|светск|не определ)/i;
const capFirst = (t) => { const x = String(t || '').trim(); return x ? x.charAt(0).toUpperCase() + x.slice(1) : x; };
/** Этап подарка — маленькой меткой: придумали / есть / вручён */
const giftStage = (g) => (g?.done ? '' : `<small class="ht-gift-stage">${esc(g?.got ? L().giftGot : L().giftIdea)}</small>`);
/** Что уже сделано к празднику по истории: сводка, последние пункты, подарки других людей */
function readyHtml(rd, live, max = 5) {
    if (!rd) return '';
    const items = rd.log.slice(-max);
    const more = rd.more + (rd.log.length - items.length);
    return `<div class="ht-ready">
        <span class="ht-ready-title">${esc(L().readyDone)}</span>
        ${rd.sum ? `<p class="ht-ready-sum">${esc(capFirst(rd.sum))}</p>` : ''}
        ${items.length ? `<ul>${items.map(x => `<li class="${x.fresh && live ? 'ht-ready-new' : ''}"><i class="fa-solid fa-check"></i><span>${esc(capFirst(x.t))}${x.who ? `<em>${esc(x.who)}</em>` : ''}</span>${live ? `<button class="ht-ready-del" data-act="ready-del" data-hid="${esc(rd.hid)}" data-t="${esc(x.t)}" title="${esc(L().readyDel)}" aria-label="${esc(L().readyDel)}"><i class="fa-solid fa-xmark"></i></button>` : ''}</li>`).join('')}</ul>` : ''}
        ${more > 0 && !rd.sum ? `<small class="ht-mute">${esc(L().readyMore(more))}</small>` : ''}
        ${(rd.gifts || []).map(g => `<em class="ht-chip"><i class="fa-solid fa-gift"></i>${esc(`${g.who}: ${g.text}`)}</em>`).join('')}
    </div>`;
}

/** Что о готовящемся празднике видно: приглашение, сделанное по истории, подарки */
function trackBody(x, live, max) {
    const gifts = [x.charGift?.text && `${getCharName()}: ${x.charGift.text}${x.charGift.done ? ` · ${L().giftGiven}` : ''}`,
        x.userGift?.text && `${getUserName()}: ${x.userGift.text}${x.userGift.done ? ` · ${L().giftGiven}` : ''}`].filter(Boolean);
    return `${x.invited ? `<span class="ht-also-tag"><i class="fa-solid fa-envelope-open-text"></i>${esc(L().alsoInvited)}${x.host ? ` · ${esc(x.host)}` : ''}</span>` : ''}
        ${readyHtml(x.ready, live, max)}
        ${gifts.map(t => `<em class="ht-chip"><i class="fa-solid fa-gift"></i>${esc(t)}</em>`).join('')}`;
}

function bodyHtml(view, live, tab = 'now') {
    const delBtn = (hid) => {
        if (!live || !hid) return '';
        const confirm = ui.confirmDel === hid;
        return `<button class="ht-del${confirm ? ' ht-del-confirm' : ''}" data-act="del" data-hid="${esc(hid)}" title="${confirm ? L().removeSure : L().remove}" aria-label="${L().remove}">
            <i class="fa-solid ${confirm ? 'fa-check' : 'fa-trash-can'}"></i>${confirm ? `<span>${L().removeQ}</span>` : ''}</button>`;
    };
    // чужой день рождения правится через карточку человека во вкладке «Люди», не здесь
    const editBtn = (hid) => (live && hid && !String(hid).startsWith('bday-npc-') ? `<button class="ht-del ht-edit-btn" data-act="edit" data-hid="${esc(hid)}" title="${L().edit}" aria-label="${L().edit}"><i class="fa-solid fa-pen"></i></button>` : '');
    const editForm = (x) => editFormHtml(x);
    const s = view.setting || {};
    const kv = (icon, label, value) => `<div class="ht-kv"><i class="fa-solid ${icon}"></i><div><span>${label}</span><b>${esc(value)}</b></div></div>`;
    const world = [
        s.era && kv('fa-hourglass-half', L().era, s.era),
        // вера — только если модель её назвала по карточке, персоне или истории; «не указана», «нет» не показываем
        s.faith && !NO_FAITH.test(s.faith) && kv('fa-hands-praying', L().faith, s.faith),
        (view.place || s.place) && (ui.editing === 'place' && live
            ? `<div class="ht-kv ht-kv-edit"><i class="fa-solid fa-location-dot"></i><div><span>${L().fPlace}</span>
                <input class="text_pole" data-ed="place" value="${esc(view.place || s.place)}">
                <div class="ht-edit-actions"><button class="ht-btn" data-act="edit-cancel">${L().cancel}</button><button class="ht-btn ht-btn-main" data-act="place-save"><i class="fa-solid fa-check"></i>${L().save}</button></div></div></div>`
            : kv('fa-location-dot', L().place, view.place || s.place).replace('</b></div></div>', `</b></div>${live ? `<button class="ht-del ht-edit-btn" data-act="place-edit" title="${L().edit}" aria-label="${L().edit}"><i class="fa-solid fa-pen"></i></button>` : ''}</div>`)),
        view.when && kv('fa-calendar-day', L().date, view.when),
    ].filter(Boolean).join('');
    // в сам праздник место и дата — одной короткой строкой, эпоха и вера не занимают место
    const worldMini = [view.place || s.place, view.when].filter(Boolean).map(esc).join(' · ');

    let main = '';
    const h = view.h;
    // перо — помощник читает историю; стрелка — запрос упал, нажать, чтобы повторить
    const sideMark = live ? sideMarkHtml() : '';
    if (view.kind === 'today' && h) {
        const plan = view.plan;
        if (plan) {
            const rows = ['morning', 'day', 'evening', 'night'].filter(p => plan[p]).map(p => `
                <div class="ht-part${p === view.part ? ' ht-now' : ''}">
                    <i class="fa-solid ${PART_ICON[p]}"></i>
                    <div><b>${L().part[p]}${p === view.part ? L().now : ''}</b><span>${esc(plan[p])}</span></div>
                </div>`).join('');
            const where = plan.where ? `<p class="ht-plan-where"><i class="fa-solid fa-location-dot"></i><span>${esc(plan.where)}</span></p>` : '';
            const prepared = view.ready ? `<details class="ht-ready-more"><summary><i class="fa-solid fa-list-check"></i>${esc(L().readyBefore)}<i class="fa-solid fa-chevron-down ht-recap-chev"></i></summary>${readyHtml(view.ready, false)}</details>` : '';
            main = section('main', holidayIcon(h), plan.title && !namesMatch(plan.title, h.name) ? esc(plan.title) : L().festiveDay, `${where}<div class="ht-parts">${rows}</div>${prepared}`, sideMark + editBtn(h.id) + delBtn(h.id));
        } else {
            main = section('main', holidayIcon(h), L().festiveDay, `${h.meaning ? `<p class="ht-text">${esc(h.meaning)}</p>` : ''}${apiOn() ? '' : `<p class="ht-mute">${L().planSoon}</p>`}`, sideMark + editBtn(h.id) + delBtn(h.id));
        }
    } else if (view.kind === 'prep' && h) {
        // подготовка — только то, что уже показала история; пока ничего не было — так и пишем, без выдумок
        const p = view.prep, rd = view.ready;
        const mood = p?.mood ? `<p class="ht-mood"><i class="fa-solid fa-feather-pointed"></i>${esc(capFirst(p.mood))}</p>` : '';
        const legacy = !rd && p?.people ? `<p class="ht-text">${esc(capFirst(p.people))}</p>` : '';   // запись из прошлой версии
        main = section('main', holidayIcon(h), L().prep,
            `${mood}${readyHtml(rd, live) || legacy || `<p class="ht-mute">${esc(L().readyNone)}</p>`}${h.meaning && !rd && !legacy ? `<p class="ht-text ht-meaning">${esc(capFirst(h.meaning))}</p>` : ''}`,
            sideMark + editBtn(h.id) + delBtn(h.id));
    } else if (view.kind === 'after' && view.ended) {
        main = section('main', 'fa-moon', esc(L().ended(view.ended.name)), `<p class="ht-text">${esc(view.ended.recap || L().afterDefault)}</p>`);
    } else if (h && view.hCard) {
        main = section('main', holidayIcon(h), esc(h.name), trackBody(view.hCard, live, 5), sideMark + editBtn(h.id) + delBtn(h.id));
    } else if (h) {
        main = section('main', holidayIcon(h), esc(h.name), `<p class="ht-text">${esc(h.meaning || '')}</p>`, editBtn(h.id) + delBtn(h.id));
    } else if (view.diag) {
        // праздников нет — объясняем почему (и что именно пришло, если не тот язык)
        main = `<p class="ht-mute"><i class="fa-solid fa-circle-info"></i> ${esc(L().diag[view.diag])}${view.diagNames?.length ? `. ${esc(L().diagGot)}: ${view.diagNames.map(esc).join(', ')}` : ''}</p>`;
    }

    if (h && ui.editing === h.id && live && main) main = main.replace('<div class="ht-sec-body">', `<div class="ht-sec-body">${editForm(h)}`);
    const upcoming = (view.upcoming || []).map(u => ui.editing === u.id && live ? editForm(u) : `
        <div class="ht-up"><i class="fa-solid ${holidayIcon(u)}"></i>
        <span>${esc(u.name)}${u.invited ? ` <i class="fa-solid fa-envelope-open-text ht-up-inv" title="${esc(L().alsoInvited)}"></i>` : ''}</span><b>${u.daysTo === 1 ? L().tomorrow : L().inDays(daysWord(u.daysTo))}</b>${u.invited ? '' : editBtn(u.id)}${delBtn(u.id)}</div>`).join('');
    // другие праздники и встречи, которые идут сегодня, — одной строкой, без «готовятся»
    const todayAlso = (view.todayAlso || []).length ? `<div class="ht-today-also"><i class="fa-solid fa-calendar-day"></i><span>${esc(L().todayAlso)}:</span>${view.todayAlso.map(x =>
        `<em class="ht-chip"><i class="fa-solid ${holidayIcon(x)}"></i>${esc(x.name)}${x.days > 1 ? ` · ${esc(L().dayOf(x.dayIndex, x.days))}` : ''}${live && x.invited ? delBtn(x.id) : ''}</em>`).join('')}</div>` : '';

    // Чей день рождения: портрет (своё фото из «Людей»), кем приходится обоим, сколько исполняется
    const bp = view.bdPerson;
    const npcCard = bp ? `<div class="ht-npcbd">${avaHtml(avatars()[bp.cid], bp.name)}<div>
            <b>${esc(bp.name)}</b>${bp.age != null ? `<span class="ht-npcbd-age"><i class="fa-solid fa-cake-candles"></i>${esc(L().turns(bp.age, plural))}</span>` : ''}
            ${[bp.toU && `${L().toWhom(getUserName())}: ${bp.toU}`, bp.toC && `${L().toWhom(getCharName())}: ${bp.toC}`].filter(Boolean).map(t => `<em>${esc(t)}</em>`).join('')}
        </div></div>` : '';

    // Подарки имениннику: общий от двоих — или от каждого свой; свой подарок {{user}} вписывает игрок
    let giftsCard = '';
    const ng = view.npcGifts;
    if (bp && ng) {
        const u = getUserName(), c = getCharName();
        const row = (who, g, extra = '', empty = L().giftUndecided) => `<div class="ht-gift-row${g?.done ? ' ht-done' : ''}"><i class="fa-solid ${g?.done ? 'fa-circle-check' : 'fa-gift'}"></i>
            <div><span>${esc(who)}</span><b class="${g?.text || g?.done ? '' : 'ht-mute-b'}">${esc(g?.done ? (g.text || L().giftGiven) : (g?.text || empty))}</b>${g?.text && !g.done ? giftStage(g) : ''}</div>${extra}</div>`;
        let body;
        if (ng.joint) body = row(L().giftFromBoth(c, u), ng.char);
        else {
            const ug = ng.user;
            const userRow = live && ui.editing === 'ugift'
                ? `<div class="ht-gift-row ht-gift-edit"><i class="fa-solid fa-gift"></i><div><span>${esc(L().giftFrom(u))}</span>
                    <input class="text_pole" data-ed="ugift" value="${esc(ug?.text || '')}" placeholder="${esc(L().userGiftPh)}" maxlength="120">
                    <label class="ht-gift-done"><input type="checkbox" data-ed="ugiftDone" ${ug?.done ? 'checked' : ''}>${esc(L().giftGiven)}</label>
                    <div class="ht-edit-actions"><button class="ht-btn" data-act="edit-cancel">${L().cancel}</button><button class="ht-btn ht-btn-main" data-act="ugift-save"><i class="fa-solid fa-check"></i>${L().save}</button></div></div></div>`
                : row(L().giftFrom(u), ug,
                    live ? `<button class="ht-del ht-edit-btn" data-act="ugift-edit" title="${esc(L().userGiftEdit)}" aria-label="${esc(L().userGiftEdit)}"><i class="fa-solid fa-pen"></i></button>` : '',
                    L().userGiftNone);
            body = row(L().giftFrom(c), ng.char) + userRow;
        }
        const toggle = live ? `<button class="ht-gift-mode" data-act="gift-mode" title="${esc(ng.joint ? L().giftOwnTip : L().giftJointTip)}"><i class="fa-solid ${ng.joint ? 'fa-people-arrows' : 'fa-handshake'}"></i><span>${esc(ng.joint ? L().giftOwn : L().giftJoint)}</span></button>` : '';
        giftsCard = `<div class="ht-gifts"><div class="ht-gifts-head"><i class="fa-solid fa-gift"></i><b>${esc(L().giftsFor(bp.name))}</b>${toggle}</div>${body}</div>`;
    }

    // Персонаж — всегда сверху, своя карточка: важность, текущий шаг, что было до, подарок
    let charCard = '';
    if ((view.kind === 'prep' || view.kind === 'today') && view.care) {
        const g = view.charGift;
        const gift = view.gifts ? `<div class="ht-char-gift${g?.done ? ' ht-done' : ''}"><i class="fa-solid ${g?.done ? 'fa-circle-check' : 'fa-gift'}"></i>
            <div><span>${esc(L().giftForUser(view.giftTo || getUserName()))}</span><b>${esc(g?.done ? (g.text || L().giftGiven) : (g?.text || L().giftUndecided))}</b>${g?.text && !g.done ? giftStage(g) : ''}</div></div>` : '';
        const ug = view.userGift;
        const ugift = ug?.text ? `<div class="ht-char-gift${ug.done ? ' ht-done' : ''}"><i class="fa-solid ${ug.done ? 'fa-circle-check' : 'fa-gift'}"></i>
            <div><span>${esc(L().giftFrom(getUserName()))}</span><b>${esc(ug.text)}</b>${ug.done ? '' : giftStage(ug)}</div></div>` : '';
        // прошлые шаги в инфоблок не выводим — они нужны только модели, чтобы цепочка шла дальше
        charCard = `<div class="ht-char${live && view.care === 'high' ? ' ht-glow' : ''}">
            <div class="ht-char-head"><i class="fa-solid fa-user"></i><b>${esc(getCharName())}</b><span class="ht-care ht-care-${esc(view.care)}">${esc(L().care[view.care])}</span></div>
            ${view.care !== 'low' ? `<div class="ht-char-now"><span>${L().thinks}</span>${view.charNow ? `«${esc(view.charNow.replace(/^[«"“]+|[»"”]+$/g, ''))}»` : esc(L().charIdle)}</div>` : ''}
            ${gift}${ugift}
        </div>`;
    }

    // Близкие и знакомые: по группам, один человек — одна строка, подарок прямо в строке
    const groups = ['relative', 'friend', 'acquaintance'].map(gk => {
        const list = (view.people || []).filter(p => p.group === gk);
        if (!list.length) return '';
        return `<div class="ht-group"><div class="ht-group-title">${L().groups[gk]}</div>${list.map(p => `
            <div class="ht-person"><b>${esc(p.name)}</b>${p.now ? `<span><i class="fa-solid fa-comment-dots"></i>${esc(p.now)}</span>` : ''}${p.gift ? `<em class="ht-chip"><i class="fa-solid fa-gift"></i>${esc(p.gift)}</em>` : ''}</div>`).join('')}</div>`;
    }).join('');
    const standout = (view.highlights || []).length ? `<div class="ht-group ht-standout"><div class="ht-group-title"><i class="fa-solid fa-star"></i>${L().standout}</div>${view.highlights.map(x => `
            <div class="ht-person"><b>${esc(x.name)}</b><span>${esc(x.text)}</span></div>`).join('')}</div>` : '';
    const peopleSec = section('people', 'fa-users', L().people, groups + standout);
    // Другие праздники, к которым уже готовятся: у каждого свой журнал и свои подарки
    const whenIn = (d) => (d <= 0 ? L().offerToday : d === 1 ? L().tomorrow : L().inDays(daysWord(d)));
    // крестик у карточки — убрать сам повод (встречу, приглашение, повод из истории), а не только пункт журнала
    const alsoRows = (view.also || []).map(x => `<div class="ht-also">
            <div class="ht-also-head"><i class="fa-solid ${holidayIcon(x)}"></i><b>${esc(x.name)}</b><em>${esc(whenIn(x.daysTo))}</em>${delBtn(x.id)}</div>
            ${trackBody(x, live, 3)}</div>`).join('');
    const primary = view.kind === 'prep' || view.kind === 'today' || view.hCard;
    const alsoSec = section('also', 'fa-list-check', primary ? L().alsoAhead : L().prepAhead, alsoRows);
    // Ивенты — внутри своего праздника или мероприятия, своим цветом (у свидания — в карточке свидания)
    const evBox = view.evFor === 'date' ? '' : eventsHtml(view.evts);
    if (evBox && main) main = main.replace('<div class="ht-sec-body">', `<div class="ht-sec-body">${evBox}`);
    const eventsSec = main ? '' : evBox;

    // Текущий год: по порядку дат; отмеченные — с итогом, прошедшие мимо — приглушены
    const yearRows = (view.year || []).map(i => {
        const [, m, d] = i.iso.split('-');
        const res = i.type === 'date' && i.result ? i.result : null;
        if (i.result === 'cancelled') return `<div class="ht-yr ht-yr-missed ht-yr-off"><time>${esc(d)}.${esc(m)}</time><i class="fa-solid fa-ban"></i><div><b>${esc(i.name)}</b></div><em>${esc(L().yearCancelled)}</em></div>`;
        return `<div class="ht-yr${i.kept ? '' : ' ht-yr-missed'}${res ? ` ht-res-${esc(res)}` : ''}${i.friendly ? ' ht-friendly' : ''}">
            <time>${esc(d)}.${esc(m)}</time><i class="fa-solid ${i.friendly ? 'fa-handshake' : holidayIcon(i)}"></i>
            <div><b>${esc(i.name)}</b>${recapSpoiler(i.recap, i.parts, i.type === 'date' && (i.friendly ? 'friendly' : true))}</div>
            <em>${res ? (res === 'missed' ? L().yearMissed : L().dateResult[res]) : i.kept ? L().yearKept : L().yearMissed}</em></div>`;
    }).join('');

    // Воспоминания: в контекст только по кнопке «вспомнить»
    const memories = (view.flashbacks || []).map(f => {
        const queued = view.recall === f.id;
        const btn = live ? `<button class="ht-recall${queued ? ' ht-on' : ''}" data-act="recall" data-fb="${esc(f.id)}" title="${queued ? L().recallQueued : L().recall}">
            <i class="fa-solid fa-clock-rotate-left"></i><span>${queued ? L().recallShort : L().recall}</span></button>` : '';
        const res = f.kind === 'date' && f.result ? `<em class="ht-res-chip ht-res-${esc(f.result)}${f.friendly ? ' ht-friendly' : ''}"><i class="fa-solid ${f.friendly ? 'fa-handshake' : 'fa-heart'}"></i>${esc(f.result === 'missed' ? L().yearMissed : L().dateResult[f.result] || '')}</em>` : '';
        return `<div class="ht-fb${f.kind === 'date' ? ' ht-fb-date' : ''}"><div><b>${esc(f.title)}</b>${res}${f.when ? `<span class="ht-mute"> · ${esc(f.when)}</span>` : ''}${recapSpoiler(f.text, f.parts, f.kind === 'date' && (f.friendly ? 'friendly' : true))}</div>${btn}</div>`;
    }).join('');

    // Вкладки сверху: праздник сейчас и прошедшие за год — год не растягивает инфоблок вниз
    const n = view.year?.length || 0;
    const nc = view.cast?.length || 0;
    const tabs = `<div class="ht-tabs" role="tablist">
        <button role="tab" class="ht-tab${tab === 'now' ? ' ht-on' : ''}" data-act="tab" data-tab="now" aria-selected="${tab === 'now'}"><i class="fa-solid fa-holly-berry"></i><span>${L().tabNow}</span></button>
        <button role="tab" class="ht-tab${tab === 'cast' ? ' ht-on' : ''}" data-act="tab" data-tab="cast" aria-selected="${tab === 'cast'}"><i class="fa-solid fa-people-group"></i><span>${L().tabPeople}</span>${nc ? `<em class="ht-count">${nc}</em>` : ''}</button>
        <button role="tab" class="ht-tab${tab === 'year' ? ' ht-on' : ''}" data-act="tab" data-tab="year" aria-selected="${tab === 'year'}"><i class="fa-solid fa-calendar-check"></i><span>${L().year}</span>${n ? `<em class="ht-count">${n}</em>` : ''}</button>
    </div>`;
    if (tab === 'cast') return `<div class="ht-body">${tabs}${castTabHtml(view, live)}</div>`;
    if (tab === 'year') {
        return `<div class="ht-body">${tabs}<div class="ht-year">${yearRows || `<p class="ht-mute">${L().yearEmpty}</p>`}</div>
            ${section('memories', 'fa-clock-rotate-left', L().flashbacks, memories)}</div>`;
    }

    const planned = view.planned ? `<div class="ht-planned${view.planned.friendly ? ' ht-friendly' : ''}"><i class="fa-solid ${view.planned.friendly ? 'fa-handshake' : 'fa-heart'}"></i><div>
            <span>${view.planned.friendly ? L().outingPlanned : L().datePlanned}${view.planned.when ? ` · ${esc(view.planned.when)}` : ''}</span>
            <b>${esc(view.planned.title)}${view.planned.where ? ` · ${esc(view.planned.where)}` : ''}</b>
            ${view.planned.goal ? `<em>${esc(view.planned.goal)}</em>` : ''}</div></div>` : '';
    const plannedBd = view.plannedBd && ![...(view.also || []), view.hCard].some(x => x?.name === view.plannedBd.name) ? `<div class="ht-planned ht-planned-bd"><i class="fa-solid ${view.plannedBd.extra ? 'fa-champagne-glasses' : 'fa-gift'}"></i><div>
            <span>${view.plannedBd.extra ? L().exPlanned : L().bdPlanned}${view.plannedBd.when ? ` · ${esc(view.plannedBd.when)}` : ''}</span>
            <b>${esc(view.plannedBd.name)}</b></div></div>` : '';
    return `<div class="ht-body">
        ${tabs}
        ${planned}${plannedBd}
        ${npcCard}
        ${todayAlso}
        ${view.kind === 'today' || bp ? (worldMini ? `<div class="ht-world-mini"><i class="fa-solid fa-location-dot"></i>${worldMini}</div>` : '') : (world ? `<div class="ht-world">${world}</div>` : '')}
        ${charCard}
        ${giftsCard}
        ${eventsSec}
        ${main}
        ${alsoSec}
        ${peopleSec}
        ${section('upcoming', 'fa-calendar-days', L().upcoming, upcoming)}
    </div>`;
}

function bindBlock(block) {
    // своя картинка человеку: ужимаем и храним в чате отдельно от снимков
    block.addEventListener('change', async (e) => {
        const inp = e.target.closest?.('input[data-act="cast-photo"]');
        if (!inp?.files?.[0]) return;
        try {
            avatars()[inp.dataset.cid] = await shrinkImage(inp.files[0]);
            saveChatDebounced();
            renderBlock(Number(block.dataset.mesid));
        } catch (err) {
            console.error('[Hearthtide] картинка:', err);
            window.toastr?.warning?.(L().badPhoto, 'Hearthtide');
        }
    });
    block.addEventListener('click', (e) => {
        const t = e.target.closest('[data-act]');
        if (!t || !block.contains(t)) return;
        e.stopPropagation();
        const id = Number(block.dataset.mesid);
        if (t.dataset.act === 'toggle') {
            const opening = !block.classList.contains('ht-open');
            if (opening) for (const k of SESSION_SECTIONS) delete secSession[k];
            ui.open.set(id, opening);
            renderBlock(id);
        } else if (t.dataset.act === 'edit') {
            ui.editing = t.dataset.hid;
            ui.confirmDel = null;
            if (t.closest('.ht-sec')?.classList.contains('ht-sec-closed')) toggleSec(t.closest('.ht-sec').querySelector('h5')?.dataset.key);
            renderBlock(id);
        } else if (t.dataset.act === 'place-edit') {
            ui.editing = 'place';
            renderBlock(id);
        } else if (t.dataset.act === 'edit-cancel') {
            ui.editing = null;
            renderBlock(id);
        } else if (t.dataset.act === 'edit-save') {
            const f = t.closest('.ht-edit');
            const val = (k) => f?.querySelector(`[data-ed="${k}"]`)?.value ?? '';
            if (saveHolidayEdit(t.dataset.hid, val('name'), val('date'), val('type'), f?.querySelector('[data-ed="meaning"]') ? val('meaning') : null)) {
                ui.editing = null;
                window.toastr?.success?.(L().saved, 'Hearthtide');
                renderAll();
            }
        } else if (t.dataset.act === 'ugift-edit') {
            ui.editing = 'ugift';
            renderBlock(id);
        } else if (t.dataset.act === 'ugift-save') {
            saveUserGift(block.querySelector('[data-ed="ugift"]')?.value, !!block.querySelector('[data-ed="ugiftDone"]')?.checked);
            ui.editing = null;
            renderAll();
        } else if (t.dataset.act === 'ready-del') {
            removeReady(t.dataset.hid, t.dataset.t);
        } else if (t.dataset.act === 'gift-mode') {
            toggleGiftMode();
        } else if (t.dataset.act === 'ev-yes' || t.dataset.act === 'ev-no') {
            decideEvent(t.dataset.eid, t.dataset.act === 'ev-yes' ? 'accepted' : 'declined');
        } else if (t.dataset.act === 'date-yes' || t.dataset.act === 'date-no') {
            decideDate(t.dataset.act === 'date-yes');
        } else if (t.dataset.act === 'date-step') {
            const n = Number(t.dataset.n);
            changeDate(st => toggleStep(st.date, n, st.turn, dateLevel()));
        } else if (t.dataset.act === 'date-end') {
            endDateNow();
        } else if (t.dataset.act === 'cast-tab') {
            ui.castTab = t.dataset.tab;
            renderBlock(id);
        } else if (t.dataset.act === 'cast-eye') {
            toggleCastOff(t.dataset.cid);
        } else if (t.dataset.act === 'cast-rom') {
            // выбор в форме — сохранится по «Сохранить»
            t.parentElement.querySelectorAll('button').forEach(b => { b.classList.toggle('ht-on', b === t); b.setAttribute('aria-pressed', String(b === t)); });
        } else if (t.dataset.act === 'cast-photo-del') {
            delete avatars()[t.dataset.cid];
            saveChatDebounced();
            renderBlock(id);
        } else if (t.dataset.act === 'inv-yes' || t.dataset.act === 'inv-no') {
            decideInv(t.dataset.act === 'inv-yes');
        } else if (t.dataset.act === 'cast-more') {
            ui.castMore.set(ui.castTab || 'all', Number(t.dataset.n) || CAST_PAGE);
            renderAll();
        } else if (t.dataset.act === 'cast-new') {
            openCastNew();
        } else if (t.dataset.act === 'pair-edit') {
            openPairEditor();
        } else if (t.dataset.act === 'cast-edit') {
            ui.confirmDel = null;
            openCastEditor(t.dataset.cid);
        } else if (t.dataset.act === 'cast-del') {
            const key = `cast:${t.dataset.cid}`;
            if (ui.confirmDel !== key) { ui.confirmDel = key; renderBlock(id); return; }
            ui.confirmDel = null;
            removeCast(t.dataset.cid);
        } else if (t.dataset.act === 'cast-save') {
            const f = t.closest('.ht-edit');
            const val = (k) => f?.querySelector(`[data-ed="${k}"]`)?.value ?? '';
            const rom = (w) => f?.querySelector(`.ht-rom-pick[data-who="${w}"] .ht-on`)?.dataset.key || '';
            if (saveCast(t.dataset.cid, { name: val('name'), toU: val('toU'), toC: val('toC'), group: groupOf(f), bday: val('bday'), relU: val('relU'), relC: val('relC'), noteU: val('noteU'), noteC: val('noteC'), romU: rom('user'), romC: rom('char') })) {
                ui.editing = null;
                renderAll();
            }
        } else if (t.dataset.act === 'tab') {
            ui.tab.set(id, t.dataset.tab);
            renderBlock(id);
        } else if (t.dataset.act === 'side-retry') {
            sideErr = null;
            maybeSide(lastProcessedMsg(), true);
        } else if (t.dataset.act === 'offer-yes') {
            if (acceptOffer(t.dataset.oid)) renderAll();
        } else if (t.dataset.act === 'offer-no') {
            declineOffer(t.dataset.oid);
            renderAll();
        } else if (t.dataset.act === 'offer-edit') {
            ui.editing = t.dataset.oid;
            ui.confirmDel = null;
            renderBlock(id);
        } else if (t.dataset.act === 'offer-save') {
            const f = t.closest('.ht-edit');
            const val = (k) => f?.querySelector(`[data-ed="${k}"]`)?.value ?? '';
            if (acceptOffer(t.dataset.hid, { name: val('name'), date: val('date'), type: val('type'), meaning: val('meaning') })) {
                ui.editing = null;
                renderAll();
            }
        } else if (t.dataset.act === 'place-save') {
            const v = block.querySelector('[data-ed="place"]')?.value;
            if (savePlaceEdit(v)) {
                ui.editing = null;
                window.toastr?.success?.(L().saved, 'Hearthtide');
                renderAll();
            }
        } else if (t.dataset.act === 'recall') {
            const fbId = t.dataset.fb;
            state.recall = state.recall === fbId ? null : fbId;   // повторное нажатие отменяет
            saveState();
            injectPrompts();
            if (state.recall) window.toastr?.info?.(L().recallToast(getCharName()), 'Hearthtide');
            renderBlock(id);
        } else if (t.dataset.act === 'sec') {
            toggleSec(t.dataset.key);
            renderAll();   // во всех инфоблоках раздел свёрнут одинаково
        } else if (t.dataset.act === 'del') {
            const hid = t.dataset.hid;
            if (ui.confirmDel === hid) {
                ui.confirmDel = null;
                deleteHoliday(hid);
            } else {
                ui.confirmDel = hid;
                renderBlock(id);
            }
        }
    });
    block.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.ht-head, .ht-sec h5')) {
            e.preventDefault();
            e.target.click();
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// ПАНЕЛЬ В МЕНЮ РАСШИРЕНИЙ
// ═══════════════════════════════════════════════════════════════
// Пояснения к настройкам романтики — что именно меняется (обновляются при выборе)
const LEVEL_NOTE = {
    easy: 'Шаг свидания +9 к успеху, срыв −6. Главная цель — после 5 шагов и 40 %. Дружба за ответ — не больше +8; итог свидания — полностью.',
    hard: 'Шаг +6, срыв −10, промахи бьют в полтора раза сильнее. Цель — после 7 шагов и 55 %. Дружба за ответ — не больше +5; удачное свидание даёт на 40 % меньше, неудачное отнимает на 30 % больше.',
};
const PACE_NOTE = {
    auto: 'По сюжету: темп выбирается по романтике пары — до 30 как Slow burn, от 70 как Fast burn, между — обычный (романтика +6 за ответ).',
    slow: 'Slow burn: романтика растёт не больше чем на +3 за ответ, удачное свидание даёт её вдвое меньше; шаги осторожнее, до главной цели на 2 шага и 10 % дольше.',
    fast: 'Fast burn: романтика может расти до +12 за ответ, удачное свидание даёт её в полтора раза больше; шаги смелее, цель на 2 шага и 10 % ближе.',
};
function setNote(id, text) { const el = document.querySelector(`#${id} span`); if (el) el.textContent = text; }

function injectSettingsPanel() {
    let attempts = 0;
    const iv = setInterval(() => {
        attempts++;
        const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!container) { if (attempts >= 40) clearInterval(iv); return; }
        clearInterval(iv);
        if (document.getElementById('ht-settings')) return;
        container.insertAdjacentHTML('beforeend', `
        <div class="inline-drawer" id="ht-settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-holly-berry"></i> Hearthtide</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <div class="ht-set">
                <section class="ht-set-sec">
                    <div class="ht-set-title"><i class="fa-solid fa-sliders"></i>Основное</div>
                    <label class="checkbox_label"><input type="checkbox" id="ht-set-enabled" ${isEnabled() ? 'checked' : ''}>Включить</label>
                    <div class="ht-set-row"><span>Инфоблок</span>
                        <div class="ht-seg" id="ht-set-position" role="radiogroup">
                            ${[['top', 'сверху', 'fa-arrow-up'], ['middle', 'посередине', 'fa-grip-lines'], ['bottom', 'снизу', 'fa-arrow-down']].map(([v, t, i]) =>
                                `<button type="button" role="radio" data-pos="${v}" aria-checked="${position() === v}" class="${position() === v ? 'ht-on' : ''}"><i class="fa-solid ${i}"></i><span>${t}</span></button>`).join('')}
                        </div>
                    </div>
                    <label class="checkbox_label"><input type="checkbox" id="ht-set-prev" ${showPrev() ? 'checked' : ''}>В предыдущих ответах тоже</label>
                    <div class="ht-set-row"><span>Язык</span>
                        <select id="ht-set-lang" class="text_pole">
                            <option value="ru" ${langMode() === 'ru' ? 'selected' : ''}>русский</option>
                            <option value="en" ${langMode() === 'en' ? 'selected' : ''}>English</option>
                        </select>
                    </div>
                </section>
                <section class="ht-set-sec">
                    <div class="ht-set-title"><i class="fa-solid fa-feather-pointed"></i>Помощник</div>
                    <div class="ht-set-row"><span>Профиль</span>
                        <select id="ht-set-api" class="text_pole"><option value="auto">текущий профиль</option></select>
                        <div class="menu_button menu_button_icon" id="ht-set-refresh" title="Обновить список профилей"><i class="fa-solid fa-arrows-rotate"></i></div>
                        <div class="menu_button menu_button_icon" id="ht-set-ping" title="Проверить подключение"><i class="fa-solid fa-plug-circle-check"></i></div>
                    </div>
                    <div class="ht-set-row"><span>Помнит сообщений</span>
                        <select id="ht-set-depth" class="text_pole">
                            ${[5, 10, 20, 30].map(n => `<option value="${n}" ${sideDepth() === n ? 'selected' : ''}>${n}</option>`).join('')}
                        </select>
                    </div>
                    <div class="menu_button ht-set-wide" id="ht-set-scan"><i class="fa-solid fa-magnifying-glass"></i> Проверить историю</div>
                </section>
                <section class="ht-set-sec">
                    <div class="ht-set-title"><i class="fa-solid fa-hourglass-half"></i>Мир <small id="ht-era-who"></small></div>
                    <div class="ht-set-row"><span>Эпоха</span>
                        <select id="ht-set-era" class="text_pole">
                            <option value="auto" ${eraMode() === 'auto' ? 'selected' : ''}>по началу чата</option>
                            <option value="ancient" ${eraMode() === 'ancient' ? 'selected' : ''}>прошлое и вымышленные миры</option>
                            <option value="modern" ${eraMode() === 'modern' ? 'selected' : ''}>наши дни</option>
                        </select>
                    </div>
                    <small class="ht-set-note"><i class="fa-solid fa-hands-praying"></i><span id="ht-faith-now"></span></small>
                    <div class="menu_button ht-set-wide" id="ht-set-rebuild" title="Убрать будущие праздники и подобрать по эпохе и вере этого чата"><i class="fa-solid fa-arrows-rotate"></i> Подобрать праздники заново</div>
                </section>
                <section class="ht-set-sec">
                    <div class="ht-set-title"><i class="fa-solid fa-dice"></i>Ивенты</div>
                    <div class="ht-set-row" title="Случайное событие на идущем мероприятии: праздник в сам день, день рождения, свидание. В подготовке и в обычные дни ивентов нет.">
                        <span>Случайные ивенты</span>
                        <input type="range" id="ht-set-evchance" min="0" max="50" step="1" value="${evChanceSetting()}">
                        <b class="ht-set-val" id="ht-set-evchance-val">${evChanceSetting() ? `${evChanceSetting()}%` : 'выкл.'}</b>
                    </div>
                    <small class="ht-set-note"><i class="fa-solid fa-dice"></i><span>Только на идущих мероприятиях: праздник, день рождения, свидание</span></small>
                </section>
                <section class="ht-set-sec">
                    <div class="ht-set-title"><i class="fa-solid fa-heart"></i>Романтика</div>
                    <div class="ht-set-row" title="Как часто чар сам зовёт на свидание после ответа. После ссоры — в 2,5 раза чаще. Свидания из самого ролплея от этого не зависят.">
                        <span>Случайные свидания</span>
                        <input type="range" id="ht-set-datechance" min="0" max="30" step="1" value="${dateChanceSetting()}">
                        <b class="ht-set-val" id="ht-set-datechance-val">${dateChanceSetting() ? `${dateChanceSetting()}%` : 'выкл.'}</b>
                    </div>
                    <small class="ht-set-note"><i class="fa-solid fa-heart"></i><span>Сейчас: <span id="ht-date-why"></span></span></small>
                    <div class="ht-set-row">
                        <span>Сложность свиданий</span>
                        <select id="ht-set-datelevel" class="text_pole">
                            <option value="easy" ${dateLevel() === 'easy' ? 'selected' : ''}>лёгкая</option>
                            <option value="hard" ${dateLevel() === 'hard' ? 'selected' : ''}>сложная</option>
                        </select>
                    </div>
                    <small class="ht-set-note ht-set-explain" id="ht-note-level"><i class="fa-solid fa-circle-info"></i><span>${esc(LEVEL_NOTE[dateLevel()])}</span></small>
                    <div class="ht-set-row">
                        <span>Темп романтики</span>
                        <select id="ht-set-datepace" class="text_pole">
                            <option value="auto" ${datePaceSetting() === 'auto' ? 'selected' : ''}>по сюжету</option>
                            <option value="slow" ${datePaceSetting() === 'slow' ? 'selected' : ''}>Slow burn</option>
                            <option value="fast" ${datePaceSetting() === 'fast' ? 'selected' : ''}>Fast burn</option>
                        </select>
                    </div>
                    <small class="ht-set-note ht-set-explain" id="ht-note-pace"><i class="fa-solid fa-circle-info"></i><span>${esc(PACE_NOTE[datePaceSetting()])}</span></small>
                </section>
              </div>
            </div>
        </div>`);
        document.getElementById('ht-set-enabled')?.addEventListener('change', e => {
            localStorage.setItem(LS.enabled, e.target.checked ? 'true' : 'false');
            injectPrompts();
            renderAll();
        });
        document.getElementById('ht-set-position')?.addEventListener('click', e => {
            const b = e.target.closest('[data-pos]');
            if (!b) return;
            localStorage.setItem(LS.position, b.dataset.pos);
            document.querySelectorAll('#ht-set-position [data-pos]').forEach(x => {
                x.classList.toggle('ht-on', x === b);
                x.setAttribute('aria-checked', String(x === b));
            });
            document.querySelectorAll('.ht-ib, .ht-cards').forEach(x => x.remove());
            ui.nodes.clear();
            renderAll();
        });
        document.getElementById('ht-set-evchance')?.addEventListener('input', e => {
            localStorage.setItem(LS.evChance, e.target.value);
            const v = document.getElementById('ht-set-evchance-val');
            if (v) v.textContent = +e.target.value ? `${e.target.value}%` : 'выкл.';
        });
        document.getElementById('ht-set-datechance')?.addEventListener('input', e => {
            localStorage.setItem(LS.dateChance, e.target.value);
            const v = document.getElementById('ht-set-datechance-val');
            if (v) v.textContent = +e.target.value ? `${e.target.value}%` : 'выкл.';
            updateDateWhy();
            scheduleRenderAll();          // строка о свидании в карточке пары
        });
        document.getElementById('ht-set-datepace')?.addEventListener('change', e => {
            localStorage.setItem(LS.datePace, e.target.value);
            setNote('ht-note-pace', PACE_NOTE[datePaceSetting()]);
            injectPrompts();
            renderAll();
        });
        document.getElementById('ht-set-datelevel')?.addEventListener('change', e => {
            localStorage.setItem(LS.dateLevel, e.target.value);
            setNote('ht-note-level', LEVEL_NOTE[dateLevel()]);
            injectPrompts();
            renderAll();
        });
        document.getElementById('ht-set-lang')?.addEventListener('change', e => {
            localStorage.setItem(LS.lang, e.target.value);
            injectPrompts();
            renderAll();
        });
        fillProfiles();
        document.getElementById('ht-set-api')?.addEventListener('focus', fillProfiles);
        document.getElementById('ht-set-api')?.addEventListener('change', e => {
            localStorage.setItem(LS.api, e.target.value);
            cancelSide();
            if (!state && chat.length) loadState();
            injectPrompts();          // запрос уйдёт сам — после следующего ответа бота
            renderAll();
        });
        document.getElementById('ht-set-refresh')?.addEventListener('click', async () => {
            await fillProfiles();
            window.toastr?.info?.(L().profilesRefreshed, 'Hearthtide');
        });
        document.getElementById('ht-set-ping')?.addEventListener('click', pingProfile);
        document.getElementById('ht-set-depth')?.addEventListener('change', e => {
            localStorage.setItem(LS.depth, e.target.value);
        });
        document.getElementById('ht-set-scan')?.addEventListener('click', () => {
            if (!apiOn()) { window.toastr?.info?.(isEnabled() ? L().noProfile : L().disabledNote, 'Hearthtide'); return; }
            if (!state || lastProcessedMsg() < 0) { window.toastr?.info?.(L().scanNothing, 'Hearthtide'); return; }
            window.toastr?.info?.(L().scanToast, 'Hearthtide');
            maybeSide(lastProcessedMsg(), true, ['census']);     // заодно — перепись людей истории
        });
        syncCharSettings();
        updateDateWhy();
        document.getElementById('ht-set-rebuild')?.addEventListener('click', () => {
            if (!chat.length) return;
            rebuildCalendar();
        });
        document.getElementById('ht-set-era')?.addEventListener('change', e => {
            if (!state) loadState();
            setChatEra(e.target.value);
            rebuildCalendar();
        });
        document.getElementById('ht-set-prev')?.addEventListener('change', e => {
            localStorage.setItem(LS.showPrev, e.target.checked ? 'true' : 'false');
            renderAll();
        });
    }, 250);
}

// Профили подключения в списке (список в таверне может меняться — обновляем при каждом открытии)
async function fillProfiles() {
    const sel = document.getElementById('ht-set-api');
    if (!sel) return;
    const list = await listProfiles();
    const cur = apiChoice();
    sel.innerHTML = `<option value="auto">${apiProfile() || apiChoice() !== 'auto' ? 'текущий профиль' : 'текущее подключение'}</option>`
        + list.map(p => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    // выбранный профиль удалили в таверне — возвращаемся к текущему профилю
    if (cur !== 'auto' && !list.some(p => p.id === cur)) localStorage.setItem(LS.api, 'auto');
}

// Проверка подключения: крошечный запрос к выбранному профилю
let pinging = false;
async function pingProfile() {
    if (pinging) return;
    const id = apiProfile();
    // выключенное расширение — не «нет профиля»: говорим прямо, что выключено
    if (!apiOn()) { window.toastr?.info?.(isEnabled() ? L().noProfile : L().disabledNote, 'Hearthtide'); return; }
    const btn = document.getElementById('ht-set-ping');
    pinging = true;
    btn?.classList.add('ht-pinging');
    const t0 = Date.now();
    try {
        await sendSide(id, [{ role: 'system', content: 'Reply with the single word OK.' }, { role: 'user', content: 'Ping' }], null, 300);
        window.toastr?.success?.(L().pingOk(((Date.now() - t0) / 1000).toFixed(1)), 'Hearthtide');
    } catch (e) {
        const why = reasonOf(e);
        console.error('[Hearthtide] проверка подключения:', why, e);
        window.toastr?.error?.(`${L().pingFail}: ${why}`, 'Hearthtide', { timeOut: 12000 });
    } finally {
        pinging = false;
        btn?.classList.remove('ht-pinging');
    }
}

// Эпоха и вера в настройках — для текущего чата
function syncCharSettings() {
    const era = document.getElementById('ht-set-era');
    if (era) era.value = eraMode();
    const who = document.getElementById('ht-era-who');
    if (who) who.textContent = chat.length ? '· этот чат' : '';
    const faith = document.getElementById('ht-faith-now');
    if (faith) faith.textContent = `Вера: ${state?.setting?.faith || 'определится по началу чата'} — по карточке, персоне и истории`;
}

// Новый чат: эпоха не наследуется — её определит ИИ по началу чата в первом календаре
function noteCharSettings() {
    syncCharSettings();
}

// ═══════════════════════════════════════════════════════════════
// СОБЫТИЯ
// ═══════════════════════════════════════════════════════════════
let generating = false;

function onGenerationStarted(type, params, dryRun) {
    if (dryRun) return;
    generating = true;
    sideAfterGen = null;
    cancelSide();          // пользователь уже пишет дальше — результат для прошлого ответа не нужен
    if (!isEnabled()) return;
    if (!state) loadState();
    injectPrompts();
}

function onMessageReceived(id) {
    if (!apiOn()) { scheduleRenderAll(); return; }
    if (!state) loadState();
    processReply(Number(id));
    // таверна ещё дописывает сообщение — запрос отправим, когда генерация закончится
    sideAfterGen = Number(id);
    // на случай, если событие конца генерации не придёт
    setTimeout(() => { if (sideAfterGen === Number(id)) { generating = false; onGenerationEnded(); } }, 4000);
}
let sideAfterGen = null;
function onGenerationEnded() {
    generating = false;
    scheduleEnsure();
    if (sideAfterGen != null) {
        const id = sideAfterGen;
        sideAfterGen = null;
        setTimeout(() => maybeSide(id), 300);
    }
}

function onMessageSwiped(id) {
    if (!apiOn() || !state) return;
    setTimeout(() => {
        if (generating) return;
        const m = chat[id];
        if (!m || m.is_user) return;
        const sw = m.swipes?.[m.swipe_id];
        if (sw && sw.trim() && m.mes === sw && state.snapshots.some(s => s.beforeMsg === Number(id))) {
            processReply(Number(id));
            maybeSide(Number(id));
        }
        else scheduleRenderAll();
    }, 150);
}

function onMessageEdited(id) {
    if (!apiOn() || !state) return;
    const m = chat[id];
    if (m && !m.is_user && Number(id) === lastProcessedMsg()) {
        processReply(Number(id));
        maybeSide(Number(id));
    }
    else scheduleRenderAll();
}

function onMessageDeleted() {
    if (!isEnabled() || !state) return;
    if (side && !chat[side.N]) cancelSide();
    const len = chat.length;
    // решения по тому, что пришло в удалённых сообщениях (ивент, приглашение, свидание), снимаются — до отката,
    // чтобы откат их не вернул: ивент, начатый раньше, остаётся с той точки, где был принят; начатый в удалённом — пропадает
    dropDecisionsFrom(len);
    const affected = state.snapshots.filter(s => s.beforeMsg >= len).sort((a, b) => a.beforeMsg - b.beforeMsg);
    if (affected.length) {
        restoreSnapshot(affected[0]);
        state.snapshots = state.snapshots.filter(s => s.beforeMsg < len);
        saveState();
        injectPrompts();
    }
    scheduleRenderAll();
}

function onChatChanged() {
    closeCastEditor();
    ui.nodes.clear();
    cancelSide();
    sideAfterGen = null;
    ui.open.clear();
    loadState();
    noteCharSettings();
    injectPrompts();
    glueOldTags();
    for (const ms of [150, 600, 1500]) setTimeout(renderAll, ms);
}

/** Старые ответы, где HT-строка стоит отдельно, а после ответа идёт блок ExtBlocks (картинка), — приклеить строку к тексту */
function glueOldTags() {
    if (!isEnabled()) return;
    let n = 0;
    chat.forEach((msg, i) => {
        if (!msg || msg.is_user || msg.is_system || !msg.mes || !msg.extra?.extblocks) return;
        const glued = glueTag(msg.mes);
        const disp = typeof msg.extra.display_text === 'string' ? glueTag(msg.extra.display_text) : null;
        if (glued === msg.mes && (disp == null || disp === msg.extra.display_text)) return;
        msg.mes = glued;
        if (disp != null) msg.extra.display_text = disp;
        if (Array.isArray(msg.swipes) && msg.swipe_id != null && msg.swipes[msg.swipe_id] != null) msg.swipes[msg.swipe_id] = glueTag(msg.swipes[msg.swipe_id]);
        try { stModule?.updateMessageBlock?.(i, msg); } catch (e) { /* пусто */ }
        n++;
    });
    if (n) { console.info(`[Hearthtide] HT-строка приклеена к тексту в ${n} ответах (картинки ExtBlocks больше не сдвигаются)`); saveChatDebounced(); }
}

// Таверна дорисовывает сообщения позже событий — следим за самим #chat
let chatObserver = null;
const OBSERVER_MAX_MOVES = 150;    // реакций в секунду: перерисовке и стримингу хватает десятков, гонке нужны тысячи
let observerMoves = 0;
let observerMovesTimer = null;
let observerCooling = false;
function observeChat() {
    const target = document.getElementById('chat');
    if (!target) { setTimeout(observeChat, 500); return; }
    if (chatObserver) return;
    // Следим и за новыми сообщениями, и за перерисовкой текста внутри них: другие
    // расширения могут переписать текст ответа и стереть инфоблок (особенно в середине)
    chatObserver = new MutationObserver((muts) => {
        let changed = false;
        for (const m of muts) {
            const t = m.target;
            if (t.nodeType === 1 && t.closest?.('.ht-ib, .ht-cards')) continue;          // наши собственные изменения
            const nodes = [...m.addedNodes, ...m.removedNodes];
            if (nodes.length && nodes.every(n => n.nodeType === 1 && (n.classList?.contains('ht-ib') || n.classList?.contains('ht-cards')))) continue;
            changed = true;
            break;
        }
        if (!changed) return;
        // страховка: если какое-то расширение без конца двигает разметку, ненадолго перестаём отвечать,
        // а не гоняемся за ним вечно (бесконечная гонка вешает страницу, особенно на телефоне)
        if (++observerMoves > OBSERVER_MAX_MOVES) {
            if (!observerCooling) {
                observerCooling = true;
                console.warn('[Hearthtide] инфоблок: другое расширение постоянно двигает разметку — пауза');
                setTimeout(() => { observerCooling = false; observerMoves = 0; }, 2000);
            }
            return;
        }
        if (!observerMovesTimer) observerMovesTimer = setTimeout(() => { observerMoves = 0; observerMovesTimer = null; }, 1000);
        reattach();
        scheduleEnsure();
    });
    chatObserver.observe(target, { childList: true, subtree: true });
}

// Вернуть инфоблоки, которые кто-то стёр (во время генерации не трогаем — текст ещё пишется)
let ensureTimer = null;
function scheduleEnsure() {
    clearTimeout(ensureTimer);
    ensureTimer = setTimeout(ensureBlocks, 150);
}
function ensureBlocks() {
    if (!isEnabled() || generating) return;
    if (!state && chat.length) loadState();
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        const id = Number(el.getAttribute('mesid'));
        const has = el.querySelector('.ht-ib');
        // стёрли инфоблок или карточки под текстом (перерисовка .mes_text) — вернуть
        const lostCards = id === lastBotIndex() && cardsDue() && !el.querySelector('.ht-cards');
        if (shouldShow(id) && (!has || lostCards)) renderBlock(id);
        // что-то вклинилось между текстом и инфоблоком — вернуть к тексту (на месте — не трогаем)
        else if (has && shouldShow(id)) placeBlock(el, has, el.querySelector('.ht-cards'));
    });
}

function on(evt, fn) { if (evt) eventSource.on(evt, fn); }

function init() {
    injectSettingsPanel();
    loadState();
    injectPrompts();
    on(event_types.GENERATION_STARTED, onGenerationStarted);
    on(event_types.GENERATION_ENDED, onGenerationEnded);
    on(event_types.GENERATION_STOPPED, onGenerationEnded);
    on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onAfterCombinePrompts);
    on(event_types.CHARACTER_MESSAGE_RENDERED, scheduleRenderAll);
    on(event_types.USER_MESSAGE_RENDERED, scheduleRenderAll);
    on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    on(event_types.MESSAGE_EDITED, onMessageEdited);
    on(event_types.MESSAGE_UPDATED, scheduleRenderAll);
    on(event_types.MESSAGE_DELETED, onMessageDeleted);
    on(event_types.MORE_MESSAGES_LOADED, scheduleRenderAll);
    on(event_types.CHAT_CHANGED, onChatChanged);
    observeChat();
    for (const ms of [300, 1000]) setTimeout(renderAll, ms);
}

jQuery(() => init());
