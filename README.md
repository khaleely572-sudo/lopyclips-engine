# LopyClips engine

An automation engine for a YouTube Shorts clipping channel. It runs on your own computer and:

1. **Finds new streams** from the creators you add (long videos only, 20 minutes or more).
2. **Reads the captions** and has two AI models pick the genuinely funny moments: the first proposes, the second reviews each one independently and rejects the weak ones.
3. **Watches the shortlist**: it fetches only the short section around each moment, takes still frames, and the second model looks at them together with the captions. The first model re-judges from the second model's notes.
4. **Edits vertical Shorts** with [Remotion](https://www.remotion.dev): several moments per Short, word-by-word captions, a title and clip labels.
5. **Checks** every Short (creator permission, profanity, flagged content, length, render quality).
6. **Uploads** to your channel on a schedule you set, with a title, description and hashtags.

A local dashboard at `http://127.0.0.1:4317` shows everything, as a 3D office or a classic view, and lets you approve, reject, rate clips and change settings.

## Built-in safety rules

- **Only short sections are fetched**, never a whole video (at most 90 seconds per request).
- **Only creators you have marked as authorized are used**, and authorizing one requires a written basis (who allowed it, where, when). Clip only creators who allow clipping.
- **A new install starts safe:** automation paused, dry run on (nothing is uploaded), manual approval on, private uploads. Unlisted or public uploads stay locked until one private upload from the engine has succeeded.
- **Footage is deleted** once the Short that needed it has been made.

## What you need

- **Node.js 24** (tested). Node 22.13 or newer should also work; the engine uses the built-in `node:sqlite`.
- **Python 3.10 or newer.** On Windows the engine calls `py`, elsewhere `python3`.
- **ffmpeg and ffprobe**, and **yt-dlp**, on your PATH.
- **The YouTube clipper script.** Clone [Youtube-clipper-skill](https://github.com/op7418/Youtube-clipper-skill) into `~/.claude/skills/Youtube-clipper-skill`, or set `LOPYCLIPS_CLIPPER_SCRIPT` in `.env` to wherever its `scripts/clip_video.py` is. Only that script is used.
- **Optional: the `/watch` skill** for Claude Code in `~/.claude/skills/watch` (or set `WATCH_SKILL_DIR`). It picks better frames when the engine watches clips. Without it, the engine takes evenly spaced frames with ffmpeg instead.
- **An API key for the AI models**, and **your own Google Cloud project** for YouTube. Both are covered below.

## Setup

### 1. Install

```bash
npm install
```

### 2. AI models

Copy `.env.example` to `.env` and fill in at least one provider. A model's name says where it runs:

| Model name | Runs on | Key in `.env` |
|---|---|---|
| `nim:nvidia/...` | [NVIDIA NIM](https://build.nvidia.com) (free) | `NVIDIA_API_KEY` |
| `openai:...` | Any OpenAI-compatible API: OpenAI, OpenRouter, Groq, Together, LM Studio... | `OPENAI_API_KEY`, and `OPENAI_BASE_URL` if it isn't OpenAI |
| anything else | [Ollama](https://ollama.com), local or cloud models | `OLLAMA_URL` if it isn't on this computer |

The defaults are two free NVIDIA models:

- **First model** (`analysis.model`): `nim:nvidia/nemotron-3-ultra-550b-a55b`. It finds moments and writes titles.
- **Second model** (`analysis.secondModel`): `nim:nvidia/nemotron-3.5-super-vl-120b-a12b`. It reviews, ranks and watches.

Change either one in the dashboard's Settings tab. **The second model should be able to see images**, because it watches frames. If yours can't, switch `analysis.watch` off and the engine judges from captions alone.

You can also store an NVIDIA key with `npm run engine:nim-key` instead of putting it in `.env`. `npm run engine:nim-models` lists the NVIDIA models your key can use.

### 3. Connect your YouTube channel

Each person uses their **own** Google Cloud project and signs in with their **own** Google account. Nobody else's keys or sign-in are needed or included.

1. Go to [Google Cloud Console](https://console.cloud.google.com), create a project, and enable **YouTube Data API v3**.
2. Under **Google Auth Platform** (OAuth consent screen), choose **External**, keep it in **Testing**, and add your own Google account as a **test user**.
3. Under **Clients**, create an OAuth client of type **Desktop app**, then download its JSON file.
4. Save that file as `secrets/youtube-oauth-client.json` in this folder.
5. Run the sign-in, which opens Google's own page in your browser:

   ```bash
   npm run auth:youtube
   ```

6. Confirm it shows your channel. To check later, run `npm run auth:youtube:status`.

While the Google app is in Testing, Google ends the sign-in after about 7 days. When the dashboard reports the YouTube sign-in has expired, run `npm run auth:youtube:logout` and then `npm run auth:youtube` again.

To test an upload safely, run `npm run youtube:test-upload -- <video.mp4>`. It always uploads as **private**.

### 4. Check and start

```bash
npm run engine:doctor
npm run engine
```

`engine:doctor` checks that every tool, both models and YouTube are reachable. Then open `http://127.0.0.1:4317`. Keep the terminal open while the engine runs; the PC must stay awake, because sleep pauses it.

### 5. First run

1. **Creators tab:** add the channels you clip, by handle. Use the channel that has the **full streams** (for some streamers that is a separate "live" or "VOD" channel).
2. Set each creator to **authorized** and write down your basis.
3. **Settings tab:** pick your time zone and posting schedule (`schedule.intervalHours`, `schedule.quietHours`, `schedule.dailyLimit`).
4. **Resume** the automation. Leave dry run on until you've looked at a few Shorts.
5. Approve one, switch dry run off, and let it make its first **private** upload. After that you can allow public uploads if you want.

## Useful settings

| Setting | What it does |
|---|---|
| `requireApproval` | Hold every Short until you approve it |
| `dryRun` | Do everything except the actual upload |
| `upload.visibility` | `private`, `unlisted` or `public` |
| `schedule.intervalHours` / `schedule.quietHours` | When posts go out |
| `analysis.minHumor` | How funny a moment must be to use (0-10; default 6) |
| `analysis.watch` / `analysis.watchMax` | Watch the shortlisted clips before deciding, and how many per stream |
| `short.minSeconds` / `short.maxSeconds` | Length of a Short |

Put `LOPYCLIPS_BRAND=YOURNAME` in `.env` to show your channel name on the Shorts.

## Notes

- **YouTube caps uploads.** It limits how many videos a new channel may upload per day. When it refuses, the engine pauses posting and tries again later by itself.
- **Clipping rights.** The engine only works with creators you authorize, but you are responsible for having permission and for following YouTube's rules.
- **Tests:** run `npm test`.
- **Licenses:** this project is MIT licensed (see `LICENSE`). [Remotion](https://www.remotion.dev/license) has its own license: free for individuals and small companies, larger companies need a company license. The clipper script and the `/watch` skill are separate projects with their own licenses.

## Keep these private

Never share, commit or upload these. They hold your keys, your YouTube sign-in and everything the engine has stored:

- `secrets/`
- `tokens/`
- `data/`
- `.env`

`.gitignore` already leaves them out.

If one of them ever leaks:

- **YouTube sign-in:** remove the app's access at https://myaccount.google.com/permissions.
- **Google client:** delete or reset the OAuth client secret in Google Cloud.
- **AI key:** revoke it with the provider.
