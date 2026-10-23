const token = document.querySelector('meta[name="lopy-token"]').content;
const $ = (selector) => document.querySelector(selector);

/** Build a DOM element. Text is always set as text, never as HTML. */
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key.startsWith('on')) {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (value !== false && value != null) {
      el.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) {
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
  }
  return el;
};

const api = async (method, url, body) => {
  const res = await fetch(url, {method, headers: {'Content-Type': 'application/json', 'X-LopyClips-Token': token}, body: body ? JSON.stringify(body) : undefined});
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && method !== 'GET') {
    // The engine was restarted after this page loaded, so the page's session token is out of date.
    setTimeout(() => location.reload(), 1500);
    throw new Error('The engine was restarted since this page was opened. Reloading the page now; then try again.');
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
};

const notify = (text, good = false) => {
  const el = $('#notice');
  el.textContent = text;
  el.className = good ? 'good' : '';
  el.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (el.hidden = true), 7000);
};

/** Run an action, show any error, then refresh. */
const act = async (fn, done) => {
  try {
    await fn();
    if (done) {
      notify(done, true);
    }
  } catch (err) {
    notify(err.message);
  }
  await refresh(true);
};

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const clock = (seconds) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const STATUS_CLASS = {
  uploaded: 'ok', approved: 'ok', authorized: 'ok', succeeded: 'ok', confirmed: 'ok', planned: 'ok', analyzed: 'ok',
  awaiting_approval: 'warn', blocked: 'warn', unknown: 'warn', uncertain: 'warn', queued: 'warn', running: 'warn', rendering: 'warn', clipping: 'warn', uploading: 'warn', skipped: '', exhausted: '',
  dead: 'bad', failed: 'bad', denied: 'bad', rejected: 'bad', compliance_rejected: 'bad', verify_failed: 'bad',
};
const tag = (status) => h('span', {class: `tag ${STATUS_CLASS[status] ?? ''}`}, String(status).replaceAll('_', ' '));
const table = (headers, rows) => h('table', {}, h('thead', {}, h('tr', {}, headers.map((header) => h('th', {}, header)))), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', {colspan: headers.length, class: 'dim'}, 'Nothing here yet.'))));
const card = (title, ...children) => h('div', {class: 'card'}, h('h2', {}, title), ...children);
const pairs = (object) => h('ul', {class: 'list'}, Object.entries(object).map(([key, value]) => h('li', {}, h('span', {class: 'dim'}, `${key.replaceAll('_', ' ')}: `), String(value))));

let state = null;
let tab = 'office';

const control = (action, done) => act(() => api('POST', '/api/control', {action}), done);

/** The status pills and the three control buttons. Built in one place so the header and the office show the same real ones. */
const buildPills = () => {
  const s = state.settings;
  const pill = (text, cls) => h('span', {class: `pill ${cls}`}, text);
  return [
    s['automation.emergencyStop'] ? pill('EMERGENCY STOP', 'bad') : pill(s['automation.paused'] ? 'automation paused' : 'automation running', s['automation.paused'] ? 'warn' : 'ok'),
    pill(s.dryRun ? 'dry run: nothing uploads' : 'live uploads', s.dryRun ? 'warn' : 'ok'),
    pill(s.requireApproval ? 'manual approval on' : 'auto-approve', s.requireApproval ? 'ok' : 'warn'),
    pill(`visibility: ${s['upload.visibility']}`, s['upload.visibility'] === 'private' ? 'ok' : 'warn'),
    pill(state.health ? (state.health.ok ? 'health ok' : 'health problem') : 'checking health', state.health ? (state.health.ok ? 'ok' : 'bad') : ''),
  ];
};
const buildControls = () => {
  const s = state.settings;
  return [
    h('button', {onclick: () => control('discover-now', 'Discovery queued.')}, 'Discover now'),
    s['automation.paused'] ? h('button', {class: 'primary', onclick: () => control('resume', 'Automation resumed.')}, 'Resume') : h('button', {onclick: () => control('pause', 'Automation paused.')}, 'Pause'),
    s['automation.emergencyStop']
      ? h('button', {onclick: () => control('clear-emergency', 'Emergency stop cleared; automation is paused.')}, 'Clear emergency stop')
      : h('button', {class: 'danger', onclick: () => confirm('Stop everything now? Running uploads are cut off.') && control('emergency-stop')}, 'Emergency stop'),
  ];
};

const renderHeader = () => {
  $('#pills').replaceChildren(...buildPills());
  $('#controls').replaceChildren(...buildControls());
};

const views = {
  async overview() {
    const {counts, quota, today, health, schedule, settings, warnings} = state;
    return [
      warnings.length ? card('Needs attention', h('ul', {class: 'list'}, warnings.map((w) => h('li', {class: w.level === 'error' ? 'bad' : 'warn'}, w.text)))) : null,
      h('div', {class: 'grid'},
        card('Today', h('div', {class: 'big'}, `${today.uploaded} uploaded`), h('div', {class: 'dim'}, `${today.produced} Shorts made · daily limit ${settings['schedule.dailyLimit']} · ${today.day}`)),
        card('YouTube quota (resets midnight Pacific)', h('div', {class: 'big'}, `${quota.uploads.used} / ${quota.uploads.limit}`), h('div', {class: 'dim'}, `uploads today · ${quota.general.used} of ${quota.general.limit} other units`)),
        card('Next publishing slots', h('ul', {class: 'list'}, schedule.next.map((slot) => h('li', {}, when(slot.at), slot.quiet ? h('span', {class: 'dim'}, ' — quiet hours') : null)))),
      ),
      h('div', {class: 'grid'}, card('Sources', pairs(counts.sources)), card('Shorts', pairs(counts.shorts)), card('Jobs', pairs(counts.jobs))),
      card('Health', health
        ? table(['Check', 'Result', 'Detail'], Object.entries(health.checks).map(([name, check]) => h('tr', {}, h('td', {}, name), h('td', {class: check.ok ? 'ok' : 'bad'}, check.ok ? 'ok' : 'FAILED'), h('td', {class: 'dim'}, check.detail))))
        : h('p', {class: 'dim'}, 'Running the first health check…'),
        h('div', {class: 'row'}, h('button', {onclick: () => control('refresh-health', 'Health re-checked.')}, 'Re-check'), health ? h('span', {class: 'dim'}, `checked ${when(health.checkedAt)}`) : null)),
    ];
  },

  async creators() {
    const creators = await api('GET', '/api/creators');
    const name = h('input', {type: 'text', placeholder: 'Name'});
    const handle = h('input', {type: 'text', placeholder: '@handle'});
    return [
      card('Add a creator', h('div', {class: 'row'}, name, handle, h('button', {class: 'primary', onclick: () => act(() => api('POST', '/api/creators', {name: name.value, handle: handle.value}), 'Creator added.')}, 'Add')),
        h('p', {class: 'dim'}, 'New creators start with no permission recorded, so their videos are listed but nothing is fetched or made from them.')),
      ...creators.map((creator) => {
        const status = h('select', {}, ['unknown', 'authorized', 'denied'].map((value) => h('option', {value, selected: value === creator.permission_status}, value)));
        const basis = h('textarea', {placeholder: 'Basis for permission: who allowed clipping, where it is stated, and when.'}, creator.permission_basis ?? '');
        const save = (patch, done) => act(() => api('PATCH', `/api/creators/${creator.id}`, patch), done);
        const handleInput = h('input', {type: 'text', value: creator.handle ?? '', style: 'flex:1;width:auto'});
        const saveHandle = () =>
          act(async () => {
            await api('PATCH', `/api/creators/${creator.id}`, {handle: handleInput.value});
            await api('POST', '/api/control', {action: 'discover-now'});
          }, 'Handle saved. Looking for videos on that channel.');
        return card(`${creator.name}  ${creator.handle ?? ''}`,
          h('div', {class: 'row'}, tag(creator.permission_status), tag(creator.enabled ? 'enabled' : 'disabled'), h('span', {class: 'dim'}, `${creator.sources} videos stored · channel ${creator.channel_id ?? 'not resolved yet'}`)),
          h('label', {class: 'field'}, h('span', {}, 'YouTube handle (the channel their long videos and streams are on)'), h('div', {class: 'row'}, handleInput, h('button', {onclick: saveHandle}, 'Save handle'))),
          h('label', {class: 'field'}, h('span', {}, 'Permission'), status),
          h('label', {class: 'field'}, h('span', {}, 'Basis (required to authorize)'), basis),
          h('div', {class: 'row'},
            h('button', {class: 'primary', onclick: () => (status.value !== 'authorized' || confirm(`Record that you have permission to clip and publish ${creator.name}'s footage? Their videos will then be fetched and edited.`)) && save({permissionStatus: status.value, permissionBasis: basis.value}, 'Permission saved.')}, 'Save permission'),
            h('button', {onclick: () => save({enabled: !creator.enabled})}, creator.enabled ? 'Disable' : 'Enable'),
            h('button', {class: 'danger', onclick: () => confirm(`Remove ${creator.name}?`) && act(() => api('DELETE', `/api/creators/${creator.id}`), 'Done.')}, 'Remove')),
          creator.permission_recorded_at ? h('p', {class: 'dim'}, `Permission last recorded ${when(creator.permission_recorded_at)}`) : null);
      }),
    ];
  },

  async sources() {
    const sources = await api('GET', '/api/sources');
    return [card('Discovered videos', table(['Creator', 'Video', 'Published', 'Length', 'Status', 'Note', ''], sources.map((source) => h('tr', {},
      h('td', {}, source.creator),
      h('td', {}, h('a', {href: source.url, target: '_blank', rel: 'noreferrer'}, source.title)),
      h('td', {class: 'dim'}, when(source.published_at)),
      h('td', {}, source.duration_s ? clock(source.duration_s) : '—'),
      h('td', {}, tag(source.status)),
      h('td', {class: 'dim'}, source.blocked_reason ?? ''),
      h('td', {}, h('button', {onclick: () => showMoments(source)}, 'Moments'))))))];
  },

  async shorts() {
    const shorts = await api('GET', '/api/shorts');
    return [card('Shorts', table(['#', 'Status', 'On-screen title', 'YouTube title', 'Creator', 'Updated', ''], shorts.map((short) => h('tr', {},
      h('td', {}, short.id),
      h('td', {}, tag(short.status), ['clipping', 'rendering'].includes(short.status) ? h('progress', {max: 1, value: short.progress}) : null, short.fail_reason ? h('div', {class: 'bad'}, short.fail_reason) : null),
      h('td', {}, short.title ?? ''),
      h('td', {}, short.video_title ?? h('span', {class: 'dim'}, '—')),
      h('td', {}, short.creator),
      h('td', {class: 'dim'}, when(short.updated_at)),
      h('td', {}, h('button', {onclick: () => showShort(short.id)}, 'Open'))))))];
  },

  async schedule() {
    const {schedule, settings} = state;
    return [
      card('Upcoming queue', schedule.queue.length
        ? table(['Slot', 'Shorts'], schedule.queue.map((slot) => h('tr', {}, h('td', {}, when(slot.at)), h('td', {}, slot.shorts.map((short) => `#${short.id} ${short.title ?? ''}`).join(' · ')))))
        : h('p', {class: 'dim'}, 'No approved Shorts are waiting. An empty slot is skipped.'),
        h('p', {class: 'dim'}, `Every ${settings['schedule.intervalHours']} h in ${settings['schedule.timezone']}, up to ${settings['schedule.maxPerSlot']} per slot, ${settings['schedule.dailyLimit']} per day. This is a projection: paused automation, dry run, quota or a failed re-check all stop an upload.`)),
      card('Next slots', h('ul', {class: 'list'}, schedule.next.map((slot) => h('li', {}, when(slot.at), slot.quiet ? ' — quiet hours' : '')))),
    ];
  },

  async uploads() {
    const uploads = await api('GET', '/api/uploads');
    return [card('Uploads', table(['Short', 'State', 'Sent as', 'YouTube reports', 'Video', 'Confirmed', 'Last error'], uploads.map((upload) => h('tr', {},
      h('td', {}, `#${upload.short_id} ${upload.title ?? ''}`),
      h('td', {}, tag(upload.state)),
      h('td', {}, upload.visibility),
      h('td', {}, upload.reported_privacy ?? '—'),
      h('td', {}, upload.video_id ? h('a', {href: `https://www.youtube.com/watch?v=${upload.video_id}`, target: '_blank', rel: 'noreferrer'}, upload.video_id) : '—'),
      h('td', {class: 'dim'}, when(upload.confirmed_at)),
      h('td', {class: 'bad'}, upload.last_error ?? '')))))];
  },

  async jobs() {
    const jobs = await api('GET', '/api/jobs');
    return [card('Jobs not yet finished, or failed', table(['#', 'Type', 'For', 'Status', 'Tries', 'Next run', 'Last error', ''], jobs.map((job) => h('tr', {},
      h('td', {}, job.id), h('td', {}, job.type), h('td', {class: 'dim'}, job.payload_json), h('td', {}, tag(job.status)), h('td', {}, `${job.attempts}/${job.max_attempts}`),
      h('td', {class: 'dim'}, job.status === 'queued' ? when(job.run_after) : ''), h('td', {class: 'bad'}, job.last_error ?? ''),
      h('td', {}, job.status === 'dead' ? h('button', {onclick: () => act(() => api('POST', `/api/jobs/${job.id}/retry`), 'Job queued again.')}, 'Retry') : null)))))];
  },

  async activity() {
    const events = await api('GET', '/api/events');
    return [card('Activity log', table(['When', 'Level', 'What'], events.map((event) => h('tr', {}, h('td', {class: 'dim'}, when(event.ts)), h('td', {class: event.level === 'error' ? 'bad' : event.level === 'warn' ? 'warn' : 'dim'}, event.level), h('td', {}, event.message)))))];
  },

  async settings() {
    const s = state.settings;
    const inputs = {};
    const field = (key) => {
      const value = s[key];
      let input;
      if (typeof value === 'boolean') {
        input = h('input', {type: 'checkbox', checked: value});
        inputs[key] = () => input.checked;
      } else if (key === 'upload.visibility') {
        input = h('select', {}, ['private', 'unlisted', 'public'].map((option) => h('option', {value: option, selected: option === value}, option)));
        inputs[key] = () => input.value;
      } else if (key === 'schedule.quietHours') {
        const start = h('input', {type: 'time', value: value?.start ?? '01:00'});
        const end = h('input', {type: 'time', value: value?.end ?? '08:00'});
        const on = h('input', {type: 'checkbox', checked: value !== null});
        input = h('div', {class: 'row'}, on, start, 'to', end);
        inputs[key] = () => (on.checked ? {start: start.value, end: end.value} : null);
      } else if (typeof value === 'number') {
        input = h('input', {type: 'number', value, step: Number.isInteger(value) ? 1 : 0.1});
        inputs[key] = () => Number(input.value);
      } else {
        input = h('input', {type: 'text', value});
        inputs[key] = () => input.value;
      }
      return h('label', {class: 'field'}, h('span', {}, key), input);
    };
    const save = () => {
      const changed = Object.fromEntries(Object.entries(inputs).map(([key, read]) => [key, read()]).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(s[key])));
      if (Object.keys(changed).length === 0) {
        return notify('Nothing changed.', true);
      }
      const opens = changed['upload.allowNonPrivate'] === true || (changed['upload.visibility'] && changed['upload.visibility'] !== 'private');
      if (opens && !confirm('This allows videos to be uploaded as unlisted or public. Continue?')) {
        return null;
      }
      return act(() => api('POST', '/api/settings', {settings: changed, confirmNonPrivate: opens || undefined}), 'Settings saved.');
    };
    return [card('Settings', h('div', {class: 'settings'}, Object.keys(s).filter((key) => !['automation.paused', 'automation.emergencyStop'].includes(key)).map(field)), h('div', {class: 'row'}, h('button', {class: 'primary', onclick: save}, 'Save settings')),
      h('p', {class: 'dim'}, 'Unlisted or public uploads stay locked until this engine has completed at least one confirmed private upload.'))];
  },
};

