"use client";

import type { Visibility } from "@/lib/types";

interface VisibilitySelectorProps {
  value: Visibility;
  onChange: (value: Visibility) => void;
  ownerPhrase?: string;
}

// The canonical home of the visibility meanings — reused by upload and the
// inspector editor so each explanation lives in exactly one place.
export function VisibilitySelector({
  value,
  onChange,
  ownerPhrase = "you",
}: VisibilitySelectorProps) {
  const options: Array<{ key: Visibility; title: string; detail: string }> = [
    {
      key: "public",
      title: "public",
      detail: "Anyone with the link. No sign-in needed.",
    },
    {
      key: "protected",
      title: "protected",
      detail: "Anyone signed in to this server — every member and admin.",
    },
    {
      key: "private",
      title: "private",
      detail: `Only ${ownerPhrase} and admins. Everyone else gets the same 404 as a missing file.`,
    },
  ];
  return (
    <fieldset className="field radio-group visibility-selector">
      <legend className="section-label">Visibility</legend>
      {options.map((option) => (
        <label
          key={option.key}
          className={`radio-card${value === option.key ? " radio-card-selected" : ""}`}
        >
          <input
            type="radio"
            name="visibility"
            checked={value === option.key}
            onChange={() => onChange(option.key)}
          />
          <span className="radio-card-text">
            <span className="radio-card-title">
              {option.title}
              {value === option.key ? (
                <span className="muted"> · selected</span>
              ) : null}
            </span>
            <span className="radio-card-detail">{option.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
