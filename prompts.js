// Hearthtide — prompts.js
// Весь инджект — на английском. Значения для инфоблока ИИ пишет на выбранном языке.

import { isoOf, fromDayNum, easterJulian, easterGregorian } from './dates.js';
import { hasGifts, isIntimate, openEvent, dateHoursLeft, giftJoint, charGiftOf, activeOccasions, occTier, preparingNow, pushable } from './calendar.js';
import { openSteps, goalOpen, DATE_OPEN, DATE_MOMENTS } from './romance.js';
import { ageOf, relLevel } from './cast.js';
import { ICON_WORDS } from './icons.js';

const PART_EN = { morning: 'morning', day: 'daytime', evening: 'evening', night: 'night' };

export function hName(h, ctx) {
    if (!h) return '';
    if (h.npc) return `${h.name}'s birthday`;
    if (h.extra) return `${h.name}${h.host ? ` (held by ${h.host})` : ''}`;
    if (h.birthday) return `${h.who === 'user' ? ctx.userName : ctx.charName}'s birthday`;
    return h.name;
}

// ─── День рождения человека из истории ───
const npcOf = (state, h) => (h?.npc ? (state.cast || []).find(c => c.id === h.cid) || null : null);
/** «turns 30; to Anna: mother; to Ivan: mother-in-law» */
function npcAbout(ctx, h) {
    const c = npcOf(ctx.state, h);
    if (!c) return '';
    const age = ageOf(c, h.start);
    return [age != null && `turns ${age}`, c.toU && `to ${ctx.userName}: ${c.toU}`, c.toC && `to ${ctx.charName}: ${c.toC}`].filter(Boolean).join('; ');
}
/** Ждут ли там {{char}} и {{user}} и почему (праздник в календаре — только после принятого приглашения) */
function npcExpect(ctx, h) {
    const { state, userName, charName } = ctx;
    const c = npcOf(state, h);
    if (c?.group === 'kin_both') return `it is family to both — ${charName} and ${userName} are among those who keep the day, not guests`;
    return `${userName} accepted the invitation: ${charName} and ${userName} are expected`;
}
const whomOf = (ctx, w) => (w === 'user' ? ctx.userName : w === 'char' ? ctx.charName : `${ctx.charName} and ${ctx.userName}`);

/** Приглашения в промпт: ждёт ответа · принятые впереди · отказ · не пришли (обида) · таймскип перепрыгнул */
function inviteLines(ctx) {
    const { state, phase, userName, charName } = ctx;
    const out = [];
    const today = state.today;
    if (today == null) return out;
    const inDays = (d) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days, not sooner`);
    const inv = state.inv;
    if (inv?.status === 'offered') {
        out.push(`${inv.host || inv.name} has invited ${whomOf(ctx, inv.whom)} to ${inv.kind === 'bday' ? `${inv.name}'s birthday` : inv.name} on ${isoOf(inv.day)} (${inDays(inv.day - today)}). ${userName} hasn't answered yet. It has NOT happened: nobody has gone, celebrated or given gifts — don't write any of it as done.`);
    }
    // принятые и ещё не наступившие — модель знает дату и что это впереди
    const cur = (phase.kind === 'prep' || phase.kind === 'today') ? phase.h?.id : null;
    const ahead = (ctx.acceptedAhead || []).filter(h => h.id !== cur && h.start > today && !preparingNow(state, h)).slice(0, 2);
    if (ahead.length) out.push(`Accepted invitations ahead: ${ahead.map(h => `${hName(h, ctx)} on ${isoOf(h.start)} (${inDays(h.start - today)})`).join('; ')} — already settled, nobody needs to invite, ask or remind about it again; it stays in the background and comes on its day.`);
    if (state.invDeclined?.turn >= (state.turn || 0) - 1) out.push(`${userName} declined the invitation to ${state.invDeclined.name} — ${state.invDeclined.host || 'the host'} takes it in their own way; don't push it.`);
    // обещали прийти и не пришли — обида живёт несколько ответов
    // не в каждом ответе: на 1-м, 4-м и 8-м после обиды — иначе обиженный поминал её в каждой сцене
    for (const x of (state.hurt || []).filter(x => [1, 4, 8].includes((state.turn || 0) - x.turn))) {
        out.push(`${x.who} is hurt: ${charName} and ${userName} accepted the invitation to ${x.what} and didn't come — ${x.who} is cooler with them now; it may show in passing (a remark, a cool word, a reproach), never as a scene of its own.`);
    }
    return out;
}
const langOf = (ctx) => ctx.lang || "the roleplay's language";

/** Как сеттинг окрашивает праздник: в наши дни — нынешняя жизнь и обычные слова, а не старинные обряды */
const MODERN_TONE = 'present-day life as people here really live it now — modern places, means and plain modern words; no old-time rites, folk-tale customs or archaic phrasing unless these characters truly keep them';
export function settingTone(ctx) {
    if (ctx.eraMode === 'modern') return `Setting: the present day — customs, plans and wording are ${MODERN_TONE}.`;
    if (ctx.eraMode === 'ancient') return 'Customs, plans and wording are those people of this era and place really have — their means, beliefs and words.';
    return `Customs, plans and wording are those people of this era and place really have; if it is our present-day world — ${MODERN_TONE}.`;
}
/** Живая мысль {{char}}: его голос, его словарь, его эмоция — а не спокойное пояснение */
export const LIVE_VOICE = (ctx) => `raw and alive, first person, the way ${ctx.charName} really talks inside — the card's and the story's own words, slang, humour, rudeness or swearing if ${ctx.charName} speaks like that, nerves, want, doubt, excitement; not a calm explanation; never about owning, claiming or guarding ${ctx.userName} as his`;
/**
 * Люди — не собственность: заметки помощника не описывают одного как вещь или территорию другого.
 * Ревность и контроль, если история их показывает, называются прямо, но не хвалятся и не становятся «сутью» пары —
 * иначе одна и та же фраза в каждой заметке делает из персонажа собственника в каждом ответе.
 */
export const RESPECT = 'Never describe one person as the other\'s property or territory: no "claims her", "his woman", "mine", "his rights to her", "marks his territory", "alpha", "male", "prey", "predator", "instinct", "owner". If the story shows jealousy or control, name it plainly (jealous, controlling, overbearing) — never praised, romanticised or used as the summary of the relationship.';
/** Подпись или мысль в духе «он заявил права на неё», «моя», «альфа», «добыча» — отбрасываем */
export const OWNING = /(прав[аоы]?\s+на\s|заявл\S*\s+прав|застолб|собственни|собственност|присвои|принадлежит\s+(ему|ей|мне)|моя\s+(женщина|девочка|девушка)|(^|[^а-яё])моя([.!…]|$)|только\s+моя|никому\s+(её|ее|его)?\s*не\s+отда|альфа|самец|самк[аи]|добыч|хищни|метит\S*\s+территори|свою\s+территори|инстинкт|my woman|(^|\W)mine(\W|$)|claim\S*\s+(her|him)|possessiv|(^|\W)alpha(\W|$)|predator|(^|\W)prey(\W|$)|territor)/i;
export const owning = (t) => OWNING.test(String(t || ''));
/** Мероприятие (чужой день рождения, собрание, повод из истории) — не праздник календаря: своё расписание, на него можно не прийти */
export const isGathering = (h) => !!(h && (h.npc || h.extra || h.story));

// Кому по обычаю дарят на этом празднике: виновнику торжества (из подготовки), иначе {{user}}
export function giftTarget(state, h, userName, charName) {
    if (!h) return userName;
    if (h.npc) return h.name;
    if (h.birthday) return h.who === 'user' ? userName : charName;
    return state.giftTo?.[h.id] || userName;
}
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Подарок персонажа уместен, если праздник с подарками и дарят не самому персонажу
function charGiftActive(ctx) {
    const { state, phase } = ctx;
    const h = phase.h;
    if (!h || (phase.kind !== 'prep' && phase.kind !== 'today')) return false;
    if (!hasGifts(state, h) || sameName(giftTarget(state, h, ctx.userName, ctx.charName), ctx.charName)) return false;
    if (state.care?.[h.id] === 'low' && !(h.birthday && h.who === 'user')) return false;
    return !charGiftOf(state, h.id)?.done;
}

