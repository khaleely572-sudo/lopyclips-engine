import {clock, normalize} from '../sources/transcript.mjs';
import {hasLaughter, makeWindows, prioritizeWindows} from './signals.mjs';

export const RISKS = ['none', 'heavy_profanity', 'slur', 'sexual', 'graphic_violence', 'dangerous_act', 'music', 'needs_context'];
export const BLOCKING_RISKS = ['slur', 'sexual', 'graphic_violence', 'dangerous_act'];
export const HUMOR_TYPES = ['sarcasm', 'deadpan', 'wit', 'banter', 'roast', 'punchline', 'running_joke', 'absurd', 'awkward', 'fail', 'reaction', 'other'];
export const TONES = ['sincere', 'sarcastic', 'joking', 'unclear'];
export const VERDICTS = ['funny', 'weak', 'not_funny', 'unsure'];
export const MECHANISMS = ['comeback', 'irony', 'absurdity', 'self_own', 'exaggeration', 'roast', 'misunderstanding', 'running_joke', 'fail', 'reaction', 'none'];
/** What the reviewer can hold against a clip, and how many points each costs. */
export const FLAG_PENALTY = {ordinary_talk: 3, just_loud: 3, missing_setup: 2, no_payoff: 2, inside_joke: 2, visual_only: 1.5, dead_air: 1, rambling: 1};
const REJECT_FLAGS = {ordinary_talk: 'it is ordinary talk, not a joke', just_loud: 'it is loud or hyped, but there is no joke in it'};
const MAX_PENALTY = 4;
const LAUGHTER_BONUS = 0.4;
const MIN_STANDALONE = 5;
const DISAGREEMENT = 3;

/** One clip may be as short as a one-liner with its setup, or as long as a story needs. */
export const CLIP_SECONDS = {min: 5, max: 45};
const MAX_PER_WINDOW = 3;
const REVIEW_BATCH = 3;
/** Review batches sent side by side. The second model thinks for a minute or two per batch, so one at a time is slow. */
const REVIEWS_AT_ONCE = 3;
const CONTEXT_BEFORE = 8;
const CONTEXT_AFTER = 4;
const RANK_MIN = 3;
const RANK_SPREAD = 0.5;
const REACTION_GAP = 2.5;
const REACTION_KEEP = 2;
const REACTION_TAG = /^\s*(>>\s*)?\[(laughter|laughs|laughing|applause)\]/i;

const number = {type: 'number'};
const integer = {type: 'integer'};
const risks = {type: 'array', items: {type: 'string', enum: RISKS}};

const DISCOVER_SCHEMA = {
  type: 'object',
  required: ['moments'],
  properties: {
    moments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['setup_line', 'punch_line', 'end_line', 'quote', 'humor_type', 'tone', 'why_funny', 'funny', 'standalone', 'confidence', 'label', 'risks'],
        properties: {
          setup_line: integer,
          punch_line: integer,
          end_line: integer,
          quote: {type: 'string'},
          humor_type: {type: 'string', enum: HUMOR_TYPES},
          tone: {type: 'string', enum: TONES},
          why_funny: {type: 'string'},
          funny: number,
          standalone: number,
          confidence: number,
          label: {type: 'string'},
          risks,
        },
      },
    },
  },
};

