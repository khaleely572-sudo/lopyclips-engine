import assert from 'node:assert/strict';
import test from 'node:test';
import {LlmError, createLlm, createOllama, parseLoose} from '../analysis/llm.mjs';
import {decide, dedupe, judgeSource, validateCandidate} from '../analysis/moments.mjs';
import {arrangeShort, selectMoments} from '../analysis/planner.mjs';
import {lineSignal, makeWindows, prioritizeWindows} from '../analysis/signals.mjs';
import {evaluate} from '../compliance/gate.mjs';
import {SETTINGS} from '../db/settings.mjs';
import {BASIS} from './helpers.mjs';

// These tests drive the models through a stand-in for Ollama, so they use Ollama-style model names.
const settings = {...Object.fromEntries(Object.entries(SETTINGS).map(([key, [value]]) => [key, value])), 'analysis.model': 'first-model:cloud', 'analysis.secondModel': 'second-model:cloud'};

// 40 lines, 4 seconds each: line i runs from i*4 to i*4+3.5
const SPOKEN = {
  8: 'watch this I never miss from here',
  9: 'nobody in this lobby can stop me',
  10: 'I promise you I am not losing this game',
  11: 'and then he lost four one [laughter]',
  20: 'LETS GO LETS GO WHAT A GOAL [screaming]',
  21: 'OH MY GOD LETS GO BRO',
  30: 'oh great another loss I love this game so much',
  31: 'best day of my life honestly',
};
const lines = Array.from({length: 40}, (_, i) => ({i, start: i * 4, end: i * 4 + 3.5, text: SPOKEN[i] ?? `filler talk number ${i} about the match`}));
const good = {setup_line: 10, punch_line: 11, end_line: 11, quote: 'I am not losing this game', humor_type: 'fail', tone: 'sincere', why_funny: 'He promises not to lose and loses at once.', funny: 8, standalone: 8, confidence: 0.8, label: 'boast backfires', risks: ['none']};
const loud = {...good, setup_line: 20, punch_line: 21, end_line: 21, quote: 'lets go lets go what a goal', humor_type: 'reaction', why_funny: 'He celebrates a goal very loudly.', funny: 7, label: 'goal celebration'};
const dry = {...good, setup_line: 30, punch_line: 31, end_line: 31, quote: 'best day of my life honestly', humor_type: 'sarcasm', tone: 'sarcastic', why_funny: 'He calls losing again the best day of his life.', label: 'sarcastic loss'};

const reply = (body) => ({ok: true, status: 200, json: async () => ({message: {content: typeof body === 'string' ? body : JSON.stringify(body)}}), text: async () => ''});
const ollama = (handler) => createOllama({baseUrl: 'http://fake', retryDelayMs: 1, fetchImpl: async (url, init) => handler(JSON.parse(init.body))});

test('replies wrapped in code fences or returned as a bare list are still read', async () => {
  assert.deepEqual(parseLoose('```json\n{"a": 1}\n```'), {a: 1});
  assert.deepEqual(parseLoose('Here you go: [1, 2] thanks'), [1, 2]);
  assert.throws(() => parseLoose('no json here'), LlmError);
  const llm = ollama(() => reply('```json\n[{"x": 1}]\n```'));
  const schema = {type: 'object', required: ['moments'], properties: {moments: {type: 'array'}}};
  assert.deepEqual(await llm.json({model: 'm', messages: [], schema}), {moments: [{x: 1}]});
});

test('a reply in the wrong shape is an error, not an empty answer', async () => {
  const llm = ollama(() => reply({something_else: true}));
  await assert.rejects(llm.json({model: 'm', messages: [], schema: {type: 'object', required: ['title', 'summary'], properties: {}}, attempts: 2}), /wrong shape/);
});

test('"nim:" models go to NVIDIA with the stored key; other models go to Ollama', async () => {
  const seen = [];
  const llm = createLlm({
    ollamaUrl: 'http://ollama',
    nimUrl: 'https://nim/v1',
    getNimKey: () => 'nvapi-test-key-000000000000000000',
    retryDelayMs: 1,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({url, model: body.model, auth: init.headers.Authorization ?? null});
      return url.startsWith('https://nim')
        ? {ok: true, status: 200, json: async () => ({choices: [{message: {content: '{"ok": true}'}}]})}
        : {ok: true, status: 200, json: async () => ({message: {content: '{"ok": true}'}})};
    },
  });
  assert.equal(await llm.ping('nim:nvidia/some-model'), true);
  assert.equal(await llm.ping('gpt-oss:120b-cloud'), true);
  assert.deepEqual(seen, [
    {url: 'https://nim/v1/chat/completions', model: 'nvidia/some-model', auth: 'Bearer nvapi-test-key-000000000000000000'},
    {url: 'http://ollama/api/chat', model: 'gpt-oss:120b-cloud', auth: null},
  ]);
});