// ═══ Подготовка по истории ═══
// Инфоблок не придумывает подготовку: инджект подталкивает мир (BEAT), основная модель показывает это в ролплее,
// помощник читает историю и записывает сделанное (HT-READY), и только потом оно появляется в инфоблоке.
const daysWord = (d) => (d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`);
/** Что уже сделано к празднику (по истории): сводка старого + последние пункты */
export function readyNoted(state, h, n = 3) {
    const r = state.ready?.[h.id];
    return [r?.sum, ...(r?.log || []).slice(-n).map(x => (x.who ? `${x.who}: ${x.t}` : x.t))].filter(Boolean);
}
/** Подарки, уже известные из истории, — коротко */
function giftsNoted(ctx, h) {
    const { state, userName, charName } = ctx;
    const st = (g) => (g.done ? 'given' : g.got ? 'got' : 'idea');
    const out = [];
    const cg = charGiftOf(state, h.id);
    if (cg?.text) out.push(`${giftJoint(state, h) ? `${charName} and ${userName}` : charName}: ${cg.text} (${st(cg)})`);
    const ug = h.npc && !giftJoint(state, h) ? state.userGift?.[h.id] : null;
    if (ug?.text) out.push(`${userName}: ${ug.text} (${ug.done ? 'given' : ug.got ? 'got' : 'idea'})`);
    for (const [who, g] of Object.entries(state.ready?.[h.id]?.gifts || {})) out.push(`${who}: ${g.text} (${g.stage})`);
    return out.join('; ');
}
/** Нумерованный список готовящихся праздников — номера в HT-READY */
function readyList(ctx) {
    const { state } = ctx;
    return (ctx.tracked || []).map((h, i) => {
        const d = h.start - state.today;
        const noted = d > 0 ? readyNoted(state, h, 4) : [];
        const g = giftsNoted(ctx, h);
        const kind = h.npc || h.extra ? ', invitation accepted' : h.story ? ', set up in the story' : '';
        return `${i + 1}. ${hName(h, ctx)} — ${d <= 0 ? 'going on today' : `${daysWord(d)} (${isoOf(h.start)})`}${kind}${noted.length ? `; already noted: ${noted.join('; ')}` : ''}${g ? `; gifts noted: ${g}` : ''}`;
    }).join('\n');
}
const READY_FORMAT = (sum) => `<!-- HT-READY
DONE | <№> | <who> | <what they did to get ready>
GIFT | <№> | <char, user, both or a name> | <the gift> | <idea, got or given>
OFF | <№> | <cancelled, moved or missed> | <new date YYYY-MM-DD if moved> | <why>${sum ? '\nSUM | <№> | <everything done for it so far>' : ''}
-->`;
function readyRule(ctx) {
    const { state, userName, charName } = ctx;
    const long = (ctx.tracked || []).map((h, i) => ((state.ready?.[h.id]?.log || []).length > 6 ? i + 1 : null)).filter(Boolean);
    return `${READY_FORMAT(long.length)}
Occasions:
${readyList(ctx)}
Fill in the lines; never copy the <…> placeholders. Only what the messages marked [NEW] actually show — nothing invented, predicted or already noted.
- DONE — only for an occasion that hasn't begun: a step of getting ready for it (bought, cooked, decorated, dressed up, invited guests, booked). 2–6 words, past tense, no retelling. Not what happens at the occasion itself, not plot scenes, talks or business that aren't getting ready for it; what was done for something else is left out, never filed under another number. WHO — a name, empty if unknown.
- GIFT: someone settles on, gets or hands over a gift for it — ${userName}'s own too, as ${userName} wrote it; the gift itself in a few words.
- OFF: only if the story clearly called it off, moved it to another day, or (missed) shows ${charName} and ${userName} won't come to it, left without going or skipped it.${long.length ? `\n- SUM for ${long.map(n => `№${n}`).join(', ')}: all that is noted for it, one short sentence.` : ''}
Leave the block out if there is nothing new. In ${langOf(ctx)}.`;
}
/** Подарок {{user}} имениннику: что вписал игрок или что {{user}} сам сказал в истории */
const userGiftOf = (state, h) => (h?.npc && !giftJoint(state, h) ? state.userGift?.[h.id] || null : null);

// ─── 1. Состояние календаря (поглубже в контексте) ───
/** В этом ответе уже есть главная просьба (позвать, ивент, свидание) — второстепенные подталкивания не добавляем */
const busyReply = (state) => !!(state.invRoll || state.dateRoll || state.evRoll || state.date?.status === 'active' || (state.skipAsk || []).length);

export function buildStatePrompt(ctx) {
    const { state, phase, userName, charName } = ctx;
    const busy = busyReply(state);
    const s = state.setting || {};
    const lines = ['[Hearthtide — the world\'s calendar and festive life; background for the story, not its topic]'];
    const where = [s.era && `Setting: ${s.era}`, s.faith && !noFaith(state) && `faith: ${s.faith}`, (state.place || s.place) && `place: ${state.place || s.place}`, state.when && `date: ${state.when}`].filter(Boolean);
    if (where.length) lines.push(where.join(' · ') + '.');

    const h = phase.h;
    const active = (phase.kind === 'prep' || phase.kind === 'today') && h;
    const aheadAccepted = h && (ctx.acceptedAhead || []).some(x => x.id === h.id);
    if (phase.kind === 'far' && h && !preparingNow(state, h) && !aheadAccepted) {
        lines.push(`Next: ${hName(h, ctx)} in ${phase.daysTo} days${h.meaning ? ` (${h.meaning})` : ''}. Not relevant yet — don't bring it up.`);
    }
    // другие праздники, к которым уже готовятся (принятое приглашение, повод из истории) — по строке, чтобы ни один не терялся
    // сегодня идёт ещё что-то, кроме главного, — одной строкой, в фоне
    const todayOther = phase.kind === 'today' ? activeOccasions(state).filter(x => x.id !== h?.id) : [];
    if (todayOther.length) lines.push(`Also today: ${todayOther.map(x => `${hName(x, ctx)}${x.days > 1 ? ` (day ${state.today - x.start + 1} of ${x.days})` : ''}`).join('; ')} — in the background of the main occasion.`);
    // другие праздники, к которым уже правда готовятся (окно подготовки или история уже готовится) — по строке
    for (const x of (ctx.tracked || []).filter(x => x.id !== (active ? h?.id : null) && preparingNow(state, x)).slice(0, 2)) {
        const noted = readyNoted(state, x, 2);
        const cg = charGiftOf(state, x.id);
        lines.push(`Also coming: ${hName(x, ctx)} — ${daysWord(x.start - state.today)}, on ${isoOf(x.start)}${x.npc || x.extra ? ' (invitation accepted)' : ''}${noted.length ? `; done so far: ${noted.join('; ')}` : ''}${cg?.text ? `; ${charName}'s gift: ${cg.text}${cg.done ? ' (given)' : ''}` : ''}. Background knowledge: it is settled, the day itself hasn't come — no need to bring it up unless the scene leads there.`);
    }
    // без помощника: изредка (чем ближе, тем чаще) — пусть подготовка к принятому покажется в мире сама
    if (phase.kind !== 'prep' && phase.kind !== 'today' && !state.beat && state.mentionNow && (ctx.tracked || []).length) {
        lines.push('This reply: let one of the coming occasions show once, in passing — someone of this world getting ready for it or speaking of it, a step not taken yet; never force it.');
    }
    // история отменила или перенесла праздник — модель знает, что его больше нет (пара ответов)
    const off = state.offNote && (state.turn || 0) - state.offNote.turn <= 2 ? state.offNote : null;
    if (off) lines.push(off.how === 'moved'
        ? `${off.name} was moved to ${isoOf(off.to)}${off.why ? ` (${off.why})` : ''} — it happens then, not sooner.`
        : off.how === 'missed'
        ? `${charName} and ${userName} didn't go to ${off.name}${off.why ? ` (${off.why})` : ''} — it went on without them; leave it behind.`
        : `${off.name} was called off in the story${off.why ? ` (${off.why})` : ''} — it no longer happens; those involved take it in their own way, no preparations for it any more.`);
    if (phase.kind === 'prep' && h) {
        // срок — словами и датой: иначе модель говорит «завтра» о празднике через пять дней
        const when = phase.daysTo === 1 ? 'tomorrow' : phase.daysTo === 2 ? 'the day after tomorrow' : `in ${phase.daysTo} days, not sooner`;
        lines.push(`Coming: ${hName(h, ctx)} — ${when} (on ${isoOf(h.start)}; today is ${isoOf(state.today)})${h.meaning ? ` (${h.meaning})` : ''}. Whoever mentions it keeps the timing right.`);
        const p = state.prep && state.prep.hid === h.id ? state.prep : null;
        const noted = readyNoted(state, h);
        const bits = [noted.length && `done so far: ${noted.join('; ')}`, p?.mood && `mood: ${p.mood}`].filter(Boolean);
        if (bits.length) lines.push(`Preparations — ${bits.join(' · ')}. Never redo or retell it.`);
        if (h.extra || h.story) lines.push(`It is ${h.extra ? 'a gathering' : 'an occasion from the story'}${h.host ? ` held by ${h.host}` : ''}${h.meaning ? ` (${h.meaning})` : ''}; ${userName} has already agreed to come — it is settled: nobody invites again, asks whether they're coming or keeps reminding of it. The hosts get ready on their side; for the invited it is a plain plan, at most a word about it when the scene touches it.`);
        if (h.npc) {
            const about = npcAbout(ctx, h);
            lines.push(`It is ${h.name}'s own occasion${about ? ` (${about})` : ''}, kept by ${h.name}'s household and close circle — a small family affair, not the whole place's; ${npcExpect(ctx, h)}.`);
        }
        if (h.birthday && h.who === 'user') {
            lines.push(`People close to ${userName} are secretly preparing a surprise — keep it hidden from ${userName}; hints at most.`);
        }
        if (!state.beat) lines.push(state.mentionNow
            ? 'This reply: let the preparations show once, indirectly — as a consequence of them or a brief encounter with someone involved, never a restatement. Pick an angle not used before; never force it.'
            : 'This reply: keep the preparations in the background — don\'t mention them unless the scene itself does.');
    }
    if (phase.kind === 'today' && h) {
        const plan = state.days?.[`${h.id}#${phase.dayIndex}`];
        const part = ctx.part;
        const dayInfo = h.days > 1 ? `, day ${phase.dayIndex} of ${h.days}` : '';
        lines.push(`TODAY: ${hName(h, ctx)}${dayInfo}${plan?.title ? ` — ${plan.title}` : ''}.`);
        if (plan && part && plan[part]) lines.push(`Now (${PART_EN[part]}): ${plan[part]}`);
        else if (h.meaning) lines.push(`Traditions: ${h.meaning}`);
        if (h.extra || h.story) {
            lines.push(`It is ${h.extra ? 'a gathering' : 'an occasion from the story'}${h.host ? `, held by ${h.host}` : ''}, kept on its own schedule${plan?.where ? ` (${plan.where})` : ''}; ${userName} accepted, so ${whomOf(ctx, h.whom || 'both')} ${(h.whom || 'both') === 'both' ? 'are' : 'is'} expected. When its time comes and the scene allows, they head there; until then it stays in the background — no reminders in every reply. The story's own events come first, and if they can't come, it goes on without them. Follow its order — don't jump ahead.`);
        } else if (h.npc) {
            // чужой день рождения — свой распорядок у именинника; {{char}} и {{user}} — гости, а не хозяева дня
            const about = npcAbout(ctx, h);
            lines.push(`It is ${h.name}'s day${about ? ` (${about})` : ''}: a small household occasion, kept by ${h.name} and their close ones on their own schedule${plan?.where ? ` (${plan.where})` : ''}; ${npcExpect(ctx, h)}. When its time comes and the scene allows, the day draws ${charName} and ${userName} in — once: someone sent for them, time to set off with a gift; no reminders in every reply; the story's own events come first, and if they can't come, it goes on without them. Follow the day's order — don't jump ahead.`);
        } else lines.push(`The holiday keeps its own course: people follow today's plan as custom expects — and carry on without ${userName} if need be. The story's own events come first and may move or shorten a part, not cancel the day. Follow the day's order — don't jump ahead.`);
        if (h.birthday && h.who === 'user') lines.push(`It is ${userName}'s birthday: the prepared surprise comes out today.`);
    }
    if (phase.kind === 'after' && phase.ended) {
        lines.push(`Yesterday ${hName(phase.ended, ctx)} ended: tiredness, leftovers, talk of how it went.`);
        if (h) lines.push(`Next: ${hName(h, ctx)} in ${phase.daysTo} days.`);
    }

    if (active) {
        lines.push(settingTone(ctx));
        // Персонаж: насколько праздник для него важен
        const care = state.care?.[h.id];
        const steps = (state.charLog?.[h.id] || []).slice(-3).map(x => x.text);
        // прошлые мысли {{char}} — только помощнику (чтобы не повторялся); основная модель озвучивала их дословно
        const trail = ctx.side && steps.length ? ` Earlier thoughts (don't repeat): ${steps.join(' / ')}.` : '';
        if (care === 'high') lines.push(`${charName} cares about this a lot.${trail} ${charName} acts on it in small steps across replies when the scene allows.`);
        else if (care === 'normal') lines.push(`For ${charName} it matters moderately.${trail}`);
        else if (care === 'low') lines.push(`For ${charName} it means little — a passing remark at most.`);
        // Подарок персонажа
        if (charGiftActive(ctx)) {
            const cg = charGiftOf(state, h.id);
            const g = cg?.text || null;
            const near = !busy && (phase.kind === 'today' || phase.daysTo <= 2);
            const joint = giftJoint(state, h);
            lines.push(joint
                ? `${charName} and ${userName} give ${h.name} one gift together: ${g || 'not decided yet'} — ${charName} moves ${charName}'s share in small steps when the scene allows (an idea, asking ${userName}'s view, finding or making it); ${userName}'s say and share are ${userName}'s own.${near && !cg?.done ? ` Time is short: ${g ? 'the next step' : `${charName} brings up what to give`} in this reply if the scene allows.` : ''}`
                : `${charName}'s gift for ${giftTarget(state, h, userName, charName)}: ${g || 'not decided yet'} — it moves forward in small steps when the scene allows, never all at once.${near && !cg?.done ? ` Time is short: ${g ? 'the next step' : `${charName} settles on it`} in this reply if the scene allows.` : ''}`);
        }
        // свой подарок {{user}} — выбор игрока: модель его не двигает, только видит
        const ug = userGiftOf(state, h);
        if (ug?.text) lines.push(`${userName}'s own gift for ${h.name}: ${ug.text}${ug.done ? ' — already given' : ''} (${userName}'s choice; never move it on ${userName}'s behalf — when ${userName} gives it, ${h.name} and those around react).`);
        // Кто уже отличился — помним до конца праздника
        const hl = (state.highlights?.[h.id] || []).slice(-3);
        if (hl.length) lines.push(`So far: ${hl.map(x => `${x.name} — ${x.text}`).join(' · ')}.`);
        // Люди: по одной строке на человека
        const people = (ctx.peopleSeen || state.people || []).filter(p => p.now).slice(0, 3);
        if (people.length) {
            lines.push(`People: ${people.map(p => `${p.name} (${p.group}) — wants: ${p.now}${p.gift ? `; gift: ${p.gift}` : ''}`).join(' · ')}. They live their own lives.`);
        }
    }

    // игрок только что отказался — без нажима
    const evNo = ctx.evTarget ? (state.evts || []).find(e => e.hid === ctx.evTarget.hid && e.status === 'declined' && e.lastUpdate >= state.turn) : null;
    if (evNo) lines.push(`${userName} let "${evNo.title}" pass — it goes on without ${userName} or fades; don't push it.`);
    if (state.dateDeclined?.turn >= state.turn) lines.push(`${userName} said no to the date (${state.dateDeclined.title}) — ${charName} takes it in ${charName}'s own way.`);

    // {{char}} и {{user}}: как они сейчас
    // подпись пары — только пока свежая: одна и та же фраза в каждом ответе превращается в одно и то же поведение
    const pn = state.pair?.note && !owning(state.pair.note) && (ctx.side || (state.turn || 0) - (state.pair.noteTurn ?? -99) <= 2) ? ` — lately: ${state.pair.note}` : '';
    if (state.pair) lines.push(state.pair.kin
        ? `${charName} and ${userName} are family to each other: closeness ${state.pair.f} (−100…100, 0 neutral)${pn}; no romance between them.`
        : `${charName} and ${userName}: friendship ${state.pair.f}, romance ${state.pair.r} (both −100…100, 0 neutral)${pn}.`);
    // Свидание: намечено (понимание, что скоро; напомнить, только если {{char}} о нём забыл) или идёт (шаги {{char}} и общие)
    lines.push(...dateStateLines(ctx));

    // Люди истории, которые сейчас рядом: кто кому кем приходится и как ладят (0 — вражда, 100 — близки)
    if (ctx.castSeen?.length) {
        // коротко: кем приходится и как ладят словами (числа модели не нужны — по ним она не пишет)
        const REL = { enmity: 'enmity', conflict: 'in conflict', cool: 'cool', neutral: 'even', warm: 'warm', close: 'close' };
        const how = (c, k) => c.note?.[k] || REL[relLevel(c.rel?.[k] ?? 0)];
        lines.push(`Who is who (it shows in how they speak and act): ${ctx.castSeen.map(c => {
            const ties = [c.toU && `to ${userName}: ${c.toU}`, c.toC && `to ${charName}: ${c.toC}`].filter(Boolean).join('; ');
            const rom = [c.rom?.user && `romance with ${userName}: ${c.rom.user}`, c.rom?.char && `romance with ${charName}: ${c.rom.char}`].filter(Boolean).join('; ');
            return `${c.name || c.toU || c.toC}${ties ? ` (${ties})` : ''} — with ${userName}: ${how(c, 'user')}; with ${charName}: ${how(c, 'char')}${rom ? `; ${rom}` : ''}`;
        }).join(' · ')}.`);
    }
    // Приглашения: на дни рождения людей истории и дополнительные праздники
    lines.push(...inviteLines(ctx));

    // Воспоминание по кнопке «вспомнить» — один раз
    const fb = state.recall && (state.flashbacks || []).find(f => f.id === state.recall);
    if (fb) lines.push(`${charName} suddenly remembers: ${fb.title} — ${fb.text} Let it surface naturally in this reply.`);
    // Что сейчас в игре: ивент, приглашение или мероприятие
    const ev = ctx.evTarget ? openEvent(state, ctx.evTarget.hid) : null;
    if (ev) {
        const who = ev.who ? ` (${ev.who})` : '';
        if (ev.status === 'invited') lines.push(`Invitation pending: ${ev.title}${who}. ${userName} decides whether to go.`);
        else if (ev.kind === 'party' && !ev.moments?.length) lines.push(`${userName} accepted the invitation: ${ev.title}${who}. It is settled — it happens when the scene gets there; don't invite or remind again.`);
        else if (ev.kind === 'party') lines.push(`At the gathering: ${ev.title}${who}${ev.moments?.length ? `; so far: ${ev.moments.slice(-2).map(m => m.title).join('; ')}` : ''}. It unfolds around the scene.`);
        else lines.push(`${userName} joins: ${ev.title}${who}${ev.hook ? ` (it began: ${ev.hook})` : ''}. ${ev.turn >= state.turn - 1 ? 'Carry on from where it began' : 'Let it unfold'} over the next replies; ${userName} still makes every own choice.`);
    }
    // Кто может зайти в этот ответ — по очереди из людей праздника (дёшево, без отдельного запроса)
    if (!busy && !state.beat && state.nudge) {
        lines.push(state.nudge.name
            ? `If the scene allows, ${state.nudge.name} can come into this reply, acting on what they want (${state.nudge.now})${phase.kind === 'today' ? ` or drawing ${userName} into what the day holds now` : ''} — in person or by word; one person, never a crowd.`
            : `If the scene allows, someone the occasion involves — kin or those its custom calls for — can come into this reply; one person, never a crowd.`);
    }
    // Что праздник может принести в этот ответ — придумал отдельный запрос по истории
    if (!busy && state.beat) lines.push(`This reply, only if it fits the scene naturally (skip it otherwise — the scene always comes first): ${state.beat}`);
    if (active) {
        lines.push(`If ${userName} is away from people (road, wilds, danger), the feast stays distant. The calendar never overrides the scene: an urgent or dramatic moment always comes first. Never write ${userName}'s thoughts, feelings, words or choices.`);
    }
    return lines.join('\n');
}

