"use client";

import { useEffect, useState, type RefObject } from "react";
import { ArrowUp } from "@phosphor-icons/react/dist/ssr";

/**
 * Floating "Back to top" button. A sentinel 1.5 viewport heights tall sits at the top of the
 * document; once it has fully scrolled out of view the button renders (so it is not in the tab
 * order otherwise). Activating it scrolls up and moves focus to the page heading.
 */
export function BackToTop({ focusRef }: { focusRef: RefObject<HTMLElement | null> }) {
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setShow(!e.isIntersecting));
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sentinel]);

  const onClick = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    const target =
      focusRef.current ??
      document.querySelector<HTMLElement>("a[href], button:not([disabled]), input, select, textarea");
    target?.focus({ preventScroll: true });
  };

  return (
    <>
      <div
        ref={setSentinel}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 w-px"
        style={{ height: "150vh" }}
      />
      {show && (
        <button
          type="button"
          onClick={onClick}
          className="fixed z-40 inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full border px-4 text-sm font-medium"
          style={{
            right: "max(1rem, env(safe-area-inset-right))",
            bottom: "calc(1.5rem + env(safe-area-inset-bottom))",
            background: "var(--surface-raised)",
            color: "var(--text)",
            borderColor: "var(--line-strong)",
            boxShadow: "var(--shadow)",
          }}
        >
          <ArrowUp size={16} aria-hidden />
          Back to top
        </button>
      )}
    </>
  );
}
