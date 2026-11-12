# Clawd 🚦

A tiny always-on-top desktop widget for Windows that shows what Claude Code is doing, so you can tab away without losing time:

| Light | Meaning | Clawd |
|---|---|---|
| *(unlit)* | No Claude Code sessions running | Completely still |
| 🟢 Green | Claude is idle — ready for your next prompt | Bobbing gently, or eyeing a stopwatch while background tasks Claude started are still running |
| 🟡 Yellow | Claude is working on a prompt | A lightbulb while he thinks, then hard hat on, hammering |
| 🔴 Red | Claude is waiting on you (permission prompt / question) | Checking his watch, or a speech bubble over his head |

With multiple sessions running, the light shows the most urgent state: **red > yellow > green**.

- **Compact by default** — when the mouse is away, the stoplight collapses to just the one lit lamp beside Clawd; hover to expand the full three-lamp light.
- **Wait timer** — when the light is red, a chip above it shows how long the oldest session has been waiting (while the session list is open, the list shows each wait instead); after 5 minutes the red pulse gets noticeably more insistent.
- **Notifications** — once a session has waited on you for 30 seconds (adjustable), Windows shows a notification naming the session and what it wants. Click it to bring that session's terminal to the front; it disappears by itself once the session stops waiting. Handy when the widget is on another screen or under a fullscreen window.
- **Finished while you were away** — when a turn ends, a blue badge appears on the light (with a count if several sessions have finished) and that session's row reads *finished* in blue. It stays until you've had the list open for a moment, clicked the row, or sent that session a new prompt.
- **Hover for details** — hovering the widget also opens the menu, an arch of glass that rises over it. Its lower half is the per-session list: each session's name, its state and how long it's been in it, and underneath, what it's doing or waiting on (*Bash: npm publish*, *Edit: main.js*, the question Claude asked you, or the background tasks still running). A session is named after its project folder, or after the name you gave it with `/rename`; two sessions in the same folder show Claude Code's own names for them (e.g. *alex-obsidian-e7* and *alex-obsidian-ec*). Clicking a row tries to bring that session's terminal to the front (best effort — it matches the project folder name against window titles, which works well for VS Code and for the active Windows Terminal tab), and Clawd runs over to knock on that window before trotting back.
- **Plan usage** — the menu's crown is a half-circle whose rim is the usage gauge, the same numbers as Claude Code's `/usage`: the rim is split into three arcs, for the 5-hour window, the weekly all-models window, and the weekly window for the top model (named by the API, e.g. *Fable*). Each arc fills clockwise like a dial, with its percentage and the time until it resets set underneath. Green under 50%, yellow to 80%, red above. It is read with the Claude Code sign-in token from `%USERPROFILE%\.claude\.credentials.json` (which Claude Code keeps fresh), refreshed every few minutes and again when you hover. When a refresh fails (the endpoint is rate limiting, the token has expired, the network is down) the last figures stay up and the widget waits before asking again: a minute at first, longer each time the server refuses, and at least as long as the server asks. A note says so once the figures are more than ten minutes old. With no figures to show, the menu is a plain rounded list of sessions.
- **Glass** — the light's housing, the wait chip and the menu are drawn as Liquid Glass: a translucent body with a bright rim and round, concentric shapes. They follow the Windows app mode, smoky in dark mode and frosted in light mode, and turn solid when Windows' transparency effects are off. A transparent window cannot blur the desktop behind it, so the glass is kept dense enough to read over anything.
- **Clawd reacts** — his pose follows what Claude is doing: a lightbulb coming on just out of reach before the first tool call, typing on a laptop for edits, holding up a magnifying glass for reads and searches, a hard hat and a hammer for commands, a blue speech bubble with a question mark when Claude asks you something, and lifting his wristwatch to check it while a permission prompt waits on you. When Claude is idle but background tasks it started (a dev server, a subagent) are still running, he holds up a stopwatch and watches its hand tick round. He hops when a long turn finishes, flinches when a permission is denied, and taps his foot, checking his watch twice as often, once a wait turns urgent.
- **Bedtime** — after three minutes of green with no background tasks running, he walks off the edge of the widget, comes back half a second later in a nightcap with a teddy bear in one hand and a blanket in the other, sits down on his folded legs with his eyes shut and his nightcap flopped over, hugs the teddy to his chest, throws the blanket over his lap, rests his arms on it and starts snoring z's. The moment anything changes (you send a prompt, Claude needs you, the session ends) he springs up into the matching pose and the cap, teddy and blanket tumble off the bottom of the screen.
- **A bit of depth** — Clawd is lit from the right: his left edge, left arm, nearest leg and the edge of his hard hat sit in a darker shade.
- **Always the same Clawd** — every pose is the same drawing, generated by `scripts/clawd-scenes.js`: the same body, arms, eyes and size, never stretched or tilted. A pose only changes what he wears or holds, and where he holds his arms; asleep, he sits down on his folded legs. He moves the way a pixel-art sprite does, in held steps with nothing in between, so his edges stay crisp.
- **Pet him** — press and hold (without dragging) and he wiggles happily.
- **Grab Clawd** — drag him right off the widget by his arm and swing him around the screen (he keeps his hard hat and hammer, or his watch). Let go and he falls to the bottom of the desktop, then walks back home and hops into place. You can catch him again mid-air or mid-walk.
- **Out of your way** — the widget lives only in the system tray (look in the hidden-icons overflow ^ menu); it never appears in the taskbar or Alt-Tab.