// ─── Пасха на нужный год: считает расширение, ИИ только выбирает, подходит ли она миру ───
function easterHint(ctx) {
    if (ctx.state.today == null || noFaith(ctx.state)) return '';
    const { y, m } = fromDayNum(ctx.state.today);
    if (y < 33 || y > 2300) return '';
    const one = (yy) => {
        const j = easterJulian(yy);
        if (yy < 1583) return `${yy}: ${yy}-${j.julian} (Julian calendar)`;
        const w = isoOf(easterGregorian(yy)), o = isoOf(j.day);
        return w === o ? `${yy}: ${w}, Western and Orthodox alike` : `${yy}: Western ${w}, Orthodox ${o} (Julian ${j.julian})`;
    };
    const years = m >= 10 ? [y, y + 1] : [y];
    return ` If Christian feasts belong here — Easter ${years.map(one).join('; ')}; movable feasts count from it.`;
}

/** Модель сказала, что живут без веры — церковных праздников и Пасхи не предлагаем */
const noFaith = (state) => /(none|no faith|not stated|unknown|unstated|secular|atheis|non-?religious|нет\b|нету|без веры|не указ|не упомин|неизвест|светск|атеи|неверу|нерелиги)/i.test(String(state.setting?.faith || ''));

/** Как определить веру: в наши дни — только веру самих персонажей; в истории и других мирах — веру того времени и места */
function faithRule(ctx) {
    const lang = langOf(ctx);
    const modern = `if the story is in our real world today: the faith these characters themselves live by, only if the card, persona, lore or story says so — otherwise write "not stated" (in ${lang}); never assume one from the country`;
    const past = `in history or another world: the faith(s) people of that time and place live by, as the setting has them`;
    if (ctx.eraMode === 'modern') return modern.replace(/^if the story is in our real world today: /, '');
    if (ctx.eraMode === 'ancient') return past.replace(/^in history or another world: /, '');
    return `${modern}; ${past}`;
}

// ─── Какие праздники брать: зависит от эпохи (настройка чата) и веры (её определяет модель по началу чата) ───
function holidayGuide(ctx) {
    const past = `The setting decides the calendar: card, world info and lore first, history second. Weigh faiths as the setting does — old gods, spirits or magic get their nights and rites on par with church feasts; include folk, seasonal and local customs.`;
    // вера — персонажей, а не страны: «в России все православные» не повод для церковного календаря
    const faith = noFaith(ctx.state)
        ? `Religious feasts: none of the church calendar — only the one or two the whole country marks as public days off.`
        : `Religious feasts: only if the card, persona, lore or story shows THESE characters living by a faith — then only the biggest feasts of that faith (e.g. Orthodox Christmas on Jan 7, Easter on its correct date that year). The country's majority faith alone is not a reason. Never minor church feasts (saints' days, feasts of the Virgin and the like).`;
    const modern = `MODERN SETTING: only what most people in this country actually celebrate today — major public holidays and days off, big festive days everyone knows. Skip minor official days, professional days, awareness and memorial days, and niche imported holidays, unless one matters to these characters personally. For Russia, for example: New Year (Dec 31, into the night of Jan 1), Defender of the Fatherland Day (Feb 23), International Women's Day (Mar 8), Spring and Labour Day (May 1), Victory Day (May 9), Russia Day (Jun 12), National Unity Day (Nov 4); also widely kept: Valentine's Day, Maslenitsa, Knowledge Day (Sep 1). ${faith} Take the character card and lore into account. Days off in a row (like the New Year holidays of Jan 1–8 or the May days) are not an occasion of their own: list only the holiday itself (New Year on Dec 31, 2 days, covering the night), never the break.`;
    if (ctx.eraMode === 'modern') return modern;
    if (ctx.eraMode === 'ancient') return past;
    // эпоха ещё не определена — модель решает сама, и для наших дней действуют правила современности
    return `First decide where the story is set. If it is our real world today: ${modern} Otherwise (history, fantasy, other worlds): ${past}`;
}

// Список людей — общий текст для подготовки и обновлений
function peopleRules(ctx) {
    const { userName, charName } = ctx;
    const h = ctx.phase?.h;
    const who = h?.npc
        ? `up to 5 people at ${h.name}'s birthday (not ${charName}, not ${userName}) — ${h.name} first, it is their day, then their household and guests.`
        : `up to 8 people taking part in this holiday (not ${charName}, not ${userName}), kin first.`;
    return `HT-PEOPLE replaces the previous list. P lines: ${who} ONLY people who have actually appeared in the story messages above — never someone the story hasn't shown yet. Each person once, under the name the story uses for them (never the same person twice under a name and a role). GROUP: relative = kin of ${userName} or of ${charName}, by blood or marriage (parents, siblings, in-laws); friend; acquaintance — judge by the card, persona and story. WANT: what this person wants or plans FOR THE HOLIDAY ITSELF — a gift they mean to give, a dish, a rite, someone they wait for, a wish for the day — as a plan or wish, a few words, the way people speak in this era and setting; never what they are doing right now, never their mood, quarrels or matters that have nothing to do with the holiday; it must not contradict what the story has shown of them. Each person different. GIFT: their gift while still pending, else empty. No surprise meant for ${userName} spoiled, no one who has left. D lines: people whose part is done (gave their gift, did their bit) — what they did; they leave the P list. Skip the block if nobody qualifies.`;
}
const PEOPLE_BLOCK = '<!-- HT-PEOPLE\nP | NAME | GROUP | WANT | GIFT\nD | NAME | WHAT_THEY_DID\n-->';

// ═══ Правила крупных блоков — общие для инджекта и отдельного запроса ═══

