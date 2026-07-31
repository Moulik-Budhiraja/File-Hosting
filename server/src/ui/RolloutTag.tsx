// Issue #6 requires every new identity/access surface to carry a rollout
// label until the backend (PR #7) merges. This is the single home of that
// label — delete this component's usage sites in one follow-up when PR #7
// lands.
export function RolloutTag() {
  return (
    <span className="rollout-tag" title="Backend ships in PR #7">
      PROPOSED · BACKEND IN PR #7
    </span>
  );
}
