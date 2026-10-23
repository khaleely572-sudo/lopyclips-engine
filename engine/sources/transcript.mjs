const TAG = /^\[[a-z ]+\]$/i;

export const isTag = (text) => TAG.test(text);
export const isCensored = (text) => text.includes('__');

/** YouTube json3 captions -> [{t, e, w}] with times in seconds. */
export const parseJson3 = (data) => {
  const words = [];
  for (const event of data?.events ?? []) {
    const base = event.tStartMs ?? 0;
    for (const seg of event.segs ?? []) {
      const text = (seg.utf8 ?? '').trim();
      if (text) {
        words.push({t: (base + (seg.tOffsetMs ?? 0)) / 1000, w: text});
      }
    }
  }
  words.forEach((word, i) => {
    const next = i + 1 < words.length ? words[i + 1].t : word.t + 0.5;
    word.e = Math.min(next, word.t + 1.2);
  });
  return words;
};

/**
 * Group caption words into sentence-sized lines. Cuts are only ever made on line
 * boundaries, which keeps clips from starting or ending mid-sentence.
 */
export const buildLines = (words) => {
  const lines = [];
  let current = null;
  const flush = () => {
    if (current) {
      lines.push({i: lines.length, start: current.start, end: current.end, text: current.parts.join(' ')});
      current = null;
    }
  };
  for (const word of words) {
    const speakerChange = word.w.startsWith('>>');
    const text = word.w.replace(/^>>\s*/, '').trim();
    if (!text) {
      continue;
    }
    if (current) {
      const sentenceEnded = /[.?!]$/.test(current.parts.at(-1));
      if (speakerChange || word.t - current.lastStart > 1.5 || (sentenceEnded && current.count >= 8) || current.count >= 24) {
        flush();
      }
    }
    if (!current) {
      current = {start: word.t, end: word.e, parts: [], count: 0, lastStart: word.t};
      if (speakerChange) {
        current.parts.push('>>');
      }
    }
    current.parts.push(text);
    current.end = word.e;
    current.lastStart = word.t;
    current.count += text.split(/\s+/).length;
  }
  flush();
  return lines;
};

export const clock = (seconds) => {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Lowercase letters and digits only, single-spaced: used to check that a quote really is in the transcript. */
export const normalize = (text) =>
  text
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