// Люди истории: каждого — один раз; потом только изменения отношений
function castRule(ctx) {
    const { state, userName, charName } = ctx;
    const known = (state.cast || []).map(c => c.name || `? (${[c.toU, c.toC].filter(Boolean).join(' / ')})`);
    const no = state.castNo || [];
    const hint = (ctx.castHint || []).map(x => `${x.name} (${x.n})`);
    const bare = (state.cast || []).filter(c => c.name && !c.toU && !c.toC && !c.edited).map(c => c.name);
    return `<!-- HT-CAST
C | <name or ?> | <group> | <to user> | <to char> | <birthday> | <with user> | <with char> | <how with user> | <how with char>
R | <name> | <with user> | <with char> | <how with user> | <how with char>
-->
Fill in the fields; never copy the <…> placeholders or field names into them.
C: people of the story not in the list yet (not ${userName}, not ${charName}), once each. NAME: the person's own name only — never a role as a name; if the story hasn't named them yet, write ? — but add such an unnamed person only if they are close kin or have actually appeared in the story. GROUP: kin_user (${userName}'s own blood family) | kin_char (${charName}'s own blood family) | kin_both (family to both: their shared children or grandchildren, or a child of one whom the other raises or treats as their own — TO_USER and TO_CHAR then say who they are to each) | friend | acquaintance | other. TO_USER / TO_CHAR: who they are to ${userName} and to ${charName}, a word or two each, in ${langOf(ctx)}; leave it empty if there is no tie — never "nobody". Work out kinship from the card, persona, lore and story — never guess what they don't support. BIRTHDAY: DD.MM or DD.MM.YYYY only if stated, else empty. WITH_USER / WITH_CHAR: how they get on, −100 (enmity) … 0 (neutral) … 100 (very close). HOW_USER / HOW_CHAR: how they are with each, 2–4 words of your own, specific to these two people — not a generic label, in ${langOf(ctx)}.
R: only someone whose relations clearly changed in the latest messages — the new numbers and words.${ctx.census ? `
Census: go through the card, persona, world info and the whole story above and list everyone who matters and isn't listed yet, up to 10 C lines — kin of both sides first, then those the story names most often.` : ''}
${bare.length ? `Listed without roles yet: ${bare.join(', ')} — send C lines for them too, with what the story shows.\n` : ''}Leave the block out if there is nothing.${hint.length ? ` Often named in the story: ${hint.join(', ')} — add those who are people.` : ''}${known.length ? ` Already listed: ${known.join(', ')}.` : ''}${no.length ? ` Never add: ${no.join(', ')}.` : ''}`;
}

// ═══ Свидания ═══
/** Что узнали друг о друге и сколько длится свидание — словами для модели */
/** Что они знают друг о друге (за все свидания). full — всё (помощнику), иначе коротко (основной модели) */
function dateKnown(ctx, d, full = false) {
    const pk = ctx.state.pairKnown || {};
    const all = (who) => [...new Set([...(pk[who] || []), ...(d?.learned?.[who] || [])])].slice(full ? -30 : -6);
    const lc = all('char'), lu = all('user');
    return [lc.length && `${ctx.charName} knows about ${ctx.userName}: ${lc.join('; ')}`, lu.length && `${ctx.userName} knows about ${ctx.charName}: ${lu.join('; ')}`].filter(Boolean).join('. ');
}
/** Прошлые свидания — коротко: название и итог */
function pastDates(state, n, len) {
    return (state.datesDone || []).filter(x => x.id !== state.date?.id).slice(-n).map(x => {
        const r = (state.recaps || []).find(y => y.hid === x.id)?.text || '';
        return `${x.title}${r ? ` — ${r.length > len ? `${r.slice(0, len).replace(/\s+\S*$/, '')}…` : r}` : ''}`;
    });
}
function dateLasts(state, d) {
    const a = d?.startAt;
    if (!a || a.day == null || state.today == null) return '';
    const h = (state.today - a.day) * 24 + (state.clock ?? 12) - (a.clock ?? 12);
    if (h < 0) return '';
    const m = Math.round(h * 60);
    return m < 60 ? `${Math.max(1, m)} min` : h < 24 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}

/** Темп романтики словами — для модели */
// Свидание или дружеская встреча: романтика ниже 0 — только встреча, ровно 0 — как сложится, выше — свидание
const isOuting = (ctx, d) => (d ? d.kind === 'friendly' : (ctx.state.pair?.r ?? 0) < 0);
const OUTING = 'a friendly outing — time together to get to know each other better, not a romantic date';
const kindField = (ctx) => {
    const r = ctx.state.pair?.r ?? 0;
    return r < 0 ? ` kind: outing — ${OUTING}.` : r < 20 ? ` kind: outing (${OUTING}) — or date only if the story itself shows it as romantic (they call it a date, flirt, confess).` : ' kind: date.';
};
const paceText = (ctx, d) => ({
    slow: `slow-burn: small, careful steps — words, glances, light touches; closeness is earned slowly`,
    fast: `fast-burn: bolder, quicker steps toward closeness`,
}[d?.pace] || `an even pace: closeness grows step by step, as the story allows`);
/** Чем должны быть шаги: заметные шаги к цели, разные по виду, каждый вырастает из предыдущего */
const stepFlow = (ctx, d) => (isOuting(ctx, d)
    ? `This is ${OUTING}. Steps are beats toward the goal of getting to know each other and getting on: asking, telling about oneself, doing something together, a joke, a small care or kindness — each a different kind, never two open steps of the same kind, never the same act in other words; no romantic gestures unless the story itself turns that way. Build ONLY on what the story has already shown: never on something about ${ctx.userName} the story hasn't revealed yet — first find it out, then the next step may build on the answer. A new step grows out of what was just done or learned.`
    : `Steps are beats toward the goal, not tiny gestures: each is a different kind of closeness — physical or spoken, mixed as the goal needs; never two open steps of the same kind, never the same act in other words. They go from general to particular and from gentle to bolder: early on — getting to know each other, light and easy; closer and bolder only as the story gets there. Build ONLY on what the story has already shown: never on something about ${ctx.userName} the story hasn't revealed yet (what ${ctx.userName} does, likes, feels or has lived through) — first find it out, then the next step may build on the answer. A new step grows out of what was just done or learned. Pace: ${paceText(ctx, d)}.`);