test('the health check rides out a momentary overload, but reports a lasting one', async () => {
  let calls = 0;
  const blip = createLlm({
    ollamaUrl: 'http://ollama',
    nimUrl: 'https://nim/v1',
    getNimKey: () => 'nvapi-test-key-000000000000000000',
    retryDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? {ok: false, status: 503, text: async () => 'Service temporarily overloaded'} : {ok: true, status: 200, json: async () => ({choices: [{message: {content: '{"ok": true}'}}]})};
    },
  });
  assert.equal(await blip.ping('nim:nvidia/some-model'), true);
  assert.equal(calls, 2);

  const down = createLlm({ollamaUrl: 'http://ollama', nimUrl: 'https://nim/v1', getNimKey: () => 'nvapi-test-key-000000000000000000', retryDelayMs: 1, fetchImpl: async () => ({ok: false, status: 503, text: async () => 'Service temporarily overloaded'})});
  await assert.rejects(down.ping('nim:nvidia/some-model'), /503/);
});

test('a "nim:" model without a key, or with a rejected key, fails clearly and never shows the key', async () => {
  let calls = 0;
  const noKey = createLlm({ollamaUrl: 'http://ollama', nimUrl: 'https://nim/v1', retryDelayMs: 1, fetchImpl: async () => (calls += 1)});
  await assert.rejects(noKey.ping('nim:nvidia/some-model'), /needs an NVIDIA API key/);
  assert.equal(calls, 0, 'nothing is sent without a key');

  const secret = 'nvapi-secret-key-0000000000000000';
  const rejected = createLlm({ollamaUrl: 'http://ollama', nimUrl: 'https://nim/v1', getNimKey: () => secret, retryDelayMs: 1, fetchImpl: async () => ({ok: false, status: 401, text: async () => `bad key ${secret}`})});
  await assert.rejects(rejected.json({model: 'nim:nvidia/some-model', messages: [], schema: {type: 'object', required: ['ok'], properties: {}}}), (err) => /rejected the stored API key/.test(err.message) && !err.message.includes(secret));
});

test('timestamps come from the transcript lines, not from the model', () => {
  const result = validateCandidate({...good, start: 999, end: 1000}, lines);
  assert.equal(result.ok, true);
  assert.equal(result.moment.start, 39.75);
  assert.equal(result.moment.end, 47.85);
  assert.equal(result.moment.quote, 'i am not losing this game');
  assert.equal(result.moment.humorType, 'fail');
});

test('a fabricated quote, bad line numbers, a stray punchline or a bad length reject the candidate', () => {
  assert.match(validateCandidate({...good, quote: 'he dunked on the entire lobby easily'}, lines).reason, /not in the transcript/);
  assert.match(validateCandidate({...good, end_line: 99}, lines).reason, /out of range/);
  assert.match(validateCandidate({...good, punch_line: 20}, lines).reason, /punchline is outside/);
  assert.match(validateCandidate({...good, setup_line: 11, quote: 'and then he lost four'}, lines).reason, /outside/, 'a 4 second clip is too short');
  assert.match(validateCandidate({...good, setup_line: 5, end_line: 25, quote: 'filler talk number 6 about'}, lines).reason, /outside/, 'an 84 second clip is too long');
  assert.match(validateCandidate({...good, funny: 14}, lines).reason, /scores/);
  assert.match(validateCandidate({...good, why_funny: ''}, lines).reason, /reason/);
});

// A stand-in for the two models. It answers by the kind of question asked, and reviews each proposal by the first line marked ">".
const firstMarked = (block) => Number(/^> (\d+)\t/m.exec(block)?.[1]);
const models = ({found = [good], review = () => null, rank = null, seen = {}} = {}) =>
  ollama((body) => {
    const kind = body.format.required[0];
    const user = body.messages.at(-1).content;
    seen[kind] = [...(seen[kind] ?? []), {model: body.model, user}];
    if (kind === 'moments') {
      return reply({moments: found});
    }
    if (kind === 'reviews') {
      const blocks = user.split(/^Proposal \d+\n/m).slice(1);
      return reply({reviews: blocks.map((block, id) => review(firstMarked(block), id)).filter(Boolean)});
    }
    return rank ? reply(rank) : reply('not json');
  });
