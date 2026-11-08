# Lukewarm Cache

A small prompt-cache countdown below the prompt, with a keep-warm toggle.

```
off    [keeᴘ warm?] ◕ 42m   Opus 5.5 High
on     [edit ᴘoke] [ᴘoke in 41m] ●   Opus 5.5 High   (the ● is red)
cold   ◌ Cold   Opus 5.5 High
```

The timer sits beside the app's own model label, and what goes out (`sends "poke, just say okay" · 1 of 3 sent`) shows as a status line next to it. In the terminal it's a row above the prompt that names the model itself, with that line beneath.

## Install

```
claude plugin marketplace add OriGonen/lukewarm-cache
claude plugin install lukewarm-cache@lukewarm-cache
```

To update later:

```
claude plugin marketplace update lukewarm-cache
claude plugin update lukewarm-cache@lukewarm-cache
```

Or, to install from a local clone instead, use the folder's path in place of `OriGonen/lukewarm-cache`. The install reads the mod from that folder, so keep it.

Then start a new session. It needs nothing else. Remove Cache TTL Timer in the app's plugin settings first (`claude plugin list` may not show it): while it's installed it holds the footer spot, and this row stays above the prompt.

## Using it

- **Toggle** (`keep warm?`): per session, off by default, and only offered while the cache is warm. Grey when off; when on it shows the next poke's time in place of the countdown (green in the terminal). The words themselves are the button, on the desktop and in the terminal: press them to turn keep-warm on or off.
- **edit poke**: shown only while keep-warm is on. Choose **When due** (`poke` or `compact`), and edit the poke message, the seconds before expiry, and the most pokes in a row. Enter saves a field; `done` saves what's left. Settings are kept between sessions. On the desktop the editor opens above the prompt, since the footer can't hold it.
- `/lukewarm` shows the state; `/lukewarm on`, `/lukewarm off`; `/lukewarm ttl 90` sets a short test countdown for this session (marked `*` on the desktop) and `/lukewarm ttl auto` goes back.

The row appears after the session's first reply. On the desktop it takes the footer spot Cache TTL Timer uses. That's the only place below the prompt that can hold buttons, so while another mod has it, this row falls back to above the prompt.

The app draws every footer button as a bubble exactly one letter tall and clips what doesn't fit, and a mod can't change that or remove the bubble. Plain text has no bubble but can't be pressed. So the toggle and `edit poke` are both buttons, and their words use look-alike letters that sit on the baseline (`ᴘ`, `ɢ`, `ʏ`). The app colors footer buttons itself, so when keep-warm is on the desktop shows a red `●` mark beside the toggle.

## Compact instead of poke

With **When due** set to `compact`, keep-warm compacts the conversation instead of sending a message, by default 3 minutes before expiry. Compacting and poking each keep their own seconds before expiry. The old context is read from the cache one last time, and what's left is small enough that a cold start later costs little. It happens once: the cache is empty afterwards, so it waits for your next real message, and the max-pokes limit doesn't apply. Compacting replaces the conversation's history with a summary, so try it in a throwaway conversation first.

## What a poke is

A poke is a real turn: it's visible in the conversation, uses your plan's usage, and needs the session open and the computer awake. It goes out only when all of these hold:

- keep-warm is on and no turn is running;
- the countdown has reached the lead time, and the cache hasn't expired yet;
- no compaction or `/clear` has emptied the cache since the last real request;
- the 5-hour window is under 90% and the weekly window under 95%.

Any request of the conversation restarts the countdown, and a real turn resets the poke count.

## When it stops

Keep-warm switches itself off and says why, until you press the toggle:

| Shown | Why |
| --- | --- |
| `stopped: limit reached` | the most pokes in a row (default 3) went out with no real turn between |
| `stopped: cache was cold` | a poke wrote more of the cache than it read |
| `stopped: poke failed` | the poke errored or didn't reach the model |
| `stopped: interrupted` | you interrupted a poke |
| `stopped: poke never ran` | a sent poke hadn't started after 10 minutes |
| `stopped: compact failed` | a compaction was refused or errored |

## TTL

The TTL comes from what the API reports in the transcript for each cache write, as Cache TTL Timer does. The model doesn't decide it: a subscription gets 1 hour, an API key 5 minutes. Until a write is seen it's estimated from your plan. A transcript over 4 MiB can't be read, so in a very long session the estimate stands until a request reads the cache more than 5 minutes after the last one, which shows the TTL is 1 hour. If the transcript ever reports a longer TTL, the countdown and next poke follow it; the lead time stays what you set. `/lukewarm ttl` only shortens the mod's own countdown, never the server's.

## Credits

The countdown and transcript reading come from [Cache TTL Timer](https://github.com/WQGGSEY/cache-ttl-timer) and the poke logic from [Cache Caffeine](https://github.com/lperezmo/cache-caffeine), both MIT. See `LICENSE`.
