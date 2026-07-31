"use client";

// The single visibility marker used on every surface (Overview, Files,
// Inspector). The full word stays in the accessibility tree at all widths;
// narrow viewports swap it for the abbreviated label via CSS, and the dot is
// always decoration — meaning never rides on color alone.

type Visibility = "public" | "private";

// "prot" is reserved for a future protected tier.
const SHORT: Record<Visibility, string> = { public: "pub", private: "prv" };

export function VisibilityLabel({ visibility }: { visibility: Visibility }) {
  return (
    <span className="visibility-label">
      <span
        className={`dot ${visibility === "public" ? "dot-success" : "dot-muted"}`}
        aria-hidden
      />
      <span className="vis-text">{visibility}</span>
      <span className="vis-text-short" aria-hidden>
        {SHORT[visibility]}
      </span>
    </span>
  );
}