/** Как писать шаг свидания: задача для {{char}}, одна форма — глагол в неопределённой форме + что / кому */
const stepForm = (ctx) => `Each step is a short, general task for ${ctx.charName}, like a to-do item: ${ctx.lang === 'Russian' ? 'an infinitive verb first' : 'a bare verb first'}, 2–5 words, no names unless needed, no details of how (the props, the exact movement, the words — ${ctx.charName} decides that in the story); never narration — no past, present or future tense, no "${ctx.charName} will…". Only ${ctx.charName}'s own actions — never a step for ${ctx.userName} or for both: what ${ctx.userName} does is the player's choice. The third field of a NEW line: ${ctx.charName}'s inner reaction to that step — ${LIVE_VOICE(ctx)}; under 10 words.`;
/** Когда назначено — словами для модели */
export function dateAtText(state, at) {
    if (!at) return 'soon';
    if (at.now) return 'right now';
    const day = at.day ?? state.today;
    const d = state.today != null && day != null ? day - state.today : null;
    const hh = at.clock != null ? `${String(Math.floor(at.clock)).padStart(2, '0')}:${String(Math.round((at.clock % 1) * 60)).padStart(2, '0')}` : '';
    const dayTxt = d == null ? isoOf(day) : d === 0 ? 'today' : d === 1 ? 'tomorrow' : d < 0 ? 'earlier' : `in ${d} days (${isoOf(day)})`;
    return `${dayTxt}${hh ? ` at ${hh}` : ''}`;
}
function dateStateLines(ctx) {
    const { state, userName, charName } = ctx;
    const d = state.date;
    const out = [];
    if (state.dateMissed?.turn >= state.turn) out.push(`The planned date (${state.dateMissed.title}) never happened — ${charName} notices it in ${charName}'s own way.`);
    // свидание только что кончилось — его исход окрашивает следующие ответы
    const last = (state.datesDone || []).slice(-1)[0];
    if (last && d?.status === 'ended' && d.id === last.id && state.turn - (d.endTurn ?? -99) <= 3) {
        const feel = { great: `it went wonderfully — ${charName} is warm, bold and light, closer than before`, good: `it went well — ${charName} is pleased and a little closer`, awkward: `it was awkward — ${charName} is unsure, replays moments, wants to make it right`, bad: `it went badly — ${charName} is stung or withdrawn, careful with ${userName}`, terrible: `it went terribly — ${charName} is hurt, cold or ashamed; the distance shows` }[last.result] || '';
        // ни шага, ни срыва — свидание проскочили (таймскип): итог по нему не окрашивает ответы
        const blank = !(d.steps || []).some(x => x.state === 'done' || x.state === 'failed') && !(d.log || []).some(x => ['misstep', 'moment', 'gift'].includes(x.kind));
        out.push(blank
            ? `The date (${last.title}) is over.${d.recap ? ` ${d.recap}` : ''}`
            : `The date (${last.title}) has just ended: ${feel}.${d.recap ? ` ${d.recap}` : ''} Let it color how ${charName} speaks and acts in the next replies.`);
    }
    if (!d) return out;
    if (d.status === 'scheduled') {
        const left = dateHoursLeft(state);
        if (left == null || left > 30) return out;
        out.push(`Planned: ${charName} and ${userName} have ${isOuting(ctx, d) ? 'an outing' : 'a date'} — ${d.title}${d.where ? `, ${d.where}` : ''}, ${dateAtText(state, d.at)}${d.goal ? `; it is meant to ${d.goal}` : ''}. ${charName} keeps it in mind — background knowledge, not something to bring up in every reply; if the story brings it on earlier, it begins then.`);
        // помним — не подталкиваем; забыл, а срок близко — напомнить один раз (решает index.js: state.dateRemind)
        if (state.dateRemind === d.id) out.push(`It is close and ${charName} hasn't given it a thought lately — this reply, ${charName} remembers it once, in passing.`);
        return out;
    }
    if (d.status !== 'active') return out;
    const open = openSteps(d);
    const both = [];
    const goal = d.goal ? ` Its goal: ${d.goal}${d.goalDone ? ' — reached.' : goalOpen(d, ctx.dateLevel) ? ` — UNLOCKED: they have grown close enough. In this reply or the next, ${charName} takes the lead and moves to it — acts on it as fits the story, their pace and how they stand; ${userName} answers.` : ' — not yet; first more closeness.'}` : '';
    // шкала растёт с нуля, поэтому «плохо» — это срывы, а не малый процент в начале
    const fails = (d.steps || []).filter(x => x.state === 'failed').length + (d.log || []).filter(x => x.kind === 'misstep').length, dones = (d.steps || []).filter(x => x.state === 'done').length;
    const how = fails > dones ? (d.score < 10 ? 'badly' : 'poorly') : d.score >= 60 ? 'wonderfully' : d.score >= 30 ? 'well' : fails ? 'unevenly, a little awkward' : 'it is just warming up';
    const gifts = (d.gifts || []).map(g => `${g.from ? `${g.from}: ` : ''}${g.what}`);
    const known = dateKnown(ctx, d), lasts = dateLasts(state, d);
    // что уже было на этом свидании — модели (в инфоблоке этого нет)
    const sofar = (d.log || []).filter(x => ['done', 'moment', 'gift', 'failed', 'misstep'].includes(x.kind) && x.t).slice(-4)
        .map(x => (x.kind === 'misstep' ? `${userName} didn't like it: ${x.t}` : x.t));
    // прошлые свидания — только в начале нового, коротко
    const past = d.startTurn >= state.turn - 2 ? pastDates(state, 2, 110) : [];
    out.push(`${userName} and ${charName} are on ${isOuting(ctx, d) ? `${OUTING} (romance isn't the point; it may come only if the story itself turns that way)` : 'a date'}${lasts ? ` (it has lasted ${lasts} of story time)` : ''}: ${d.title}${d.where ? `, ${d.where}` : ''}.${d.startTurn >= state.turn - 1 ? ' It begins now.' : ''}${gifts.length ? ` Gifts so far: ${gifts.join('; ')}.` : ''}${goal}${open.length ? ` ${charName}'s next steps (tasks ${charName} carries out — gently, one at a time, as the scene allows): ${open.map(s => s.t).join('; ')}.` : ''} So far: ${how}${d.vibe ? ` (${d.vibe})` : ''} — ${charName}'s mood, boldness and warmth follow it.${sofar.length ? ` On this date so far: ${sofar.join('; ')}.` : ''}${past.length ? ` Earlier dates: ${past.join(' · ')}.` : ''}${known ? ` ${known} — they remember it; only this is known, nothing beyond it.` : ''} ${userName} decides everything of ${userName}'s own.`);
    // подходит к концу — закруглить по-человечески, а не оборвать
    if (d.closing != null) out.push(`The date is drawing to its close: let it wind down naturally over this reply or the next — a last moment together, goodbyes, seeing ${userName} home — never cut off mid-scene; if ${userName} keeps it going, it goes on.`);
    else out.push(`The date goes on until the story itself brings it to a close — don't end it on your own.`);
    return out;
}

/** Ход свидания — для отдельного запроса помощника (по [NEW]) и для основной модели без помощника (по этому ответу) */
function dateUpRule(ctx) {
    const { state, userName, charName } = ctx;
    const d = state.date;
    const lang = langOf(ctx);
    const scope = 'in the messages marked [NEW]';
    if (d.status === 'scheduled') {
        return `<!-- HT-DATE-UP\nSTART\nNEW | <task for ${charName}> | <${charName}'s thought>\nMOVE | <YYYY-MM-DD HH:MM>\nCANCEL | <why, a few words>\n-->\nFill in the lines, never copy the <…> placeholders. The date "${d.title}" is planned ${dateAtText(state, d.at)} (today is ${isoOf(state.today)}; goal: ${d.goal || 'to be together'}). Only if it has actually begun ${scope} — they are at the place or already doing what was planned; getting ready, picking up, the road there or waiting is not the date yet: START, then ${DATE_OPEN} NEW first steps toward the goal. ${stepFlow(ctx, d)} ${stepForm(ctx)} Never chores or anything off the date. MOVE — only if ${scope} they agreed on another day or time for it (or the invitation itself named a day or time other than the planned one): the new day and time. CANCEL — only if ${scope} it was plainly called off. Otherwise write nothing.`;
    }
    const open = openSteps(d);
    const list = open.map(s => `${s.n}. ${s.t}`).join('\n');
    const need = DATE_OPEN - open.length;
    const goal = d.goalDone ? 'reached' : goalOpen(d, ctx.dateLevel) ? `UNLOCKED — ${charName} moves to it now; GOAL | yes once the story shows it done` : `locked: ${(d.need?.steps ?? 5)} done steps and ${(d.need?.score ?? 40)}% success needed`;
    const gifts = (d.gifts || []).map(g => `${g.from ? `${g.from}: ` : ''}${g.what}`);
    const time = ctx.dateTime ? `\n${ctx.dateTime}` : '';
    return `<!-- HT-DATE-UP
STATE | <on, ending or over> | <why, a few words>
STEP | <number> | <done, failed, missed or open> | <what came of it>
NEW | <task for ${charName}> | <${charName}'s thought>
MOMENT | <what happened>
GIFT | <who gave> | <the thing given>
MISSTEP | <what ${charName} did or said> | <small or big>
LEARN | <char or user> | <what they found out>
MOOD | <up or down>
VIBE | <how it goes, 2–5 words>
THOUGHT | <${charName}'s thought>
GOAL | yes
-->
Fill in the lines; never copy the <…> placeholders. The date: ${d.title}${d.where ? `, ${d.where}` : ''}; goal: ${d.goal || '—'} (${goal}); success so far ${d.score}%${d.closing != null ? '; it was already drawing to a close' : ''}.${gifts.length ? ` Gifts already counted: ${gifts.join('; ')}.` : ''}${time}
Open steps:
${list || '(none yet)'}

Judge what happens ${scope} — read every [NEW] message to its very end:
- STATE, always: on — they are still on the date; ending — it is winding down (saying goodbye, heading home, about to part); over — it has ended: they parted, went their separate ways, or the story skipped past it. WHY: what in the story shows it. A quarrel, a pause, a change of place or a talk about other things is still on. Never over just because the [NEW] messages are short or quiet.
- One STEP line for EVERY open step above, by its number: done — ${charName} did it, or something close to it in spirit; missed — the moment for it has passed: the scene has moved on and it no longer fits (no note); failed — tried, but met a refusal, coldness or a bad reaction; open — not yet (no note). NOTE for done or failed: what came of it, past tense, one line, real names.
- NEW: ${need > 0 ? `exactly ${need} new step${need > 1 ? 's' : ''}` : 'one for each step you mark done or failed'}, so that ${DATE_OPEN} stay open. ${stepFlow(ctx, d)} After a failed step, one NEW step softens the moment. Never chores, errands or anything off the date. ${stepForm(ctx)} Never (user), (char) or {{…}}.${(d.rejected || []).length ? ` Rejected earlier as repeats or not tasks — don't send these again: ${d.rejected.slice(-4).join(' / ')}.` : ''}
- MOMENT: up to ${DATE_MOMENTS} notable things that happened outside the open steps — ${isOuting(ctx, d) ? 'a frank talk, a shared laugh, a kind, brave or trusting gesture' : 'a confession, a kiss, an embrace, a brave or tender gesture'}; one line each, past tense, real names. None if nothing stood out.
- MISSTEP: up to 2 things ${charName} said or did in these messages (outside the open steps) that ${userName} plainly didn't like — as ${userName}'s own reply shows: pulled back, went cold, got annoyed or hurt, cut it short. small or big. Judge only by ${userName}'s actual reaction, never guess it; none is the usual answer.
- GIFT: only a present — a thing given as a gift, meant to be kept or to mark the moment: who gave it and what it is, a few words. Not a gift: food, drink, cigarettes or anything bought, ordered, paid for or shared on the spot; everyday small favours; a kiss, a touch, a word or an act. Up to ${DATE_MOMENTS}; skip the gifts already counted; none is the usual answer.
- LEARN: up to 3 new personal things they found out about each other in these messages — char: what ${charName} learned about ${userName}; user: what ${userName} learned about ${charName}. Only about the person: their past, family, tastes, habits, fears, views, feelings, plans for their life — not plans for today, news, places, events or other people. Only what was actually said or shown, a few words each, no guesses, nothing already known.${dateKnown(ctx, d, true) ? ` Already known (from this and earlier dates): ${dateKnown(ctx, d, true)}.` : ''}${pastDates(state, 3, 160).length ? `\nEarlier dates: ${pastDates(state, 3, 160).join(' · ')}.` : ''}
- MOOD only if it clearly went better or worse beyond the steps. VIBE: how the date goes overall. THOUGHT: ${charName}'s thought about the date now — ${LIVE_VOICE(ctx)}; under 15 words.
- GOAL | yes only when the story itself reaches the goal.
Text in ${lang}.`;
}

/** Помощнику, вдогонку: на освободившиеся места не пришло новых шагов — только они */
export function buildDateRefillMessages(ctx, src, k) {
    const { state, userName, charName } = ctx;
    const d = state.date;
    const open = openSteps(d).map(s => `- ${s.t}`).join('\n');
    const done = (d.steps || []).filter(s => s.state !== 'open').slice(-6).map(s => `- ${s.t}`).join('\n');
    return [
        { role: 'system', content: `You suggest the next small steps of a date between ${charName} and ${userName} in an ongoing roleplay. Answer only with the requested lines.` },
        { role: 'user', content: [
            src.card && `[${charName}]\n${src.card}`,
            `[Story — latest messages]\n${src.story || '—'}`,
            `The date: ${d.title}${d.where ? `, ${d.where}` : ''}; goal: ${d.goal || '—'}.\nStill open:\n${open || '—'}\nAlready done or tried:\n${done || '—'}`,
            `Write exactly ${k} line${k > 1 ? 's' : ''} like:\nNEW | <task for ${charName}> | <${charName}'s thought>\nEach leads toward the goal and grows out of the last thing done and what is happening right now. ${stepFlow(ctx, d)} Never chores or anything off the date. ${stepForm(ctx)}${(d.rejected || []).length ? ` Rejected as repeats — don't send again: ${d.rejected.slice(-4).join(' / ')}.` : ''} In ${langOf(ctx)}.`,
        ].filter(Boolean).join('\n\n') },
    ];
}

/** Отдельный запрос помощника о свидании: каждый ответ, коротко, только про свидание */
export function buildDateSideMessages(ctx, src) {
    const { state, userName, charName } = ctx;
    const d = state.date;
    const task = [];
    if (d && (d.status === 'active' || d.status === 'scheduled')) task.push(dateUpRule(ctx));
    if (state.dateRecapFor && !(d?.status === 'active')) task.push(dateRecapRule(ctx));
    return [
        { role: 'system', content: `You track a date between ${charName} and ${userName} in an ongoing roleplay for an extension. Answer only with the requested hidden block, nothing else. Count what the story actually shows — fairly, not stingily: a step done in spirit is done. Steps and thoughts are about care, attention and closeness, never about owning, guarding or claiming ${userName}. ${RESPECT}` },
        { role: 'user', content: [
            src.card && `[${charName}]\n${src.card}`,
            src.persona && `[${userName}]\n${src.persona}`,
            src.lore && `[World info]\n${src.lore}`,
            `[Story — latest messages; [NEW] marks those since the last check, given in full]\n${src.story || '—'}`,
            task.join('\n\n'),
        ].filter(Boolean).join('\n\n') },
    ];
}

function dateRecapRule(ctx) {
    const last = (ctx.state.datesDone || []).slice(-1)[0];
    const d = ctx.state.date?.id === ctx.state.dateRecapFor ? ctx.state.date : null;
    const facts = d ? [(d.gifts || []).length && `gifts: ${d.gifts.map(g => `${g.from ? `${g.from}: ` : ''}${g.what}`).join('; ')}`,
        (d.log || []).some(x => x.kind === 'moment') && `moments: ${(d.log || []).filter(x => x.kind === 'moment').map(x => x.t).slice(-4).join('; ')}`].filter(Boolean) : [];
    // со второго свидания: всё, что знают друг о друге, — переписать короче, только главное
    const pk = ctx.state.pairKnown || {};
    const squeeze = (ctx.state.datesDone || []).length >= 2 && ((pk.char || []).length + (pk.user || []).length) >= 4;
    const knowRule = squeeze ? `
Then rewrite everything they know about each other into a short summary — KNOW lines, up to 6 per person, only what matters most (merge close facts, drop small details): char — what ${ctx.charName} knows about ${ctx.userName}; user — what ${ctx.userName} knows about ${ctx.charName}. Now known: ${dateKnown(ctx, null, true)}.` : '';
    return `<!-- HT-DATE-UP\nRECAP | <text> | <best moment>${squeeze ? '\nKNOW | <char or user> | <fact>' : ''}\n-->\nThe date "${last?.title || ''}" is over: text — how it went for ${ctx.userName} and ${ctx.charName}, one or two sentences, only what the story showed; best moment — the one worth remembering, a few words.${facts.length ? ` Facts: ${facts.join(' · ')}.` : ''}${knowRule} In ${langOf(ctx)}.`;
}

// ─── Приглашение на свидание ───
// Кубик выпал → помощник составляет план (место, время, цель) по карточке, персоне, лорбуку и истории и сверяет
// его с записями лорбука о выбранном месте → основная модель только произносит приглашение по плану.
// Без помощника (или если он не успел) — основная модель придумывает сама, по тем же правилам здравого смысла.
const hhmm = (c) => `${String(Math.floor(c)).padStart(2, '0')}:${String(Math.round((c % 1) * 60)).padStart(2, '0')}`;
function dateSense(ctx) {
    const { state, userName, charName } = ctx;
    const now = `${state.today != null ? isoOf(state.today) : 'today'}${state.clock != null ? ` ${hhmm(state.clock)}` : ''}`;
    return `It must make sense right here and now:
- where: a place that exists in this world (card, world info, story) or is ordinary for this era and place; never one the world info or the story marks as dangerous, forbidden, cursed or hostile, nor one the story has just made unsafe;
- who: fits both of them as they are now — body and health (pregnancy, injury, illness, tiredness), mood, what just happened between them and around them, duties and threats in the story; ${charName} cares about ${userName} and would not lead ${userName} into harm;
- when: ahead of now (${now}), at a sensible hour for this kind of outing, the season, the weather and daylight; not at night or at dawn unless the story itself points there;
- what: true to ${charName}'s character and means and to the customs of the era — something ${charName} would really think of for ${userName}.`;
}
/** Главная цель свидания — к чему они должны прийти, а не название или описание самого свидания */
const GOAL_RULE = (ctx) => `goal: what ${ctx.charName} hopes changes between the two of them by the end — closeness, trust, making up, knowing each other, a confession or the like, as the story calls for; 2–4 words, ${ctx.lang === 'Russian' ? 'an infinitive verb first' : 'a bare verb first'}; never the name, kind or description of the outing itself`;
const DATE_FORMAT = '<!-- HT-DATE title=… | goal=… | hook=… | where=… | at=YYYY-MM-DD HH:MM | kind=… -->';
const dateFields = (ctx) => `title: what it is, a few words; ${GOAL_RULE(ctx)}; hook: how ${ctx.charName} will ask, one sentence; where: the place; at: when, in the story's calendar (now — if right away);${kindField(ctx)}`;

