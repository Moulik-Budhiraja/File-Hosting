const WORDS = [
  "anchor",
  "basalt",
  "canyon",
  "delta",
  "ember",
  "fjord",
  "garnet",
  "harbor",
  "island",
  "juniper",
  "kestrel",
  "lantern",
  "meadow",
  "nickel",
  "orchid",
  "pumice",
  "quartz",
  "ridge",
  "summit",
  "timber",
  "umbra",
  "violet",
  "walnut",
  "yonder",
];

function pick(values: Uint32Array, index: number, bound: number): number {
  return values[index]! % bound;
}

// Generates a shown-once temporary password: three words plus a two-digit
// suffix, always comfortably above the 12-character server minimum.
export function generateTempPassword(): string {
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  const words = [0, 1, 2].map(
    (index) => WORDS[pick(values, index, WORDS.length)],
  );
  const digits = String(pick(values, 3, 90) + 10);
  return `${words.join("-")}-${digits}`;
}
