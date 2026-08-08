export const DERIVATIVE_REVISION = "image-derivatives-v1" as const;

export const DERIVATIVE_PROFILES = Object.freeze({
  thumbnail: Object.freeze({
    maxWidth: 320,
    quality: 78,
    maxBytes: 256 * 1024,
  }),
  small: Object.freeze({ maxWidth: 768, quality: 82, maxBytes: 1024 * 1024 }),
  standard: Object.freeze({
    maxWidth: 1920,
    quality: 88,
    maxBytes: 2 * 1024 * 1024,
  }),
});

export type DerivativeProfileName = keyof typeof DERIVATIVE_PROFILES;
export const DERIVATIVE_PROFILE_NAMES = Object.freeze(
  Object.keys(DERIVATIVE_PROFILES) as DerivativeProfileName[],
);