const verdict = (id, overrides = {}) => ({id, joke: 'He boasts and it backfires at once.', verdict: 'funny', humor: 8, standalone: 8, payoff: 8, tone: 'sincere', humor_type: 'fail', start_line: 10, end_line: 11, flags: [], risks: ['none'], ...overrides});

test('finding nothing funny is a normal answer, not an error', async () => {
  const seen = {};
  const result = await judgeSource({llm: models({found: [], seen}), lines, creatorName: 'Test', title: 'Stream', settings});
  assert.deepEqual(result.moments, []);
  assert.equal(result.proposed, 0);
  assert.equal(seen.reviews, undefined, 'the second model is not asked about nothing');
});

test("the second model judges each proposal for itself, with the surrounding lines and without the first model's reasons", async () => {
  const unproven = await judgeSource({llm: models({found: [good, {...good, quote: 'something nobody ever said here'}, {...good, setup_line: 200, punch_line: 200, end_line: 201}], review: (line, id) => verdict(id)}), lines, creatorName: 'Test', title: 'Stream', settings});
  assert.deepEqual(unproven.rejected.map((r) => r.reason).sort(), ['cites lines it was not shown', 'quote is not in the transcript lines it cites']);
  assert.equal(unproven.proposed, 1, 'only a proposal backed by the real captions reaches the second model');

  const seen = {};
  const llm = models({
    found: [good, loud, dry],
    seen,
    review: (line, id) =>
      line === 10
        ? verdict(id, {humor: 9, standalone: 9, payoff: 9, start_line: 8, end_line: 11, flags: ['missing_setup'], risks: ['heavy_profanity']})
        : line === 20
          ? verdict(id, {joke: 'He shouts about a goal.', verdict: 'not_funny', humor: 2, standalone: 6, payoff: 3, start_line: 20, end_line: 21, flags: ['just_loud']})
          : verdict(id, {joke: 'He says he loves losing.', humor: 7, start_line: 30, end_line: 31, humor_type: 'sarcasm'}),
  });
  const result = await judgeSource({llm, lines, creatorName: 'Test', title: 'Stream', settings});
  assert.equal(result.proposed, 3);

  const asked = seen.reviews[0];
  assert.equal(asked.model, settings['analysis.secondModel']);
  assert.ok(!asked.user.includes(good.why_funny) && !asked.user.includes('boast backfires'), "it is not shown the first model's reason or label");
  assert.match(asked.user, /^ {2}9\t.*nobody in this lobby can stop me$/m, 'the lines before the clip are shown as context');
  assert.match(asked.user, /^> 10\t.*I promise you/m, 'the clip lines are marked');

  const [boast, sarcasm, shouting] = [11, 31, 21].map((line) => result.moments.find((m) => m.punchLine === line));
  assert.equal(boast.status, 'candidate');
  assert.equal(boast.start, 31.75, 'the clip now starts where the reviewer found the setup');
  assert.deepEqual([boast.details.boundary.setupAdded, boast.details.laughter, boast.details.penalty], [true, true, 0], 'the setup problem was fixed by moving the start, so it costs nothing');
  assert.ok(Math.abs(boast.score - (0.6 * (0.4 * 8 + 0.6 * 9) + 0.2 * 9 + 0.2 * 9 + 0.4)) < 1e-9, 'humor counts most; laughter in the captions adds a little');
  assert.deepEqual(boast.risks, ['heavy_profanity']);

  assert.equal(shouting.status, 'rejected');
  assert.match(shouting.rejectReason, /no joke here/);
  assert.ok(shouting.score < 3, 'a loud moment with no joke scores at the bottom');

  assert.equal(sarcasm.status, 'uncertain', 'one model read it as sarcasm, the other as sincere');
  assert.match(sarcasm.rejectReason, /sarcasm literally/);
  assert.equal(seen.order, undefined, 'one survivor needs no ranking');
});

