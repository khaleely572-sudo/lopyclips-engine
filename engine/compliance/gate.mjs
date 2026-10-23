import {BLOCKING_RISKS} from '../analysis/moments.mjs';
import {checkAccess} from '../sources/access.mjs';

const REVIEW_FLAGS = ['slurs', 'sexual_content', 'graphic_violence', 'dangerous_acts', 'harassment'];
const BLOCKING_FLAGS = ['slurs', 'sexual_content', 'graphic_violence', 'dangerous_acts'];
const SECONDS_PER_MUSIC_TAG = 4;

const REVIEW_SCHEMA = {
  type: 'object',
  required: [...REVIEW_FLAGS, 'notes'],
  properties: {...Object.fromEntries(REVIEW_FLAGS.map((flag) => [flag, {type: 'boolean'}])), notes: {type: 'string'}},
};

const REVIEW_SYSTEM = `You review the caption text of a short video before it is published on YouTube. "[ __ ]" style gaps are swear words that have already been muted.
Set each flag to true only if the text itself clearly contains it:
- slurs: slurs or hateful language about a protected group;
- sexual_content: explicit sexual talk;
- graphic_violence: graphic descriptions of real violence or injury;
- dangerous_acts: real dangerous stunts or challenges, or encouraging them;
- harassment: sustained abuse aimed at a real, named private person.
Trash talk between players, shouting and video-game events are not violations. "notes" is one short sentence on anything a human reviewer should look at, or an empty string.`;

/** Model review of the final caption text. Throws if the model cannot be reached; the gate then fails closed. */
export const reviewContent = async (llm, model, text) => {
  const reply = await llm.json({
    model,
    schema: REVIEW_SCHEMA,
    messages: [
      {role: 'system', content: REVIEW_SYSTEM},
      {role: 'user', content: text},
    ],
  });
  return {...Object.fromEntries(REVIEW_FLAGS.map((flag) => [flag, reply[flag] === true])), notes: String(reply.notes ?? '').slice(0, 300)};
};

/**
 * The compliance decision for one Short. It lowers risk; it cannot establish that a video
 * is free of copyright claims or will be monetized, and it never says so.
 *
 * clips: [{momentId, seconds, censored, musicTags, risks}]
 * review: result of reviewContent, or null when it did not run
 * usedMomentIds: moments already in another Short that is approved, uploading or uploaded
 */
export const evaluate = ({creator, clips, review, usedMomentIds, settings}) => {
  const failures = [];
  const warnings = [];
  const fail = (check, detail) => failures.push({check, detail});
  const warn = (check, detail) => warnings.push({check, detail});

  const access = checkAccess(creator);
  if (!access.allowed) {
    fail('permission', access.reason);
  }

  const reused = clips.filter((clip) => usedMomentIds.has(clip.momentId)).map((clip) => clip.momentId);
  if (reused.length > 0) {
    fail('duplicate', `moment(s) ${reused.join(', ')} already used in another Short`);
  }

  const seconds = clips.reduce((sum, clip) => sum + clip.seconds, 0);
  const censored = clips.reduce((sum, clip) => sum + clip.censored, 0);
  const perMinute = seconds > 0 ? (censored * 60) / seconds : 0;
  if (perMinute > settings['compliance.maxProfanityPerMinute']) {
    fail('profanity', `${perMinute.toFixed(1)} muted swear words per minute (limit ${settings['compliance.maxProfanityPerMinute']})`);
  }

  const risks = [...new Set(clips.flatMap((clip) => clip.risks ?? []))];
  const blockingRisks = risks.filter((risk) => BLOCKING_RISKS.includes(risk));
  if (blockingRisks.length > 0) {
    fail('content', `flagged during analysis: ${blockingRisks.join(', ')}`);
  }
  if (risks.includes('needs_context')) {
    warn('context', 'a clip may not make sense on its own');
  }

  if (!review) {
    fail('review', 'the content review did not run');
  } else {
    const blockingFlags = BLOCKING_FLAGS.filter((flag) => review[flag]);
    if (blockingFlags.length > 0) {
      fail('content', `content review flagged: ${blockingFlags.join(', ')}`);
    }
    if (review.harassment) {
      warn('harassment', 'content review flagged possible harassment');
    }
    if (review.notes) {
      warn('reviewer note', review.notes);
    }
  }

  const musicShare = seconds > 0 ? Math.min(1, (clips.reduce((sum, clip) => sum + clip.musicTags, 0) * SECONDS_PER_MUSIC_TAG) / seconds) : 0;
  if (musicShare > settings['compliance.maxMusicShare'] || risks.includes('music')) {
    const detail = `music detected in the captions (roughly ${(musicShare * 100).toFixed(0)}% of the runtime); it may be copyrighted`;
    if (settings.requireApproval) {
      warn('music', detail);
    } else {
      fail('music', `${detail}, and no human review is configured`);
    }
  }

  return {passed: failures.length === 0, failures, warnings, checkedAt: new Date().toISOString()};
};
