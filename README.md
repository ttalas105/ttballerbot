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

`.env`, `bin/`, `models/`, and `.runtime/` are ignored by Git. Never share `.env` or bot tokens. The bot reads command requests and voice membership, keeps queue metadata in memory, sends song-search terms to YouTube, and displays queued titles in Discord. Incoming voice is not processed unless a listener explicitly opts into Hey Baller below. Audio is piped through yt-dlp and FFmpeg without saving songs to disk. Console errors omit provider response bodies and credentials. Spotify metadata is linked back to Spotify.

Player artwork uses the provider's original cover image in a custom layout. Cover requests are limited to known Spotify/YouTube image hosts, bounded to 5 MB, and timeout after four seconds. The bundled Barlow Condensed fonts are licensed under the SIL Open Font License in `assets/fonts/OFL.txt`.

To disconnect Spotify, revoke **ttballerbot** in your Spotify account's app-access settings, clear the Spotify credentials/refresh token in `.env`, and restart the bot. Stop the bot to clear queued data; remove existing queue messages from Discord if you also want those displays deleted.

## Hey Baller — experimental `heyTT` branch

Local wake phrase detection with opt-in per Discord user. Say **“Hey Baller”**, wait for the ready chime, then say one of:

- “Give this conversation a dramatic soundtrack” — 15 seconds of original synthesized suspense music.
- “Air horn” — a short synthesized horn.
- “Announce Jason like a wrestling entrance” — an AI arena announcer over a synthesized entrance bed. Use the person's Discord display name or username; they must be in the channel. Ambiguous names are rejected.
- “Stop” — stop effects. While an effect is playing, use the chat Stop effects button or `/hey mode:stop`; wake triggers are suppressed during playback to avoid echoes.

The first version pauses music while playing effects and restores the same queue position afterward. It uses prepared announcer lines with the selected name; it does not yet write unlimited custom speeches or generate new music on demand. The detector and command routing run separately from Discord's audio scheduler. Wake phrase accuracy on real microphones needs a live trial; synthetic fixtures are not a substitute for testing accents, background noise, and speaker leakage.

### Setup and trial

```powershell
git switch heyTT
npm ci
npm run voice:install
```

In `.env`, set `ENABLE_HEY_BALLER=true`. Create a **free-tier** Gemini API key in [Google AI Studio](https://aistudio.google.com/api-keys), and set `GEMINI_API_KEY` locally. No OpenAI key is needed. Keep billing disabled for a free-only trial. Free-tier quotas vary by project/model; quota errors stop the request instead of retrying indefinitely or switching providers. Google says free-tier requests may be used to improve its products; see [pricing and data use](https://aistudio.google.com/docs/pricing).

Defaults are `gemini-3.1-flash-lite` for command transcription and `gemini-3.8-flash-tts` with `Fenrir` for the announcer. `VOICE_TRANSCRIPTION_MODEL`, `VOICE_SPEECH_MODEL`, and `VOICE_ANNOUNCER` can override these. The last 20 generated entrance lines are cached in memory to reduce repeated API usage. Google model availability and free quotas must be checked for your own project.

```powershell
npm run check
npm run build
npm run register
npm start
```

Join voice and run `/hey mode:on`. **Only the user who invokes it opts in.** Up to four listeners can opt in; the session expires after 15 minutes from the most recent opt-in. The public status card lists listeners and explains data handling. `/hey mode:off` removes yourself, `/hey mode:alloff` stops all reception, and leaving voice removes your subscription. Anybody in the same voice channel can use the stop controls. Listening returns to off after a restart.

`/effect prompt:dramatic soundtrack` and `/effect prompt:air horn` work without a speech key and without enabling listening. Without a key, `/hey mode:on` can still test the local wake detector and chime, but it does not open a command recording window.

### Voice data and limits

Normal opted-in speech goes only to the local Sherpa-ONNX keyword spotter. After the ready chime, a bounded buffer holds at most eight seconds of that user's command. A short silence ends the command, and the buffer is sent to Gemini for transcription. The narrow parser accepts only the actions above; it never executes arbitrary model instructions, code, URLs, moderation, or server administration actions. Opt-out, channel leave, expiry, and stop cancel pending operations. The bot stores no incoming recordings or transcripts on disk and does not print them in logs. Gemini requests use `store:false`; Google's service terms/data policies still apply independently.

Discord voice reception is supported by `@discordjs/voice`, but is not documented by Discord and can break with platform changes. The wake model comes from the [official Sherpa-ONNX release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models), downloaded separately with a pinned SHA-256. It is not committed to this repo. Model provenance/license: [upstream model](https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01), Apache 2.0. The authored effects contain no sampled commercial recordings.

Additional checks:

- `npx tsx scripts/smoke-wake.ts <mono-16kHz.wav> ...`: test keyword spotting locally; never joins Discord or calls an API.
- `node dist/scripts/smoke-voice-worker.js <mono-16kHz-hey-baller.wav>`: verify real Opus decoding, opt-in isolation, wake detection, command capture, and opt-out.
- `npx tsx scripts/smoke-gemini.ts <mono-16kHz-command.wav>`: make one Gemini transcription request. No path generates a Jason announcer preview in ignored `.runtime/` instead. These explicit development checks use API quota.
