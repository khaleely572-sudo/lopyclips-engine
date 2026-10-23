import {now} from '../db/db.mjs';

/**
 * The owner's ratings of individual moments. They teach the two models the channel's taste and
 * shift the ranking. They never approve, reject, publish or schedule anything.
 */
export const FEEDBACK_LABELS = {
  funny: 'Genuinely funny',
  not_funny: 'Not funny',
  good_sarcasm: 'Good sarcasm or witty remark',
  good_reaction: 'Good reaction',
  good_punchline: 'Good punchline',
  missing_context: 'Missing context',
  bad_boundaries: 'Poor editing or bad clip boundaries',
  duplicate: 'Duplicate or repetitive',
};
export const POSITIVE_LABELS = ['funny', 'good_sarcasm', 'good_reaction', 'good_punchline'];
export const NEGATIVE_LABELS = ['not_funny', 'missing_context', 'bad_boundaries', 'duplicate'];
/** A moment cannot be both; choosing one clears the other. */
const OPPOSITES = {funny: ['not_funny'], not_funny: POSITIVE_LABELS, good_sarcasm: ['not_funny'], good_reaction: ['not_funny'], good_punchline: ['not_funny']};

const EXAMPLE_VERDICT = {
  funny: 'FUNNY',
  good_sarcasm: 'FUNNY (good sarcasm or wit)',
  good_reaction: 'FUNNY (good reaction)',
  good_punchline: 'FUNNY (good punchline)',
  not_funny: 'NOT FUNNY',
  missing_context: 'REJECT (needs context the clip does not include)',
};
const EXAMPLES_PER_SIDE = 4;
const EXAMPLE_WORDS = 60;
const MIN_RATED_PER_TYPE = 3;
const MAX_TYPE_BIAS = 0.75;
export const LIKED_BOOST = 1;

export const getFeedback = (db, momentId) => db.all('SELECT label FROM moment_feedback WHERE moment_id = ? ORDER BY label', momentId).map((row) => row.label);

/** Every rating for a set of moments, as Map(momentId -> [labels]). */
export const feedbackByMoment = (db, momentIds) => {
  const map = new Map(momentIds.map((id) => [id, []]));
  if (momentIds.length === 0) {
    return map;
  }
  for (const row of db.all(`SELECT moment_id, label FROM moment_feedback WHERE moment_id IN (${momentIds.map(() => '?').join(',')}) ORDER BY label`, ...momentIds)) {
    map.get(row.moment_id).push(row.label);
  }
  return map;
};

/** Switch one rating on or off for a moment. Returns the moment's ratings afterwards. */
export const setFeedback = (db, momentId, label, on = true) => {
  if (!(label in FEEDBACK_LABELS)) {
    throw new Error('Unknown rating.');
  }
  if (!db.get('SELECT id FROM moments WHERE id = ?', momentId)) {
    throw new Error('Moment not found.');
  }
  db.tx(() => {
    if (!on) {
      db.run('DELETE FROM moment_feedback WHERE moment_id = ? AND label = ?', momentId, label);
      return;
    }
    for (const opposite of OPPOSITES[label] ?? []) {
      db.run('DELETE FROM moment_feedback WHERE moment_id = ? AND label = ?', momentId, opposite);
    }
    db.run('INSERT OR IGNORE INTO moment_feedback (moment_id, label, created_at) VALUES (?,?,?)', momentId, label, now());
  });
  return getFeedback(db, momentId);
};

/** How a moment's ratings change its place in the queue: disliked ones are skipped, liked ones go first. */
export const rankingEffect = (labels) => {
  if (labels.some((label) => NEGATIVE_LABELS.includes(label))) {
    return {skip: true, boost: 0};
  }
  return {skip: false, boost: labels.some((label) => POSITIVE_LABELS.includes(label)) ? LIKED_BOOST : 0};
};

const shorten = (text) => {
  const words = String(text ?? '').replace(/["\n]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > EXAMPLE_WORDS ? `${words.slice(0, EXAMPLE_WORDS).join(' ')}…` : words.join(' ');
};

/**
 * What the ratings teach the analysis of the next stream:
 *   examples  recent clips the owner liked and disliked, shown to both models as a guide to taste;
 *   typeBias  per kind of humor, a small score shift (at most ±0.75) once at least 3 clips of that
 *             kind have been rated, towards the kinds the owner keeps liking.
 * textOf(moment row) returns the clip's caption text, or null when the transcript is gone.
 */
export const buildCalibration = (db, textOf = () => null) => {
  const rows = db.all('SELECT m.*, f.label AS rating FROM moment_feedback f JOIN moments m ON m.id = f.moment_id ORDER BY f.created_at DESC, f.moment_id DESC');
  const byMoment = new Map();
  for (const row of rows) {
    const entry = byMoment.get(row.id) ?? {moment: row, labels: []};
    entry.labels.push(row.rating);
    byMoment.set(row.id, entry);
  }
  const rated = [...byMoment.values()];
  const liked = rated.filter((entry) => entry.labels.some((label) => POSITIVE_LABELS.includes(label)));
  const disliked = rated.filter((entry) => entry.labels.includes('not_funny') || entry.labels.includes('missing_context'));
  const toExample = (entry, order) => {
    const text = shorten(textOf(entry.moment) ?? entry.moment.quote);
    const label = order.find((key) => entry.labels.includes(key));
    return text ? {verdict: EXAMPLE_VERDICT[label], text} : null;
  };
  const examples = [
    ...liked.slice(0, EXAMPLES_PER_SIDE).map((entry) => toExample(entry, ['good_sarcasm', 'good_punchline', 'good_reaction', 'funny'])),
    ...disliked.slice(0, EXAMPLES_PER_SIDE).map((entry) => toExample(entry, ['not_funny', 'missing_context'])),
  ].filter(Boolean);

  const tally = {};
  for (const {moment, labels} of rated) {
    const good = labels.some((label) => POSITIVE_LABELS.includes(label));
    const bad = labels.includes('not_funny');
    if (!moment.humor_type || good === bad) {
      continue;
    }
    tally[moment.humor_type] ??= {good: 0, bad: 0};
    tally[moment.humor_type][good ? 'good' : 'bad'] += 1;
  }
  const typeBias = {};
  for (const [type, {good, bad}] of Object.entries(tally)) {
    if (good + bad >= MIN_RATED_PER_TYPE) {
      typeBias[type] = Number((((good - bad) / (good + bad)) * MAX_TYPE_BIAS).toFixed(2));
    }
  }
  return {examples, typeBias, rated: rated.length};
};