const closePanel = () => ($('#panel').hidden = true);
const openPanel = (...children) => {
  $('#panel').replaceChildren(h('button', {class: 'close', onclick: closePanel}, 'Close'), ...children.filter((child) => child != null && child !== false));
  $('#panel').hidden = false;
};

/**
 * The owner's ratings of one moment. A rating is a note that teaches the ranking what this channel
 * finds funny; it never approves, rejects, uploads or schedules anything.
 */
const ratingRow = (moment) => {
  const labels = state.feedbackLabels;
  if (!labels || !moment) {
    return null; // the engine was started before ratings existed
  }
  const on = new Set(moment.feedback ?? []);
  const row = h('div', {class: 'row ratings'});
  const toggle = async (key) => {
    try {
      const result = await api('POST', `/api/moments/${moment.id}/feedback`, {label: key, on: !on.has(key)});
      moment.feedback = result.feedback;
      on.clear();
      result.feedback.forEach((label) => on.add(label));
      draw();
    } catch (err) {
      notify(err.message);
    }
  };
  const draw = () => row.replaceChildren(...Object.entries(labels).map(([key, text]) => h('button', {class: on.has(key) ? 'primary' : '', onclick: () => toggle(key)}, text)));
  draw();
  return row;
};

/** What the second model made of a moment, in one line, when the moment was judged by the two-model method. */
/** What the models made of a moment after watching it: the second model looked at frames, the first read its notes. */
const watchLine = (moment) => {
  const watch = moment.review?.watch;
  if (!watch) {
    return null;
  }
  if (watch.skipped) {
    return h('div', {class: 'dim'}, `Not watched: ${watch.skipped.replace(/^not watched: |^could not watch: /, '')}`);
  }
  return h('div', {class: 'dim'},
    `Watched (${watch.frames} frames): ${watch.seer.verdict.replace('_', ' ')}, humor ${watch.seer.humor}/10${watch.judge ? `; first model after the notes: ${watch.judge.humor}/10` : ''} · ${watch.outcome} — ${watch.seer.joke}`,
    watch.seer.seen?.length ? h('div', {}, `On screen: ${watch.seer.seen.join(' · ')}`) : null);
};

const reviewLine = (moment) => {
  const review = moment.review?.review;
  if (!review) {
    return null;
  }
  const moved = moment.review.boundary;
  const changes = moved ? [moved.setupAdded && 'start moved earlier to include the setup', moved.reactionAdded && 'end moved later to keep the payoff', moved.trimmed && 'trimmed'].filter(Boolean).join(', ') : '';
  return h('div', {class: 'dim'}, `Second model: ${review.verdict.replace('_', ' ')}, humor ${review.humor}/10 — ${review.joke}${review.flags.length ? ` · flagged: ${review.flags.join(', ').replaceAll('_', ' ')}` : ''}${changes ? ` · clip ${changes}` : ''}${moment.review.laughter ? ' · laughter in the captions' : ''}`);
};

const showMoments = async (source) => {
  const moments = await api('GET', `/api/sources/${source.video_id}/moments`);
  openPanel(h('h2', {}, source.title), h('p', {class: 'dim'}, `${moments.length} moment(s) judged`), ...moments.map((moment) => h('div', {class: 'card'},
    h('div', {class: 'row'}, tag(moment.status), h('strong', {}, `score ${moment.score}`), h('span', {class: 'dim'}, `confidence ${moment.confidence}`),
      moment.humor_type ? h('span', {class: 'tag'}, moment.humor_type.replace('_', ' ')) : null,
      h('a', {href: `${source.url}&t=${Math.floor(moment.start_s)}s`, target: '_blank', rel: 'noreferrer'}, `${clock(moment.start_s)} – ${clock(moment.end_s)}`)),
    h('div', {}, moment.reason),
    reviewLine(moment),
    watchLine(moment),
    moment.quote ? h('div', {class: 'dim'}, `Verified quote: “${moment.quote}”`) : null,
    JSON.parse(moment.risks_json ?? '[]').length ? h('div', {class: 'warn'}, `Risks: ${JSON.parse(moment.risks_json).join(', ')}`) : null,
    moment.reject_reason ? h('div', {class: moment.status === 'uncertain' ? 'warn' : 'bad'}, moment.reject_reason) : null,
    ratingRow(moment))));
};

const showShort = async (id) => {
  const short = await api('GET', `/api/shorts/${id}`);
  const post = (action, body, done) => act(async () => {
    await api('POST', `/api/shorts/${id}/${action}`, body ?? {});
    closePanel();
  }, done);
  const title = h('input', {type: 'text', value: short.metadata?.title ?? ''});
  const description = h('textarea', {}, short.metadata?.description ?? '');
  const style = h('select', {}, h('option', {value: ''}, 'next style in rotation'), state.styles.map((name) => h('option', {value: name}, name)));
  const editable = ['awaiting_approval', 'approved'].includes(short.status) && short.metadata;
  openPanel(
    h('h2', {}, `Short #${short.id} — ${short.title ?? ''}`),
    h('div', {class: 'row'}, tag(short.status), h('span', {class: 'dim'}, `${short.creator} · style ${short.style ?? 'not rendered'}`)),
    short.fail_reason ? h('p', {class: 'bad'}, short.fail_reason) : null,
    short.has_video ? h('video', {controls: true, src: `/media/short/${short.id}`}) : h('p', {class: 'dim'}, 'No rendered video yet.'),
    short.output_path ? h('p', {class: 'dim'}, short.output_path) : null,
    h('div', {class: 'row'},
      short.status === 'awaiting_approval' ? h('button', {class: 'primary', onclick: () => post('approve', null, 'Approved.')}, 'Approve') : null,
      ['awaiting_approval', 'approved'].includes(short.status) ? h('button', {class: 'danger', onclick: () => post('reject', null, 'Rejected.')}, 'Reject') : null,
      short.status === 'approved' ? h('button', {onclick: () => confirm(`Upload now as ${state.settings['upload.visibility']}${state.settings.dryRun ? ' (dry run: nothing is sent)' : ''}?`) && post('upload-now', null, 'Upload queued.')}, 'Upload now') : null,
      !['uploading', 'uploaded', 'planned', 'clipping', 'rendering'].includes(short.status) ? h('span', {class: 'row'}, style, h('button', {onclick: () => post('rerender', {style: style.value || null}, 'Rerender queued.')}, 'Rerender')) : null),
    short.video_id ? h('p', {}, 'On YouTube: ', h('a', {href: `https://www.youtube.com/watch?v=${short.video_id}`, target: '_blank', rel: 'noreferrer'}, short.video_id), ` (sent as ${short.visibility}, YouTube reports ${short.reported_privacy ?? 'unknown'})`) : null,
    h('h3', {}, 'Clips and source timestamps'),
    table(['Label', 'Source time', 'Why it was picked'], short.plan.clips.map((clip) => {
      const moment = short.moments.find((entry) => entry.id === clip.momentId);
      return h('tr', {}, h('td', {}, clip.label), h('td', {}, h('a', {href: `${short.source_url}&t=${Math.floor(clip.start)}s`, target: '_blank', rel: 'noreferrer'}, `${clock(clip.start)} – ${clock(clip.end)}`)), h('td', {class: 'dim'}, moment ? `${moment.reason} (score ${moment.score})` : ''));
    })),
    h('p', {class: 'dim'}, `Source: ${short.source_title} · order chosen by ${short.plan.arrangedBy}`),
    ...(state.feedbackLabels ? [
      h('h3', {}, 'Rate these clips'),
      h('p', {class: 'dim'}, 'Ratings teach the clip picker your taste. They do not approve, reject or upload anything.'),
      ...short.plan.clips.map((clip) => h('div', {}, h('div', {}, `${clip.label} · ${clock(clip.start)} – ${clock(clip.end)}`), ratingRow(short.moments.find((entry) => entry.id === clip.momentId)))),
    ] : []),
    h('h3', {}, 'Compliance'),
    short.compliance
      ? h('div', {}, h('p', {class: short.compliance.passed ? 'ok' : 'bad'}, short.compliance.passed ? 'Passed the mandatory checks. This lowers risk; it is not a guarantee about copyright or monetization.' : 'Failed'),
          h('ul', {class: 'list'}, short.compliance.failures.map((item) => h('li', {class: 'bad'}, `${item.check}: ${item.detail}`)), short.compliance.warnings.map((item) => h('li', {class: 'warn'}, `${item.check}: ${item.detail}`))))
      : h('p', {class: 'dim'}, 'Not checked yet.'),
    h('h3', {}, 'Render checks'),
    short.verify ? h('ul', {class: 'list'}, short.verify.checks.map((check) => h('li', {class: check.ok ? 'ok' : check.mandatory ? 'bad' : 'warn'}, `${check.name}: ${check.detail}`))) : h('p', {class: 'dim'}, 'Not rendered yet.'),
    h('h3', {}, 'YouTube title and description'),
    short.metadata
      ? h('div', {}, h('label', {class: 'field'}, h('span', {}, 'Title'), title), h('label', {class: 'field'}, h('span', {}, 'Description'), description),
          editable ? h('button', {onclick: () => act(() => api('POST', `/api/shorts/${id}/metadata`, {title: title.value, description: description.value}), 'Saved.')}, 'Save text') : null)
      : h('p', {class: 'dim'}, 'Not written yet.'),
  );
};

