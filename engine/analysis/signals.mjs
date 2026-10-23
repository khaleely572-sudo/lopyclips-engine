// Laughter is the only sound tag that says something was funny. Screaming and cheering only say it was loud.
const TAG_WEIGHT = {'[laughter]': 4, '[applause]': 1.5, '[cheering]': 1, '[gasps]': 1, '[screaming]': 0.5};
const LAUGH_TAG = /\[(laughter|laughs|laughing)\]/i;
/** Share of the window budget given to the parts with the most laughter and back-and-forth; the rest is spread over the stream. */
const SIGNAL_SHARE = 0.6;

export const hasLaughter = (text) => LAUGH_TAG.test(text);

/**
 * Rough "this stretch is worth reading" score for one caption line. It only decides which parts of
 * a very long stream get read at all; it never selects a clip. Loudness counts for almost nothing.
 */
export const lineSignal = (text) => {
  let score = 0;
  for (const [tag, weight] of Object.entries(TAG_WEIGHT)) {
    score += weight * (text.toLowerCase().split(tag).length - 1);
  }
  // A change of speaker: banter, roasts and comebacks need two people talking.
  score += Math.min(1.5, (text.match(/>>/g) ?? []).length * 0.75);
  const words = text.split(/\s+/).filter((word) => /[a-z]/i.test(word) && !word.startsWith('['));
  const shouted = words.filter((word) => word.length > 2 && word === word.toUpperCase()).length;
  score += Math.min(0.5, shouted * 0.1);
  return score;
};

/** Split line indexes into overlapping windows small enough for one model call. */
export const makeWindows = (lineCount, size = 90, overlap = 10) => {
  const windows = [];
  for (let from = 0; from < lineCount; from += size - overlap) {
    windows.push({from, to: Math.min(lineCount, from + size)});
    if (from + size >= lineCount) {
      break;
    }
  }
  return windows;
};

/**
 * When a stream has more windows than the budget allows, read the ones with the most laughter and
 * conversation, plus an even spread of the rest: dry humor and sarcasm leave no sound tag, so
 * the quiet parts of the stream must still be sampled. Returned in stream order.
 */
export const prioritizeWindows = (lines, windows, max) => {
  if (windows.length <= max) {
    return windows;
  }
  const scored = windows.map((window) => ({
    window,
    score: lines.slice(window.from, window.to).reduce((sum, line) => sum + lineSignal(line.text), 0),
  }));
  const bySignal = Math.max(1, Math.round(max * SIGNAL_SHARE));
  const keep = new Set(scored.sort((a, b) => b.score - a.score).slice(0, bySignal).map((entry) => entry.window));
  const rest = windows.filter((window) => !keep.has(window));
  const spread = max - keep.size;
  for (let i = 0; i < spread; i += 1) {
    keep.add(rest[Math.floor(((i + 0.5) * rest.length) / spread)]);
  }
  return windows.filter((window) => keep.has(window));
};
