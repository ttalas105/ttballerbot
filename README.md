# ttballerbot

A Discord listening room: join voice, send `/play` or `@ttballerbot play`, and control a shared queue from one chat card.

```text
/play query:<Spotify song, album, playlist, YouTube URL, or song name>
@ttballerbot play <link or song name>
```

The Discord Components V2 player has a custom album-art banner, progress display, requester, next three tracks, total queued time, and the actual YouTube match. Buttons: **Back · Pause/Resume · Next · Shuffle · Stop**, plus **Add a song** (opens a form) and **View queue** (private paginated list). Artwork is rendered once per song and reused for progress updates. It needs Attach Files permission; without it, the native text and controls still work.

## Spotify and audio sources

Spotify supplies **metadata**, not the audio. A Spotify track is matched to a YouTube video when it reaches the front of the queue. Matching requires the song title and primary artist, checks duration, and rejects unrequested alternate versions. If neither search produces a confident match, the bot skips the song with an explanation instead of playing an unrelated result. Matching is approximate; the actual YouTube title/link and audio duration are shown so you can identify a different version and request the exact URL. Playlist order is preserved unless a listener uses Shuffle.

This is an independent, self-hosted integration, not a Spotify-approved streaming service. Spotify's [developer policy](https://developer.spotify.com/policy) restricts broadcasting and integrations with other services; using metadata does not automatically make a cross-service music bot compliant. Use sources you are authorized to play and review the services' terms before deploying broadly. There is no Spotify DRM bypass, account-audio capture, or Spotify audio download.

