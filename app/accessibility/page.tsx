import Link from "next/link";
import type { Metadata } from "next";

/**
 * Rendered from docs/ACCESSIBILITY.md, but written as a page a person would actually read, not
 * a copy of the working file. Server component: no client JS, so it loads and reads under any
 * network condition, including the low-bandwidth case this whole document is about.
 */

export const metadata: Metadata = {
  title: "Deucalion accessibility statement",
  description: "What Deucalion does for accessibility, what we tested, and what we know is missing.",
};

export default function AccessibilityPage() {
  return (
    <main
      id="main"
      className="mx-auto flex max-w-[70ch] flex-col gap-8 px-4 py-10 text-sm leading-relaxed"
      style={{ background: "var(--surface)", color: "var(--text)" }}
    >
      <div>
        <Link
          href="/"
          className="text-xs underline"
          style={{ color: "var(--text-muted)" }}
        >
          Back to Deucalion
        </Link>
      </div>

      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Accessibility statement</h1>
        <p style={{ color: "var(--text-muted)" }}>
          This tool has two accessibility jobs, and we treat them as equally important. The first
          is the ordinary one: the app itself has to be usable by everyone, to WCAG 2.2 level AA.
          The second is the reason the project exists at all. The information inside it has to
          reach people during a flood, over satellite internet, on a cracked phone screen in the
          rain, and to people with low literacy or no smartphone at all. A tool that passes an
          accessibility checker but fails a band office trying to read it during an evacuation has
          not actually succeeded.
        </p>
        <p style={{ color: "var(--text-faint)" }}>
          Written by the two people who built the app, for the Thunder Bay AI Hackathon judged on
          2026-09-26.
        </p>
      </header>

      <section aria-labelledby="baseline-heading" className="flex flex-col gap-4">
        <h2 id="baseline-heading" className="text-lg font-semibold">
          The baseline: usable by everyone
        </h2>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Keyboard and focus</h3>
          <p>
            Every control, including the map, can be reached and operated without a mouse. Focus
            has a visible ring at all times, we never set <code>outline: none</code>. There is a
            skip link to the main content, and pressing <kbd>?</kbd> opens a shortcut panel. Map
            markers are keyboard-navigable: tab into the layer, move between points with the
            arrow keys, press enter to open one. A map that only works with a mouse is not
            something we were willing to ship, because it is the single most common way map
            interfaces fail.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Nothing depends on hover</h3>
          <p>
            Every tooltip and every truncated cell also opens on focus and on tap, not only on
            hover. We tested this by unplugging the mouse entirely and working through the app
            with the keyboard alone.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Screen readers</h3>
          <p>
            The map has a genuine text equivalent, not a lesser fallback: a sortable table with
            the same filters and the same data. An announcement region reports result counts as
            filters change, for example, forty two reports match and eighteen are mapped. Every
            image carries alt text, generated automatically for uploaded photos and left empty
            for decorative art. Progress during classification is announced as it happens, not
            only shown as an animation.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Colour and contrast</h3>
          <p>
            Colour is never the only signal. A category is always colour plus an icon plus a
            text label. Confidence is always a filled meter plus the number. Text holds 4.5 to 1
            contrast and interface elements hold 3 to 1, in both the light and dark themes. The
            category palette is chosen to still separate under the common forms of colour
            blindness, and severity uses a plain light to dark ramp rather than a red to green
            scale, which is exactly the scale that fails for about eight percent of men. The app
            also honours a system preference for higher contrast and for Windows high contrast
            mode.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Motion, zoom and layout</h3>
          <p>
            With reduced motion requested by the system, marker animation stops and transitions
            are limited to opacity. Text can be zoomed to two hundred percent with nothing clipped
            or lost. The layout holds at phone width with a sixteen pixel gutter and no sideways
            scrolling, and a large touch target mode is available for gloves and outdoor use.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Forms and errors</h3>
          <p>
            An upload error names the row and says what happened and what we did about it, for
            example row four hundred twelve had an empty text column and was skipped, eight
            thousand and twenty three rows loaded. It never just says the file was invalid. Every
            input has a real label, not a placeholder standing in for one, and the page carries a
            meaningful message for anyone without JavaScript enabled.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Type</h3>
          <p>
            Atkinson Hyperlegible, the typeface the Braille Institute designed for low vision, is
            offered as a free toggle. Body text never drops below fourteen pixels, and we do not
            use justified text.
          </p>
        </div>
      </section>

      <section aria-labelledby="crisis-heading" className="flex flex-col gap-3">
        <h2 id="crisis-heading" className="text-lg font-semibold">
          Built for the moment of a flood, not just for a checklist
        </h2>
        <p>
          This is the part of accessibility that a generic checker cannot grade, and the part CE
          Strategies actually asked for. Every item below exists because someone reading this in
          a real flood does not have reliable power, signal or a free hand.
        </p>
        <table className="w-full border-collapse text-left text-[13px]">
          <caption className="sr-only">Accessibility features aimed at flood conditions specifically</caption>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--line)" }}>
              <th scope="col" className="py-1.5 pr-3 font-medium" style={{ color: "var(--text-muted)" }}>
                Feature
              </th>
              <th scope="col" className="py-1.5 font-medium" style={{ color: "var(--text-muted)" }}>
                Why it is here
              </th>
            </tr>
          </thead>
          <tbody>
            {CRISIS_FEATURES.map((row) => (
              <tr key={row.feature} style={{ borderBottom: "1px solid var(--line)" }}>
                <td className="py-1.5 pr-3 align-top font-medium">{row.feature}</td>
                <td className="py-1.5 align-top" style={{ color: "var(--text-muted)" }}>
                  {row.why}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="indigenous-heading" className="flex flex-col gap-2">
        <h2 id="indigenous-heading" className="text-lg font-semibold">
          Indigenous language support
        </h2>
        <p>
          We do not ship Anishinaabemowin or Oji-Cree interface labels in this build, and we are
          deliberate about that. Machine-translated Indigenous language text in a tool meant for
          use during an emergency would be worse than shipping no translation at all, and it is
          not a decision either of us is qualified to make alone. If a fluent speaker from a
          partner community validates a translation, it goes in. Until then, naming this gap
          honestly is meant to be the first item on the list the next time we sit down with
          community partners, not a footnote.
        </p>
      </section>

      <section aria-labelledby="gaps-heading" className="flex flex-col gap-2" style={{ background: "var(--surface-sunken)", borderRadius: "var(--radius-lg)", padding: "1rem" }}>
        <h2 id="gaps-heading" className="text-lg font-semibold">
          What we know still falls short
        </h2>
        <p>
          Stating these plainly is part of the submission, not an admission we tried to avoid. Two
          things are true of everything on this list. This is a self-assessment written by the two
          people who built the tool, not an independent audit, and the screen reader work behind
          it was done with keyboard-only navigation and automated checkers, not by sitting down
          with a person who uses a screen reader day to day. Everything below should be read with
          that in mind.
        </p>
        <ul className="flex flex-col gap-2 pl-4" style={{ listStyleType: "disc" }}>
          <li>
            We have not tested this with a person who actually relies on a screen reader day to
            day, only with keyboard navigation and automated accessibility checkers. That means we
            cannot claim the experience is right for a screen reader user, only that it is not
            obviously wrong.
          </li>
          <li>
            The map can be panned and its markers opened with a keyboard, but inspecting a
            complex overlapping polygon is still easier with a mouse than with keys alone.
          </li>
          <li>
            Chrome&apos;s built-in speech recognition sends the audio it hears to Google, so voice
            input is switched off in sovereignty mode. A fully local alternative would need a
            server-hosted speech model, and we did not have time to host one for this build.
          </li>
          <li>
            Plain-language rewriting of the situation brief depends on a live call to Gemini. With
            no network available, the app shows the original wording instead of a rewrite, rather
            than pretending a simplified version exists.
          </li>
          <li>
            No outside body has audited this app. Everything on this page is a claim from the team
            that built it, checked against WCAG 2.2 by hand and with automated tools, not a formal
            audit finding.
          </li>
        </ul>
      </section>

      <footer className="border-t pt-4 text-xs" style={{ borderColor: "var(--line)", color: "var(--text-faint)" }}>
        <p>
          Every label the classifier produces is a proposal with a confidence, never a verified
          fact. Nothing you load into Deucalion is stored on the server. This browser keeps
          classification labels and hashes of post text so that loading the same posts again is
          free; the Clear saved results and Wipe everything buttons in the page footer remove them.
        </p>
      </footer>
    </main>
  );
}

const CRISIS_FEATURES: Array<{ feature: string; why: string }> = [
  {
    feature: "Low-bandwidth mode",
    why: "Remote communities often run satellite internet. This mode drops raster map tiles for a plain outline, defers images, and shrinks what the page has to load. It also turns off dictation, which otherwise uploads audio.",
  },
  {
    feature: "Works offline once loaded",
    why: "The app keeps showing the last result if the connection drops mid-flood, instead of going blank.",
  },
  {
    feature: "Mobile first",
    why: "Responders and community members are often outdoors, one-handed, on a phone.",
  },
  {
    feature: "Read aloud",
    why: "Uses the browser's built-in speech synthesis, so it is free, offline and instant. Reads the situation brief or any single report, for low vision and for low literacy alike.",
  },
  {
    feature: "Voice input",
    why: "Speaking a report instead of typing it helps with cold hands, low literacy, and elders who would rather talk than type. This is a front door into the app, not a minor extra.",
  },
  {
    feature: "Plain-language mode",
    why: "Rewrites the situation brief at roughly a grade six reading level.",
  },
  {
    feature: "Print and short text export",
    why: "For anyone without a smartphone, and for a printed copy on the band office whiteboard.",
  },
  {
    feature: "English and French",
    why: "Both official languages are supported throughout.",
  },
];