## Install

Run **`Clawd Setup <version>.exe`** (from the `dist/` folder or wherever it was shared to you). It installs per-user (no admin prompt) and starts with Windows by default.

On first launch it registers its status hooks into your user-level Claude Code settings (`%USERPROFILE%\.claude\settings.json`), after saving a timestamped backup next to it. When an update changes the hooks, the next launch rewrites them the same way, backup included. Claude Code watches that file, so sessions already running normally pick the hooks up by themselves; restart one if it doesn't. Either way, every session that is already running shows up in the widget right away (see below).

## How it works (and why it can't interfere with Claude)

Claude Code hooks fire on session events (prompt submitted, tool use, permission prompt, response finished…). Each hook is a one-line `curl.exe` call — built into Windows 10/11, no other software needed — that POSTs the event to the widget at `http://127.0.0.1:47615` and then **always exits 0**:

- output is fully suppressed, so nothing is ever injected into Claude's context,
- it never returns a decision, so it can't approve, deny, or block anything,
- the hooks that fire on every tool call run in the background (`async`), so Claude never waits on them; the rest fire a few times per turn at most and take well under 100 ms, capped at 1 s, with a 5 s hook timeout as a second safety net,
- if the widget isn't running, the call fails instantly and silently — Claude is unaffected.

The widget just listens, tracks each session's state (what it's doing and which tool call it's on, since when, and in which project folder), and renders the light. It only takes events from local programs like curl: a request that carries a browser's `Origin` header, or is addressed to any host but `127.0.0.1` or `localhost`, is refused, so a web page can't feed it fake sessions. It also reads Claude Code's own list of running processes (`%USERPROFILE%\.claude\sessions\`, one small file per process) so that sessions already running or sitting idle when the widget starts appear immediately, each session is tied to its process and its name from the first moment, and a session disappears within about 20 s of its process exiting even if it never sent SessionEnd. It stores its own data in `%USERPROFILE%\.claude-stoplight\`.

## Tray menu & settings

Right-click the tray icon (or the widget itself): open **Settings**, reset sessions if a light gets stuck (a session whose Claude Code process has exited is dropped automatically, even if it never sent SessionEnd), toggle *Start with Windows*, install/remove the Claude Code hooks, check for updates, or quit. Drag the widget anywhere; its position is remembered. Leave it against a screen edge and it stays docked to that edge: if you later hide, resize or move the taskbar, or change displays, it follows the edge instead of floating where the taskbar used to be.

Settings lets you change:

- **Size** (50–200%).
- **Dim when idle** — fades the widget when the light is green or unlit.
- **Click through when idle** — when green/unlit, clicks pass straight through the widget to whatever is beneath it (hovering still previews the session list; use the tray icon to interact until Claude is working/waiting again).
- **Notifications** — on or off, how long a session waits on you before one appears (default 30 s), and whether it plays the Windows notification sound (off by default).
- **Forget silent sessions after** — fallback for a silent session whose process could not be identified: how long it lingers before it's forgotten (default 6 h). Normally a session disappears within about 20 s of its Claude Code process exiting.
- **Listen port** — changing it restarts the listener and re-installs the hooks automatically.

## Auto-update

The installed app checks GitHub Releases for a new version once at launch, downloads in the background, and asks before restarting. After that it only checks when you use **Check for updates…** in the tray menu.

For updates to work you must publish releases: set `build.publish.owner` in `package.json` to your GitHub username, create a `claude-stoplight` repo, and upload the contents of a `npm run dist` build (the setup exe, the `.blockmap`, and `latest.yml`) as a GitHub release tagged `v<version>`.

## Uninstall

1. Right-click the tray icon → **Remove Claude Code hooks**.
2. Uninstall *Clawd* from Windows Settings → Apps.
3. Optionally delete `%USERPROFILE%\.claude-stoplight\`.

## Building from source

```
npm install
npm start        # run in dev
npm run dist     # build dist/Clawd Setup <version>.exe
```

If port `47615` clashes with something on your machine, pick a different port in Settings.
