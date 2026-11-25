# Changelog

## 1.4.2 (2026-11-24)

Three changes to how the opened tray looks and moves.

- **The sessions card is black.** It was the one white tile on the tray. It now takes the same black as the usage tile and the status pill, with session names in white and the times and second lines in grey.
- **The tray opens out of the lamp.** It used to fade in while it grew from 30% of its size, so it was nearly full size before it could be seen. Now the lamp's circle widens from the corner and uncovers the tray as it goes, and the tray closes back into the lamp the same way, faster.
- **Tiles swell under the pointer.** The usage tile, the sessions card, each session row, the status pill and the lamp grow by a pixel or two at each edge while the pointer is on them, and settle back when it leaves. Clawd stays the size he is; the lamp's bezel and ring grow round him. With Windows' animation effects switched off, the tray only fades and nothing swells.

## 1.4.1 (2026-11-24)

**Plan usage now fills in when you work only in the Claude app.** Sessions there send no usage figures (only Claude Code in a terminal runs the status line they come from), and the usage service needs Claude Code's sign-in, which only a terminal session renewed. With neither, the tile stayed on "Usage appears with Claude's next reply" however often Claude replied.

- **The sign-in is kept renewed.** When it has expired and a figure is wanted, Clawd runs `claude -p /usage` out of sight, so Claude Code renews its own sign-in. Nothing is sent to a model; none of your hooks or MCP servers run for it; it does not appear in the sessions list. At most once in a quarter of an hour, and less often while it does not help. **Settings → Plan usage → Keep Claude Code's sign-in renewed** turns it off.
- **Claude Code's own saved figures are read.** Claude Code keeps the usage service's last answer in its config file. Clawd takes it when it is newer than what it holds, which is also how the figures arrive after a renewal, without a second request to the service.
- **The empty tile says what is true.** It reads *Usage appears when Claude replies in a terminal*, which is what brings figures when Claude Code is not installed or was never signed in on this computer.

## 1.4.0 (2026-11-24)

A new design. The widget is now a single 36 px lamp in a corner of your screen. Hover it and a quarter-disc tray opens out of the corner, with four tiles: plan usage, your sessions, a status pill, and the lamp with Clawd inside.

**What changed**

- **At rest it is just the lamp**: green, amber with an arc circling it while Claude works, red with the wait time beside it when Claude needs you. A blue badge counts turns that finished while you were away.
- **The tray opens away from whichever corner the lamp is in.** Drag the widget across the screen and it turns round to match.
- **Plan usage no longer shows "sign-in expired" or "rate limited".** The 5-hour and weekly figures now come from Claude Code itself, through its status line, with every reply. The usage service is only asked for the top model's weekly figure, rarely, and never with an expired token. A figure that could not be refreshed is drawn dim with its age.
- **Clawd lives inside the lamp** and shows while the tray is open, in the same poses as before. Press and hold the lamp to pet him. After a few idle minutes he sleeps there.
- **Size** now runs from 70% to 150%, and 100% is the new design's natural size.

**Removed**

- Grabbing Clawd and flinging him across the desktop, his walk to a session's window when you click its row, and his bedtime walk. The full-screen overlay window they needed is gone with them.
- The Helvetica Neue font files. The widget now ships Inter, under the SIL Open Font License.

**The status line**

On first launch after updating, Clawd registers a status line command in Claude Code's `settings.json` (a timestamped backup is saved first). It prints nothing, so your status line stays blank. If you already have a status line of your own, it is kept: Clawd wraps it, tries the wrapper, and only uses it if your status line still runs cleanly; otherwise yours is left untouched. You can turn all of this off under **Settings → Plan usage**, which puts your entry back exactly as it was.