test('weak, low-rated and hard-to-follow moments are rejected with the reason', () => {
  const judge = (review, options = {}) => {
    const moment = {...validateCandidate(good, lines).moment, review: {verdict: 'funny', humor: 8, standalone: 8, payoff: 8, tone: 'sincere', humorType: 'fail', joke: 'x', flags: [], ...review}};
    return decide(moment, lines, {minHumor: 7, minScore: 5, ...options});
  };
  assert.equal(judge({}).status, 'candidate');
  assert.match(judge({verdict: 'weak', humor: 5}).rejectReason, /too weak, humor 5 of 10/);
  assert.match(judge({humor: 6}).rejectReason, /below the minimum of 7/);
  assert.match(judge({standalone: 3}).rejectReason, /stranger would not follow/);
  assert.match(judge({flags: ['ordinary_talk']}).rejectReason, /ordinary talk/);
  assert.equal(judge({verdict: 'unsure'}).status, 'uncertain');
  assert.equal(judge({humor: 10, flags: ['inside_joke', 'no_payoff', 'rambling']}).details.penalty, 4, 'penalties add up, to a limit');
  assert.ok(judge({flags: ['inside_joke']}).score < judge({}).score - 1.9);
  assert.ok(Math.abs(judge({}, {typeBias: {fail: 0.5}}).score - judge({}).score - 0.5) < 1e-9, 'the kinds of humor the owner keeps liking rank a little higher');
});

test('a moment the second model could not review is never used automatically', async () => {
  const silent = await judgeSource({llm: models({review: () => null}), lines, creatorName: 'Test', title: 'Stream', settings});
  assert.deepEqual(silent.moments.map((m) => m.status), ['uncertain']);
  assert.equal(silent.unreviewed, 1);
  assert.match(silent.moments[0].rejectReason, /could not review/);

  const down = createOllama({baseUrl: 'http://fake', retryDelayMs: 1, fetchImpl: async (url, init) => (JSON.parse(init.body).format.required[0] === 'moments' ? reply({moments: [good]}) : {ok: false, status: 503, text: async () => 'down'})});
  let kept = null;
  await assert.rejects(judgeSource({llm: down, lines, creatorName: 'Test', title: 'Stream', settings, onDiscovered: (found) => (kept = found)}), /503/, 'with the reviewer down the analysis fails, so it is retried later');
  const retry = await judgeSource({llm: models({found: [], review: (line, id) => verdict(id)}), lines, creatorName: 'Test', title: 'Stream', settings, discovered: kept});
  assert.deepEqual(retry.moments.map((m) => m.status), ['candidate'], 'the retry reuses what the first model already found');
});

test('survivors are ranked side by side, and a repeat of a better clip is dropped', async () => {
  const seen = {};
  const three = [good, {...loud, tone: 'sincere'}, {...dry, tone: 'sincere'}];
  const agree = (line, id) => verdict(id, {start_line: line, end_line: line + 1});
  const result = await judgeSource({llm: models({found: three, seen, review: agree, rank: {order: [2, 0, 1], repeats: [[0, 2]]}}), lines, creatorName: 'Test', title: 'Stream', settings});
  assert.equal(seen.order.length, 1);
  assert.equal(seen.order[0].model, settings['analysis.secondModel']);
  const at = (line) => result.moments.find((m) => m.startLine === line);
  assert.deepEqual([at(30).details.rank, at(10).details.rank, at(20).details.rank], [1, 2, 3]);
  assert.equal(at(10).status, 'rejected');
  assert.match(at(10).rejectReason, /repeats the same joke/);
  assert.deepEqual([at(30).status, at(20).status], ['candidate', 'candidate']);

  const unranked = await judgeSource({llm: models({found: three, review: agree, rank: {order: [0, 0, 1], repeats: []}}), lines, creatorName: 'Test', title: 'Stream', settings});
  assert.ok(unranked.moments.every((m) => m.status === 'candidate' && m.details.rank === undefined), 'a ranking that is not a real ordering is ignored');
  // Same reviews with and without a ranking: first place gains half a point and last place loses half.
  const before = (line) => unranked.moments.find((m) => m.startLine === line).score;
  assert.ok(Math.abs(at(30).score - before(30) - 0.5) < 1e-9);
  assert.ok(Math.abs(at(20).score - before(20) + 0.5) < 1e-9);
});