/** Помощнику: составить план свидания */
function datePlanRule(ctx) {
    const { state, userName, charName } = ctx;
    const past = (state.datesDone || []).slice(-3).map(d => d.title);
    return `${DATE_FORMAT}
Plan the date ${charName} will ask ${userName} on in the next reply${(state.pair?.r ?? 0) < 0 ? ` — ${OUTING}` : (state.pair?.r ?? 0) === 0 ? ' — or a friendly outing to get to know each other, if that fits them better' : ''}. ${dateSense(ctx)}
${dateFields(ctx)}${past.length ? ` Different from: ${past.join(' / ')}.` : ''}${dateKnown(ctx, null, true) ? ` What they already know about each other: ${dateKnown(ctx, null, true)} — the plan may build on it.` : ''} In ${langOf(ctx)}.`;
}

/** Помощнику, второй проход: сверить план с записями лорбука о выбранном месте */
export function buildDateReview(ctx, planBlock, lore, src) {
    const { userName, charName } = ctx;
    return [
        { role: 'system', content: `You check a planned date in a roleplay between ${charName} and ${userName} against the world's lore. Answer with a single line.` },
        { role: 'user', content: `[World info about the planned date]\n${lore}\n\n[${charName}]\n${src.card || '—'}\n\n[${userName}]\n${src.persona || '—'}\n\n[Story — latest messages]\n${String(src.story || '').slice(-2500)}\n\n[The plan]\n${planBlock}\n\n${dateSense(ctx)}\nIf the plan clashes with the world info or the story (a dangerous or forbidden place, a wrong hour, it doesn't suit someone's state), answer with a corrected ${DATE_FORMAT} — same format, in ${langOf(ctx)}. Otherwise answer OK.` },
    ];
}

/** Основной модели: позвать по готовому плану */
function dateAskRule(ctx) {
    const { state, userName, charName } = ctx;
    const pl = state.datePlan;
    const p = state.pair || {};
    return `${state.dateRollTry ? 'REQUIRED — your last reply skipped it. ' : ''}This reply ${charName} asks ${userName} on ${pl.kind === 'friendly' ? OUTING : 'a date'} ${charName} has in mind: ${pl.title}${pl.where ? ` — ${pl.where}` : ''}, ${dateAtText(state, pl.at)}${pl.goal ? `; meant to ${pl.goal}` : ''}.${pl.hook ? ` How: ${pl.hook}` : ''} Ask in ${charName}'s own way, as fits who ${charName} is and how they stand (friendship ${p.f ?? 0}, romance ${p.r ?? 0}): openly, shyly, in passing or as a half-joke, at a moment that fits the scene. Write only the asking; ${userName} answers. If the scene is urgent or dangerous, don't ask yet.`;
}

/** Основной модели без плана: придумать и позвать самой */
function dateOfferRule(ctx) {
    const { state, userName, charName } = ctx;
    const p = state.pair || {};
    const past = (state.datesDone || []).slice(-3).map(d => d.title);
    const cg = charGiftOf(state, ctx.phase?.h?.id);
    const gift = cg && !cg.done && cg.got && cg.text ? ` ${charName}'s gift is ready (${cg.text}) — it may be part of it.` : '';
    return `${state.dateRollTry ? 'REQUIRED — your last reply skipped it. ' : ''}This reply ${charName} asks ${userName} on ${(p.r ?? 0) < 0 ? OUTING : (p.r ?? 0) === 0 ? `a date or ${OUTING} — whichever fits them` : 'a date'}, in ${charName}'s own way, as fits who ${charName} is and how they stand (friendship ${p.f ?? 0}, romance ${p.r ?? 0}${p.note ? `, ${p.note}` : ''}): openly, shyly, in passing or as a half-joke; after a quarrel — as a way to make up. ${dateSense(ctx)}
Write only the asking; ${userName} answers. Only if ${charName} actually said it to ${userName} in this reply (not just thought of it), add after the HT line: ${DATE_FORMAT} — ${dateFields(ctx)}${gift} In ${langOf(ctx)}.${past.length ? ` Different from: ${past.join(' / ')}.` : ''} If the scene is urgent or dangerous, don't ask yet and add nothing.`;
}

// Случайный ивент: предлагается игроку кнопками, в историю входит, только если он принял
/** Чем живёт праздник — помощнику, чтобы подсказки и ивенты были в духе повода, а не «что-нибудь праздничное» */
export function occasionFlavor(h, ctx) {
    const name = String(h?.name || '').toLowerCase();
    const modern = ctx.eraMode === 'modern';
    if (!modern) return 'its own customs and rites as this era and place keep them: food, songs, games, visits, small rituals, someone\'s antics';
    if (h?.birthday || h?.npc || /день рожд|юбилей|birthday/.test(name)) return 'a toast in turn, a cake with candles, a funny or touching gift, a guest\'s story about the birthday person, a song, a photo, someone arriving late';
    if (/корпорат|офис|работ|office|party|вечерин/.test(name) || h?.type === 'gathering') return 'a boss\'s or colleague\'s toast, a silly party contest (a quiz, a dance-off, a balloon or tug-of-war game, a prize draw), Ded Moroz or a host with a game, karaoke, a tipsy colleague\'s antics, secret-Santa gifts';
    if (/нов(ый|ого) год|new year/.test(name)) return 'the chimes and the president\'s address, writing a wish on paper, sparklers, fireworks outside, a call from relatives, gifts under the tree, Olivier and champagne, a neighbour dropping by';
    if (/рождеств|christmas/.test(name)) return 'a festive meal, a church service or carols, gifts, a call to family, candles and lights';
    if (/валентин|valentine/.test(name)) return 'flowers, a card or small gift, a café with hearts, a couple nearby, a radio song';
    if (/масленн/.test(name)) return 'pancakes, a sledding hill, burning the effigy, folk games, a market';
    return 'what people usually do on this day here: a meal, a toast, a visit, a call, music, a small tradition, someone\'s funny moment';
}

/** Помощнику: выпал шанс ивента — придумать, что именно случится в следующем ответе */
export function evPlanRule(ctx) {
    const t = ctx.evTarget;
    const { state, userName, charName } = ctx;
    const past = (state.evts || []).filter(e => e.hid === t.hid && e.kind !== 'moment').map(e => e.title).slice(-4);
    const h = ctx.phase?.kind === 'today' ? ctx.phase.h : null;
    return `<!-- HT-EVPLAN kind=event|party | title=… | who=… | hook=… -->
A chance happening for the NEXT reply at ${t.name}: one concrete thing that livens the occasion up — ${h ? occasionFlavor(h, ctx) : t.kind === 'date' ? 'a small surprise around them: a street musician, a photographer, an unexpected meeting, a game or treat on offer, the weather turning' : 'something true to the moment'}. It must fit this exact scene, the people already there and the mood; someone present starts it. kind=party only if it is an invitation to a separate gathering; otherwise event. title: 2–5 words; who: the person who starts it (a name from the story or a role); hook: how it starts, one sentence — ${charName} and ${userName} can join or not. In ${langOf(ctx)}.${past.length ? ` Different in kind from: ${past.join(' / ')}.` : ''} Never anything urgent, dangerous or that decides for ${userName}.`;
}

function eventOfferRule(ctx) {
    const { state, userName } = ctx;
    const t = ctx.evTarget;
    const past = (state.evts || []).filter(e => e.hid === t.hid && e.kind !== 'moment').map(e => e.title).slice(-4);
    const p = state.evPlan && state.evPlan.hid === t.hid ? state.evPlan : null;
    // помощник уже придумал, что именно случится: конкретная просьба выполняется куда чаще абстрактной
    if (p) return `This reply — the occasion livens up: ${p.who ? `${p.who} starts` : 'it begins:'} ${p.hook || p.title} ("${p.title}"). Weave it into the scene naturally, true to the people and the moment; show only how it starts (someone begins it or calls ${userName} in) and stop where ${userName} can choose to join or not. Then add after the HT line: <!-- HT-EV kind=${p.kind === 'party' ? 'party' : 'event'} | title=${p.title} | who=${p.who || ''} | hook=<what has just begun, one sentence in ${langOf(ctx)}> -->. Only an urgent or dramatic moment may push it off — then add nothing.`;
    return `This reply, if the scene allows: let one chance happening at ${t.name} begin — outside its own plan, brought by a person, by chance or by the world around, true to the era, the place and the moment; it livens up the people around and the world. Show only its start (someone begins it or invites ${userName}) and stop where ${userName} can choose to join. Then add after the HT line: <!-- HT-EV kind=event|party | title=… | who=… | hook=… --> — kind=party if it is an invitation to a gathering; title a few words; who brings it; hook: what has just begun, one sentence; in ${langOf(ctx)}.${past.length ? ` Different in kind from: ${past.join(' / ')}.` : ''} If the scene is urgent or nothing fits, skip it and add nothing.`;
}
function calRule(ctx) {
    const { state, userName, charName } = ctx;
    const lang = langOf(ctx);
    // календарь продолжаем только от общих праздников; поводы из истории — отдельно, «не повторять»
    const ahead = (state.holidays || []).filter(x => state.today == null || x.start + x.days - 1 >= state.today);
    const known = state.rebuild ? [] : ahead.filter(x => !x.story && !x.edited).map(x => `${x.name} (${isoOf(x.start)})`).slice(0, 5);
    // поводы из истории и праздники, поправленные игроком, — уже в календаре, повторять их не нужно
    const storyKnown = ahead.filter(x => x.story || x.edited).map(x => `${x.name} (${isoOf(x.start)})`).slice(0, 6);
    // дни рождения спрашиваем один раз: не указаны в карточке — значит, их нет, пока история не скажет
    const needB = (!state.birthdays?.user || !state.birthdays?.char) && !state.bdayAsked;
    const gap = ctx.skipGap;
    const askMode = ctx.eraMode === 'auto';
    return `<!-- HT-CAL
S | ERA_AND_YEAR | FAITH | PLACE${askMode ? ' | MODE' : ''}
H | YYYY-MM-DD | DAYS | NAME | MEANING | TYPE | PREP | ICON
${needB ? `B | user | MM-DD | PREP\nB | char | MM-DD | PREP\n` : ''}${gap ? `X | YYYY-MM-DD | NAME | TYPE\n` : ''}E | YYYY-MM-DD | DAYS | NAME | HOST | FOR | MEANING
-->
- S: the era by name and the year${ctx.eraMode === 'modern' ? '' : ', as people of that time would say it (our reckoning in brackets only if theirs differs)'} — not a bare date; FAITH — ${faithRule(ctx)}; PLACE — the kind of place and its proper name exactly as the story gives it (never invent a name the story doesn't use).${askMode ? ' MODE — present if the story is set in our real world today, otherwise past (history, fantasy, other worlds).' : ''}
- H: ${state.rebuild ? 'pick the calendar afresh: ' : ''}the next 4 holidays the whole country or world of the story keeps — public, religious, folk or seasonal days everyone there knows — from the current date (one going on today counts and comes first), in date order, none skipped, decided briskly${known.length ? `, continuing after: ${known.join(', ')}` : ''}. Never a day made up from the story itself — its groups, jobs, gangs, households or plot — nor anything still to happen in it: those are not the calendar. Personal and family dates never go here either. ${holidayGuide(ctx)} Compute movable feasts properly for that year and calendar.${easterHint(ctx)}${storyKnown.length ? ` Already added from the story — don't repeat: ${storyKnown.join(', ')}.` : ''} DAYS = how many days it really lasts. TYPE: religious | folk | seasonal | state | supernatural | fast | memorial. PREP = days before it people start getting ready (0 for a minor day). ICON — one word from: ${ICON_WORDS.join(', ')}. Birthdays never go in H lines.${needB ? `\n- B: birthdays of ${userName} and ${charName} only if the card, persona or story states them; otherwise leave that line out — never guess.` : ''}${gap ? `\n- X: holidays the time skip jumped over, ${gap.from} to ${gap.to}, by the same rules.` : ''}${ctx.passed?.length ? `\n- Already passed this year, don't repeat: ${ctx.passed.join(', ')}.` : ''}${ctx.banned?.length ? `\n- NEVER include these (the player removed them): ${ctx.banned.join(', ')}.` : ''}
- E: ${extrasText(ctx)}
- All of it in ${lang}: translate holiday names even if the story's world speaks another language.`;
}