const DISCOVER_SYSTEM = `You find the genuinely funny moments in a livestream for a comedy clips channel. Most of a stream is not funny. Find the few moments that would make a stranger laugh, and return nothing when there are none: three hilarious clips beat twenty mediocre ones.

You only have auto-generated captions. Each line is: line number, time, text. Tags such as [laughter] or [screaming] mark sounds the captions picked up, "[ __ ]" is a censored swear word and ">>" marks a change of speaker. Captions contain mistakes and carry no tone of voice, so read for meaning. People are often sarcastic, exaggerating or teasing: a line can be funny precisely because it is NOT meant literally, and quiet, dry humor counts as much as a loud moment.

What counts as funny:
- sarcasm, deadpan and dry understatement;
- a witty comeback, banter or a roast between people;
- a joke with a setup and a punchline, or a running joke paying off;
- something absurd, awkward or unexpected, together with the reaction to it;
- a fail, or a boast that backfires straight away;
- people cracking up at something that was said in these lines.

What does NOT count, however loud or energetic:
- shouting, screaming, hype, celebrating or swearing with no joke in it;
- ordinary gameplay talk, commentary, instructions, greetings, reading chat or donations;
- a line that only works if you saw something earlier, or something on screen, that these lines do not show;
- a laughter tag on its own, when the lines do not show what was funny.

Read the lines around a moment before choosing it. A punchline is only worth clipping together with its setup, so find where the setup starts and where the payoff and the reaction to it end.

For each moment:
- "setup_line": the first line a stranger needs in order to get the joke.
- "punch_line": the line where the funny thing lands.
- "end_line": the last line to keep: the punchline and the immediate reaction to it, nothing after the payoff.
- "quote": copied word for word from the lines you chose, at least 4 words in a row, taken from the punchline where possible.
- "humor_type": the kind of humor.
- "tone": how the key line is meant: "sincere", "sarcastic", "joking" or "unclear".
- "why_funny": one sentence naming the joke: what is expected, and how it is turned around. If you cannot name the joke, do not return the moment.
- "funny" 0-10: 9-10 a line people would quote and send to a friend; 7-8 a clear joke or exchange that lands; 5-6 lively or mildly amusing with no real punchline; 0-4 not a joke.
- "standalone" 0-10: how well a stranger follows it from these lines alone.
- "confidence" 0-1: how sure you are from text alone.
- "label": a plain 2-3 word description.
- "risks": flag anything built on slurs, sexual content, graphic violence or dangerous stunts.

Rules:
- Return only moments you score 7 or higher for "funny", and at most ${MAX_PER_WINDOW}. An empty list is the normal, expected answer for most sets of lines.
- Use only the lines you are given. Never invent events, dialogue or reactions.
- Line numbers come from the first column.`;

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['reviews'],
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'punchline', 'mechanism', 'joke', 'verdict', 'humor', 'standalone', 'payoff', 'tone', 'humor_type', 'start_line', 'end_line', 'flags', 'risks'],
        properties: {
          id: integer,
          punchline: {type: 'string'},
          mechanism: {type: 'string', enum: MECHANISMS},
          joke: {type: 'string'},
          verdict: {type: 'string', enum: VERDICTS},
          humor: number,
          standalone: number,
          payoff: number,
          tone: {type: 'string', enum: TONES},
          humor_type: {type: 'string', enum: HUMOR_TYPES},
          start_line: integer,
          end_line: integer,
          flags: {type: 'array', items: {type: 'string', enum: Object.keys(FLAG_PENALTY)}},
          risks,
        },
      },
    },
  },
};

const REVIEW_SYSTEM = `You are the second, independent judge for a comedy clips channel. Another editor proposed the clips below from a livestream. You are not told why: decide for yourself from the captions. Be fair in both directions: reject what has no joke in it, and give full credit to what does. The channel would rather post three hilarious clips than twenty mediocre ones.

Each proposal lists caption lines with line numbers and times. Lines starting with ">" are the proposed clip. The other lines are what was said just before and after: the viewer will NOT see them. Tags such as [laughter] mark sounds, "[ __ ]" is a censored swear word and ">>" marks a change of speaker.

How to read them:
- Captions carry no tone of voice. People are often sarcastic, teasing or exaggerating, so ask what a line MEANS, not what it literally says.
- Streamers often play characters and bits. An obviously made-up name, a ridiculous excuse or a claim nobody could believe is a joke, not a fact.
- Quiet humor counts fully. A deadpan reply, a dry one-liner, a witty comeback or an ironic observation is as good as a loud moment, and often better. Never mark a clip down for being calm.
- Loud is not funny. Shouting, swearing, hype, celebrating or raging earns nothing unless there is a joke in what is said.

Work through each proposal in this order:
1. "punchline": copy the funniest line of the clip word for word: the comeback, the ironic remark, the absurd excuse, the line the others react to. Use "" if no line stands out.
2. "mechanism": how it is funny: "comeback" (a reply that deflates what was just said), "irony" (the opposite of what is meant, or a contradiction someone points out), "absurdity", "self_own" (the speaker undercuts or exposes themselves), "exaggeration", "roast", "misunderstanding", "running_joke", "fail", "reaction" (people cracking up at something shown in the lines), or "none".
3. "joke": one sentence saying what is set up and how the punchline turns it. If there is none, say what the clip actually is ("he shouts at the game", "they arrange a meeting").
4. "humor" 0-10, judged by the joke and not by the volume:
   8-10  a quotable punchline or an exchange that builds and pays off; viewers would repeat the line;
   6-7   a real joke: a clear setup and a punchline that turns it; a stranger would smile or laugh;
   4-5   a funny phrase or lively energy, but no real setup and punchline, or the joke is muddled;
   0-3   no joke: ordinary talk, logistics, hype, shouting.
5. "verdict": "funny" for 6 and up, "weak" for 4-5, "not_funny" for 0-3. Use "unsure" only when it may well be funny but depends on tone of voice or on something on screen that captions cannot show.
6. "standalone" 0-10: would a stranger who never watched this streamer follow it from the ">" lines alone?
7. "payoff" 0-10: does the clip contain the punchline and stop soon after it?
8. "tone": how the key line is meant: "sincere", "sarcastic", "joking" or "unclear".
9. "humor_type": the kind of humor, or "other".
10. "start_line" and "end_line": the best first and last line for the clip. If the setup is in the lines above the clip, move "start_line" up to where the setup begins. If the punchline or the reaction to it runs on below, move "end_line" down. If the clip rambles before the setup or after the payoff, trim it. Keep it as short as the joke allows. If the proposal is already right, repeat its own first and last ">" line numbers.
11. "flags": every problem that applies: "ordinary_talk" (no joke at all), "just_loud" (energy with no joke), "missing_setup" (the setup is nowhere in the lines shown), "no_payoff", "inside_joke", "visual_only" (the funny part is on screen, not in the words), "dead_air", "rambling".
12. "risks": anything built on slurs, sexual content, graphic violence or dangerous stunts.

Judge only what the lines show, and return one entry for every proposal, using its number as "id".`;