/* ----------------------------------------------------------------------------------------------
 * 3D office. A different way of looking at the same data the other tabs show. Its buttons call
 * the same control() as the header, and it only ever reads from the engine: it cannot change
 * how the automation runs.
 * -------------------------------------------------------------------------------------------- */

const AGENT_DEFS = {
  main: {
    key: 'main', role: 'Lead analyst', setting: 'analysis.model', accent: '#E3B261', jobTypes: ['analyze', 'plan', 'produce'],
    does: 'Picks the funny moments in each stream, arranges them into Shorts, writes the titles and descriptions, and runs the content check.',
    feed: /^(Analysed |Planned |No Short planned|Short \d+ (is ready|failed compliance|stopped)|Content review unavailable|Arrangement unavailable|Analysis of lines|Job (analyze|plan|produce) failed)/,
  },
  second: {
    key: 'second', role: 'Second opinion', setting: 'analysis.secondModel', accent: '#57C7C0', jobTypes: ['analyze'],
    does: "Re-scores the lead analyst's best picks at the end of each stream analysis. Where the two disagree, the pick's confidence is lowered.",
    feed: /^(Analysed |Second opinion unavailable|Job analyze failed)/,
  },
};
const AGENT_STATUS = {
  working: {label: 'Working', color: null},
  waiting: {label: 'Waiting', color: '#FFB020'},
  idle: {label: 'Idle', color: '#9AA0AD'},
  error: {label: 'Error', color: '#FF5C5C'},
  halted: {label: 'Halted', color: '#FF5C5C'},
};
const ANALYSED = ['analyzed', 'planned', 'exhausted'];
const RANGES = [['today', 'Today'], ['day', 'Last 24 h'], ['all', 'All time']];
const NOT_TRACKED = 'Not tracked';

const modelLabel = (id) => {
  const nim = id.startsWith('nim:');
  const name = nim ? id.slice(4) : id;
  return {id, name, short: name.split('/').pop(), provider: nim ? 'NVIDIA NIM' : 'Ollama cloud'};
};

/** Count items per time range by a timestamp. "All time" counts every item, dated or not. */
const countByRange = (items, pick, now) => {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const since = {today: midnight, day: now - 86_400_000};
  const out = {all: items.length};
  for (const range of ['today', 'day']) {
    out[range] = items.filter((item) => {
      const t = Date.parse(pick(item));
      return Number.isFinite(t) && t >= since[range];
    }).length;
  }
  return out;
};

/**
 * Work out what each desk is doing and has done, from what the engine reports. Nothing here is
 * estimated: a figure the engine does not record is returned as "Not tracked".
 */
const deriveAgents = (data, now = Date.now()) => {
  const {jobs, events, shorts, sources, uploads, moments, momentsReady} = data;
  const settings = data.state.settings;
  const sourceById = new Map(sources.map((source) => [source.video_id, source]));
  const shortById = new Map(shorts.map((short) => [short.id, short]));
  const payloadOf = (job) => {
    try {
      return JSON.parse(job.payload_json || '{}');
    } catch {
      return {};
    }
  };
  const describe = (job) => {
    const payload = payloadOf(job);
    if (payload.videoId) {
      return sourceById.get(payload.videoId)?.title ?? payload.videoId;
    }
    if (payload.shortId != null) {
      const short = shortById.get(payload.shortId);
      return `Short #${payload.shortId}${short?.title ? ` · ${short.title}` : ''}`;
    }
    return job.payload_json;
  };

  const analysed = sources.filter((source) => ANALYSED.includes(source.status));
  const analysedTimed = analysed.map((source) => ({at: (moments.get(source.video_id) ?? [])[0]?.created_at ?? null}));
  const allMoments = analysed.flatMap((source) => moments.get(source.video_id) ?? []);
  const loading = {today: '…', day: '…', all: '…'};
  const analysedCounts = momentsReady ? countByRange(analysedTimed, (entry) => entry.at, now) : {today: '…', day: '…', all: analysed.length};
  const confirmed = uploads.filter((upload) => upload.state === 'confirmed');
  const stopped = shorts.filter((short) => ['compliance_rejected', 'verify_failed'].includes(short.status));
  const anyRunning = jobs.find((job) => job.status === 'running');
  const unavailable = events.filter((event) => event.message.startsWith('Second opinion unavailable'));

  const build = (def) => {
    const model = modelLabel(String(settings[def.setting]));
    const health = data.state.health?.checks?.[`model ${model.id}`] ?? null;
    const mine = jobs.filter((job) => def.jobTypes.includes(job.type));
    const running = mine.find((job) => job.status === 'running');
    const queued = mine.filter((job) => job.status === 'queued');
    const dead = mine.filter((job) => job.status === 'dead');

    let status = 'idle';
    let task = 'No work is queued for this desk.';
    let progress = null;
    if (running) {
      status = 'working';
      const payload = payloadOf(running);
      if (def.key === 'second') {
        task = `On call for “${describe(running)}”. It re-scores the best picks when the lead analyst finishes this stream.`;
      } else if (running.type === 'analyze') {
        task = `Analysing a stream: “${describe(running)}”.`;
      } else if (running.type === 'plan') {
        task = `Planning Shorts from “${describe(running)}”.`;
      } else {
        const short = shortById.get(payload.shortId);
        if (short?.status === 'rendering') {
          task = `Short #${payload.shortId} is rendering. This desk runs its content check and writes its title as part of the same job.`;
          progress = {label: 'Render progress', value: Number(short.progress) || 0};
        } else {
          task = `Producing ${describe(running)}: the footage is cut, then this desk runs the content check and writes the title.`;
        }
      }
    } else if (queued.length > 0) {
      status = 'waiting';
      task = `${queued.length} job${queued.length === 1 ? '' : 's'} waiting for this desk.${anyRunning ? ` The engine is busy with a ${anyRunning.type} job.` : ''}`;
    }
    if (health && !health.ok) {
      status = 'error';
      task = `The model did not answer the engine's last health check: ${health.detail}`;
    }
    if (settings['automation.emergencyStop']) {
      status = 'halted';
      task = 'The emergency stop is on. Nothing runs until it is cleared.';
    }

    const notes = [];
    if (settings['automation.paused'] && !settings['automation.emergencyStop']) {
      notes.push('Automation is paused: no new streams are looked for and nothing posts on schedule. Jobs already queued still run.');
    }
    const assigned = events.find((event) => event.message.startsWith('Settings changed:') && event.message.includes(`${def.setting} =`))?.ts ?? null;
    notes.push(
      assigned
        ? `This model was assigned to the desk at ${when(assigned)}. The counts cover all work done at this desk, including by the model that sat here before.`
        : 'The counts cover all work done at this desk, whichever model was assigned at the time.',
    );
    if (sources.length >= 200) {
      notes.push('Stream counts cover the 200 most recently found streams.');
    }

    const failed = {label: def.key === 'main' ? 'Failed jobs at this desk' : 'Failed analysis jobs', ...countByRange(dead, (job) => job.finished_at, now)};
    const stats =
      def.key === 'main'
        ? [
            {label: 'Streams analysed', ...analysedCounts},
            {label: 'Moments judged', ...(momentsReady ? countByRange(allMoments, (moment) => moment.created_at, now) : loading)},
            {label: 'Candidate clips kept', ...(momentsReady ? countByRange(allMoments.filter((moment) => moment.status !== 'rejected'), (moment) => moment.created_at, now) : loading)},
            {label: 'Shorts planned', ...countByRange(shorts, (short) => short.created_at, now)},
            {label: 'Edits rendered', today: NOT_TRACKED, day: NOT_TRACKED, all: shorts.filter((short) => short.has_video).length},
            {label: 'Stopped by the checks', ...countByRange(stopped, (short) => short.updated_at, now)},
            {label: 'Published to YouTube', ...countByRange(confirmed, (upload) => upload.confirmed_at, now), hint: `All time: ${confirmed.filter((u) => (u.reported_privacy ?? u.visibility) === 'public').length} public, ${confirmed.filter((u) => (u.reported_privacy ?? u.visibility) !== 'public').length} not public.`},
            failed,
          ]
        : [
            {label: 'Stream analyses it took part in', ...analysedCounts},
            {label: 'Picks re-scored', today: NOT_TRACKED, day: NOT_TRACKED, all: NOT_TRACKED, hint: 'The engine has this model re-score up to 12 picks per stream but does not record which ones.'},
            {label: 'Times it was unavailable', ...countByRange(unavailable, (event) => event.ts, now), hint: 'Counted from the latest 200 log entries only.'},
            failed,
          ];
    const tiles =
      def.key === 'main'
        ? [['Streams analysed', analysed.length], ['Shorts planned', shorts.length], ['Published', confirmed.length]]
        : [['Analyses joined', analysed.length], ['Unavailable (recent)', unavailable.length], ['Failed jobs', dead.length]];

    return {
      key: def.key,
      role: def.role,
      does: def.does,
      accent: def.accent,
      model,
      status,
      task,
      progress,
      notes,
      stats,
      tiles,
      jobs: [running, ...queued.slice(0, 6), ...dead.slice(0, 4)].filter(Boolean).map((job) => ({id: job.id, type: job.type, status: job.status, text: describe(job), error: job.last_error ?? null})),
      queuedCount: queued.length,
      feed: events.filter((event) => def.feed.test(event.message)).slice(0, 14).map((event) => ({ts: event.ts, level: event.level, text: event.message})),
    };
  };

  return {
    main: build(AGENT_DEFS.main),
    second: build(AGENT_DEFS.second),
    context: {
      found: countByRange(sources, (source) => source.discovered_at, now),
      blocked: sources.filter((source) => source.status === 'blocked').length,
      skipped: sources.filter((source) => source.status === 'skipped').length,
    },
  };
};

