interface ProposedBlockProps {
  items: string[];
  note?: string;
}

// Capabilities the design anticipates but the server does not implement.
// They must stay visibly subordinate and never present data.
export function ProposedBlock({ items, note }: ProposedBlockProps) {
  return (
    <section className="proposed-block" aria-label="Proposed · Not implemented">
      <h2 className="proposed-title">Proposed · Not implemented</h2>
      <p className="proposed-items">{items.join(" · ")}</p>
      <p className="proposed-note">
        {note ??
          "Listed for planning context only — nothing above is available in this build."}
      </p>
    </section>
  );
}