const RANK_SCHEMA = {
  type: 'object',
  required: ['order', 'repeats'],
  properties: {order: {type: 'array', items: integer}, repeats: {type: 'array', items: {type: 'array', items: integer}}},
};

const RANK_SYSTEM = `You decide which clips a comedy channel posts first. Each numbered item is the caption text of one clip; all are from the same livestream and all have already passed review.
- "order": every clip number exactly once, from the funniest for a stranger to the least funny. Judge the joke, not the volume.
- "repeats": pairs of clip numbers that are the same joke or the same bit told twice, for example [[0, 3]]. Use an empty list if there are none.`;

export const formatLines = (lines) => lines.map((line) => `${line.i}\t${clock(line.start)}\t${line.text}`).join('\n');

const MIN_QUOTE_WORDS = 4;
const toInt = (value) => (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value);
const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const cleanRisks = (list) => [...new Set((Array.isArray(list) ? list : []).filter((risk) => RISKS.includes(risk) && risk !== 'none'))];

/** The longest run of consecutive words that the model's quote and the real caption text share. */
export const longestSharedRun = (quote, text) => {
  const a = quote.split(' ').filter(Boolean);
  const b = text.split(' ').filter(Boolean);
  let best = [];
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = previous[j - 1] + 1;
        if (row[j] > best.length) {
          best = b.slice(j - row[j], j);
        }
      }
    }
    previous = row;
  }
  return best;
};

/** Start, end and text of a run of caption lines. Times always come from the captions, never from a model. */
const span = (lines, from, to) => {
  const chosen = lines.slice(from, to + 1);
  return {start: Math.max(0, chosen[0].start - 0.25), end: chosen.at(-1).end + 0.35, text: chosen.map((line) => line.text).join(' ')};
};

/**
 * Check one suggestion from the first model against the real transcript. A quote that is not in
 * the lines it cites, or a punchline outside its own clip, is rejected.
 */