// ─── Дополнительные праздники: собрания из жизни {{user}} и {{char}}, на которые их могут позвать ───
function extrasText(ctx) {
    const { state, userName, charName } = ctx;
    const known = (state.extras || []).filter(x => state.today == null || x.start >= state.today).map(x => `${x.name} (${isoOf(x.start)})`);
    return `up to 2 side gatherings in the next 60 days that come with the lives of ${userName} and ${charName} — something a host would invite them to: a gathering of their work, trade or guild, their regiment, crew, school or court, their community or neighbours, often tied to a coming holiday. Only what fits who they are, where they live and what they do, by the card, persona, lore and story, in this era and setting; none if their lives give no grounds. NAME: what the gathering is, never just a person's name; HOST: who holds it and invites; FOR: user, char or both — whom the invitation is for. Never birthdays, never a holiday already in the calendar.${known.length ? ` Already known: ${known.join(', ')}.` : ''}`;
}
function extrasRule(ctx) {
    return `<!-- HT-EXTRA
E | YYYY-MM-DD | DAYS | NAME | HOST | FOR | MEANING
-->
E: ${extrasText(ctx)} Leave the block out if there are none. In ${langOf(ctx)}.`;
}

/** Основной модели: выпало приглашение — его произносят в этом ответе */
function inviteAskRule(ctx) {
    const { state, userName, charName } = ctx;
    const r = state.invRoll;
    const d = r.day - state.today;
    const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `on ${isoOf(r.day)}, in ${d} days`;
    const what = r.kind === 'bday' ? `${r.name}'s birthday` : r.name;
    return `${r.tries ? 'REQUIRED — your last reply skipped it. ' : ''}This reply: ${r.host || r.name}${r.kind === 'bday' ? ', or someone close to them,' : ''} invites ${whomOf(ctx, r.whom || 'both')} to ${what} — ${when}${r.kind === 'bday' ? '' : `${r.meaning ? ` (${r.meaning})` : ''}`}: in person, by a word passed on or a note, as fits the era and how they get on; plainly, with the day${d <= 1 ? '' : ' and the time'}. Only the invitation — nothing of the occasion itself happens yet; ${userName} answers. If the scene is urgent or dangerous, the next calm moment.`;
}

function prepRule(ctx) {
    const { state, phase, userName, charName } = ctx;
    const h = phase.h;
    const scope = h.extra || h.story
        ? `This is ${h.extra ? 'a gathering' : 'an occasion from the story'}${h.host ? `, held by ${h.host}` : ''}: its hosts get ready; for ${whomOf(ctx, h.whom || 'both')} it is an accepted invitation (clothes, a gift or a word for the hosts, getting there).`
        : h.npc
        ? `This is ${h.name}'s birthday${npcAbout(ctx, h) ? ` (${npcAbout(ctx, h)})` : ''}: only ${h.name}'s household and close circle get ready, modestly, as a family affair; ${npcExpect(ctx, h)}.`
        : isIntimate(h)
        ? `This is a personal or family occasion: only ${h.birthday && h.who === 'user' ? `the people close to ${userName}` : 'the household and close circle'} get ready — not the whole community.`
        : `This is a public holiday: the community around ${userName} gets ready.`;
    return `<!-- HT-PREP mood=… | gifts=yes|no | gift_to=… | care=high|normal|low -->
${hName(h, ctx)} is ${daysWord(phase.daysTo)}. ${scope} mood: the feeling in the air about it now, a few words, capital letter — only what is visible or commonly known, no secret plans the story hasn't shown. gifts: does this occasion involve giving gifts by custom; gift_to: to whom they go — the name only, as the story names them, in its plain form (never "for …", never a role word). care: how much it matters to ${charName} personally, judging by who ${charName} is.${h.birthday && h.who === 'user' ? ` A surprise for ${userName} stays unspoiled.` : ''} ${settingTone(ctx)}`;
}

/** Распорядок — коротко: одна строка на часть дня */
const PART_LINE = 'Each part: one short line, up to 12 words — what happens then; leave out the parts when nothing happens for it. Fields are separated by |.';
function dayRule(ctx) {
    const h = ctx.phase.h;
    const tone = settingTone(ctx);
    if (isGathering(h)) {
        const about = h.npc ? npcAbout(ctx, h) : '';
        const what = h.npc ? `${h.name}'s birthday${about ? ` (${about})` : ''} — a small household occasion` : `${hName(h, ctx)} — an event with its own order`;
        return `<!-- HT-DAY title=… | where=… | morning=… | day=… | evening=… | night=… -->
${what}: when it starts, what happens there in turn, when it ends, as its hosts would run it. ${tone} title = what it is for, a few words; where = the place as the story names it. ${PART_LINE} Never decide whether ${ctx.userName} comes.`;
    }
    return `<!-- HT-DAY title=… | morning=… | day=… | evening=… | night=… -->
How ${hName(h, ctx)} is kept TODAY${h.days > 1 ? ` (day ${ctx.phase.dayIndex} of ${h.days})` : ''} by the people around ${ctx.userName} and ${ctx.charName}. ${tone} title = what this day is about, a few words — not the holiday's name. ${PART_LINE}`;
}

function replanRule(ctx) {
    const { state, phase } = ctx;
    const h = phase.h;
    const plan = state.days?.[`${h.id}#${phase.dayIndex}`] || {};
    const ahead = ['morning', 'day', 'evening', 'night'];
    const from = Math.max(0, ahead.indexOf(ctx.part));
    const ev = ctx.evTarget?.hid === h.id ? openEvent(state, h.id) : null;
    return `<!-- HT-DAY ${ahead.slice(from).map(p => `${p}=…`).join(' | ')} -->
The day has moved on: rewrite the parts from now on to fit what has actually happened${ev ? ` — including "${ev.title}" going on there` : ''}. It keeps its own course (moved, shortened, or going on without someone), never replaced by the story's other events and never a retelling of them. ${settingTone(ctx)} ${PART_LINE}${plan[ahead[from]] ? ` The plan was: ${ahead.slice(from).filter(p => plan[p]).map(p => `${p}: ${plan[p]}`).join('; ')}.` : ''}`;
}

