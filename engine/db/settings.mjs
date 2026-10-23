export const VISIBILITIES = ['private', 'unlisted', 'public'];

const bool = (v) => typeof v === 'boolean';
const int = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const num = (min, max) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const clock = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const timezone = (v) => {
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: v});
    return typeof v === 'string';
  } catch {
    return false;
  }
};

/** Every setting, its default and its validator. Unknown keys are rejected. */
export const SETTINGS = {
  'automation.paused': [true, bool],
  'automation.emergencyStop': [false, bool],
  dryRun: [true, bool],
  requireApproval: [true, bool],
  'upload.visibility': ['private', (v) => VISIBILITIES.includes(v)],
  'upload.allowNonPrivate': [false, bool],
  'upload.categoryId': ['24', (v) => typeof v === 'string' && /^\d{1,3}$/.test(v)],
  'schedule.timezone': ['Asia/Riyadh', timezone],
  'schedule.intervalHours': [2, int(1, 24)],
  'schedule.maxPerSlot': [2, int(1, 2)],
  'schedule.dailyLimit': [12, int(0, 48)],
  'schedule.quietHours': [null, (v) => v === null || (v && clock(v.start) && clock(v.end))],
  'quota.insertPerDay': [100, int(1, 10000)],
  'discovery.minDurationMinutes': [20, int(1, 600)],
  'discovery.maxAgeDays': [14, int(1, 365)],
  'discovery.pollMinutes': [60, int(5, 1440)],
  'discovery.maxPerPoll': [15, int(1, 50)],
  'analysis.model': ['nim:nvidia/nemotron-3-ultra-550b-a55b', text],
  // The second model also watches frames of the shortlisted clips, so it should be able to see images.
  'analysis.secondModel': ['nim:nvidia/nemotron-3.5-super-vl-120b-a12b', text],
  'analysis.maxWindows': [40, int(1, 200)],
  'analysis.minScore': [5, num(0, 10)],
  // The second model's own humor rating (0-10) a moment needs before it can be used at all. On its scale 6 is "a real joke
  // with a setup and a punchline"; the value was set by comparing its ratings with a reader's on real clips.
  'analysis.minHumor': [6, num(0, 10)],
  // Watch the shortlisted moments (short sections only) before deciding, and at most this many per stream.
  'analysis.watch': [true, bool],
  'analysis.watchMax': [16, int(0, 40)],
  'short.targetSeconds': [58, int(15, 180)],
  'short.minSeconds': [45, int(10, 180)],
  'short.maxSeconds': [60, int(15, 180)],
  'short.maxPerSource': [3, int(1, 10)],
  'compliance.maxProfanityPerMinute': [8, num(0, 100)],
  'compliance.maxMusicShare': [0.3, num(0, 1)],
  'render.concurrency': [6, int(1, 32)],
};

export const getSettings = (db) => {
  const stored = Object.fromEntries(db.all('SELECT key, value_json FROM settings').map((row) => [row.key, JSON.parse(row.value_json)]));
  return Object.fromEntries(Object.entries(SETTINGS).map(([key, [fallback]]) => [key, key in stored ? stored[key] : fallback]));
};

export const setSetting = (db, key, value) => {
  const rule = SETTINGS[key];
  if (!rule) {
    throw new Error(`Unknown setting "${key}".`);
  }
  if (!rule[1](value)) {
    throw new Error(`Invalid value for "${key}".`);
  }
  db.run('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', key, JSON.stringify(value));
};
