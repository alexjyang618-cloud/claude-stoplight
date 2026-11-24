# Changelog

## 1.4.0

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
