export class LlmError extends Error {}

/** A model name starting with this goes to NVIDIA NIM, e.g. "nim:nvidia/some-model". Anything else goes to Ollama. */
export const NIM_PREFIX = 'nim:';
/** A model name starting with this goes to any OpenAI-compatible chat API (OpenAI, OpenRouter, Groq, LM Studio...), e.g. "openai:gpt-4o-mini". */
export const OPENAI_PREFIX = 'openai:';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cloud models do not reliably honour a JSON-schema output setting, so the schema is also spelled out in the prompt. */
const withSchema = (messages, schema) => {
  const note = `\n\nReply with one JSON object only: no markdown, no code fences, no commentary. It must match this JSON Schema exactly, using these property names:\n${JSON.stringify(schema)}`;
  const [first, ...rest] = messages;
  return first?.role === 'system' ? [{...first, content: first.content + note}, ...rest] : [{role: 'system', content: note.trim()}, ...messages];
};

/** Parse a reply that may be wrapped in a code fence or surrounded by stray text. */
export const parseLoose = (content, model = 'model') => {
  const text = String(content ?? '').replace(/```(?:json)?/gi, '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (starts.length === 0 || end < 0) {
    throw new LlmError(`Model ${model} did not return JSON.`);
  }
  try {
    return JSON.parse(text.slice(Math.min(...starts), end + 1));
  } catch {
    throw new LlmError(`Model ${model} returned malformed JSON.`);
  }
};

/** Accept a bare list where the schema wraps one list in an object; refuse anything missing required properties. */
const shape = (value, schema, model) => {
  const required = schema?.required ?? [];
  let result = value;
  if (Array.isArray(result) && required.length === 1 && schema.properties?.[required[0]]?.type === 'array') {
    result = {[required[0]]: result};
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || required.some((key) => !(key in result))) {
    throw new LlmError(`Model ${model} replied in the wrong shape (expected: ${required.join(', ')}).`);
  }
  return result;
};

const httpError = (message, status) => Object.assign(new LlmError(message), {status});

/**
 * Room for the whole reply. These models think before they answer, and the thinking counts towards the limit:
 * with too little room the answer itself comes back empty.
 */
const NIM_MAX_TOKENS = 16_384;

/**
 * Chat client that returns JSON matching a schema. A model name says where it runs: "nim:..." on NVIDIA NIM,
 * "openai:..." on any OpenAI-compatible API (address and key from OPENAI_BASE_URL and OPENAI_API_KEY), and
 * anything else through Ollama. Keys are read when needed and never logged or put in an error message.
 */
export const createLlm = ({ollamaUrl, nimUrl, getNimKey = () => null, openaiUrl = 'https://api.openai.com/v1', getOpenAiKey = () => null, fetchImpl = fetch, timeoutMs = 240_000, retryDelayMs = 2000}) => {
  const send = async (url, init, unreachable) => {
    try {
      return await fetchImpl(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
    } catch (err) {
      throw new LlmError(`${unreachable} (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`);
    }
  };

  const viaOllama = async (model, messages, schema) => {
    const res = await send(
      `${ollamaUrl}/api/chat`,
      {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({model, messages, stream: false, format: schema, options: {temperature: 0.2}})},
      `Could not reach Ollama at ${ollamaUrl}. Is the Ollama app running?`,
    );
    if (!res.ok) {
      throw httpError(`Ollama model ${model} answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`, res.status);
    }
    return (await res.json())?.message?.content;
  };

  /** Any OpenAI-style /chat/completions endpoint: NVIDIA NIM, OpenAI, OpenRouter, Groq, a local LM Studio... */
  const viaChatApi = async ({model, messages, name, baseUrl, key, noKey, badKey}) => {
    if (!key) {
      throw httpError(noKey, 401);
    }
    const res = await send(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}`},
        body: JSON.stringify({model, messages, temperature: 0.2, max_tokens: NIM_MAX_TOKENS, stream: false}),
      },
      `Could not reach ${name}`,
    );
    if (res.status === 401 || res.status === 403) {
      throw httpError(badKey, res.status);
    }
    if (!res.ok) {
      throw httpError(`${name} model ${model} answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`, res.status);
    }
    const choice = (await res.json())?.choices?.[0];
    if (choice?.finish_reason === 'length' && !String(choice.message?.content ?? '').includes('}')) {
      throw new LlmError(`${name} model ${model} ran out of room before it finished its answer.`);
    }
    return choice?.message?.content;
  };

  const viaNim = (model, messages) =>
    viaChatApi({
      model: model.slice(NIM_PREFIX.length),
      messages,
      name: 'NVIDIA',
      baseUrl: nimUrl,
      key: getNimKey(),
      noKey: `Model "${model}" needs an NVIDIA API key, and none is stored. Run "npm run engine:nim-key" to add one, or set NVIDIA_API_KEY in .env.`,
      badKey: 'NVIDIA rejected the stored API key. Run "npm run engine:nim-key" to replace it.',
    });

  const viaOpenAi = (model, messages) =>
    viaChatApi({
      model: model.slice(OPENAI_PREFIX.length),
      messages,
      name: 'OpenAI-compatible API',
      baseUrl: openaiUrl,
      key: getOpenAiKey(),
      noKey: `Model "${model}" needs OPENAI_API_KEY in .env (with OPENAI_BASE_URL if it is not OpenAI itself).`,
      badKey: 'The OpenAI-compatible API rejected OPENAI_API_KEY. Check the key in .env.',
    });

  const chatOnce = async (model, messages, schema) => {
    const prompt = withSchema(messages, schema);
    const content = model.startsWith(NIM_PREFIX) ? await viaNim(model, prompt) : model.startsWith(OPENAI_PREFIX) ? await viaOpenAi(model, prompt) : await viaOllama(model, prompt, schema);
    return shape(parseLoose(content, model), schema, model);
  };

  /** Ask for a JSON object matching `schema`. Retries transient failures; throws LlmError otherwise. */
  const json = async ({model, messages, schema, attempts = 3}) => {
    let last;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await chatOnce(model, messages, schema);
      } catch (err) {
        last = err;
        // A badly shaped reply is worth another try; a 4xx other than rate limiting is not.
        const permanent = err.status && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
        if (permanent) {
          break;
        }
        if (i + 1 < attempts) {
          await sleep(retryDelayMs * 2 ** i);
        }
      }
    }
    throw last;
  };

  return {
    json,
    /** Health check for one model. Retries like any other request, so a momentary overload is not reported as a failure. */
    async ping(model) {
      const reply = await json({
        model,
        messages: [{role: 'user', content: 'Reply with {"ok": true}.'}],
        schema: {type: 'object', required: ['ok'], properties: {ok: {type: 'boolean'}}},
      });
      return reply.ok === true;
    },
  };
};

/** An Ollama-only client. */
export const createOllama = ({baseUrl, ...rest}) => createLlm({ollamaUrl: baseUrl, ...rest});
