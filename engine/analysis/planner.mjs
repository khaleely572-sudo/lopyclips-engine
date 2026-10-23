// Two long, strong moments make a better Short than three where the third is filler.
const MIN_CLIPS = 2;
const MAX_CLIPS = 6;
const HEADER_MAX = 22;
const LABEL_MAX = 18;
/** Once a Short is long enough, a moment scoring this much below its weakest clip is left out rather than used to fill time. */
const CLEARLY_WEAKER = 1;

const length = (moment) => moment.end - moment.start;
const total = (moments) => moments.reduce((sum, moment) => sum + length(moment), 0);

/**
 * Choose the best-scoring moments that fit one Short. Returns them in stream order,
 * or null when there is not enough good material; a thin Short is never padded. Clips keep
 * their natural length: only the Short as a whole has to fit the length settings.
 */
export const selectMoments = (candidates, {targetSeconds, minSeconds, maxSeconds}) => {
  const chosen = [];
  for (const moment of [...candidates].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= MAX_CLIPS) {
      break;
    }
    const longEnough = chosen.length >= MIN_CLIPS && total(chosen) >= minSeconds;
    if (longEnough && moment.score < Math.min(...chosen.map((other) => other.score)) - CLEARLY_WEAKER) {
      break;
    }
    const tooClose = chosen.some((other) => moment.start < other.end + 3 && other.start < moment.end + 3);
    if (tooClose || total(chosen) + length(moment) > maxSeconds) {
      continue;
    }
    chosen.push(moment);
    if (chosen.length >= MIN_CLIPS && total(chosen) >= targetSeconds - 4) {
      break;
    }
  }
  if (chosen.length < MIN_CLIPS || total(chosen) < minSeconds) {
    return null;
  }
  return chosen.sort((a, b) => a.start - b.start);
};

const ARRANGE_SCHEMA = {
  type: 'object',
  required: ['header', 'order', 'labels'],
  properties: {
    header: {type: 'string'},
    order: {type: 'array', items: {type: 'integer'}},
    labels: {type: 'array', items: {type: 'object', required: ['id', 'label'], properties: {id: {type: 'integer'}, label: {type: 'string'}}}},
  },
};

const ARRANGE_SYSTEM = `You are planning one short vertical video from several clips of the same livestream. The clips are numbered and listed in the order they happened.
Decide the order that tells the clearest story: open on the clip that hooks fastest and needs no setup, and end on the strongest payoff. Keep stream order unless changing it clearly helps. You may leave a clip out of "order" only if it does not fit the others or repeats one.
Write:
- "header": 2 to 4 words describing what actually happens across the clips, at most ${HEADER_MAX} characters.
- one "label" per clip: a plain description of that clip, at most ${LABEL_MAX} characters.
Describe only what the text shows. Do not invent events, and do not suggest the creator endorses anything.`;

const tidy = (text, max) => {
  const clean = String(text ?? '').replace(/["<>]/g, '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toUpperCase();
  if (clean.length <= max) {
    return clean;
  }
  const cut = clean.slice(0, max + 1);
  return (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : clean.slice(0, max)).trim();
};

/**
 * Ask the model to order and label the chosen moments. Its answer is only accepted when it
 * is a valid arrangement that still fills a Short; otherwise stream order is used.
 */
export const arrangeShort = async ({llm, model, moments, creatorName, limits, log = () => {}}) => {
  const fallbackLabel = (moment, i) => tidy(moment.label || `CLIP ${i + 1}`, LABEL_MAX) || `CLIP ${i + 1}`;
  const fallback = {
    header: tidy(`${creatorName} MOMENTS`, HEADER_MAX) || 'BEST MOMENTS',
    clips: moments.map((moment, i) => ({moment, label: fallbackLabel(moment, i)})),
    arrangedBy: 'stream order',
  };
  let reply;
  try {
    reply = await llm.json({
      model,
      schema: ARRANGE_SCHEMA,
      messages: [
        {role: 'system', content: ARRANGE_SYSTEM},
        {role: 'user', content: `Creator: ${creatorName}\n\n${moments.map((moment, id) => `${id}. (${length(moment).toFixed(0)}s) ${moment.text}`).join('\n\n')}`},
      ],
    });
  } catch (err) {
    log('warn', `Arrangement unavailable, using stream order: ${err.message}`);
    return fallback;
  }
  const order = Array.isArray(reply.order) ? reply.order : [];
  const valid = order.length >= MIN_CLIPS && new Set(order).size === order.length && order.every((id) => Number.isInteger(id) && id >= 0 && id < moments.length);
  const ordered = valid ? order.map((id) => moments[id]) : moments;
  if (!valid || total(ordered) < limits.minSeconds) {
    return {...fallback, header: tidy(reply.header, HEADER_MAX) || fallback.header};
  }
  const labels = new Map((Array.isArray(reply.labels) ? reply.labels : []).map((entry) => [entry.id, entry.label]));
  return {
    header: tidy(reply.header, HEADER_MAX) || fallback.header,
    clips: ordered.map((moment, i) => ({moment, label: tidy(labels.get(moments.indexOf(moment)), LABEL_MAX) || fallbackLabel(moment, i)})),
    arrangedBy: 'model',
  };
};