export const validateCandidate = (raw, lines, {min = CLIP_SECONDS.min, max = CLIP_SECONDS.max} = {}) => {
  const reject = (reason) => ({ok: false, reason});
  const [from, punch, to] = [toInt(raw?.setup_line), toInt(raw?.punch_line), toInt(raw?.end_line)];
  if (![from, punch, to].every(Number.isInteger) || from < 0 || to >= lines.length || to < from) {
    return reject('line numbers missing or out of range');
  }
  if (punch < from || punch > to) {
    return reject('the punchline is outside the clip it belongs to');
  }
  const {start, end, text} = span(lines, from, to);
  const verified = longestSharedRun(normalize(String(raw.quote ?? '')), normalize(text));
  if (verified.length < MIN_QUOTE_WORDS) {
    return reject('quote is not in the transcript lines it cites');
  }
  if (end - start < min || end - start > max) {
    return reject(`length ${(end - start).toFixed(1)}s is outside ${min}-${max}s`);
  }
  const [funny, standalone, confidence] = [Number(raw.funny), Number(raw.standalone), Number(raw.confidence)];
  if (!inRange(funny, 0, 10) || !inRange(standalone, 0, 10)) {
    return reject('scores missing or out of range');
  }
  if (!inRange(confidence, 0, 1)) {
    return reject('confidence missing or out of range');
  }
  const reason = String(raw.why_funny ?? '').trim();
  if (reason.length < 10) {
    return reject('no reason given');
  }
  const humorType = HUMOR_TYPES.includes(raw.humor_type) ? raw.humor_type : 'other';
  return {
    ok: true,
    moment: {
      startLine: from,
      punchLine: punch,
      endLine: to,
      start,
      end,
      text,
      // Until the second model has reviewed it, a moment only carries the first model's own opinion.
      score: funny,
      confidence,
      reason: reason.slice(0, 500),
      label: String(raw.label ?? '').trim().slice(0, 40),
      quote: verified.join(' ').slice(0, 300),
      risks: cleanRisks(raw.risks),
      humorType,
      discovery: {funny, standalone, tone: TONES.includes(raw.tone) ? raw.tone : 'unclear', humorType, confidence},
      review: null,
    },
  };
};

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const wordSet = (text) => new Set(normalize(text).split(' ').filter((word) => word.length > 2));
const sameWords = (a, b) => {
  const [x, y] = [wordSet(a.text), wordSet(b.text)];
  if (x.size < 6 || y.size < 6) {
    return false;
  }
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / (x.size + y.size - shared) >= 0.7;
};

/**
 * Overlapping windows can propose the same moment twice, and a streamer can repeat a bit almost
 * word for word. Keep the better one; the others are reported as duplicates.
 */
export const dedupe = (moments) => {
  const kept = [];
  const duplicates = [];
  for (const moment of [...moments].sort((a, b) => b.score - a.score)) {
    const clash = kept.some((other) => overlap(moment, other) > 0.5 * Math.min(moment.end - moment.start, other.end - other.start) || sameWords(moment, other));
    (clash ? duplicates : kept).push(moment);
  }
  return {kept, duplicates};
};

const calibrationNote = (examples) =>
  examples?.length > 0 ? `The channel owner has rated earlier clips. Match their taste:\n${examples.map((example) => `- ${example.verdict}: "${example.text}"`).join('\n')}\n\n` : '';

/** One proposal as the reviewer sees it: the clip lines marked, with what was said just before and after. */
export const formatProposal = (moment, lines, id) => {
  const from = Math.max(0, moment.startLine - CONTEXT_BEFORE);
  const to = Math.min(lines.length - 1, moment.endLine + CONTEXT_AFTER);
  const body = lines
    .slice(from, to + 1)
    .map((line) => `${line.i >= moment.startLine && line.i <= moment.endLine ? '>' : ' '} ${line.i}\t${clock(line.start)}\t${line.text}`)
    .join('\n');
  return {from, to, text: `Proposal ${id}\n${body}`};
};

/** Take the reviewer's better clip boundaries, when they are real lines around the same punchline and still a usable length. */
const applyBoundaries = (moment, entry, shown, lines) => {
  const [from, to] = [toInt(entry.start_line), toInt(entry.end_line)];
  if (![from, to].every(Number.isInteger) || from < shown.from || to > shown.to || from > moment.punchLine || to < moment.punchLine) {
    return null;
  }
  if (from === moment.startLine && to === moment.endLine) {
    return null;
  }
  const next = span(lines, from, to);
  if (next.end - next.start < CLIP_SECONDS.min || next.end - next.start > CLIP_SECONDS.max) {
    return null;
  }
  const change = {setupAdded: from < moment.startLine, reactionAdded: to > moment.endLine, trimmed: from > moment.startLine || to < moment.endLine, was: [moment.startLine, moment.endLine]};
  Object.assign(moment, {startLine: from, endLine: to, ...next});
  return change;
};