/** Build the 3D scene inside `host`. Resolves with handles to update, steer and dispose of it. */
const buildOffice = async (host, hooks) => {
  const THREE = await import('three');
  const [{RoomEnvironment}, {RoundedBoxGeometry}, {mergeGeometries}] = await Promise.all([
    import('three/addons/environments/RoomEnvironment.js'),
    import('three/addons/geometries/RoundedBoxGeometry.js'),
    import('three/addons/utils/BufferGeometryUtils.js'),
  ]);

  const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D office. Click to look around; W A S D or the arrow keys to move.');
  host.append(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(66, 1, 0.05, 2600);
  camera.rotation.order = 'YXZ';
  const disposers = [];
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    disposers.push(() => target.removeEventListener(type, fn, options));
  };
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // A fixed seed, so the city is the same every time.
  let seed = 20261013;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const tex = (w, hgt, draw, repeat = null) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hgt;
    draw(c.getContext('2d'), w, hgt);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    if (repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat[0], repeat[1]);
    }
    return t;
  };
  const speckle = (ctx, w, hgt, count, light, dark) => {
    for (let i = 0; i < count; i += 1) {
      ctx.fillStyle = rnd() < 0.5 ? light : dark;
      ctx.globalAlpha = 0.03 + rnd() * 0.07;
      ctx.fillRect(rnd() * w, rnd() * hgt, 1 + rnd() * 2.5, 1 + rnd() * 2.5);
    }
    ctx.globalAlpha = 1;
  };
  const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

  const walnutTex = tex(512, 512, (ctx, w, hgt) => {
    ctx.fillStyle = '#4d311e';
    ctx.fillRect(0, 0, w, hgt);
    for (let i = 0; i < 300; i += 1) {
      ctx.strokeStyle = rnd() < 0.5 ? `rgba(126,84,50,${0.05 + rnd() * 0.14})` : `rgba(20,10,4,${0.08 + rnd() * 0.22})`;
      ctx.lineWidth = 0.6 + rnd() * 2.4;
      ctx.beginPath();
      let y = rnd() * hgt;
      ctx.moveTo(0, y);
      for (let x = 0; x <= w; x += 32) {
        y += (rnd() - 0.5) * 5;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, [1, 1]);
  const walnutVTex = walnutTex.clone();
  walnutVTex.center.set(0.5, 0.5);
  walnutVTex.rotation = Math.PI / 2;
  walnutVTex.needsUpdate = true;
  const concreteTex = tex(512, 512, (ctx, w, hgt) => {
    ctx.fillStyle = '#8e9091';
    ctx.fillRect(0, 0, w, hgt);
    for (let i = 0; i < 40; i += 1) {
      const g = ctx.createRadialGradient(rnd() * w, rnd() * hgt, 4, rnd() * w, rnd() * hgt, 90 + rnd() * 140);
      g.addColorStop(0, `rgba(${rnd() < 0.5 ? '255,255,255' : '40,40,40'},0.05)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, hgt);
    }
    speckle(ctx, w, hgt, 7000, '#ffffff', '#303030');
  }, [3, 1]);
  const floorTex = tex(512, 512, (ctx, w, hgt) => {
    ctx.fillStyle = '#6f7275';
    ctx.fillRect(0, 0, w, hgt);
    for (let i = 0; i < 30; i += 1) {
      const g = ctx.createRadialGradient(rnd() * w, rnd() * hgt, 4, rnd() * w, rnd() * hgt, 120 + rnd() * 160);
      g.addColorStop(0, `rgba(${rnd() < 0.5 ? '255,255,255' : '30,30,30'},0.045)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, hgt);
    }
    speckle(ctx, w, hgt, 5000, '#ffffff', '#2a2a2a');
    ctx.strokeStyle = 'rgba(20,20,22,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, w, hgt);
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, hgt);
    ctx.moveTo(0, hgt / 2);
    ctx.lineTo(w, hgt / 2);
    ctx.stroke();
  }, [22 / 3.2, 14 / 3.2]);
  const facade = (frame, glassA, glassB) =>
    tex(256, 256, (ctx) => {
      ctx.fillStyle = frame;
      ctx.fillRect(0, 0, 256, 256);
      for (let r = 0; r < 4; r += 1) {
        for (let c = 0; c < 4; c += 1) {
          const g = ctx.createLinearGradient(0, r * 64, 0, r * 64 + 64);
          g.addColorStop(0, rnd() > 0.45 ? glassA : glassB);
          g.addColorStop(1, glassB);
          ctx.fillStyle = g;
          ctx.fillRect(c * 64 + 7, r * 64 + 9, 50, 46);
        }
      }
    }, [1, 1]);
  const signTex = (w, hgt, size, background) =>
    tex(w, hgt, (ctx) => {
      if (background) {
        const g = ctx.createLinearGradient(0, 0, 0, hgt);
        g.addColorStop(0, '#0e1116');
        g.addColorStop(1, '#07080a');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, hgt);
      }
      ctx.font = `800 ${size}px ${FONT}`;
      ctx.textBaseline = 'middle';
      const widthA = ctx.measureText('Lopy').width;
      const widthB = ctx.measureText('Clips').width;
      const x = (w - widthA - widthB) / 2;
      ctx.fillStyle = '#f4f1ea';
      ctx.fillText('Lopy', x, hgt * 0.48);
      ctx.fillStyle = '#e3b261';
      ctx.fillText('Clips', x + widthA, hgt * 0.48);
      if (background) {
        ctx.fillStyle = 'rgba(227,178,97,0.9)';
        ctx.fillRect(x, hgt * 0.83, widthA + widthB, Math.max(4, size * 0.03));
      }
    });

  const std = (options) => new THREE.MeshStandardMaterial({envMapIntensity: 0.5, ...options});
  const mats = {
    walnut: std({map: walnutTex, roughness: 0.48}),
    walnutV: std({map: walnutVTex, roughness: 0.5}),
    walnutDark: std({map: walnutTex, color: 0x9a8f88, roughness: 0.55}),
    concrete: std({map: concreteTex, roughness: 0.93}),
    floor: std({map: floorTex, roughness: 0.3, envMapIntensity: 0.85}),
    // Matte: a ceiling should not mirror the room at shallow angles.
    ceiling: new THREE.MeshLambertMaterial({color: 0xdedbd4}),
    blackMetal: std({color: 0x17181b, roughness: 0.42, metalness: 0.85}),
    brushed: std({color: 0xb9bcc0, roughness: 0.3, metalness: 1}),
    gloss: std({color: 0x08090b, roughness: 0.14, metalness: 0.5}),
    plastic: std({color: 0x1d1f23, roughness: 0.62}),
    fabric: std({color: 0x2b2d32, roughness: 0.97}),
    fabricLight: std({color: 0x8f8b84, roughness: 0.97}),
    rug: std({color: 0x25272b, roughness: 1}),
    leaf: std({color: 0x2f5a37, roughness: 0.72}),
    ceramic: std({color: 0xe6e2da, roughness: 0.35}),
    backing: std({color: 0x15120f, roughness: 0.9}),
    glass: std({color: 0xa9c4d2, transparent: true, opacity: 0.1, roughness: 0.04, envMapIntensity: 1.6, depthWrite: false, side: THREE.DoubleSide}),
    glow: new THREE.MeshBasicMaterial({color: 0xfff1d6}),
  };

  const box = (w, hgt, d, material, x, y, z, {cast = true, receive = true, radius = 0, parent = scene} = {}) => {
    const geometry = radius > 0 ? new RoundedBoxGeometry(w, hgt, d, 3, radius) : new THREE.BoxGeometry(w, hgt, d);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    parent.add(mesh);
    return mesh;
  };
  const cyl = (rTop, rBottom, hgt, material, x, y, z, {cast = true, parent = scene, segments = 20} = {}) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, hgt, segments), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const colliders = [];
  const solid = (x, z, w, d) => colliders.push({minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2});

  /* ---- sky, sun and reflections ---- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  const SUN = new THREE.Vector3(0.62, 0.47, -0.63).normalize();
  scene.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(1900, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {sunDir: {value: SUN}},
        vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 sunDir; varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float up = clamp(d.y, -1.0, 1.0);
            vec3 zenith = vec3(0.10, 0.30, 0.68);
            vec3 horizon = vec3(0.62, 0.76, 0.92);
            vec3 col = mix(horizon, zenith, pow(max(up, 0.0), 0.42));
            col = mix(col, vec3(0.92, 0.86, 0.78), pow(1.0 - abs(up), 14.0) * 0.5);
            float s = max(dot(d, normalize(sunDir)), 0.0);
            col += vec3(1.0, 0.86, 0.66) * (pow(s, 700.0) * 6.0 + pow(s, 24.0) * 0.25);
            if (up < 0.0) { col = mix(horizon, vec3(0.70, 0.74, 0.79), clamp(-up * 4.0, 0.0, 1.0)); }
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    ),
  );
  scene.fog = new THREE.Fog(0xb9cde3, 300, 1900);
  const sun = new THREE.DirectionalLight(0xfff0dc, 3.3);
  sun.position.copy(SUN).multiplyScalar(80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {left: -18, right: 18, top: 14, bottom: -14, near: 20, far: 150});
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target, new THREE.HemisphereLight(0xdbe8ff, 0x6f665a, 0.75));

  /* ---- the city ---- */
  const GROUND = -168;
  const cityParts = {glass: [], stone: [], dark: []};
  const cityMats = {
    glass: std({map: facade('#3b4650', '#a3bccf', '#5d7a91'), vertexColors: true, roughness: 0.25, metalness: 0.55, envMapIntensity: 0.9}),
    stone: std({map: facade('#b9b2a6', '#4a5a68', '#2c3842'), vertexColors: true, roughness: 0.82, metalness: 0.05}),
    dark: std({map: facade('#23272c', '#72899b', '#34424e'), vertexColors: true, roughness: 0.42, metalness: 0.45, envMapIntensity: 0.8}),
  };
  const kinds = Object.keys(cityParts);
  const addBlock = (kind, x, z, w, d, base, height, shade) => {
    const geometry = new THREE.BoxGeometry(w, height, d);
    const uv = geometry.attributes.uv;
    // Scale the texture by the block's size so every window is the same size; roofs get the frame colour.
    for (let i = 0; i < uv.count; i += 1) {
      const face = Math.floor(i / 4);
      if (face === 2 || face === 3) {
        uv.setXY(i, 0.02, 0.02);
      } else {
        uv.setXY(i, (uv.getX(i) * (face < 2 ? d : w)) / 14, (uv.getY(i) * height) / 14.4);
      }
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(uv.count * 3).fill(shade), 3));
    geometry.translate(x, base + height / 2, z);
    cityParts[kind].push(geometry);
  };
  const beaconSpots = [];
  for (let gx = -11; gx <= 11; gx += 1) {
    for (let gz = -11; gz <= 11; gz += 1) {
      const x = gx * 62 + (rnd() - 0.5) * 16;
      const z = gz * 62 + (rnd() - 0.5) * 16;
      const dist = Math.hypot(x, z);
      const onSignBlock = (Math.abs(x - 4) < 52 && Math.abs(z + 96) < 46) || (Math.abs(x - 104) < 46 && Math.abs(z - 6) < 54);
      if (dist < 62 || onSignBlock || rnd() < 0.1) {
        continue;
      }
      // Keep the sightlines to the two signs clear of tall buildings.
      const sightline = (z < -30 && z > -165 && Math.abs(x - 4) < 72) || (x > 30 && x < 190 && Math.abs(z - 6) < 62);
      let height = 55 + Math.pow(rnd(), 1.6) * (dist > 260 ? 190 : 110);
      if (sightline) {
        height = 28 + rnd() * 50;
      } else if (z < -175 && Math.abs(x) < 280) {
        height = 150 + rnd() * 110;
      }
      const w = 28 + rnd() * 18;
      const d = 28 + rnd() * 18;
      const kind = kinds[Math.floor(rnd() * kinds.length)];
      const shade = 0.72 + rnd() * 0.36;
      addBlock(kind, x, z, w, d, GROUND, height, shade);
      let top = GROUND + height;
      if (height > 90 && rnd() < 0.45) {
        const crown = 12 + rnd() * 30;
        addBlock(kind, x, z, w * 0.62, d * 0.62, top, crown, shade);
        top += crown;
      }
      addBlock('dark', x + (rnd() - 0.5) * w * 0.3, z + (rnd() - 0.5) * d * 0.3, 6, 6, top, 3, 0.6);
      if (top > 25 && beaconSpots.length < 9) {
        beaconSpots.push([x, top + 4, z]);
      }
    }
  }
  addBlock('dark', 4, -96, 56, 42, GROUND, 158, 0.9);
  addBlock('glass', 104, 6, 42, 58, GROUND, 160, 0.95);
  for (const kind of kinds) {
    const mesh = new THREE.Mesh(mergeGeometries(cityParts[kind]), cityMats[kind]);
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    cityParts[kind].forEach((geometry) => geometry.dispose());
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), std({color: 0x3b4147, roughness: 1, envMapIntensity: 0}));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND;
  scene.add(ground);

  const lampMat = new THREE.MeshBasicMaterial({color: 0xfff3da});
  const makeBillboard = (x, roofY, z, rotY, width, height) => {
    const group = new THREE.Group();
    group.position.set(x, roofY, z);
    group.rotation.y = rotY;
    scene.add(group);
    const legHeight = 4.2;
    const centre = legHeight + height / 2;
    const face = signTex(2048, Math.round((2048 * height) / width), Math.round((2048 * height) / width) * 0.52, true);
    const lit = std({map: face, emissive: 0xffffff, emissiveMap: face, emissiveIntensity: 1.15, roughness: 0.55, envMapIntensity: 0.2});
    const metal = mats.blackMetal;
    const quiet = {parent: group, cast: false, receive: false};
    const panel = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.9), [metal, metal, metal, metal, lit, metal]);
    panel.position.set(0, centre, 0);
    group.add(panel);
    box(width + 1, 0.55, 1.3, metal, 0, centre + height / 2 + 0.27, 0, quiet);
    box(width + 1, 0.55, 1.3, metal, 0, centre - height / 2 - 0.27, 0, quiet);
    for (const side of [-1, 1]) {
      box(0.55, height + 1.1, 1.3, metal, side * (width / 2 + 0.27), centre, 0, quiet);
    }
    for (let i = 0; i < 6; i += 1) {
      const lx = -width / 2 + 1.6 + (i * (width - 3.2)) / 5;
      box(0.5, legHeight + height, 0.5, metal, lx, (legHeight + height) / 2, -0.95, quiet);
      const brace = box(0.32, height * 0.9, 0.32, metal, lx, height * 0.42, -3.2, quiet);
      brace.rotation.x = 0.5;
    }
    box(width, 0.18, 1.7, metal, 0, legHeight - 0.25, 1.15, quiet);
    box(width, 0.09, 0.09, metal, 0, legHeight + 0.95, 1.9, quiet);
    for (let i = 0; i <= 16; i += 1) {
      box(0.08, 1.15, 0.08, metal, -width / 2 + (i * width) / 16, legHeight + 0.38, 1.9, quiet);
    }
    for (let i = 0; i < 9; i += 1) {
      const lx = -width / 2 + 2 + (i * (width - 4)) / 8;
      box(0.13, 0.13, 2.7, metal, lx, centre + height / 2 + 0.75, 1.25, quiet);
      box(0.55, 0.22, 0.36, lampMat, lx, centre + height / 2 + 0.66, 2.5, quiet);
    }
  };
  makeBillboard(4, -10, -77, 0, 44, 13.5);
  makeBillboard(84.5, -8, 6, -Math.PI / 2, 30, 9.2);

  const beaconMat = new THREE.MeshBasicMaterial({color: 0xff2a1a});
  const beacons = beaconSpots.map(([x, y, z]) => {
    box(0.6, 8, 0.6, mats.blackMetal, x, y, z, {cast: false, receive: false});
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), beaconMat);
    lamp.position.set(x, y + 4.6, z);
    scene.add(lamp);
    return lamp;
  });
  const cloudTex = tex(256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });
  const clouds = Array.from({length: 9}, () => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map: cloudTex, transparent: true, opacity: 0.5, depthWrite: false, fog: false}));
    sprite.position.set((rnd() - 0.5) * 2200, 230 + rnd() * 240, -500 - rnd() * 800);
    sprite.scale.set(420 + rnd() * 360, 110 + rnd() * 90, 1);
    scene.add(sprite);
    return sprite;
  });

  /* ---- the room ---- */
  const HALF_W = 11;
  const HALF_D = 7;
  const HEIGHT = 3.3;
  box(HALF_W * 2 + 0.6, 0.3, HALF_D * 2 + 0.6, mats.floor, 0, -0.15, 0, {cast: false});
  box(HALF_W * 2 + 0.6, 0.3, HALF_D * 2 + 0.6, mats.ceiling, 0, HEIGHT + 0.15, 0, {receive: false});
  box(HALF_W * 2 + 0.6, HEIGHT, 0.3, mats.concrete, 0, HEIGHT / 2, HALF_D + 0.15, {cast: false});
  box(0.3, HEIGHT, HALF_D * 2 + 0.6, mats.concrete, -HALF_W - 0.15, HEIGHT / 2, 0, {cast: false});
  // Walnut slat wall with the company sign.
  box(12.3, HEIGHT, 0.04, mats.backing, 0, HEIGHT / 2, HALF_D - 0.005, {cast: false});
  const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.075, HEIGHT - 0.06, 0.05), mats.walnutV, 87);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < 87; i += 1) {
    matrix.makeTranslation(-6.02 + i * 0.14, HEIGHT / 2, HALF_D - 0.045);
    slats.setMatrixAt(i, matrix);
  }
  slats.receiveShadow = true;
  scene.add(slats);
  const wallSign = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 0.7), new THREE.MeshBasicMaterial({map: signTex(1024, 218, 150, false), transparent: true}));
  wallSign.position.set(0, 2.12, HALF_D - 0.085);
  wallSign.rotation.y = Math.PI;
  scene.add(wallSign);
  box(3.7, 0.7, 0.5, mats.walnut, 0, 0.35, HALF_D - 0.3, {radius: 0.012});
  box(3.74, 0.03, 0.54, mats.blackMetal, 0, 0.715, HALF_D - 0.3);
  cyl(0.09, 0.12, 0.34, mats.ceramic, -1.2, 0.9, HALF_D - 0.3);
  cyl(0.06, 0.09, 0.22, mats.blackMetal, -0.9, 0.84, HALF_D - 0.28);
  box(0.3, 0.05, 0.22, mats.fabricLight, 1.1, 0.755, HALF_D - 0.3);
  box(0.27, 0.04, 0.2, mats.blackMetal, 1.1, 0.8, HALF_D - 0.3);
  solid(0, HALF_D - 0.3, 3.8, 0.6);
  // Door and bookshelf on the concrete wall.
  box(0.06, 2.25, 1.05, mats.walnutDark, -HALF_W + 0.03, 1.125, 4.7, {cast: false});
  cyl(0.015, 0.015, 0.3, mats.brushed, -HALF_W + 0.09, 1.05, 4.3, {cast: false});
  const shelfZ = -1.6;
  box(0.03, 2.3, 3.2, mats.walnutDark, -HALF_W + 0.02, 1.15, shelfZ, {cast: false});
  for (const side of [-1, 1]) {
    box(0.38, 2.3, 0.04, mats.walnut, -HALF_W + 0.2, 1.15, shelfZ + side * 1.6);
  }
  const shelfLevels = [0.02, 0.48, 0.94, 1.4, 1.86, 2.28];
  shelfLevels.forEach((y) => box(0.38, 0.035, 3.2, mats.walnut, -HALF_W + 0.2, y, shelfZ));
  const bookColours = [0x2b3440, 0x6b4a34, 0x8a8478, 0x1e2226, 0x4a5a52, 0x9a6b3a, 0xd9d2c4, 0x3a2f2a];
  const books = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), std({roughness: 0.85}), 260);
  const colour = new THREE.Color();
  let bookCount = 0;
  for (const level of shelfLevels.slice(0, 5)) {
    let z = shelfZ - 1.5;
    while (z < shelfZ + 1.48 && bookCount < 260) {
      if (rnd() < 0.08) {
        z += 0.25 + rnd() * 0.3;
        continue;
      }
      const thick = 0.028 + rnd() * 0.034;
      const tall = 0.2 + rnd() * 0.11;
      matrix.compose(new THREE.Vector3(-HALF_W + 0.17, level + 0.0175 + tall / 2, z + thick / 2), new THREE.Quaternion(), new THREE.Vector3(0.2 + rnd() * 0.05, tall, thick));
      books.setMatrixAt(bookCount, matrix);
      books.setColorAt(bookCount, colour.setHex(bookColours[Math.floor(rnd() * bookColours.length)]));
      bookCount += 1;
      z += thick + 0.003;
    }
  }
  books.count = bookCount;
  books.castShadow = true;
  scene.add(books);
  solid(-HALF_W + 0.2, shelfZ, 0.55, 3.35);
  // Glass curtain walls on the north and east sides.
  const northGlass = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, HEIGHT), mats.glass);
  northGlass.position.set(0, HEIGHT / 2, -HALF_D);
  const eastGlass = new THREE.Mesh(new THREE.PlaneGeometry(HALF_D * 2, HEIGHT), mats.glass);
  eastGlass.position.set(HALF_W, HEIGHT / 2, 0);
  eastGlass.rotation.y = Math.PI / 2;
  scene.add(northGlass, eastGlass);
  for (let x = -HALF_W; x <= HALF_W + 0.01; x += 2.2) {
    box(0.07, HEIGHT, 0.15, mats.blackMetal, x, HEIGHT / 2, -HALF_D);
  }
  for (let z = -HALF_D + 2; z <= HALF_D + 0.01; z += 2) {
    box(0.15, HEIGHT, 0.07, mats.blackMetal, HALF_W, HEIGHT / 2, z);
  }
  for (const y of [0.05, HEIGHT - 0.05]) {
    box(HALF_W * 2, 0.1, 0.17, mats.blackMetal, 0, y, -HALF_D, {cast: false});
    box(0.17, 0.1, HALF_D * 2, mats.blackMetal, HALF_W, y, 0, {cast: false});
  }
  box(0.3, HEIGHT, 0.3, mats.concrete, HALF_W, HEIGHT / 2, -HALF_D);
  // Ceiling light lines and soft interior fill.
  for (const z of [-3.2, 0.6, 4.4]) {
    box(16, 0.03, 0.12, mats.glow, 0, HEIGHT - 0.016, z, {cast: false, receive: false});
  }
  for (const [x, z] of [[-6.5, 1.2], [0, 2.4], [6.5, 1.2], [-4, 5.2], [4, 5.2]]) {
    const light = new THREE.PointLight(0xffe9cf, 4.5, 15, 2);
    light.position.set(x, 1.9, z);
    scene.add(light);
  }
  // Lounge by the east glass.
  box(4.4, 0.02, 3.4, mats.rug, 8.2, 0.012, 3.2, {cast: false});
  box(0.95, 0.42, 2.3, mats.fabric, 9.6, 0.21, 3.2, {radius: 0.05});
  box(0.24, 0.5, 2.3, mats.fabric, 9.98, 0.66, 3.2, {radius: 0.05});
  for (const side of [-1, 1]) {
    box(0.95, 0.26, 0.2, mats.fabric, 9.6, 0.55, 3.2 + side * 1.05, {radius: 0.04});
    box(0.7, 0.14, 0.95, mats.fabricLight, 9.5, 0.49, 3.2 + side * 0.5, {radius: 0.05});
  }
  solid(9.65, 3.2, 1.1, 2.4);
  box(0.7, 0.04, 1.3, mats.walnut, 8.0, 0.38, 3.2, {radius: 0.012});
  for (const [dx, dz] of [[-0.3, -0.58], [0.3, -0.58], [-0.3, 0.58], [0.3, 0.58]]) {
    box(0.03, 0.36, 0.03, mats.blackMetal, 8.0 + dx, 0.18, 3.2 + dz);
  }
  box(0.26, 0.03, 0.34, mats.fabricLight, 7.95, 0.415, 3.0);
  cyl(0.07, 0.05, 0.1, mats.ceramic, 8.1, 0.45, 3.55);
  solid(8.0, 3.2, 0.75, 1.35);
  cyl(0.16, 0.2, 0.03, mats.blackMetal, 10.3, 0.015, 5.3);
  cyl(0.012, 0.012, 1.6, mats.blackMetal, 10.3, 0.8, 5.3);
  cyl(0.14, 0.2, 0.3, new THREE.MeshBasicMaterial({color: 0xffe2b0}), 10.3, 1.7, 5.3, {cast: false});
  const lamp = new THREE.PointLight(0xffd9a0, 9, 7, 2);
  lamp.position.set(10.3, 1.6, 5.3);
  scene.add(lamp);
  solid(10.3, 5.3, 0.4, 0.4);
  const plant = (x, z, size = 1) => {
    cyl(0.2 * size, 0.16 * size, 0.42 * size, mats.concrete, x, 0.21 * size, z);
    for (let i = 0; i < 11; i += 1) {
      const angle = (i / 11) * Math.PI * 2 + rnd();
      const tall = (0.55 + rnd() * 0.6) * size;
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.045 * size, tall, 5), mats.leaf);
      blade.scale.z = 0.35;
      blade.position.set(x + Math.cos(angle) * 0.07 * size, 0.42 * size + tall / 2 - 0.03, z + Math.sin(angle) * 0.07 * size);
      blade.rotation.set((rnd() - 0.5) * 0.35, angle, (rnd() - 0.5) * 0.35);
      blade.castShadow = true;
      scene.add(blade);
    }
    solid(x, z, 0.5 * size, 0.5 * size);
  };
  plant(-10.2, -6.1, 1.25);
  plant(10.2, 6.2, 1.2);
  plant(-10.2, 6.1, 1.1);
  plant(6.4, 5.9, 0.9);

  /* ---- the two workstations ---- */
  const SCREEN_W = 1024;
  const SCREEN_H = 594;
  const fit = (ctx, text, max) => {
    let out = String(text);
    if (ctx.measureText(out).width <= max) {
      return out;
    }
    while (out.length > 1 && ctx.measureText(`${out}…`).width > max) {
      out = out.slice(0, -1);
    }
    return `${out}…`;
  };
  const wrap = (ctx, text, max, maxLines) => {
    const lines = [];
    let current = '';
    for (const word of String(text).split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width > max && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    lines.push(current);
    if (lines.length > maxLines) {
      lines[maxLines - 1] = fit(ctx, lines.slice(maxLines - 1).join(' '), max);
      lines.length = maxLines;
    }
    return lines;
  };
  const statusColour = (agent) => AGENT_STATUS[agent.status].color ?? agent.accent;
  const drawStatus = (ctx, agent) => {
    const w = SCREEN_W;
    const colourNow = statusColour(agent);
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(0, 0, w, SCREEN_H);
    ctx.fillStyle = agent.accent;
    ctx.fillRect(0, 0, w, 8);
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 24px ${FONT}`;
    ctx.fillStyle = agent.accent;
    ctx.fillText(agent.role.toUpperCase().split('').join(' '), 44, 62);
    ctx.font = `700 46px ${FONT}`;
    ctx.fillStyle = '#f2efe9';
    ctx.fillText(fit(ctx, agent.model.short, w - 88), 44, 116);
    ctx.font = `400 22px ${FONT}`;
    ctx.fillStyle = '#8f95a3';
    ctx.fillText(agent.model.provider, 44, 148);
    ctx.font = `800 30px ${FONT}`;
    const label = AGENT_STATUS[agent.status].label.toUpperCase();
    const chipWidth = ctx.measureText(label).width + 76;
    ctx.strokeStyle = colourNow;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(44, 176, chipWidth, 56, 28);
    ctx.stroke();
    ctx.fillStyle = colourNow;
    ctx.beginPath();
    ctx.arc(74, 204, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(label, 96, 215);
    ctx.font = `400 27px ${FONT}`;
    ctx.fillStyle = '#d6d8de';
    wrap(ctx, agent.task, w - 88, 3).forEach((line, i) => ctx.fillText(line, 44, 286 + i * 38));
    agent.tiles.forEach(([caption, value], i) => {
      const x = 44 + i * 316;
      ctx.fillStyle = '#151820';
      ctx.beginPath();
      ctx.roundRect(x, 414, 300, 140, 14);
      ctx.fill();
      ctx.font = `800 56px ${FONT}`;
      ctx.fillStyle = '#f2efe9';
      ctx.fillText(String(value), x + 24, 488);
      ctx.font = `400 21px ${FONT}`;
      ctx.fillStyle = '#8f95a3';
      ctx.fillText(fit(ctx, caption, 256), x + 24, 526);
    });
  };
  const drawFeed = (ctx, agent) => {
    const w = SCREEN_W;
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(0, 0, w, SCREEN_H);
    ctx.fillStyle = agent.accent;
    ctx.fillRect(0, 0, w, 8);
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 24px ${FONT}`;
    ctx.fillStyle = agent.accent;
    ctx.fillText('R E C E N T   A C T I V I T Y', 44, 62);
    if (agent.feed.length === 0) {
      ctx.font = `400 27px ${FONT}`;
      ctx.fillStyle = '#8f95a3';
      ctx.fillText('Nothing for this desk in the recent log.', 44, 130);
      return;
    }
    agent.feed.slice(0, 7).forEach((entry, i) => {
      const y = 122 + i * 66;
      ctx.font = `400 22px ${FONT}`;
      ctx.fillStyle = '#8f95a3';
      ctx.fillText(new Date(entry.ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}), 44, y);
      ctx.font = `400 25px ${FONT}`;
      ctx.fillStyle = entry.level === 'error' ? '#ff7b7b' : entry.level === 'warn' ? '#ffc35a' : '#e4e6ea';
      ctx.fillText(fit(ctx, entry.text, w - 190), 146, y);
      ctx.fillStyle = '#1b1e26';
      ctx.fillRect(44, y + 22, w - 88, 2);
    });
  };

  const interactables = [];
  const desks = {};
  const makeDesk = (key, x, z) => {
    const def = AGENT_DEFS[key];
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    scene.add(group);
    const local = {parent: group};
    box(2.3, 0.045, 0.98, mats.walnut, 0, 0.745, 0, {...local, radius: 0.015});
    for (const side of [-1, 1]) {
      box(0.05, 0.72, 0.05, mats.blackMetal, side * 1.05, 0.36, -0.4, local);
      box(0.05, 0.72, 0.05, mats.blackMetal, side * 1.05, 0.36, 0.4, local);
      box(0.05, 0.04, 0.85, mats.blackMetal, side * 1.05, 0.02, 0, local);
      box(0.05, 0.04, 0.85, mats.blackMetal, side * 1.05, 0.7, 0, local);
    }
    box(2.06, 0.32, 0.02, mats.blackMetal, 0, 0.55, -0.44, local);
    const screens = [drawStatus, drawFeed].map((draw, i) => {
      const side = i === 0 ? -1 : 1;
      const surface = document.createElement('canvas');
      surface.width = SCREEN_W;
      surface.height = SCREEN_H;
      const texture = new THREE.CanvasTexture(surface);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = maxAniso;
      const monitor = new THREE.Group();
      monitor.position.set(side * 0.37, 1.14, -0.3);
      monitor.rotation.y = -side * 0.2;
      group.add(monitor);
      box(0.66, 0.4, 0.028, mats.gloss, 0, 0, 0, {parent: monitor, radius: 0.008});
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.625, 0.3625), new THREE.MeshBasicMaterial({map: texture, toneMapped: false}));
      screen.position.z = 0.0155;
      monitor.add(screen);
      cyl(0.016, 0.016, 0.24, mats.blackMetal, 0, -0.26, -0.035, {parent: monitor});
      box(0.24, 0.012, 0.17, mats.blackMetal, 0, -0.366, -0.02, {parent: monitor});
      return {draw, context: surface.getContext('2d'), texture};
    });
    const barMaterial = new THREE.MeshBasicMaterial({color: def.accent});
    box(0.96, 0.012, 0.012, barMaterial, 0, 0.9, -0.27, {...local, cast: false, receive: false});
    box(0.44, 0.018, 0.14, mats.plastic, 0, 0.778, 0.14, {...local, radius: 0.006});
    box(0.3, 0.004, 0.24, mats.plastic, 0.42, 0.77, 0.16, local);
    box(0.06, 0.03, 0.1, mats.gloss, 0.42, 0.786, 0.16, {...local, radius: 0.012});
    cyl(0.04, 0.035, 0.09, mats.ceramic, -0.86, 0.813, 0.12, local);
    const notebook = box(0.2, 0.014, 0.28, mats.fabricLight, 0.86, 0.775, 0.16, local);
    notebook.rotation.y = 0.18;
    // Nameplate on the front edge of the desk.
    const plateCanvas = document.createElement('canvas');
    plateCanvas.width = 768;
    plateCanvas.height = 128;
    const plateTexture = new THREE.CanvasTexture(plateCanvas);
    plateTexture.colorSpace = THREE.SRGBColorSpace;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.08), new THREE.MeshBasicMaterial({map: plateTexture, toneMapped: false}));
    plate.position.set(-0.72, 0.812, 0.4);
    plate.rotation.x = -0.45;
    group.add(plate);
    box(0.5, 0.02, 0.07, mats.blackMetal, -0.72, 0.775, 0.41, local);
    // Chair, on the side the visitor walks up to.
    const chair = new THREE.Group();
    chair.position.set(0, 0, 0.92);
    chair.rotation.y = key === 'main' ? 0.25 : -0.25;
    group.add(chair);
    const seat = {parent: chair};
    box(0.5, 0.08, 0.48, mats.fabric, 0, 0.47, 0, {...seat, radius: 0.035});
    const back = box(0.46, 0.56, 0.07, mats.fabric, 0, 0.83, 0.25, {...seat, radius: 0.035});
    back.rotation.x = 0.12;
    cyl(0.03, 0.03, 0.34, mats.brushed, 0, 0.26, 0, seat);
    for (let i = 0; i < 5; i += 1) {
      const spoke = box(0.3, 0.03, 0.045, mats.blackMetal, 0, 0.07, 0, seat);
      spoke.rotation.y = (i / 5) * Math.PI * 2;
      spoke.translateX(0.15);
    }
    for (const side of [-1, 1]) {
      box(0.05, 0.03, 0.3, mats.plastic, side * 0.28, 0.66, 0.02, seat);
      box(0.03, 0.2, 0.03, mats.blackMetal, side * 0.28, 0.56, 0.1, seat);
    }
    // The desk's emblem: an abstract sculpture on a plinth, lit in the desk's colour.
    const coreX = key === 'main' ? -1.85 : 1.85;
    cyl(0.17, 0.2, 0.92, mats.walnutV, coreX, 0.46, 0.1, {...local, segments: 28});
    cyl(0.185, 0.185, 0.03, mats.blackMetal, coreX, 0.935, 0.1, {...local, segments: 28});
    const ringMaterial = new THREE.MeshBasicMaterial({color: def.accent});
    cyl(0.19, 0.19, 0.008, ringMaterial, coreX, 0.954, 0.1, {...local, cast: false, segments: 28});
    const coreMaterial = std({color: def.accent, emissive: def.accent, emissiveIntensity: 0.5, roughness: 0.22, metalness: 0.85, envMapIntensity: 1.2, flatShading: key === 'main'});
    const core = new THREE.Mesh(key === 'main' ? new THREE.IcosahedronGeometry(0.15, 0) : new THREE.TorusKnotGeometry(0.1, 0.032, 110, 14), coreMaterial);
    core.position.set(coreX, 1.3, 0.1);
    core.castShadow = true;
    group.add(core);
    const coreLight = new THREE.PointLight(def.accent, 1.2, 3.5, 2);
    coreLight.position.set(coreX, 1.3, 0.1);
    group.add(coreLight);
    // What a click on this workstation hits.
    const reach = new THREE.Mesh(new THREE.BoxGeometry(3.9, 1.75, 2.4), new THREE.MeshBasicMaterial({visible: false}));
    reach.position.set(coreX * 0.4, 0.9, 0.3);
    reach.userData.agent = key;
    group.add(reach);
    interactables.push(reach);
    solid(x, z, 2.4, 1.08);
    solid(x, z + 0.92, 0.66, 0.66);
    solid(x + coreX, z + 0.1, 0.72, 0.72);
    desks[key] = {screens, barMaterial, ringMaterial, core, coreMaterial, coreLight, plateCanvas, plateTexture, status: 'idle', colour: new THREE.Color(def.accent), baseY: 1.3, signature: ''};
  };
  makeDesk('main', -4.4, -3.6);
  makeDesk('second', 4.4, -3.6);

  /* ---- showing the engine's real state ---- */
  const update = (agents) => {
    for (const key of ['main', 'second']) {
      const agent = agents[key];
      const desk = desks[key];
      const signature = JSON.stringify([agent.model.id, agent.status, agent.task, agent.tiles, agent.feed.slice(0, 7)]);
      if (signature === desk.signature) {
        continue;
      }
      desk.signature = signature;
      desk.status = agent.status;
      desk.colour.set(statusColour(agent));
      for (const screen of desk.screens) {
        screen.draw(screen.context, agent);
        screen.texture.needsUpdate = true;
      }
      const ctx = desk.plateCanvas.getContext('2d');
      ctx.fillStyle = '#101216';
      ctx.fillRect(0, 0, 768, 128);
      ctx.textBaseline = 'middle';
      ctx.font = `700 34px ${FONT}`;
      ctx.fillStyle = agent.accent;
      ctx.fillText(agent.role.toUpperCase(), 28, 44);
      ctx.font = `400 34px ${FONT}`;
      ctx.fillStyle = '#e9e6df';
      ctx.fillText(fit(ctx, agent.model.short, 712), 28, 92);
      desk.plateTexture.needsUpdate = true;
    }
  };

  /* ---- walking ---- */
  const EYE = 1.65;
  const RADIUS = 0.34;
  const BOUND_X = HALF_W - 0.45;
  const BOUND_Z = HALF_D - 0.45;
  const pos = {x: 0, z: 5.2};
  const velocity = {x: 0, z: 0};
  let yaw = 0;
  let pitch = -0.02;
  let locked = false;
  let panelOpen = false;
  let target = null;
  let tween = null;
  const keys = new Set();
  const blocked = (x, z) =>
    x < -BOUND_X || x > BOUND_X || z < -BOUND_Z || z > BOUND_Z || colliders.some((c) => x > c.minX - RADIUS && x < c.maxX + RADIUS && z > c.minZ - RADIUS && z < c.maxZ + RADIUS);
  /** Move by a small step, sliding along anything solid instead of passing through it. */
  const moveBy = (dx, dz) => {
    if (!blocked(pos.x + dx, pos.z)) {
      pos.x += dx;
    } else {
      velocity.x = 0;
    }
    if (!blocked(pos.x, pos.z + dz)) {
      pos.z += dz;
    } else {
      velocity.z = 0;
    }
  };
  const STOPS = {
    entrance: {x: 0, z: 5.2, yaw: 0, pitch: -0.02},
    main: {x: -4.1, z: -1.55, yaw: 0.12, pitch: -0.1},
    second: {x: 4.1, z: -1.55, yaw: -0.12, pitch: -0.1},
    window: {x: 0.6, z: -5.9, yaw: -0.05, pitch: 0.02},
    lounge: {x: 6.6, z: 1.2, yaw: -1.2, pitch: -0.02},
  };
  const goTo = (name) => {
    const stop = STOPS[name];
    if (stop) {
      tween = {t: 0, from: {x: pos.x, z: pos.z, yaw, pitch}, to: stop};
    }
  };
  const step = (dt) => {
    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 0.75);
      const e = tween.t * tween.t * (3 - 2 * tween.t);
      const mix = (a, b) => a + (b - a) * e;
      pos.x = mix(tween.from.x, tween.to.x);
      pos.z = mix(tween.from.z, tween.to.z);
      yaw = mix(tween.from.yaw, tween.to.yaw);
      pitch = mix(tween.from.pitch, tween.to.pitch);
      velocity.x = velocity.z = 0;
      if (tween.t >= 1) {
        tween = null;
      }
    } else {
      const active = !panelOpen;
      const turn = active ? (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0) : 0;
      yaw += turn * 1.9 * dt;
      const forward = active ? (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) : 0;
      const strafe = active ? (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) : 0;
      const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3.1 : 1.7;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      let wantX = -sin * forward + cos * strafe;
      let wantZ = -cos * forward - sin * strafe;
      const length = Math.hypot(wantX, wantZ);
      if (length > 1) {
        wantX /= length;
        wantZ /= length;
      }
      const ease = 1 - Math.exp(-10 * dt);
      velocity.x += (wantX * speed - velocity.x) * ease;
      velocity.z += (wantZ * speed - velocity.z) * ease;
      moveBy(velocity.x * dt, velocity.z * dt);
    }
    camera.position.set(pos.x, EYE, pos.z);
    camera.rotation.x = pitch;
    camera.rotation.y = yaw;
  };

  /* ---- looking and interacting ---- */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(0, 0);
  const findTarget = () => {
    raycaster.setFromCamera(locked ? {x: 0, y: 0} : pointer, camera);
    const hit = raycaster.intersectObjects(interactables, false)[0];
    const next = hit && hit.distance < 4.2 ? hit.object.userData.agent : null;
    if (next !== target) {
      target = next;
      hooks.onTarget(target);
    }
  };
  const look = (dx, dy) => {
    yaw -= dx * 0.0023;
    pitch = Math.max(-1.3, Math.min(1.3, pitch - dy * 0.0023));
  };
  let drag = null;
  listen(canvas, 'pointerdown', (event) => {
    canvas.focus({preventScroll: true});
    if (!locked && event.button === 0) {
      drag = {x: event.clientX, y: event.clientY, moved: 0};
    }
  });
  listen(window, 'pointermove', (event) => {
    if (locked) {
      look(event.movementX, event.movementY);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = event.clientX;
      drag.y = event.clientY;
      look(-dx * 1.4, -dy * 1.4);
    }
  });
  listen(window, 'pointerup', () => {
    if (drag && drag.moved < 6 && !panelOpen) {
      findTarget();
      if (target) {
        hooks.onInspect(target);
      } else {
        canvas.requestPointerLock?.();
      }
    }
    drag = null;
  });
  listen(canvas, 'click', () => {
    if (locked && target && !panelOpen) {
      hooks.onInspect(target);
    }
  });
  listen(document, 'pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    keys.clear();
    hooks.onLock(locked);
  });
  const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'];
  listen(window, 'keydown', (event) => {
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target?.tagName ?? '') && !locked) {
      return;
    }
    if (!locked && document.activeElement !== canvas) {
      return;
    }
    if (MOVE_KEYS.includes(event.code)) {
      keys.add(event.code);
      tween = null;
      if (event.code.startsWith('Arrow')) {
        event.preventDefault();
      }
    } else if ((event.code === 'KeyE' || event.code === 'Enter') && target && !panelOpen) {
      hooks.onInspect(target);
    }
  });
  listen(window, 'keyup', (event) => keys.delete(event.code));
  listen(window, 'blur', () => keys.clear());

  const resize = () => {
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  /* ---- the frame loop ---- */
  const clockNow = new THREE.Clock();
  const SPIN = {working: 1.3, waiting: 0.5, idle: 0.16, error: 0, halted: 0};
  let frameId = 0;
  let elapsed = 0;
  let frames = 0;
  const frame = () => {
    frameId = requestAnimationFrame(frame);
    if (document.hidden) {
      clockNow.getDelta();
      return;
    }
    const dt = Math.min(clockNow.getDelta(), 0.05);
    elapsed += dt;
    frames += 1;
    step(dt);
    if (frames % 4 === 0) {
      findTarget();
    }
    for (const desk of Object.values(desks)) {
      const spin = SPIN[desk.status];
      desk.core.rotation.y += spin * dt;
      desk.core.rotation.x += spin * 0.4 * dt;
      desk.core.position.y = desk.baseY + Math.sin(elapsed * 1.4) * 0.018;
      const pulse = desk.status === 'working' ? 0.6 + 0.4 * Math.sin(elapsed * 4) : desk.status === 'idle' ? 0.45 : 0.85;
      desk.barMaterial.color.copy(desk.colour).multiplyScalar(pulse);
      desk.ringMaterial.color.copy(desk.colour).multiplyScalar(pulse);
      desk.coreMaterial.emissive.copy(desk.colour);
      desk.coreMaterial.emissiveIntensity = 0.25 + pulse * 0.55;
      desk.coreLight.color.copy(desk.colour);
      desk.coreLight.intensity = 0.5 + pulse * 1.3;
    }
    const blink = elapsed % 1.6 < 0.8 ? 1 : 0.12;
    beaconMat.color.setRGB(blink, 0.16 * blink, 0.1 * blink);
    for (const cloud of clouds) {
      cloud.position.x += dt * 2.2;
      if (cloud.position.x > 1300) {
        cloud.position.x = -1300;
      }
    }
    renderer.render(scene, camera);
  };
  frame();

  return {
    update,
    goTo,
    lock: () => canvas.requestPointerLock?.(),
    setPanelOpen(open) {
      panelOpen = open;
      keys.clear();
      if (open && locked) {
        document.exitPointerLock();
      }
    },
    focus: () => canvas.focus({preventScroll: true}),
    dispose() {
      cancelAnimationFrame(frameId);
      disposers.forEach((off) => off());
      observer.disconnect();
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        for (const material of [object.material].flat().filter(Boolean)) {
          for (const value of Object.values(material)) {
            if (value?.isTexture) {
              value.dispose();
            }
          }
          material.dispose();
        }
      });
      scene.environment?.dispose();
      renderer.dispose();
      canvas.remove();
    },
    /** Read-only facts about the scene, and a walk simulator, used when checking that it works. */
    debug: {
      state: () => ({x: +pos.x.toFixed(3), z: +pos.z.toFixed(3), yaw: +yaw.toFixed(3), pitch: +pitch.toFixed(3), locked, target, panelOpen, colliders: colliders.length, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frames}),
      walk(forward, strafe, seconds) {
        tween = null;
        const sin = Math.sin(yaw);
        const cos = Math.cos(yaw);
        for (let t = 0; t < seconds; t += 1 / 60) {
          moveBy(((-sin * forward + cos * strafe) * 1.7) / 60, ((-cos * forward - sin * strafe) * 1.7) / 60);
        }
        return {x: +pos.x.toFixed(3), z: +pos.z.toFixed(3)};
      },
      face(newYaw, newPitch = 0) {
        tween = null;
        yaw = newYaw;
        pitch = newPitch;
      },
      place(x, z) {
        tween = null;
        pos.x = x;
        pos.z = z;
        return !blocked(x, z);
      },
    },
  };
};

