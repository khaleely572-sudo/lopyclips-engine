import {isCensored, isTag} from '../sources/transcript.mjs';

const round = (n) => Math.round(n * 100) / 100;

/** Group caption words into short on-screen chunks, breaking at speaker changes, pauses and sentence ends. */
export const chunkWords = (words) => {
  const groups = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  };
  for (const word of words) {
    if (current.length > 0) {
      const last = current.at(-1);
      const chars = current.reduce((sum, w) => sum + w.w.length, 0) + word.w.length;
      if (word.sp || word.t - last.t > 0.9 || current.length >= 4 || chars > 16 || /[.?!]$/.test(last.w)) {
        flush();
      }
    }
    current.push(word);
  }
  flush();
  return groups.map((group, i) => {
    let end = group.at(-1).e + 0.35;
    if (i + 1 < groups.length) {
      end = Math.min(end, groups[i + 1][0].t);
    }
    const shown = group.map(({t, e, w}) => ({t, e, w}));
    shown.at(-1).e = round(Math.max(shown.at(-1).e, end));
    return {s: group[0].t, e: round(end), words: shown};
  });
};

/**
 * Captions for one clip, timed from the clip's start. Reaction tags are dropped, censored
 * swear words are left out of the text and returned as ranges to mute.
 */
export const buildCaptions = (words, start, end, fixes = {}) => {
  const shown = [];
  const mutes = [];
  let censored = 0;
  let musicTags = 0;
  for (const word of words) {
    if (word.t < start || word.t >= end) {
      continue;
    }
    const speaker = word.w.startsWith('>>');
    let text = word.w.replace(/^>>\s*/, '').trim();
    if (!text) {
      continue;
    }
    const t = word.t - start;
    const e = Math.min(word.e, end) - start;
    if (isTag(text)) {
      musicTags += text.toLowerCase() === '[music]' ? 1 : 0;
      continue;
    }
    if (isCensored(text)) {
      censored += 1;
      mutes.push([round(Math.max(0, t - 0.05)), round(Math.min(e, t + 0.45))]);
      continue;
    }
    text = Object.hasOwn(fixes, text) ? fixes[text] : text;
    if (text) {
      shown.push({t: round(t), e: round(e), w: text, sp: speaker});
    }
  }
  return {chunks: chunkWords(shown), mutes, censored, musicTags, wordCount: shown.length, text: shown.map((word) => word.w).join(' ')};
};