const readReview = (entry) => {
  const [humor, standalone, payoff] = [Number(entry.humor), Number(entry.standalone), Number(entry.payoff)];
  if (!VERDICTS.includes(entry.verdict) || ![humor, standalone, payoff].every((score) => inRange(score, 0, 10))) {
    return null;
  }
  return {
    verdict: entry.verdict,
    humor,
    standalone,
    payoff,
    tone: TONES.includes(entry.tone) ? entry.tone : 'unclear',
    humorType: HUMOR_TYPES.includes(entry.humor_type) ? entry.humor_type : 'other',
    joke: String(entry.joke ?? '').trim().slice(0, 300),
    punchline: String(entry.punchline ?? '').trim().slice(0, 200),
    mechanism: MECHANISMS.includes(entry.mechanism) ? entry.mechanism : 'none',
    flags: [...new Set((Array.isArray(entry.flags) ? entry.flags : []).filter((flag) => flag in FLAG_PENALTY))],
  };
};

/**
 * The second model judges every proposal for itself, seeing the lines around it but not the first
 * model's reasons or scores. Fills in moment.review; a moment it could not judge keeps review = null.
 */
export const reviewMoments = async ({llm, model, moments, lines, creatorName, title, examples, log = () => {}}) => {
  let lastError = null;
  const reviewBatch = async (batch) => {
    const shown = batch.map((moment, id) => formatProposal(moment, lines, id));
    const reply = await llm.json({
      model,
      schema: REVIEW_SCHEMA,
      messages: [
        {role: 'system', content: REVIEW_SYSTEM},
        {role: 'user', content: `Creator: ${creatorName}\nStream title: ${title}\n\n${calibrationNote(examples)}${shown.map((proposal) => proposal.text).join('\n\n')}`},
      ],
    });
    for (const entry of Array.isArray(reply.reviews) ? reply.reviews : []) {
      const moment = batch[toInt(entry?.id)];
      const review = moment && !moment.review ? readReview(entry) : null;
      if (!review) {
        continue;
      }
      moment.review = review;
      moment.risks = [...new Set([...moment.risks, ...cleanRisks(entry.risks)])];
      moment.boundary = applyBoundaries(moment, entry, shown[toInt(entry.id)], lines);
    }
  };
  const run = async (pending, size) => {
    const batches = [];
    for (let i = 0; i < pending.length; i += size) {
      batches.push(pending.slice(i, i + size));
    }
    const lane = async () => {
      while (batches.length > 0) {
        const batch = batches.shift();
        try {
          await reviewBatch(batch);
        } catch (err) {
          lastError = err;
          log('warn', `Second opinion unavailable for ${batch.length} proposal(s): ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(REVIEWS_AT_ONCE, batches.length)}, lane));
  };
  await run(moments, REVIEW_BATCH);
  // Anything the reviewer skipped or failed on gets one more try, one proposal at a time.
  await run(moments.filter((moment) => !moment.review), 1);
  const unreviewed = moments.filter((moment) => !moment.review).length;
  // With most proposals unjudged there is no review to speak of: fail, so the stream is retried later.
  if (lastError && unreviewed > moments.length / 2) {
    throw lastError;
  }
  return {unreviewed};
};

/** Keep the first seconds of laughter or applause that follow the clip, so it does not cut off the reaction. */
const keepReaction = (moment, lines) => {
  const next = lines[moment.endLine + 1];
  if (!next || next.start - lines[moment.endLine].end > REACTION_GAP || !REACTION_TAG.test(next.text)) {
    return false;
  }
  const end = Math.min(next.start + REACTION_KEEP, moment.start + CLIP_SECONDS.max);
  if (end <= moment.end) {
    return false;
  }
  moment.end = end;
  return true;
};

const toneConflict = (a, b) => (a === 'sincere' && ['sarcastic', 'joking'].includes(b)) || (b === 'sincere' && ['sarcastic', 'joking'].includes(a));

/**
 * Turn the two models' opinions into one humor-first score and a status:
 *   candidate  both models find it funny: it may be used in a Short;
 *   uncertain  it may be funny, but the models could not agree or could not tell: never used automatically;
 *   rejected   not funny enough, with the reason.
 * Score = 60% humor (reviewer 60%, first model 40%) + 20% standalone + 20% payoff, minus a penalty
 * for each problem the reviewer flagged, plus a little when the captions show people laughing.
 */
export const decide = (moment, lines, {minHumor, minScore, typeBias = {}}) => {
  const {discovery, review} = moment;
  const reactionKept = keepReaction(moment, lines);
  const laughter = reactionKept || lines.slice(moment.punchLine, moment.endLine + 1).some((line) => hasLaughter(line.text));
  const settle = (status, rejectReason, extra = {}) => Object.assign(moment, {status, rejectReason, details: {discovery, review, laughter, reactionKept, boundary: moment.boundary ?? null, ...extra}});

  if (!review) {
    moment.score = discovery.funny * 0.6;
    moment.confidence *= 0.5;
    return settle('uncertain', 'the second model could not review it, so it is not used automatically');
  }
  // A problem the reviewer fixed by moving the clip's start or end no longer counts against it.
  const fixed = [moment.boundary?.setupAdded && 'missing_setup', moment.boundary?.reactionAdded && 'no_payoff', moment.boundary?.trimmed && 'rambling', moment.boundary?.trimmed && 'dead_air'];
  const flags = review.flags.filter((flag) => !fixed.includes(flag));
  const penalty = Math.min(MAX_PENALTY, flags.reduce((sum, flag) => sum + FLAG_PENALTY[flag], 0));
  const ownerTaste = typeBias[review.humorType] ?? 0;
  const humor = 0.4 * discovery.funny + 0.6 * review.humor;
  moment.score = clamp(0.6 * humor + 0.2 * review.standalone + 0.2 * review.payoff - penalty + (laughter ? LAUGHTER_BONUS : 0) + ownerTaste, 0, 10);
  moment.humorType = review.humorType === 'other' ? discovery.humorType : review.humorType;
  const extra = {humor: Number(humor.toFixed(2)), penalty, flags, ownerTaste};

  const blocking = flags.find((flag) => flag in REJECT_FLAGS);
  if (review.verdict === 'not_funny') {
    return settle('rejected', `second model: no joke here (${review.joke || 'none found'})`, extra);
  }
  if (blocking) {
    return settle('rejected', `second model: ${REJECT_FLAGS[blocking]}`, extra);
  }
  if (review.humor < minHumor) {
    return settle('rejected', review.verdict === 'weak' ? `second model: too weak, humor ${review.humor} of 10 (${review.joke || 'mildly amusing at best'})` : `second model rated the humor ${review.humor}, below the minimum of ${minHumor}`, extra);
  }
  if (review.standalone < MIN_STANDALONE) {
    return settle('rejected', `a stranger would not follow it: standalone ${review.standalone} of 10`, extra);
  }
  if (moment.score < minScore) {
    return settle('rejected', `score ${moment.score.toFixed(1)} is below the threshold of ${minScore}`, extra);
  }
  if (review.verdict === 'unsure') {
    moment.confidence *= 0.7;
    return settle('uncertain', 'the second model could not tell from captions alone whether it is funny', extra);
  }
  if (toneConflict(discovery.tone, review.tone)) {
    moment.confidence *= 0.7;
    return settle('uncertain', `the models read the tone differently (${discovery.tone} vs ${review.tone}), so one of them may be taking sarcasm literally`, extra);
  }
  if (Math.abs(discovery.funny - review.humor) >= DISAGREEMENT) {
    moment.confidence *= 0.7;
    return settle('uncertain', `the models disagree on how funny it is (${discovery.funny} vs ${review.humor})`, extra);
  }
  return settle('candidate', null, extra);
};

/**
 * Side by side, the second model orders the surviving clips of one stream and points out repeats.
 * The order nudges each score by at most ±0.5; a repeat of a better clip is rejected.
 */
export const rankSurvivors = async ({llm, model, moments, log = () => {}}) => {
  const survivors = moments.filter((moment) => moment.status === 'candidate').sort((a, b) => a.start - b.start);
  if (survivors.length < RANK_MIN) {
    return;
  }
  let reply;
  try {
    reply = await llm.json({
      model,
      schema: RANK_SCHEMA,
      messages: [
        {role: 'system', content: RANK_SYSTEM},
        {role: 'user', content: survivors.map((moment, id) => `${id}. ${moment.text}`).join('\n\n')},
      ],
    });
  } catch (err) {
    log('warn', `Second opinion unavailable for the ranking, so the review scores stand as they are: ${err.message}`);
    return;
  }
  const order = (Array.isArray(reply.order) ? reply.order : []).map(toInt);
  if (order.length !== survivors.length || new Set(order).size !== order.length || !order.every((id) => Number.isInteger(id) && id >= 0 && id < survivors.length)) {
    log('warn', 'Ranking ignored: the second model did not return every clip exactly once.');
    return;
  }
  order.forEach((id, position) => {
    const moment = survivors[id];
    moment.details.rank = position + 1;
    moment.score = clamp(moment.score + RANK_SPREAD * (1 - (2 * position) / (order.length - 1)), 0, 10);
  });
  for (const pair of Array.isArray(reply.repeats) ? reply.repeats : []) {
    const [a, b] = (Array.isArray(pair) ? pair : []).map(toInt).map((id) => survivors[id]);
    if (!a || !b || a === b || a.status !== 'candidate' || b.status !== 'candidate') {
      continue;
    }
    const [better, worse] = a.details.rank <= b.details.rank ? [a, b] : [b, a];
    Object.assign(worse, {status: 'rejected', rejectReason: `repeats the same joke as a better clip at ${clock(better.start)}`});
  }
};

/** Step 1: the first model reads the stream window by window and proposes only what it finds funny. */
export const discover = async ({llm, lines, creatorName, title, settings, examples, log = () => {}}) => {
  const windows = prioritizeWindows(lines, makeWindows(lines.length), settings['analysis.maxWindows']);
  const accepted = [];
  const rejected = [];
  let failedWindows = 0;
  let lastError = null;
  for (const window of windows) {
    let reply;
    try {
      reply = await llm.json({
        model: settings['analysis.model'],
        schema: DISCOVER_SCHEMA,
        messages: [
          {role: 'system', content: DISCOVER_SYSTEM},
          {role: 'user', content: `Creator: ${creatorName}\nStream title: ${title}\n\n${calibrationNote(examples)}Lines:\n${formatLines(lines.slice(window.from, window.to))}`},
        ],
      });
    } catch (err) {
      failedWindows += 1;
      lastError = err;
      log('warn', `Analysis of lines ${window.from}-${window.to} failed: ${err.message}`);
      if (failedWindows > Math.max(2, windows.length / 4)) {
        throw err;
      }
      continue;
    }
    for (const raw of (Array.isArray(reply.moments) ? reply.moments : []).slice(0, MAX_PER_WINDOW)) {
      const [from, to] = [toInt(raw?.setup_line), toInt(raw?.end_line)];
      const shown = Number.isInteger(from) && Number.isInteger(to) && from >= window.from && to < window.to;
      const result = shown ? validateCandidate(raw, lines) : {ok: false, reason: 'cites lines it was not shown'};
      if (result.ok) {
        accepted.push(result.moment);
      } else {
        rejected.push({reason: result.reason, startLine: from ?? null, endLine: to ?? null, quote: String(raw?.quote ?? '').slice(0, 120)});
      }
    }
  }
  // Too little of the stream was actually read to say what is in it: fail, so it is retried.
  if (failedWindows > 0 && failedWindows >= windows.length / 2) {
    throw lastError;
  }
  return {accepted, rejected, windows: windows.length, failedWindows};
};

/**
 * Judge a whole transcript in three steps: the first model proposes funny moments, the second
 * model reviews each one independently with its surrounding lines, then ranks the survivors.
 * Every returned moment has a status ('candidate', 'uncertain' or 'rejected') and, when it is
 * not a candidate, the reason. `discovered` lets a retry reuse step 1 instead of repeating it.
 */
export const judgeSource = async ({llm, lines, creatorName, title, settings, calibration = {}, discovered = null, onDiscovered = () => {}, watch = null, log = () => {}}) => {
  const {examples = [], typeBias = {}} = calibration;
  const found = discovered ?? (await discover({llm, lines, creatorName, title, settings, examples, log}));
  if (!discovered) {
    onDiscovered(found);
  }
  const {kept: moments, duplicates} = dedupe(found.accepted.map((moment) => ({...moment, risks: [...moment.risks], review: null})));
  const {unreviewed} = await reviewMoments({llm, model: settings['analysis.secondModel'], moments, lines, creatorName, title, examples, log});
  for (const moment of moments) {
    decide(moment, lines, {minHumor: settings['analysis.minHumor'], minScore: settings['analysis.minScore'], typeBias});
  }
  // Watching the shortlisted moments (when the pipeline provides a way to) comes before the final ranking.
  const watched = watch ? await watch(moments) : null;
  await rankSurvivors({llm, model: settings['analysis.secondModel'], moments, log});
  moments.sort((a, b) => b.score - a.score);
  const rejected = [...found.rejected, ...duplicates.map((moment) => ({reason: 'duplicate of a better moment', startLine: moment.startLine, endLine: moment.endLine, quote: moment.quote.slice(0, 120)}))];
  return {moments, rejected, windows: found.windows, failedWindows: found.failedWindows, proposed: found.accepted.length, unreviewed, watched};
};