/** Mounts the office into the page, keeps it supplied with the engine's data, and shows the desk panels. */
const office = {
  root: null,
  scene: null,
  mounting: false,
  syncing: false,
  failed: null,
  ticks: 0,
  agents: null,
  panelKey: null,
  panelSignature: '',
  loadingMoments: false,
  data: {jobs: [], events: [], shorts: [], sources: [], uploads: [], moments: new Map(), momentsReady: false},

  fitHeight() {
    if (this.root && document.fullscreenElement !== this.root) {
      this.root.style.height = `${Math.max(420, window.innerHeight - this.root.getBoundingClientRect().top)}px`;
    }
  },

  async mount() {
    this.mounting = true;
    const canvasHost = h('div', {class: 'office-canvas'});
    const loading = h('div', {class: 'office-loading'}, h('strong', {}, 'LOPYCLIPS HQ'), 'Opening the office…');
    this.el = {
      cross: h('div', {class: 'office-cross', hidden: true}),
      prompt: h('div', {class: 'office-prompt', hidden: true, role: 'status'}),
      hint: h('div', {class: 'office-hint'}),
      bar: h('div', {class: 'office-bar'}),
      panel: h('aside', {class: 'office-panel', hidden: true, 'aria-label': 'Workstation details'}),
      fullscreen: h('button', {onclick: () => this.toggleFullscreen()}, 'Full screen'),
    };
    // Jumping between spots and opening the panels from here needs no mouse-look or walking.
    const jump = h('select', {'aria-label': 'Jump to a spot in the office'},
      h('option', {value: ''}, 'Jump to…'),
      [['entrance', 'Entrance'], ['main', 'Analyst desk'], ['second', 'Second-opinion desk'], ['window', 'Window'], ['lounge', 'Lounge']].map(([value, label]) => h('option', {value}, label)));
    jump.addEventListener('change', () => {
      if (jump.value) {
        this.closePanel();
        this.scene?.goTo(jump.value);
        jump.value = '';
      }
    });
    const tools = h('div', {class: 'office-tools', role: 'toolbar', 'aria-label': 'Office shortcuts'},
      jump,
      h('button', {onclick: () => this.openPanel('main')}, 'Inspect analyst'),
      h('button', {onclick: () => this.openPanel('second')}, 'Inspect second opinion'),
      this.el.fullscreen,
      h('button', {onclick: () => { tab = 'overview'; refresh(true); }}, 'Classic dashboard'));
    const root = h('section', {class: 'office', 'aria-label': 'LopyClips 3D office'}, canvasHost, h('div', {class: 'office-brand'}, 'LopyClips HQ'), this.el.cross, this.el.prompt, this.el.hint, this.el.bar, tools, this.el.panel, loading);
    this.root = root;
    $('#view').replaceChildren(root);
    this.fitHeight();
    this.onResize = () => this.fitHeight();
    this.onFullscreen = () => {
      this.el.fullscreen.textContent = document.fullscreenElement === root ? 'Exit full screen' : 'Full screen';
      this.fitHeight();
    };
    window.addEventListener('resize', this.onResize);
    document.addEventListener('fullscreenchange', this.onFullscreen);
    this.setHint(false);
    try {
      const built = await buildOffice(canvasHost, {
        onTarget: (key) => {
          this.el.prompt.hidden = !key || this.panelKey !== null;
          if (key && this.agents) {
            this.el.prompt.textContent = `Click or press E to inspect the ${AGENT_DEFS[key].role.toLowerCase()} · ${this.agents[key].model.short}`;
          }
        },
        onInspect: (key) => this.openPanel(key),
        onLock: (locked) => {
          this.el.cross.hidden = !locked;
          this.setHint(locked);
        },
      });
      if (this.root !== root || tab !== 'office') {
        built.dispose();
        return;
      }
      this.scene = built;
      window.__lopyOffice = built.debug;
      if (this.agents) {
        built.update(this.agents);
      }
      loading.remove();
    } catch (err) {
      this.fail(err);
    } finally {
      this.mounting = false;
    }
  },

  setHint(locked) {
    this.el.hint.textContent = locked
      ? 'W A S D to walk · Shift to hurry · move the mouse to look · click a desk or press E to inspect · Esc frees the mouse'
      : 'Click the view to look around with the mouse (or drag) · W A S D or arrow keys to walk · the buttons above jump to each spot';
  },

  /** The office could not start. Everything else keeps working, so say why and offer the classic view. */
  fail(err) {
    this.failed = err?.message || String(err);
    this.teardown();
    document.body.classList.remove('in-office');
    $('#view').replaceChildren(
      card('The 3D office could not start',
        h('p', {}, `Reason: ${this.failed}`),
        h('p', {class: 'dim'}, 'It needs WebGL and an internet connection to load its graphics library. Nothing else is affected: the engine and every other tab work as before.'),
        h('div', {class: 'row'},
          h('button', {class: 'primary', onclick: () => { tab = 'overview'; refresh(true); }}, 'Open the classic dashboard'),
          h('button', {onclick: () => { this.failed = null; refresh(true); }}, 'Try again'))),
    );
  },

  teardown() {
    this.scene?.dispose();
    this.scene = null;
    if (this.root) {
      window.removeEventListener('resize', this.onResize);
      document.removeEventListener('fullscreenchange', this.onFullscreen);
      if (document.fullscreenElement === this.root) {
        document.exitFullscreen();
      }
    }
    this.root = null;
    this.panelKey = null;
    this.panelSignature = '';
    delete window.__lopyOffice;
  },

  unmount() {
    if (this.root || this.scene) {
      this.teardown();
    }
  },

  toggleFullscreen() {
    if (document.fullscreenElement === this.root) {
      document.exitFullscreen();
    } else {
      this.root.requestFullscreen?.().catch((err) => notify(`Full screen is not available: ${err.message}`));
    }
  },

  /** Called on every refresh while the Office tab is open. Shares the dashboard's one timer; it adds no loop of its own. */
  async sync() {
    if (this.failed || this.syncing) {
      return;
    }
    this.syncing = true;
    try {
      if (!this.root?.isConnected) {
        this.unmount();
        if (!this.mounting) {
          this.mount();
        }
      }
      this.ticks += 1;
      const [jobs, events, shorts] = await Promise.all([api('GET', '/api/jobs'), api('GET', '/api/events'), api('GET', '/api/shorts')]);
      Object.assign(this.data, {jobs, events, shorts});
      if (this.ticks % 6 === 1) {
        const [sources, uploads] = await Promise.all([api('GET', '/api/sources'), api('GET', '/api/uploads')]);
        Object.assign(this.data, {sources, uploads});
      }
      this.render();
      if (this.panelKey) {
        this.loadMoments();
      }
    } catch (err) {
      notify(`The office could not refresh its data: ${err.message}`);
    } finally {
      this.syncing = false;
    }
  },

  render() {
    this.agents = deriveAgents({...this.data, state});
    this.scene?.update(this.agents);
    this.el.bar.replaceChildren(...buildPills(), ...buildControls());
    this.renderPanel();
  },

  /** Clip counts need each analysed stream's moments. Fetched once per stream, only while a panel is open. */
  async loadMoments() {
    if (this.loadingMoments) {
      return;
    }
    const missing = this.data.sources.filter((source) => ANALYSED.includes(source.status) && !this.data.moments.has(source.video_id));
    if (missing.length === 0) {
      if (!this.data.momentsReady) {
        this.data.momentsReady = true;
        this.render();
      }
      return;
    }
    this.loadingMoments = true;
    this.data.momentsReady = false;
    try {
      for (const source of missing) {
        this.data.moments.set(source.video_id, await api('GET', `/api/sources/${source.video_id}/moments`));
      }
      this.data.momentsReady = true;
      this.render();
    } catch {
      // Leave the counts showing as loading; the next refresh tries again.
    } finally {
      this.loadingMoments = false;
    }
  },

  openPanel(key) {
    this.panelKey = key;
    this.panelSignature = '';
    this.el.panel.hidden = false;
    this.el.prompt.hidden = true;
    this.scene?.setPanelOpen(true);
    this.renderPanel();
    this.loadMoments();
    this.el.panel.querySelector('button')?.focus();
  },

  closePanel() {
    this.panelKey = null;
    this.el.panel.hidden = true;
    this.scene?.setPanelOpen(false);
    this.scene?.focus();
  },

  renderPanel() {
    const agent = this.panelKey && this.agents?.[this.panelKey];
    if (!agent) {
      return;
    }
    const context = this.agents.context;
    const signature = JSON.stringify([agent, context]);
    if (signature === this.panelSignature) {
      return;
    }
    this.panelSignature = signature;
    const panel = this.el.panel;
    const scroll = panel.scrollTop;
    const statusColour = AGENT_STATUS[agent.status].color ?? agent.accent;
    const cell = (value) => h('td', {class: `num${typeof value === 'number' ? '' : ' dim'}`}, String(value));
    const statRow = (row) => [
      h('tr', {}, h('td', {}, row.label), cell(row.today), cell(row.day), cell(row.all)),
      row.hint ? h('tr', {}, h('td', {colspan: 4, class: 'small'}, row.hint)) : null,
    ];
    panel.replaceChildren(
      h('button', {class: 'close', onclick: () => this.closePanel()}, 'Close'),
      h('div', {class: 'role', style: `color:${agent.accent}`}, agent.role),
      h('h2', {}, agent.model.name),
      h('div', {class: 'small'}, `Runs on ${agent.model.provider}`),
      h('p', {}, h('span', {class: 'chip', style: `color:${statusColour}`}, AGENT_STATUS[agent.status].label)),
      h('p', {class: 'task'}, agent.task),
      agent.progress
        ? h('div', {}, h('div', {class: 'small'}, `${agent.progress.label}: ${Math.round(agent.progress.value * 100)}%`), h('div', {class: 'meter'}, h('i', {style: `width:${Math.round(agent.progress.value * 100)}%;background:${agent.accent}`})))
        : agent.status === 'working'
          ? h('div', {class: 'small'}, `Progress: ${NOT_TRACKED.toLowerCase()} for this kind of job.`)
          : null,
      h('h3', {}, 'What this desk does'),
      h('p', {class: 'dim'}, agent.does),
      h('h3', {}, 'Work done at this desk'),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, ''), RANGES.map(([, label]) => h('th', {class: 'num'}, label)))),
        h('tbody', {}, agent.stats.flatMap(statRow))),
      h('h3', {}, 'Before it reaches a desk'),
      h('table', {}, h('tbody', {},
        h('tr', {}, h('td', {}, 'Streams found by discovery'), cell(context.found.today), cell(context.found.day), cell(context.found.all)),
        h('tr', {}, h('td', {colspan: 4, class: 'small'}, `Found by the YouTube search step, not by a model. Of those, ${context.blocked} are blocked and ${context.skipped} were skipped as too short or too old.`)))),
      h('h3', {}, 'Jobs for this desk'),
      agent.jobs.length
        ? h('ul', {class: 'list'}, agent.jobs.map((job) => h('li', {}, tag(job.status), ` #${job.id} ${job.type} · ${job.text}`, job.error ? h('div', {class: 'bad small'}, job.error) : null)))
        : h('p', {class: 'dim'}, 'None running, waiting or failed.'),
      agent.queuedCount > 6 ? h('p', {class: 'small'}, `${agent.queuedCount} waiting in total; the first six are shown.`) : null,
      h('div', {class: 'row'}, h('button', {onclick: () => { tab = 'jobs'; refresh(true); }}, 'Open the Jobs tab'), h('button', {onclick: () => { tab = 'activity'; refresh(true); }}, 'Open the Activity tab')),
      h('h3', {}, 'Recent activity'),
      agent.feed.length
        ? h('ul', {class: 'list feed'}, agent.feed.map((entry) => h('li', {}, h('time', {}, new Date(entry.ts).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})), h('span', {class: entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : ''}, entry.text))))
        : h('p', {class: 'dim'}, 'Nothing for this desk in the latest 200 log entries.'),
      h('h3', {}, 'About these numbers'),
      h('ul', {class: 'list small'}, agent.notes.map((note) => h('li', {}, note))),
    );
    panel.scrollTop = scroll;
  },
};

const TABS = ['office', 'overview', 'creators', 'sources', 'shorts', 'schedule', 'uploads', 'jobs', 'activity', 'settings'];
const FORM_TABS = ['creators', 'settings'];

const renderTabs = () =>
  $('#tabs').replaceChildren(...TABS.map((name) => h('button', {class: name === tab ? 'on' : '', onclick: () => { tab = name; refresh(true); }}, name[0].toUpperCase() + name.slice(1))));

/** Reload state. Tabs with forms are only redrawn when asked, so typing is not wiped by the timer. */
const refresh = async (force = false) => {
  try {
    state = await api('GET', '/api/state');
    renderHeader();
    renderTabs();
    document.body.classList.toggle('in-office', tab === 'office' && !office.failed);
    if (tab === 'office') {
      await office.sync();
      return;
    }
    office.unmount();
    office.failed = null;
    if (force || !FORM_TABS.includes(tab)) {
      $('#view').replaceChildren(...(await views[tab]()).filter(Boolean));
    }
  } catch (err) {
    notify(`Cannot reach the engine: ${err.message}`);
  }
};

refresh(true);
setInterval(() => refresh(false), 5000);
