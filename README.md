# Claude Usage — GNOME Shell extension

A top-bar indicator for your Claude plan limits. The panel shows how much of
your current 5-hour session window you've used; the drop-down shows every
limit window, when each resets, where you're on pace to finish, and a local
breakdown of what you've been spending it on.

Requires GNOME Shell 48–50 and a Claude Code install signed in with a Claude
subscription (Pro, Max, Team or Enterprise).

## What it shows

**Plan limits** — the same numbers `/usage` prints inside Claude Code:

- **Current session** — utilization of the 5-hour window, a bar, time until
  it resets, and a projection: at the pace so far, where you'll be by reset.
- **Current week (all models)** — the 7-day window, same treatment.
- Any other windows your plan has (Opus-only, Sonnet-only, per-model weekly),
  and extra-usage credits when they're enabled.

**Local activity** — from the transcripts Claude Code writes to
`~/.claude/projects`, which the plan limits say nothing about:

- Today's usage as equivalent API cost, with token and message counts.
- A 14-day sparkline and a 7-day total.
- Today's top five by model, or by project.

The bars turn amber at 75% and red at 100%, and so does the panel label.

## Themes

Pick a colour theme under **Settings → Appearance**, with a live preview:

Claude (the default, which keeps the shell's own menu colours), Claude Dark,
Claude Light, Adwaita Dark, Adwaita Light, Catppuccin Mocha, Catppuccin Latte,
Dracula, Everforest, GitHub Dark, GitHub Light, Gruvbox Dark, Gruvbox Light,
Kanagawa, Monokai, Nord, One Dark, Rosé Pine, Solarized Dark, Solarized Light,
Tokyo Night and High Contrast.

Each theme sets seven colours: accent, warning, critical, and the drop-down's
background, text, secondary text and bar track. Turn off **Theme the drop-down
background** to keep only a theme's accent and warning colours on the shell's
own menu.

To make your own, change any colour. The current theme and your change are
saved as the **Custom** theme, which stays in the list when you switch away.
From the command line:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/claude-usage@tobrien.local/schemas \
  set org.gnome.shell.extensions.claude-usage custom-theme \
  "{'accent': '#50c878', 'background': '#141e3c', 'text': '#f0f0f0'}"
gsettings --schemadir ~/.local/share/gnome-shell/extensions/claude-usage@tobrien.local/schemas \
  set org.gnome.shell.extensions.claude-usage theme custom
```

Colours can be `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`. Any you
leave out come from Claude Dark. Built-in themes live in `themes.js`.

## How it gets the numbers

Claude Code answers a `get_usage` control request on its stream-json
protocol with the structured data behind `/usage`:

```sh
printf '%s\n' '{"type":"control_request","request_id":"1","request":{"subtype":"get_usage"}}' \
  | claude --input-format stream-json --output-format stream-json --verbose -p
```

That call makes no model request and costs no tokens. It takes about 1.5 s and
creates no session files. It uses the CLI's existing sign-in, so the extension
never touches your credentials. Claude Code marks this request as experimental,
so its response shape may change between versions.

If limits aren't available (an API key, Bedrock/Vertex, or `claude` not found),
the drop-down says why and the panel falls back to today's local cost.

The local figures are priced at published Anthropic API rates. On a
subscription they're a measure of consumption, not a bill.

## Install

```sh
git clone https://github.com/Tom0Brien/gnome-claude-usage.git
cd gnome-claude-usage
./install.sh
```

Then log out and back in. Wayland can't reload the shell in place. On X11,
<kbd>Alt</kbd>+<kbd>F2</kbd>, `r`, <kbd>Enter</kbd> is enough.

```sh
gnome-extensions info claude-usage@tobrien.local    # should say State: ACTIVE
gnome-extensions prefs claude-usage@tobrien.local   # panel display, position, refresh
```

If GNOME Shell can't find `claude` on its `PATH`, the scanner also looks in
`~/.local/bin`, `~/.claude/local`, `/usr/local/bin` and `/usr/bin`. You can set
`CLAUDE_USAGE_BIN` in your session environment to point at it explicitly.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Display | Session window used (%) | Also: weekly %, 5-hour block cost, today's cost, icon only |
| Position | Right | Left, centre or right of the top bar |
| Refresh interval | 60 s | Opening the menu always fetches fresh numbers |
| Break down by project | Off | Today's top five per project instead of per model |
| Theme | Claude | 21 more built-in themes, or Custom |
| Theme the drop-down background | On | Off keeps the shell's menu colours |

## How it's built

| File | Role |
| --- | --- |
| `extension.js` | Panel button, drop-down, refresh timer |
| `scanner.js` | Standalone GJS script: fetches plan limits, parses transcripts, prints JSON |
| `prefs.js` | Adwaita preferences window |
| `themes.js` | Built-in themes and colour resolution, shared by the extension and prefs |
| `stylesheet.css` | Menu layout and fallback colours |
| `schemas/` | GSettings schema |

`scanner.js` runs as a subprocess, so neither the `claude` call nor parsing tens
of megabytes of JSONL blocks the compositor. It caches two things in
`~/.cache/claude-usage/`:

- per-transcript results keyed by size and mtime, so a refresh only re-reads
  the session in use
- the last plan-limit response, reused for half the refresh interval on the
  timer

Run it by hand to see the raw data:

```sh
gjs -m scanner.js --live-max-age=0 | python3 -m json.tool
```

### Pricing

Local cost rates live in the `PRICES` table at the top of `scanner.js`, in
dollars per million tokens as
`[input, output, cache write 5m, cache write 1h, cache read]`. Unknown model ids
fall back to their family's rate. Long-context premium rates are not modelled.

### Testing without logging out

Your running shell only loads a changed extension at session start. To test a
change, boot a throwaway headless shell on a private bus:

```sh
dbus-run-session -- gnome-shell --headless --virtual-monitor 1400x900 --wayland
```

Inside that session, `gnome-extensions info claude-usage@tobrien.local` reports
whether the extension reached `ACTIVE`, and JS errors show up in the shell's
output.
