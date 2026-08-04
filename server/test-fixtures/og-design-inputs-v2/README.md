# OG design input fixtures

These files are immutable synthetic inputs for `server/scripts/design-audit.ts`; they are not approved output baselines. The audit displays uploaded byte size in the card facts line, so generating facts-bearing inputs at audit time made approved pixels depend on host native encoders.

They were generated once with the pre-fix `independentRaster` implementation and Sharp 0.35.3. The landscape PNG intermediates were then encoded as JPEG at quality 90, matching the pre-fix audit path.

- `source-01-image-landscape.jpg`: 1600×900, `#d9a14c`, 24,325 bytes, SHA-256 `ab6ba96e46a1367fc36757df43ca5e447eba651e2d4d9c186921de5c14efd02d`
- `source-01-image-landscape-mutation.jpg`: 1600×900, `#5f9de8`, 23,434 bytes, SHA-256 `28983842de8c3945c2cbe0ceeb1713aea36775ea42b031bd23a3d8b85793c6ca`
- `source-02-image-portrait.png`: 900×1600, `#d9a14c`, 51,357 bytes, SHA-256 `404b086471792815896989ea70fe422f2bab76714af5b5bbcd65c311548cd90b`
- `source-02-image-portrait-mutation.png`: 900×1600, `#78c68a`, 51,328 bytes, SHA-256 `1300e303fb18c6625690f96ac1c117599dcc607a0a9e48b1e008468a1d7e5955`

`tests/release-graph.test.mjs` pins every size and digest. Do not regenerate these inputs from CI output or use generated card output as an input.
