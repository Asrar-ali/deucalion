# Accessibility

Two different jobs. Both are in scope, and the second one is the point of the project.

**1. The app must be usable by everyone** — WCAG 2.2 AA.
**2. The information must reach people in a flood** — satellite internet, a phone in the rain,
low literacy, no smartphone at all.

This file doubles as the source for the in-app `/accessibility` statement, including what we
did **not** manage. Stating the gaps is part of the submission, not an embarrassment.

---

## Baseline — must ship

### Keyboard and focus
- Every control reachable and operable by keyboard. Visible focus ring, never `outline: none`.
- Skip link to main content.
- **Map markers are keyboard-navigable** — tab into the layer, arrow between points, Enter to
  open. A mouse-only map is an inaccessible map, and most map UIs fail exactly here.
- `?` opens a shortcut panel.

### Nothing hover-only
Every map tooltip and truncated cell opens on **focus and tap** as well as hover. This is the
single most-failed rule in map interfaces. Test it by unplugging the mouse.

### Screen readers
- The map has a **text equivalent**: a sortable table with identical filters and the same data.
  Not a lesser fallback — the same information.
- `aria-live="polite"` region announcing result counts as filters change
  ("42 reports match, 18 mapped").
- Every image has alt text. Uploaded images get it automatically from Gemini; decorative
  imagery gets `alt=""`.
- Progress during classification is announced, not just animated.

### Colour and contrast
- **Never colour alone.** Category = colour **+** icon **+** text label. Confidence = fill level
  **+** number on focus.
- AA contrast (4.5:1 text, 3:1 UI) in both themes. Verified, not assumed.
- Colourblind-safe categorical palette; severity uses a sequential ramp, not red/green.
- Honour `prefers-contrast` and Windows High Contrast / `forced-colors`.

### Motion, zoom, layout
- `prefers-reduced-motion`: no marker animation, no transitions beyond opacity.
- 200% text zoom with no loss of content or function.
- Works at phone width with a 16px gutter and no horizontal page scroll.
- Large-target touch mode toggle — for gloves and outdoor use.

### Forms and errors
- WCAG 3.3: errors **identify the row and say what to do**.
  Not "invalid CSV" but "row 412: text column was empty — skipped. 8,023 rows loaded."
- Labels on every input. No placeholder-as-label.
- Meaningful `<noscript>`.

### Fonts
- **Atkinson Hyperlegible** toggle — designed by the Braille Institute for low vision, free.
- No text below 14px. No justified text.

---

## Crisis accessibility — the part that matters in a flood

| Feature | Why |
|---|---|
| **Low-bandwidth mode** | Remote communities run satellite internet. Drops basemap tiles for a plain vector outline, defers images, shrinks payloads. Also disables STT, which uploads audio. |
| **PWA / offline** | The app must still open and show the last result when the connection dies mid-flood. |
| **Mobile-first** | Responders and community members are outdoors, one-handed, on a phone. |
| **Read aloud (TTS)** | `window.speechSynthesis`. Free, offline, instant. Reads the brief and any individual report. Serves low vision and low literacy both. |
| **Voice input (STT)** | `SpeechRecognition`. Speak a report instead of typing it — cold hands, low literacy, elders. This is a front door, not a checkbox. |
| **Plain-language mode** | Briefs rewritten at roughly grade 6. |
| **Print / SMS-length export** | For people without a smartphone, and for the band office whiteboard. |
| **EN / FR** | Both official languages. |

### On Indigenous language support
Anishinaabemowin and Oji-Cree UI labels are **only** shipped if a fluent speaker validates them.
Machine-translated Indigenous language in an emergency tool would be worse than none, and this
is not ours to guess at. If unvalidated, we say so on the accessibility page and name it as the
first thing we would do with community partners.

---

## Known gaps (put these in the statement, do not hide them)

- Screen reader testing was done with keyboard-only and automated checks, not with a
  screen-reader user. Unverified in the field.
- The map pans with keyboard but complex polygon inspection is easier with a mouse.
- Chrome speech recognition sends audio to Google, so it is off in sovereignty mode. A local
  alternative would need a server-side model we did not host today.
- Plain-language rewriting depends on Gemini; with no network the original text is shown instead.
- No formal audit. This is a self-assessment written by the team that built it.

---

## Test before freeze — 10 minutes, do it at 14:45

1. Unplug the mouse. Complete the whole demo path with the keyboard alone.
2. Tab to a map point and open it.
3. Zoom text to 200%. Look for clipping.
4. Toggle dark, light, and high-contrast. Check every badge still reads.
5. Turn on reduced motion. Confirm nothing animates.
6. Load at phone width. No horizontal scroll.
7. Break the network mid-classify. Confirm partial results survive and a real message appears.
8. Run one page through an automated checker. Fix anything critical, log the rest here.
