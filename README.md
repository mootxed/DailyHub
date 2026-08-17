# Daily Hub

Daily Hub is a desktop [Obsidian](https://obsidian.md/) community plugin that tracks recurring daily time goals automatically. You define a minimum and one or more activity rules; Daily Hub reads local [ActivityWatch](https://activitywatch.net/) events and calculates the time for you. There is no manual timer and no active-goal switch.

> **Privacy:** Daily Hub works locally and does not send your activity history to third-party servers. Raw activity remains in ActivityWatch; the plugin stores only its settings, goals, and daily notification markers in Obsidian plugin data.

## Dashboard

- A dedicated **Daily Hub** view with live progress bars, remaining time, and above-target totals.
- A **Remaining today** summary with each unfinished goal and the combined time left.
- A seven-day navigator with a persistent Today shortcut when another date is selected.
- A daily summary with total studied time and enabled-goal completion count.
- A clickable Monday–Sunday overview with weekly total, elapsed-day average, completion count, and per-goal breakdown.
- Goal details for the selected week, including daily totals and completed-day count.
- Unlimited daily goals with a minimum number of minutes.
- Case-insensitive `contains` and `equals` primary/continuation rules for URL, application, and window title.
- OR matching within each rule group and deterministic single-goal attribution if goals overlap.
- ActivityWatch window, browser, and AFK event support.
- Every interval that ActivityWatch reports as `afk` is excluded.
- Automatic refresh and refresh when Obsidian returns to the foreground.
- One Obsidian completion notice per goal per day.
- Goal management from the dashboard or plugin settings.
- On-demand historical recalculation from ActivityWatch for any selected local date.

Reaching the minimum completes a goal but does not stop tracking. A 30-minute goal can show `43 / 30 min`, while its progress bar remains visually capped at 100%.

## Screenshot

_Screenshot coming after the first packaged release._

## Requirements

- Obsidian Desktop 1.5.0 or newer.
- ActivityWatch running locally (normally at `http://localhost:5600`) with `aw-watcher-window` and `aw-watcher-afk`.
- The `aw-watcher-web` browser watcher if you want to use URL rules.
- Linux/X11 for the currently targeted Linux desktop setup; no Wayland-specific integration is included.

Daily Hub is marked desktop-only because it depends on a local ActivityWatch server and desktop watcher data.

Watcher dependencies are intentionally strict: application and window-title rules require `aw-watcher-window`; URL rules require both `aw-watcher-web` and `aw-watcher-window`, because the active window verifies that the URL belongs to the foreground browser; AFK exclusion requires `aw-watcher-afk`.

## Install

### From a release

1. Download `main.js`, `manifest.json`, and `styles.css` from a release.
2. Create `<vault>/.obsidian/plugins/daily-hub/`.
3. Put the three files in that directory.
4. In Obsidian, open **Settings → Community plugins**, reload installed plugins, and enable **Daily Hub**.

### Development build

```bash
npm install
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/daily-hub/`, then reload Obsidian. `npm run dev` starts an esbuild watcher.

## Testing

```bash
npm test
npm run test:coverage
npm run lint
npm run build
```

## CI

GitHub Actions runs the tests, coverage thresholds, lint, and production build for pushes and pull requests targeting `main`.

## Set up ActivityWatch

1. Install ActivityWatch from its [official download page](https://activitywatch.net/downloads/).
2. Start ActivityWatch and its standard window and AFK watchers.
3. Open **Settings → Daily Hub**. Keep the default URL unless your local server uses another port.
4. Click **Check again**. The dashboard should show **ActivityWatch connected**.

The **Install ActivityWatch** button deliberately opens the official download page. Automatic binary installation varies by architecture, distribution, packaging, and release format, so the MVP does not run installation shell commands or modify system files.

If ActivityWatch starts after Obsidian, use the refresh button or wait for the next configured refresh. Temporary API failures appear as an offline status and do not delete goals.

### AFK timeout

ActivityWatch—not Daily Hub—decides when you become AFK. Daily Hub trusts the `afkstatus` timeline and excludes every interval whose status is `afk`, regardless of how short or long that event is.

For the intended behaviour, configure `aw-watcher-afk` to mark you AFK after **60 seconds**. On Linux, open **Settings → Daily Hub → AFK tracking** and choose **Configure ActivityWatch**. Daily Hub updates only the documented user config file:

```text
$XDG_CONFIG_HOME/activitywatch/aw-watcher-afk/aw-watcher-afk.toml
```

or `~/.config/activitywatch/aw-watcher-afk/aw-watcher-afk.toml` when `XDG_CONFIG_HOME` is unset. The action requires explicit confirmation, creates a timestamped backup, refuses symlinks or unexpected config structures, and replaces the file atomically. Restart ActivityWatch afterward.

If Daily Hub cannot locate the file, follow the [official ActivityWatch configuration instructions](https://docs.activitywatch.net/en/latest/configuration.html#aw-watcher-afk): open the ActivityWatch config folder from its tray menu, edit `[aw-watcher-afk]`, set `timeout = 60`, save, and restart ActivityWatch. The settings screen never claims to know the effective timeout when it cannot read an explicit value.

### Browser watcher

URL matching requires an ActivityWatch browser extension. Install the watcher for your browser by following the [official browser watcher instructions](https://docs.activitywatch.net/en/latest/watchers.html#web-browser). Daily Hub does not attempt to install browser extensions automatically. Without it, application and window-title rules continue to work and the dashboard explains that URL data is unavailable.

## Example: keybr.com

Create a goal from **Daily Hub → Add goal**:

```text
Name: Typing practice
Daily minimum: 30
Rule type: URL
Match: contains
Value: keybr.com
```

When the browser watcher reports a URL containing `keybr.com`, the corresponding browser is the active X11 window, and the AFK watcher does not report `afk`, that time is attributed automatically. A stale browser event is ignored after you switch to Terminal or another application.

## Context-aware goals

Primary rules identify a goal on their own. Continuation rules count only after a primary activity recently established that goal's context. For example:

```text
Name: DevOps
Daily minimum: 90 min
Primary: URL contains stepik.org
Count while AFK: on
Continuation: Application contains kitty
Continuation: Application contains terminal
Continuation: Application contains code
Context timeout: 10 min
```

After an active Stepik page identifies DevOps, work in Terminal or VS Code can continue to count for 10 minutes after the most recent matching Primary activity. Primary activity establishes and refreshes this context lease. Continuation activity can use the lease but does **not** refresh it, so closing Stepik cannot make Terminal count indefinitely. Opening those applications without the earlier Stepik activity does not start DevOps. Unrelated activity itself is never counted.

For passive activities such as video lessons, a specific Primary rule can enable **Count while AFK**. That rule must still match the current foreground activity, so a background Stepik tab is not counted. A matching passive Primary continues to refresh the context lease while it remains in the foreground. Continuation rules never count while AFK and never extend the lease.

## How counting works

ActivityWatch remains the source of truth. Daily Hub requests the selected local-day range, clips and sorts events, combines a browser URL only with its corresponding active browser window, applies rule-aware AFK exclusion, matches timeline segments to enabled goals, and computes progress on demand. Context is reconstructed from that timeline for every calculation and is not stored in plugin data. It prefers the current ActivityWatch hostname and the newest duplicate bucket for each source. It does not duplicate raw ActivityWatch history into the vault.

Weekly days load in parallel. In-memory snapshots are keyed by ActivityWatch URL and local date: today's and failed entries expire quickly, while successful historical entries remain cached for the plugin session. Refresh invalidates the selected week, selected date, and Today. No raw history or derived weekly database is written to the vault.

Historical totals always use the current goal configuration. Changing a rule, target, or enabled state can therefore change the recalculated result for an older day; Daily Hub does not keep versioned goal history yet.

If two goals' primary rules accidentally match one segment, only the goal with the lexicographically smallest stable goal ID receives the time. This deterministic fallback prevents double-counting; rules are easiest to understand when they do not overlap.

## Current limitations

- Context starts empty at midnight for each calculated local day; it is not carried across day boundaries.
- No automatic ActivityWatch binary or browser-extension installation.
- No manual timers, schedules, weekly/monthly goals, streaks, calendar integrations, or cloud sync.
- Changes to rules or targets recalculate the entire selected day from current ActivityWatch history and configuration.

## Manual smoke test

1. Start ActivityWatch and confirm that `aw-watcher-window` and `aw-watcher-afk` appear in its timeline.
2. Set the AFK timeout to 60 seconds and restart ActivityWatch.
3. Install and enable the ActivityWatch browser watcher.
4. Open Obsidian and enable Daily Hub.
5. Create `Typing Practice`, target `30 min`, with `URL contains keybr.com`.
6. Open Keybr and confirm that the time increases after a refresh.
7. Switch to Terminal and confirm that Keybr time stops increasing.
8. Return to Keybr, then provide no keyboard or mouse input for more than 60 seconds; confirm that the AFK interval is not counted.
9. Resume activity in Keybr and confirm that counting continues.

## License

[MIT](LICENSE)