test('the same bit proposed twice counts once', () => {
  const a = validateCandidate(good, lines).moment;
  const overlapping = validateCandidate({...good, setup_line: 9, funny: 7}, lines).moment;
  const retold = {...a, start: 500, end: 508, score: 6};
  const {kept, duplicates} = dedupe([overlapping, retold, a]);
  assert.deepEqual(kept, [a]);
  assert.equal(duplicates.length, 2);
});

test('loudness alone does not decide which parts of a long stream get read', () => {
  assert.ok(lineSignal('[screaming] LETS GO LETS GO BRO [screaming]') < lineSignal('that was actually good [laughter]'));
  assert.ok(lineSignal('>> no way >> yes way') > lineSignal('no way yes way'), 'a back-and-forth counts');
  const long = Array.from({length: 900}, (_, i) => ({i, start: i * 4, end: i * 4 + 3.5, text: i >= 90 && i < 170 ? 'LETS GO [screaming]' : i >= 500 && i < 510 ? 'you are terrible at this [laughter]' : 'plain talk'}));
  const chosen = prioritizeWindows(long, makeWindows(long.length), 5);
  assert.equal(chosen.length, 5);
  assert.ok(chosen.some((w) => w.from <= 500 && w.to >= 510), 'the stretch with laughter is read');
  const quiet = chosen.filter((w) => long.slice(w.from, w.to).every((line) => line.text === 'plain talk'));
  assert.ok(quiet.length >= 2, 'quiet stretches are still sampled, because dry humor leaves no sound tag');
  assert.deepEqual(chosen, [...chosen].sort((a, b) => a.from - b.from), 'in stream order');
});

test('a model outage fails the analysis instead of reporting "no moments"', async () => {
  const llm = createOllama({baseUrl: 'http://fake', retryDelayMs: 1, fetchImpl: async () => ({ok: false, status: 503, text: async () => 'down'})});
  await assert.rejects(judgeSource({llm, lines, creatorName: 'Test', title: 'Stream', settings}), /503/);
});

const moment = (id, start, seconds, score) => ({id, start, end: start + seconds, score, label: `m${id}`, text: `clip ${id}`});
const limits = {targetSeconds: 58, minSeconds: 45, maxSeconds: 60};

test('the planner fills a Short with the best non-overlapping moments, or makes none', () => {
  const chosen = selectMoments([moment(1, 100, 20, 9), moment(2, 105, 20, 8.5), moment(3, 300, 20, 7), moment(4, 500, 18, 6), moment(5, 700, 30, 5)], limits);
  assert.deepEqual(chosen.map((m) => m.id), [1, 3, 4], 'overlapping #2 is skipped, #5 would exceed the limit, result is in stream order');
  assert.ok(chosen.reduce((sum, m) => sum + m.end - m.start, 0) <= 60);
  assert.equal(selectMoments([moment(1, 100, 15, 9), moment(2, 300, 15, 8)], limits), null, 'two clips and 30 seconds is not a Short');
});

test('clips keep their natural length, and a clearly weaker moment is not added just to fill time', () => {
  const twoLong = selectMoments([moment(1, 100, 25, 9), moment(2, 300, 24, 8.5), moment(3, 500, 10, 6)], limits);
  assert.deepEqual(twoLong.map((m) => m.id), [1, 2], 'two strong long clips are a Short; the 6 is left out');
  const three = selectMoments([moment(1, 100, 25, 9), moment(2, 300, 22, 8.5), moment(3, 500, 10, 8.2)], limits);
  assert.deepEqual(three.map((m) => m.id), [1, 2, 3], 'a third clip of similar quality is welcome');
});

test('an invalid arrangement from the model falls back to stream order', async () => {
  const moments = [moment(1, 100, 20, 9), moment(2, 300, 20, 7), moment(3, 500, 18, 6)];
  const bad = await arrangeShort({llm: ollama(() => reply({header: 'he said "what"', order: [0, 0, 7], labels: []})), model: 'm', moments, creatorName: 'Test', limits});
  assert.equal(bad.arrangedBy, 'stream order');
  assert.deepEqual(bad.clips.map((c) => c.moment.id), [1, 2, 3]);
  assert.equal(bad.header, 'HE SAID WHAT');
  const possessive = await arrangeShort({llm: ollama(() => reply({header: 'Speed’s backflip', order: [0, 1, 2], labels: []})), model: 'm', moments, creatorName: 'Test', limits});
  assert.equal(possessive.header, "SPEED'S BACKFLIP", 'apostrophes are kept');
  const ok = await arrangeShort({llm: ollama(() => reply({header: 'A very long header that will not fit on screen', order: [2, 0, 1], labels: [{id: 2, label: 'the ending'}]})), model: 'm', moments, creatorName: 'Test', limits});
  assert.deepEqual(ok.clips.map((c) => c.moment.id), [3, 1, 2]);
  assert.equal(ok.clips[0].label, 'THE ENDING');
  assert.ok(ok.header.length <= 22);
});