For current Spotify Development Mode apps, the app owner needs Premium. Playlist items are accessible only when the signed-in Spotify account owns or collaborates on the playlist. An arbitrary public/editorial playlist may return 403 even if it opens in the Spotify app. See the [playlist API](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items) and [quota documentation](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

This version connects **one Spotify account for the host**, rather than linking a Spotify account for every Discord listener. Everyone in voice can request accessible public playlists. Importing the connected account's **private** playlists is restricted to the Discord application owner (and optional IDs in `SPOTIFY_PRIVATE_PLAYLIST_USERS`). Requesting a private playlist displays its queued song details to the Discord text-channel audience and plays its YouTube matches to voice listeners.

## Run locally

Requires **Node.js 22.12+**, **FFmpeg** with libopus on PATH, and internet access including Discord voice UDP. The installed `@discordjs/voice` includes DAVE support for Discord's current voice encryption.

```powershell
git clone https://github.com/ttalas105/ttballerbot.git
cd ttballerbot
npm ci
npm run setup
npm run tools:install
```

The tool installer downloads yt-dlp from the project's official GitHub releases and verifies its published SHA-256 checksum. Node is used for its JavaScript challenges. FFmpeg is already installed on this development computer; other hosts need their own FFmpeg installation.

1. Create an application named **ttballerbot** in the [Discord Developer Portal](https://discord.com/developers/applications).
2. On the **Bot** page, generate the token. Save it as `DISCORD_TOKEN` in `.env`. Set `DISCORD_CLIENT_ID` to the application's ID.
3. Optionally set `DISCORD_GUILD_ID` to your server ID for immediate server-scoped slash-command registration. Without it, registration is global.
4. Create an app in the [Spotify dashboard](https://developer.spotify.com/dashboard). Select Web API and add the exact redirect URI `http://127.0.0.1:8888/callback`. Put its client ID and secret in `.env`.
5. Run `npm run spotify:login`, open the printed link, and approve playlist read access. The refresh token is saved to `.env` without printing it. Start/restart the bot afterward. The callback server binds only to `127.0.0.1` and exits on completion or after 10 minutes.
6. Run `npm run register`, then open the printed invite URL and add the bot to your server. Permissions are View Channel, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Connect, and Speak. Administrator is unnecessary.

```powershell
npm run doctor
npm run check
npm run build
npm start
```

Or launch in the background on Windows after building:

```powershell
& .\scripts\start-background.ps1
Get-Content .\.runtime\bot.log
# To stop it:
& .\scripts\stop-background.ps1
```

The bot stays available only while this computer and process are running. No startup task, paid hosting, or public deployment is installed. Use one running instance per token. Queues live in memory and reset on restart.

### Optional `!play` commands

Slash commands and mentioning the bot work without privileged Message Content Intent. To enable commands such as `!play`, turn on **Message Content Intent** in Discord's Bot settings, set `ENABLE_MESSAGE_COMMANDS=true` in `.env`, and restart. This gives the bot access to ordinary message content in channels it can view. `COMMAND_PREFIX` defaults to `!`.

## Commands

| Command | Effect |
| --- | --- |
| `/play query:…` | Join your voice channel and append a song, album, or playlist |
| `/queue page:…` | Show upcoming songs, ten per page |
| `/nowplaying` | Link to the current control card; recreate it if deleted |
| `/pause`, `/resume` | Pause/resume playback |
| `/skip`, `/back` | Next/previous; Back restarts the first song |
| `/shuffle` | Shuffle upcoming songs |
| `/remove position:…` | Remove an upcoming song by its queue position |
| `/clear` | Clear upcoming songs, keep the current one playing |
| `/stop` | Stop, clear, and leave voice |
| `/help` | Show usage |

The same commands work after an `@ttballerbot` mention. Optional prefix aliases include `!p`, `!q`, `!next`, `!previous`, and `!leave`. Only listeners in the same voice channel can add or change playback. Ordinary voice channels are supported; Stage channels and live video streams are not.

Each server has a separate queue (default 250 songs). Playlist imports keep order and skip removed tracks, local files, and podcasts. Long imports stop at the available queue capacity and report the truncation. The bot leaves after three idle minutes or at most one minute alone. Stop/skip cancels pending audio extraction and subprocesses; obsolete player cards cannot operate a new session.

Audio is buffered ahead in bounded memory to tolerate network stalls. Interrupted streams retry the same song up to twice, resuming near the last played position before advancing the queue. The player tolerates up to five seconds without packets, and a premature end is treated as an interruption. The card explains reconnects and failures; logs include timestamps and safe error categories without provider URLs or tokens.

## Checks and troubleshooting

- `npm run check`: TypeScript plus queue, parser, playlist pagination/auth, UI bounds, playback cancellation, and a real FFmpeg-to-Opus test. The FFmpeg test uses a generated tone, not an external song.
- `npx tsx scripts/smoke-youtube.ts "<YouTube URL or search>"`: fetch a short audio stream and verify 100 Opus packets locally; nothing is broadcast or saved as a song.
- `npx tsx scripts/smoke-playback.ts "<YouTube URL or search>" [startSeconds]`: run a complete song at normal speed through Discord's audio scheduler without joining voice. This checks sustained playback and optional resume seeking; it takes the remaining song duration plus loading time.
- `npx tsx scripts/smoke-spotify.ts`: check token refresh and import up to five tracks from the first owned playlist; nothing is posted to Discord.
- **No slash commands:** check the invite includes `applications.commands`; run `npm run register` for the right server/application.
- **Bot cannot log in:** check the token. If Message Content Intent is not enabled, leave `ENABLE_MESSAGE_COMMANDS=false`.
- **No audio / cannot join:** check Connect/Speak permissions, server mute, channel capacity, and outbound UDP/firewall access. Run `npm run doctor`.
- **YouTube errors:** run `npm run tools:install` to update the extractor. Age/region restrictions, datacenter blocking, and service changes can still prevent playback. No cookies or browser sessions are imported.
- **Wrong song version:** use the actual YouTube URL instead of automatic matching.
- **Spotify 403:** check Premium, app access, sign-in, and playlist ownership/collaboration. Public visibility alone is insufficient for new apps.
- **Spotify quota error:** other apps under the developer account share its quota. Use a YouTube URL/name until access returns.
- **Spotify authorization expires:** run `npm run spotify:login` again. The host persists refreshed tokens if Spotify rotates them.

## Data and secrets

`.env`, `bin/`, `models/`, and `.runtime/` are ignored by Git. Never share `.env` or bot tokens. The bot reads command requests and voice membership, keeps queue metadata in memory, sends song-search terms to YouTube, and displays queued titles in Discord. Incoming voice is not processed unless a listener explicitly opts into Hey Rajan below. Audio is piped through yt-dlp and FFmpeg without saving songs to disk. Console errors omit provider response bodies and credentials. Spotify metadata is linked back to Spotify.

Player artwork uses the provider's original cover image in a custom layout. Cover requests are limited to known Spotify/YouTube image hosts, bounded to 5 MB, and timeout after four seconds. The bundled Barlow Condensed fonts are licensed under the SIL Open Font License in `assets/fonts/OFL.txt`.

To disconnect Spotify, revoke **ttballerbot** in your Spotify account's app-access settings, clear the Spotify credentials/refresh token in `.env`, and restart the bot. Stop the bot to clear queued data; remove existing queue messages from Discord if you also want those displays deleted.

## Hey Rajan — experimental `heyTT` branch

An opt-in voice assistant for conversation, music, and sound effects. Rajan AI chats naturally and gives the person speaking a sharp, playful roast based on their question. Replies stay short, useful, and free of stock catchphrases. It is an AI character, not the actual person. Say **“Hey Rajan”**, wait for the ready chime, then speak:

- “What’s good bro?” — casual conversation with a sarcastic comeback; follow up with another question after the wake phrase.
- “Give this conversation a dramatic soundtrack” — 15 seconds of original synthesized suspense music.
- “Air horn” — a short synthesized horn.
- “Play some J Cole” — search and queue music through the same player as `/play`. Spotify/YouTube links work in typed requests too.
- “Pause the music”, “resume”, “skip”, “go back”, “shuffle” — control the existing queue. “Stop the music” clears the queue and leaves voice.
- “Tell me a joke”, “what is a pick and roll?”, “help me think of a team name” — short, natural spoken replies.
- “Tell me another one” — follows your own recent conversation, separate from other listeners.
- “Announce Jason like a wrestling entrance” or “announce me like a WWE entrance” — an AI arena announcer over a synthesized entrance bed.
- “Announce Tyrone like a wedding” — a warm wedding host with a gentle musical bed. Names can be custom; matching Discord names/aliases retain their spelling. Ambiguous member names are rejected.
- “Stop” — stop assistant speech/effects. While a request is processing or playing, use **Stop response** or `/hey mode:stop`; wake triggers are suppressed while busy to avoid echoes.

Wake again for each request; it does not automatically keep recording after replying. Music pauses for spoken replies/effects and resumes at the same position afterward. General replies and jokes are generated; wrestling/wedding entrances use prepared lines with the selected name. Effects are synthesized locally. Other sound effects and live browsing/sports scores are not available. The detector runs separately from Discord's audio scheduler. Wake accuracy on real microphones needs a live trial; synthetic fixtures are not a substitute for testing accents, background noise, and speaker leakage.

### Setup and trial

A quiet two-note pulse repeats while Baller understands a request, finds music, or generates speech. It starts after command capture, stops before the reply/effect, and clears on failure, opt-out, or Stop response. Music pauses during the pulse and resumes afterward. The loop has a 60-second safety limit.

For a future custom voice, see the [recording script](docs/voice-sample-script.txt). Have the speaker approve use of their voice before uploading their recording; voice cloning is not enabled by this script.

```powershell
git switch heyTT
npm ci
npm run voice:install
```

In `.env`, set `ENABLE_HEY_BALLER=true`. Create a **free-tier** Gemini API key in [Google AI Studio](https://aistudio.google.com/api-keys), and set `GEMINI_API_KEY` locally. No OpenAI key is needed. Keep billing disabled for a free-only trial. Free-tier quotas vary by project/model; quota errors stop the request instead of retrying indefinitely or switching providers. Google says free-tier requests may be used to improve its products; see [pricing and data use](https://aistudio.google.com/docs/pricing).

Defaults are `gemini-3.1-flash-lite` for audio understanding/conversation and `gemini-3.8-flash-tts` with `Fenrir` for speech. `VOICE_TRANSCRIPTION_MODEL`, `VOICE_SPEECH_MODEL`, and `VOICE_ANNOUNCER` can override these. A single multimodal call understands a spoken request and either selects an allowed action or writes a reply; spoken replies need a second TTS call. Explicit typed music/effect/control requests skip the understanding call. The last 20 generated speech lines are cached in memory by text and style. Cloud latency and free quotas vary; replies are not guaranteed to be instant.

Rajan is prompted to answer in at most 20 words / 160 characters. Understanding uses Gemini’s streaming generation endpoint; the complete response must finish and pass validation before any action runs. His answer appears in the bot card while speech generates. A failed request stops the thinking pulse and plays a local error tone. Optionally set `VOICE_ERROR_AUDIO` to a private prerecorded retry notice (24 kHz mono PCM16 WAV, up to eight seconds); this is loaded at startup and never calls a cloud service during failure handling. Missing or invalid clips fall back to the tone. Cancellation stays silent and cannot interrupt a newer request. Logs identify the failed stage and elapsed time without recording conversation content.

### Optional private voice clone

With the speaker’s permission, prepare 10–30 seconds of clean solo speech and its exact transcript in `.runtime/` (ignored by Git). Keep the source recording out of this public repo. Create a Fish Audio API key and configure the local `.env`:

```dotenv
FISH_API_KEY=your-private-key
FISH_REFERENCE_AUDIO=.runtime/rajan-reference.wav
FISH_REFERENCE_TEXT=.runtime/rajan-reference.txt
FISH_SPEECH_MODEL=s2.1-pro-free
```

This uses Fish’s documented instant cloning: the stored reference audio, its transcript, and outgoing reply text are sent as MessagePack on each uncached speech request. No saved Fish voice model is created or published. Live Discord requests still go only to Gemini for understanding. The status card discloses both the AI clone and the reference upload. The free model is explicit; service/quota failures never automatically switch to a paid model or another voice. To return to Gemini TTS, remove the Fish reference settings and restart. Local reference files remain until you delete them, and Fish’s data-retention policy applies to requests.

Alternatively, use an existing **private** `FISH_REFERENCE_ID` instead of the two reference paths. Creating a persistent model with `npx tsx scripts/clone-voice.ts .runtime/rajan-reference.wav --speaker-consented` may require an API credit top-up: new accounts can have a zero saved-model quota even when the free TTS model is available. The setup command uploads the reference and saves only the returned ID in `.env`; it never adds billing. Do not configure both reference modes. Verify a generated preview before restarting.

As checked on November 3, 2026, Fish lists this TTS model at $0 and advertises free access through November 30, 2026, subject to fair use. Requests may be retained for model improvement and latency is best-effort. See [Fish pricing](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits), [free-tier terms](https://fish.audio/blog/s2-1-pro-free-api/) and [voice cloning](https://docs.fish.audio/features/voice-cloning). No billing or subscription is required for inline cloning on this free model; do not assume the promotion is permanent.

The historical `ENABLE_HEY_BALLER` environment setting still enables the assistant; the detected wake phrase is now “Hey Rajan”.

```powershell
npm run check
npm run build
npm run register
npm start
```

Join voice and run `/hey mode:on`. **Only the user who invokes it opts in.** Up to four listeners can opt in; the session expires after 15 minutes from the most recent opt-in. The public status card lists listeners and explains data handling. `/hey mode:off` removes yourself, `/hey mode:alloff` stops all reception, and leaving voice removes your subscription. Anybody in the same voice channel can use the stop controls. Listening returns to off after a restart.

`/ask prompt:<request>` talks or acts in your voice channel without enabling microphone listening. `/effect` remains a shortcut. `/effect prompt:dramatic soundtrack` and `/effect prompt:air horn` work without a speech key. Without a key, `/hey mode:on` can still test the local wake detector and chime, but it does not open a command recording window.

### Voice data and limits

Normal opted-in speech goes only to the local Sherpa-ONNX keyword spotter. After the ready chime, a bounded buffer holds at most eight seconds of that user's request. A short silence ends capture, and Gemini receives the buffer, name hints, and that speaker's last four successful requests/replies. Context stays in memory for ten minutes and is cleared on opt-out, channel leave, session expiry, or restart. Users' conversation contexts are separate. Spoken replies are audible to everyone in the channel.

Model output is validated against an allowlist before any action. Music uses the existing URL validation, queue limits, and same-channel checks; there are no moderation, server administration, shell, or arbitrary network tools. Opt-out, channel leave, expiry, and stop cancel pending operations; late model responses cannot start playback. The bot stores no live incoming requests or transcripts on disk and does not print them in logs. An explicitly supplied voice-cloning reference is separate from live requests. It is uploaded by the host’s persistent-model setup command, or with each generated reply when inline reference mode is configured. Diagnostic logs contain only action categories, timing, and safe error codes. Gemini uses the stateless [generateContent API](https://aistudio.google.com/api-reference/generate-content/generate-content), without uploaded files, server-side conversation IDs, or explicit context caches. Google's service terms/data policies still apply independently.

Discord voice reception is supported by `@discordjs/voice`, but is not documented by Discord and can break with platform changes. The wake model comes from the [official Sherpa-ONNX release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models), downloaded separately with a pinned SHA-256. It is not committed to this repo. Model provenance/license: [upstream model](https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01), Apache 2.0. The authored effects contain no sampled commercial recordings.

Additional checks:

- `npx tsx scripts/smoke-wake.ts <mono-16kHz.wav> ...`: test keyword spotting locally; never joins Discord or calls an API.
- `node dist/scripts/smoke-voice-worker.js <mono-16kHz-hey-rajan.wav>`: verify real Opus decoding, opt-in isolation, wake detection, command capture, and opt-out.
- `npx tsx scripts/smoke-gemini.ts <mono-16kHz-command.wav>`: make one Gemini transcription request. No path generates a Jason announcer preview in ignored `.runtime/` instead. These explicit development checks use API quota.
- `npx tsx scripts/smoke-assistant.ts`: check music, wedding, jokes, follow-up context, and conversational TTS against Gemini without connecting to Discord. Writes an authored speech preview to ignored `.runtime/assistant-preview.wav`. Pass `<mono-16kHz-command.wav> <expected-action>` to check a synthetic audio fixture instead. Uses API quota; prints only result categories and timing.
