# Daily Hub

Daily Hub is a desktop [Obsidian](https://obsidian.md/) community plugin that tracks recurring daily time goals automatically. You define a minimum and one or more activity rules; Daily Hub reads local [ActivityWatch](https://activitywatch.net/) events and calculates the time for you. There is no manual timer and no active-goal switch.

> **Privacy:** Daily Hub works locally and does not send your activity history to third-party servers. Raw activity remains in ActivityWatch; the plugin stores only its settings, goals, and daily notification markers in Obsidian plugin data.

## Current MVP

- A dedicated **Daily Hub** view with live progress bars.
- Unlimited daily goals with a minimum number of minutes.
- Case-insensitive `contains` and `equals` rules for URL, application, and window title.
- OR matching within a goal and deterministic single-goal attribution if goals overlap.
- ActivityWatch window, browser, and AFK event support.
- AFK exclusion with a configurable 60-second default threshold.
- Automatic refresh and refresh when Obsidian returns to the foreground.
- One Obsidian completion notice per goal per day.
- Goal management from the dashboard or plugin settings.
- Date-independent calculation APIs, ready for a future date navigator.

Reaching the minimum completes a goal but does not stop tracking. A 30-minute goal can show `43 / 30 min`, while its progress bar remains visually capped at 100%.

## Screenshot

_Screenshot coming after the first packaged release._

## Requirements

- Obsidian Desktop 1.5.0 or newer.
- ActivityWatch running locally (normally at `http://localhost:5600`).
- The ActivityWatch browser watcher if you want to use URL rules.

Daily Hub is marked desktop-only because it depends on a local ActivityWatch server and desktop watcher data.

## Install

### From a release

1. Download `main.js`, `manifest.json`, and `styles.css` from a release.
2. Create `<vault>/.obsidian/plugins/daily-hub/`.
3. Put the three files in that directory.
4. In Obsidian, open **Settings → Community plugins**, reload installed plugins, and enable **Daily Hub**.

### Development build

```bash
npm install
npm test
npm run lint
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/daily-hub/`, then reload Obsidian. `npm run dev` starts an esbuild watcher.

## Set up ActivityWatch

1. Install ActivityWatch from its [official download page](https://activitywatch.net/downloads/).
2. Start ActivityWatch and its standard window and AFK watchers.
3. Open **Settings → Daily Hub**. Keep the default URL unless your local server uses another port.
4. Click **Check again**. The dashboard should show **ActivityWatch connected**.

The **Install ActivityWatch** button deliberately opens the official download page. Automatic Linux installation varies by architecture, distribution, packaging, and release format; the MVP does not run shell commands or modify system files.

If ActivityWatch starts after Obsidian, use the refresh button or wait for the next configured refresh. Temporary API failures appear as an offline status and do not delete goals.

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

When the browser watcher reports a URL containing `keybr.com` and the AFK watcher says you are active, that time is attributed automatically.

## How counting works

ActivityWatch remains the source of truth. Daily Hub requests the selected local-day range, combines window and browser context, removes qualifying AFK intervals, matches timeline segments to enabled goals, and computes progress on demand. It does not duplicate raw ActivityWatch history into the vault.

If two goals accidentally match one segment, only the goal with the lexicographically smallest stable goal ID receives the time. This deterministic fallback prevents double-counting; rules are easiest to understand when they do not overlap.

## MVP limitations

- The dashboard currently displays today; the calculation layer already accepts arbitrary dates.
- No automatic ActivityWatch binary or browser-extension installation.
- No manual timers, schedules, weekly/monthly goals, streaks, calendar integrations, or cloud sync.
- Changes to rules or targets recalculate the entire selected day from current ActivityWatch history and configuration.

## License

[MIT](LICENSE)