function recapRule(ctx) {
    const { state, phase, userName, charName } = ctx;
    const e = phase.ended;
    const hl = (state.highlights?.[e.id] || []).map(x => `${x.name} — ${x.text}`).join('; ');
    const g = charGiftOf(state, e.id)?.done ? charGiftOf(state, e.id).text : null;
    const ug = e.npc && state.userGift?.[e.id]?.text ? state.userGift[e.id] : null;
    const noted = readyNoted(state, e, 4);
    const gl = g && (giftJoint(state, e) ? `${charName} and ${userName}'s gift: ${g}` : `${charName}'s gift: ${g}`);
    const ul = ug && `${userName}'s gift: ${ug.text}${ug.done ? '' : ' (if the story showed it given)'}`;
    const inv = e.npc || e.extra;
    return `<!-- HT-RECAP text=… | done=… | gifts=… | best=…${inv ? ' | went=yes|no' : ''} -->${inv ? ` went — did ${charName} and ${userName} actually come to it, as the story shows (no if they didn't make it).` : ''} In ${langOf(ctx)}, only what the story showed: text — how ${hName(e, ctx)} went for ${userName} and ${charName}, one or two short sentences (under 40 words); done — what was done or kept, a few short items separated by ;; gifts — who gave what to whom, separated by ; (empty if none); best — the one moment worth remembering, a few words.${hl || gl || ul || noted.length ? ` Facts: ${[gl, ul, hl, noted.length && `prepared: ${noted.join('; ')}`].filter(Boolean).join('; ')}.` : ''}`;
}

// ─── 2. Правило тега (конец промпта) ───
export function buildTagPrompt(ctx) {
    const { state, userName } = ctx;
    const lang = langOf(ctx);
    const out = [`[Hearthtide tag — required]
End every reply with one hidden line:
<!-- HT date=YYYY-MM-DD | time=HH:MM | when=DATE_TEXT -->
date: in-world date, numeric, in the story's own calendar (fictional months → 1–12). time: in-world clock now. when: the day and month as the story says it, short. Add place=KIND NAME (the settlement or area: its kind word and name as the story says them, not a building) when ${userName} moves or it's wrong${ctx.placeUnnamed ? ` — and THIS reply, because the current place has no name yet: the name the story gives it, or a fitting one` : ''}.
All text values in these comments: ${lang} only.`];

    if (state.langSlip) out.push(`Your last values were not in ${lang} — write them in ${lang}.`);
    if (ctx.fixPlace) out.push(`Add place=… to the HT line THIS reply: the current place rewritten in ${lang}.`);
    if (ctx.fixSetting) out.push(`ALSO add after the HT line: <!-- HT-CAL\nS | ERA_AND_YEAR | FAITH | PLACE\n--> — the current setting rewritten in ${lang}.`);
    if (state.missed > 0) out.push(`Your previous reply had no HT line — include it now.`);
    // Основная модель пишет историю: в её правиле — только дата, время, место и то, что должно случиться в самом тексте
    // (позвать, начать ивент, чем ивент кончился). Всё служебное по истории собирает помощник.
    const dt = state.date?.status === 'active' ? state.date : null;
    // выпал шанс — ивент или приглашение на свидание начинаются прямо в этом ответе, игрок решает кнопками
    if (state.evRoll && ctx.evTarget) out.push(eventOfferRule(ctx));
    if (state.invRoll) out.push(inviteAskRule(ctx));
    if (state.dateRoll && !dt) out.push(state.datePlan ? dateAskRule(ctx) : dateOfferRule(ctx));
    const evOpen = ctx.evTarget ? openEvent(state, ctx.evTarget.hid) : null;
    if (evOpen?.status === 'invited') out.push(`Add ev=joined to the HT line if ${userName} accepts the invitation, ev=declined if not.`);
    else if (evOpen) out.push(`When "${evOpen.title}" ends, add ev=done | ev_note=its outcome in one sentence to the HT line${evOpen.kind === 'party' ? '' : `; ev=skipped if ${userName} turned away`}.`);
    out.push('Never skip, mention or explain these comments.');
    return out.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 3. Отдельный запрос: модель читает историю и ведёт заметки о празднике.
// Пресет не входит; входят карточка, персона, лорбук и последние сообщения.
// ═══════════════════════════════════════════════════════════════
export function buildSideMessages(ctx, needs, src) {
    const { state, phase, userName, charName } = ctx;
    const h = phase.h;
    const lang = langOf(ctx);
    const sys = [`You are Hearthtide, the keeper of the holiday calendar for an ongoing roleplay between ${userName} and ${charName}. You do not continue the story. You read it and reply ONLY with the hidden blocks asked for below — no other text. Notes about what happened hold only what the story has shown. Never decide ${userName}'s thoughts, feelings, words or choices. ${RESPECT}`];
    if (src.card) sys.push(`[${charName}]\n${src.card}`);
    if (src.persona) sys.push(`[${userName}]\n${src.persona}`);
    if (src.lore) sys.push(`[World info]\n${src.lore}`);
    // заметки без указаний основной модели — помощнику нужны только факты
    const notes = buildStatePrompt({ ...ctx, side: true, state: { ...state, beat: null, mentionNow: false, recall: null } })
        .split('\n').filter(l => !/^(This reply|If .+ is away from people|If the scene allows)/.test(l)).join('\n');
    sys.push(`[Calendar notes so far]\n${notes}`);
    // точная дата обязательна: от неё считаются все даты в блоках
    if (state.today != null) sys.push(`[Today in the story] ${isoOf(state.today)}${state.when ? ` (${state.when})` : ''}${ctx.part ? `, ${ctx.part}` : ''}. Count every date from it.`);
    sys.push(`[Story — latest messages, the last one is the newest]\n${src.story || '(empty)'}`);

    const task = [`Reply with these blocks, each at most once, nothing else. Values meant for the player in ${lang}; BEAT in English.`];
    if (needs.has('cal')) task.push(calRule(ctx));
    if (needs.has('prep') && h) task.push(prepRule(ctx));
    if (needs.has('ready') && (ctx.tracked || []).length) task.push(readyRule(ctx));
    if (needs.has('day') && h) task.push(dayRule(ctx));
    if (needs.has('replan') && h) task.push(replanRule(ctx));
    else if (needs.has('plancheck') && h) task.push(`Only if the latest messages have moved away from today's plan (something happened earlier, later or differently): ${replanRule(ctx)} Leave this block out if the plan still holds.`);
    if (needs.has('cast') || needs.has('census')) task.push(castRule({ ...ctx, census: needs.has('census') }));
    if (needs.has('extras') && !needs.has('cal')) task.push(extrasRule(ctx));
    if (needs.has('people') && h) task.push(`${PEOPLE_BLOCK}\n${peopleRules(ctx)}`);
    if (needs.has('recap') && phase.ended) task.push(recapRule(ctx));
    if (needs.has('evplan') && ctx.evTarget) task.push(evPlanRule(ctx));

    // Короткие поля одной строкой
    const sf = [];
    if (needs.has('char') && h) sf.push(`char=${charName}'s thought about the occasion right now — ${LIVE_VOICE(ctx)}, under 12 words; never a description of what ${charName} is doing; not echoing earlier ones`);
    if (needs.has('char') && h && charGiftActive(ctx)) sf.push(`gift=${giftJoint(state, h) ? `the current step with ${charName} and ${userName}'s joint gift` : `${charName}'s current step with a gift`} for ${giftTarget(state, h, userName, charName)}: what the gift is now, one short phrase with a capital letter, no stage word like "idea:" (picked → found or made → ready and hidden → given); gift_done=true once the story shows it given. Leave gift out until there is a real step — never write that it isn't decided`);
    // кому дарят — если подготовка не успела сказать
    if (needs.has('giftto') && h) sf.push(`gift_to=to whom gifts go by custom on this occasion — the name only, in its plain form as the story names them, never "for …" or a role word`);
    const evOpen = ctx.evTarget ? openEvent(state, ctx.evTarget.hid) : null;
    if (evOpen?.status === 'invited') sf.push(`ev=joined if ${userName} accepted the invitation "${evOpen.title}", ev=declined if refused; leave out if not decided yet`);
    else if (evOpen) sf.push(`ev=done with ev_note=its outcome in one sentence once "${evOpen.title}" is over in the story${evOpen.kind === 'party' ? '' : `; ev=skipped if ${userName} turned away`}`);
    const sk = (state.skipAsk || [])[0];
    if (needs.has('went') && sk) sf.push(`went=yes or no: ${sk.what} (${isoOf(sk.day)}) passed during a time skip after ${userName} accepted the invitation — did ${charName} and ${userName} go, as fits the story; went_note=a few words on how it went or why not`);
    if (needs.has('focus')) {
        // только среди праздников первого ряда — встречи и приглашения главным праздником дня не становятся
        const act = activeOccasions(state), top = Math.min(...act.map(occTier));
        const pool = act.filter(x => occTier(x) === top);
        if (pool.length > 1) sf.push(`focus=which of today's holidays the latest messages are actually celebrating or living through: ${pool.map(x => `"${hName(x, ctx)}"`).join(' or ')} — exactly as quoted; leave it out if none of them`);
    }
    if (needs.has('mean') && ctx.meaningFor) sf.push(`mean=what "${ctx.meaningFor}" is and how it is kept in this era and place, one sentence`);
    const pr = state.pair;
    if (needs.has('bond') && pr) sf.push(`bond=FRIENDSHIP/ROMANCE only if the latest messages clearly changed how ${charName} and ${userName} stand (now ${pr.f}/${pr.r}${pr.note ? `, ${pr.note}` : ''}; both −100…100); bond_note=a few words on how they are now — what they share or what stands between them (${RESPECT}); leave both out if nothing changed`);
    if (needs.has('ugift') && h) sf.push(`ugift=only if ${userName}'s own messages name, get or give ${userName}'s own gift for ${h.name} — what it is, as ${userName} wrote it; ugift_done=true once given; never a guess`);
    if (needs.has('bond') && !pr) sf.push(`bond=FRIENDSHIP/ROMANCE: how ${charName} and ${userName} stand by the card, persona and story, two numbers −100…100 — friendship (enmity … 0 neutral … very close), romance (hatred or exes … 0 none … deep love); spouses, lovers, rivals and strangers all differ; bond_note=a few words on how they are now — what they share or what stands between them (${RESPECT}); bond_kin=yes only if they are family to each other by blood or upbringing (then romance 0)`);
    const keys = (x) => (x.startsWith('bond=') ? 'bond=F/R | bond_note=… | bond_kin=…' : x.startsWith('went=') ? 'went=… | went_note=…' : `${x.split('=')[0]}=…`);
    if (sf.length) task.push(`<!-- HT-S ${sf.map(keys).join(' | ')} -->\n${sf.map(x => `- ${x}`).join('\n')}`);

    if (needs.has('moments') && ctx.evTarget) {
        const ev = openEvent(state, ctx.evTarget.hid);
        task.push(`<!-- HT-EV kind=moment | title=… -->
Only if the latest messages show something new at "${ev?.title || 'the gathering'}" that ${userName} joined — a few words. Leave it out otherwise.${ev?.moments?.length ? ` Already: ${ev.moments.slice(-3).map(m => m.title).join(' / ')}.` : ''}`);
    }
    if (needs.has('date') && state.date) task.push(dateUpRule(ctx));
    if (needs.has('dateplan')) task.push(datePlanRule(ctx));
    if (needs.has('daterecap') && !(needs.has('date') && state.date?.status === 'active')) task.push(dateRecapRule(ctx));
    if (needs.has('datewatch')) task.push(`<!-- HT-DATE title=… | goal=… | where=… | at=YYYY-MM-DD HH:MM | kind=… | started=… | agreed=… -->
${GOAL_RULE(ctx)}. Only if the latest messages show a date or an outing of ${userName} and ${charName} alone that isn't tracked yet — time spent together for its own sake (a walk, a café, the cinema, a trip for fun). Not an errand or a practical matter: shopping for something needed, a lift somewhere, chores, work, helping out — those are just the story: one of them asks the other for one (at — when; now if right away), or they are already on it together (started=yes). agreed=yes only if ${userName}'s own message already said yes to it or ${userName} proposed it; if ${charName} asked and ${userName} hasn't answered yet — agreed=no and no started.${kindField(ctx)} Leave it out otherwise.`);
    if (needs.has('new')) {
        // и то, на что уже позвали или позовут (дополнительные праздники, принятые приглашения): иначе каждое «приходи на…»
        // в истории становилось ещё одним поводом
        const invited = [state.inv?.status !== 'declined' && state.inv?.name, ...(state.extras || []).map(x => x.name), ...(ctx.acceptedAhead || []).map(h => h.name)];
        const known = [...new Set([...(state.holidays || []).filter(x => x.start >= (state.today ?? 0) - 1).map(x => x.name), ...invited, ...(ctx.offerNames || []), ...(ctx.passed || [])].filter(Boolean))].slice(0, 14);
        const no = (ctx.offerSeen || []).slice(-10);
        task.push(`<!-- HT-NEW CAUSE | YYYY-MM-DD | DAYS | NAME | MEANING | TYPE | PREP | HOST | AGREED -->
Only a festive occasion the story has set up that isn't in the calendar: a celebration of someone's life event, an announced party, feast or festive gathering, a leisure trip or outing agreed on for a set day — or one the card or lore dates within a month. A party, get-together or celebration at someone's place or out with friends, kin or colleagues for a set day counts, even if nobody has answered yet. Not business, work or plot meetings, talks, deals, errands, fights or casual drop-ins with no occasion: those are the story. Not a date of the two of them alone. CAUSE: what happened, a few words. NAME: what the occasion is (never just a person's name). Date: the day it takes place, counted from today; if it is already happening in the latest messages — today. DAYS: how many days it lasts — 1 for a party, evening, dinner or get-together; more only for a trip or a festival the story says lasts several days. TYPE: family | personal | religious | folk | memorial | gathering. HOST: who personally invited ${userName} or ${charName} to it in the story, empty if nobody did. AGREED: yes only if ${userName}'s own message already said yes to it or proposed it, or they are already there; no if ${userName} hasn't answered yet. At most two lines; leave the block out if there is none.${known.length ? ` Already known: ${known.join(', ')}.` : ''}${no.length ? ` Turned down by the player this year — never offer again, under any name: ${no.join('; ')}.` : ''}`);
    }
    if (needs.has('beat') && (h || (ctx.tracked || []).length)) {
        // что дать миру сделать в следующем ответе: шаг подготовки, которого ещё не было, — живыми людьми, вскользь;
        // в сам день — то, что день несёт сейчас. Потом помощник запишет это из истории в журнал (HT-READY)
        const trH = (ctx.tracked || []).filter(x => pushable(state, x));
        const tr = trH.map(x => `${hName(x, ctx)} (${daysWord(x.start - state.today)})`);
        const gath = phase.kind === 'today' && h ? isGathering(h) : trH.some(isGathering);
        const what = phase.kind === 'today' && h ? `the festive day (${hName(h, ctx)}) — what it holds right now`
            : tr.length ? `a step of getting ready for ${tr.join(' or ')} that hasn't happened yet (see what is already noted) — the nearer the day, the more visible`
            : `the coming ${hName(h, ctx)} (in ${phase.daysTo} days — a passing mention at most)`;
        task.push(`<!-- HT-BEAT … -->
One sentence in English for the story model: one concrete small thing for the NEXT reply — ${what} — shown through someone of this world doing it or speaking of it in passing, true to who they are, the era and the place (${ctx.eraMode === 'modern' ? 'present-day life' : 'their own customs and means'}); it moves things forward, never redoes what is done. Vary the kind and never repeat an earlier one${state.beatLog?.length ? ` (earlier: ${state.beatLog.join(' / ')})` : ''}. It must fit the current scene.${phase.kind === 'today' && h
    ? ` On the day itself something always goes on: pick what this occasion holds right now and hasn't happened yet in the story — ${occasionFlavor(h, ctx)}. Someone of the people present does it; it may draw ${charName} and ${userName} in, but they choose for themselves. Write none only if the scene is urgent, tense, intimate, or they are away from the occasion.`
    : `${gath ? ` For a gathering or invitation (a party, get-together, someone's birthday): ${userName} has already agreed — never a new or repeated invitation, never asking again whether they're coming, never a reminder of the date or time; only a real small step that fits (picking clothes or a gift, a word with someone who's also going), or none.` : ''} Write none if the latest messages already touched this occasion.`} At most one person per beat; for a family occasion, kin and those the custom involves may come in even if not seen yet. Write none if the scene is urgent or tense, ${userName} is away from people, the scene is already full, or nothing fits naturally — leaving room is fine. Never decide what ${userName} does, and never spoil a surprise meant for ${userName}.`);
    }
    task.push('Never write the story, comments outside the blocks, or explanations.');
    return [
        { role: 'system', content: sys.join('\n\n') },
        { role: 'user', content: task.join('\n\n') },
    ];
}
