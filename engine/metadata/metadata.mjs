const TITLE_MAX = 90;
const MAX_HASHTAGS = 5;

const SCHEMA = {
  type: 'object',
  required: ['title', 'summary', 'hashtags'],
  properties: {title: {type: 'string'}, summary: {type: 'string'}, hashtags: {type: 'array', items: {type: 'string'}}},
};

const SYSTEM = `You write the YouTube title and description for a short clip compilation, using only the caption text and facts you are given.
- "title": accurate and engaging, under 70 characters, about what actually happens in the clips. No clickbait that the clips do not deliver, no quotation marks, no ALL CAPS sentences.
- "summary": one or two plain sentences describing what happens. Do not invent events, scores, names or outcomes that are not in the text.
- "hashtags": 3 or 4 relevant single-word hashtags (letters and digits only, no "#"), such as the creator's name or the game.
Never say or imply that the creator endorses, sponsors or is affiliated with the channel.`;

const cleanTitle = (title) =>
  String(title ?? '')
    .replace(/[<>"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX);

const cleanTag = (tag) => String(tag ?? '').replace(/[^A-Za-z0-9_]/g, '');

/**
 * Build the upload package for a Short from its real captions. Throws if the model
 * cannot produce a usable, unused title; nothing is made up as a fallback.
 */
export const buildMetadata = async ({llm, model, creatorName, sourceTitle, sourceUrl, clips, existingTitles, categoryId}) => {
  const taken = new Set([...existingTitles].map((title) => title.toLowerCase()));
  const captions = clips.map((clip, i) => `Clip ${i + 1} (${clip.label}): ${clip.text}`).join('\n');
  let avoid = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await llm.json({
      model,
      schema: SCHEMA,
      messages: [
        {role: 'system', content: SYSTEM},
        {role: 'user', content: `Creator: ${creatorName}\nOriginal video title: ${sourceTitle}\n${avoid}\nCaptions of the clips, in order:\n${captions}`},
      ],
    });
    const title = cleanTitle(reply.title);
    const summary = String(reply.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (title.length < 8 || summary.length < 15) {
      continue;
    }
    if (taken.has(title.toLowerCase())) {
      avoid = `This title is already used on the channel, so write a different one: ${title}\n`;
      continue;
    }
    const tags = [...new Set([...(Array.isArray(reply.hashtags) ? reply.hashtags : []).map(cleanTag).filter((tag) => tag.length >= 2 && tag.length <= 30), 'shorts'])].slice(0, MAX_HASHTAGS);
    const description = [summary, '', `Clips from ${creatorName} on YouTube.`, `Full video: ${sourceUrl}`, '', tags.map((tag) => `#${tag}`).join(' ')].join('\n');
    return {title, description, tags, categoryId, generatedAt: new Date().toISOString()};
  }
  throw new Error('The model did not produce a usable, unique title and description.');
};
