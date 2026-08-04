# OG design input fixtures

These PNGs are immutable synthetic inputs for `server/scripts/design-audit.ts`; they are not approved output baselines. The audit displays uploaded byte size in the card facts line, so generating the inputs at audit time made approved pixels depend on the host libvips PNG encoder.

They were generated once with the pre-fix `independentRaster(900, 1600, color, true)` implementation and Sharp 0.35.3:

- `source-02-image-portrait.png`: `#d9a14c`, 51,357 bytes, SHA-256 `404b086471792815896989ea70fe422f2bab76714af5b5bbcd65c311548cd90b`
- `source-02-image-portrait-mutation.png`: `#78c68a`, 51,328 bytes, SHA-256 `1300e303fb18c6625690f96ac1c117599dcc607a0a9e48b1e008468a1d7e5955`

`tests/release-graph.test.mjs` pins both size and digest. Do not regenerate them from CI output or use generated card output as an input.
