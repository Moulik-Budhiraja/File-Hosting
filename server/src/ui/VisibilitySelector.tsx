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
      detail: "Anyone with the link",
    },
    {
      key: "protected",
      title: "protected",
      detail: "Anyone signed in",
    },
    {
      key: "private",
      title: "private",
      detail: `Only ${ownerPhrase} and admins`,
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
            <span className="radio-card-title">{option.title}</span>
            <span className="radio-card-detail">{option.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
