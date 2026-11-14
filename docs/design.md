# Showup design reference

The look of the app lives in `src/app/globals.css` (tokens at the top) and a few small
components. This page records the rules, so new screens stay consistent.

## Type roles

| Role       | Face                       | Use for                                                        |
| ---------- | -------------------------- | -------------------------------------------------------------- |
| Display    | Inter Tight, 800, capitals | Page and section headings                                      |
| Reading    | IBM Plex Sans              | Paragraphs, help text, inputs                                  |
| Label      | IBM Plex Mono              | Labels, buttons, navigation, amounts, codes                    |
| Dot-matrix | Doto 900                   | Large numbers only: totals, countdowns, the live check-in code |

Fonts are self-hosted from `src/app/fonts/` under the SIL Open Font License, so pages make
no third-party font requests. Keep dot-matrix at 40px or larger and render `.`, `:` and `,`
through `DotText`: the dot face draws them as crosses.

## Color

Sand paper, ink text, one accent. **Blue marks the next thing to do** and nothing else:
primary buttons, links, the current journey step. Blue text on sand uses `--blue-ink` to
meet the 4.5:1 contrast ratio; `--blue` is for fills and large display text.

## Status tones

`JourneyStatus` is the only status box. Each tone pairs its color with a word, a glyph and
a border style, so color is never the only signal.

| Tone        | Label     | Glyph      | Border      | Motion                    | Telegram mark |
| ----------- | --------- | ---------- | ----------- | ------------------------- | ------------- |
| `action`    | Your turn | →          | Solid blue  | One sweep on entry        | 👉            |
| `checking`  | Checking  | Three dots | Dashed      | Dots step while waiting   | ⏳            |
| `confirmed` | Confirmed | ✓          | Solid green | One sweep, check draws in | ✅            |
| `blocked`   | Blocked   | !          | Heavy rust  | None                      | ⛔            |

Telegram cannot show these colors or fonts. Bot messages open with the tone's mark and
label, for example `✅ Confirmed. You’re signed in to Showup.`

## Shared pieces

- `JourneyStrip`: the attendee path Commit → Funded → Checked in → Paid out.
- `Countdown`: dot-matrix time left; amber with an "Expiring soon" tag near the end.
- `LiveCode`: the host's check-in code for a big screen, plus a read-aloud card.
- `.ticket`: the receipt shape, shared by the home page example and real results.
- `.empty-state`: an empty list says what will appear and offers one next step.

## Motion

Motion explains state: a sweep when a box appears, stepping dots while waiting, one
count-up on the home receipt. Errors never animate. Everything stops under
`prefers-reduced-motion`.

## Layout

The grid paper, ticker and blue band belong to the home page only. App pages stay calm:
sand background, bordered cards, a 1120px measure. Every page must hold at 320px wide
without horizontal scrolling.
