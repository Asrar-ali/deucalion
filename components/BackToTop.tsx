"use client";

import { useEffect, useState, type RefObject } from "react";
import { ArrowUp } from "@phosphor-icons/react/dist/ssr";

/**
 * Floating "Back to top" button. Renders only after the user has scrolled 1.5 screens down, so it
 * is not in the tab order otherwise. Activating it scrolls up and moves focus to the page heading.
 */
export function BackToTop({ focusRef }: { focusRef: RefObject<HTMLElement | null> }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      // Only worth showing once the user is well past the first screens of content.
      setShow(window.scrollY > window.innerHeight * 1.5);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

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