const creator = {permission_status: 'authorized', permission_basis: BASIS};
const clip = (overrides = {}) => ({momentId: 1, seconds: 20, censored: 0, musicTags: 0, risks: [], ...overrides});
const cleanReview = {slurs: false, sexual_content: false, graphic_violence: false, dangerous_acts: false, harassment: false, notes: ''};
const check = (overrides = {}) => evaluate({creator, clips: [clip(), clip({momentId: 2}), clip({momentId: 3})], review: cleanReview, usedMomentIds: new Set(), settings, ...overrides});

test('compliance passes clean footage from an authorized creator', () => {
  const result = check();
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('every mandatory compliance failure is recorded with its reason', () => {
  const failed = (overrides) => check(overrides).failures.map((f) => f.check);
  assert.deepEqual(failed({creator: {permission_status: 'unknown'}}), ['permission']);
  assert.deepEqual(failed({usedMomentIds: new Set([2])}), ['duplicate']);
  assert.deepEqual(failed({clips: [clip({censored: 12})]}), ['profanity']);
  assert.deepEqual(failed({clips: [clip({risks: ['slur']})]}), ['content']);
  assert.deepEqual(failed({review: {...cleanReview, sexual_content: true}}), ['content']);
  assert.deepEqual(failed({review: null}), ['review'], 'no review means no pass');
});

test('possible music is a warning for a human reviewer, and a failure when nobody reviews', () => {
  const musical = {clips: [clip({musicTags: 4})]};
  const reviewed = check(musical);
  assert.equal(reviewed.passed, true);
  assert.deepEqual(reviewed.warnings.map((w) => w.check), ['music']);
  const unattended = check({...musical, settings: {...settings, requireApproval: false}});
  assert.deepEqual(unattended.failures.map((f) => f.check), ['music']);
});

test('a reply cut off before the answer began is reported as such and tried again', async () => {
  let calls = 0;
  const llm = createLlm({
    ollamaUrl: 'http://ollama',
    nimUrl: 'https://nim/v1',
    getNimKey: () => 'nvapi-test-key-000000000000000000',
    retryDelayMs: 1,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.ok(JSON.parse(init.body).max_tokens >= 16000, 'there is room for the thinking as well as the answer');
      return {ok: true, status: 200, json: async () => ({choices: [calls === 1 ? {finish_reason: 'length', message: {content: ''}} : {finish_reason: 'stop', message: {content: '{"ok": true}'}}]})};
    },
  });
  assert.equal(await llm.ping('nim:nvidia/some-model'), true);
  assert.equal(calls, 2);
});

test('"openai:" models go to the OpenAI-compatible address with its own key, never the NVIDIA one', async () => {
  const seen = [];
  const llm = createLlm({
    ollamaUrl: 'http://ollama',
    nimUrl: 'https://nim/v1',
    getNimKey: () => 'nvapi-test-key-000000000000000000',
    openaiUrl: 'https://openrouter.example/api/v1',
    getOpenAiKey: () => 'sk-test-0000',
    retryDelayMs: 1,
    fetchImpl: async (url, init) => {
      seen.push({url, model: JSON.parse(init.body).model, auth: init.headers.Authorization});
      return {ok: true, status: 200, json: async () => ({choices: [{message: {content: '{"ok": true}'}}]})};
    },
  });
  assert.equal(await llm.ping('openai:meta-llama/llama-4-maverick'), true);
  assert.deepEqual(seen, [{url: 'https://openrouter.example/api/v1/chat/completions', model: 'meta-llama/llama-4-maverick', auth: 'Bearer sk-test-0000'}]);
  const keyless = createLlm({ollamaUrl: 'http://ollama', nimUrl: 'https://nim/v1', retryDelayMs: 1, fetchImpl: async () => assert.fail('nothing is sent without a key')});
  await assert.rejects(keyless.ping('openai:gpt-4o-mini'), /needs OPENAI_API_KEY/);
});
