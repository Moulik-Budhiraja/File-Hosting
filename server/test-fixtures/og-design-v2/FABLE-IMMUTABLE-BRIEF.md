# File-Hosting OG/Social Cards V2 — Immutable Exact-Fable Brief

Status: READY, BLOCKED ONLY ON EXISTING CLAUDE OAUTH APPROVAL
Design model: exact `claude-fable-5`; no fallback
Canvas: Paper via the existing strict MCP configuration at `../paper-mcp.json`
Scope: DESIGN ONLY. Stop at user approval.
Reference: `/Users/admin/.hermes/cache/images/img_f412a43bb43b.png`
Output root: `/Users/admin/Library/Caches/Hermes/Scratch/20260803-file-hosting-design-review/og-cards-v2/`

## Absolute boundary

Create the corrected Paper design review for the generated 1200×630 OG/social image itself and its appearance in iMessage. This replaces the rejected historical direction that showed destination-page UI.

Do not write or modify product code. Do not commit, push, update issues or PRs, merge, deploy, or launch coding/audit sessions. Do not create an HTML mockup. Do not substitute another model or design tool. Paper mutations and review exports under the output root are the only allowed writes.

Before any Paper mutation, a zero-mutation structured probe must prove all of the following:

1. Claude authentication is valid.
2. `modelUsage` proves exact `claude-fable-5` with nonzero input/output tokens.
3. Paper MCP tools are available through `../paper-mcp.json` under strict MCP configuration.
4. No fallback model ran.

If any gate fails, stop without touching Paper.

## Source-grounded product contract

Read-only source inspected at Git commit `70aa6365893d5106badaa2474f5859aed266c278` in:
`/Users/admin/Library/Caches/Hermes/Scratch/20260803-file-hosting-design-review/source`

GitHub issue #10 was inspected read-only. The live service stores filename, size, MIME type, visibility, owner, tags, SHA-256, archive type, timestamps, preview URL, and raw URL. Filename validation permits up to 255 UTF-8 bytes and permits Unicode/emoji while rejecting separators and controls. The service currently recognizes these preview families:

1. Markdown: `text/markdown`, `text/x-markdown`, and `.md`, `.markdown`, `.mdown`, `.mkd`.
2. Text/code/data: `text/*`, `application/json`, `application/xml`, `*+json`, `*+xml`, plus SVG on the existing safe text-preview path.
3. Raster/image: `image/*` outside the SVG text-path behavior.
4. Audio: `audio/*`.
5. Video: `video/*`.
6. PDF: `application/pdf`.
7. Archive: explicit archive metadata supports only `tar.gz` for CLI-created directory archives.
8. Generic binary/unknown: everything else.

Anonymous social crawlers may see only public resources. Protected, private, unauthorized, missing, and unavailable states must be privacy-indistinguishable.

The visual review may demonstrate derived artwork/posters/pages/waveforms as target behavior, but must also show extraction/no-thumbnail failure fallbacks and must not imply that unsupported derivation already exists. Do not include implementation or rollout copy in recipient-facing cards.

## Reference anatomy to adopt, without copying branding or artwork

The iMessage reference shows the right preview hierarchy:

- A large, editorial 1200×630-style artwork region dominates the shared preview.
- The recipient sees visual content first; title and source domain follow in a compact metadata region.
- The title is large, high contrast, and allowed to wrap to two lines.
- The domain is quieter and sits directly below the title.
- The combined image + metadata preview reads as one object with native outer corner treatment and message-tail behavior in context.
- The metadata surface remains legible against a dark chat background; the same generated OG pixels must also survive light recipient surfaces.

Use this as a quality and behavior benchmark only. Do not copy Luma marks, typography, palette, RSVP affordance, robot artwork, or event-card composition.

## Design thesis

The uploaded file/content is the visual hero. File-Hosting identity is restrained support, never the subject.

- Exact raw card size: 1200×630.
- Establish a conservative central safe area and show explicit mobile/crop stress overlays on review-only frames, not in exported OG pixels.
- Dense, dark, editorial, terse, and premium.
- Near-black/charcoal foundation; one restrained identity accent; semantic colors only where meaningful.
- Strong title hierarchy; filename/title may wrap to two lines and then truncate gracefully.
- Domain: `files.moulik.dev`, restrained and always readable.
- Metadata only when useful: humanized type, size, and duration where applicable.
- No owner, tags, hash, file ID, locator/path, visibility narration, uploader identity, or operational metadata.
- No controls, mini dashboards, admin chrome, tables, status rails, rollout notes, implementation details, card grids, decorative gradients, glassmorphism, pill soup, oversized AI rounding, huge whitespace, or generic icon-only treatment.
- Natural tonal variation inside uploaded media is allowed; decorative UI gradients are forbidden.
- The raw OG card must work when rendered on both light and dark host surfaces.

## Required Paper document and pages

Create a new Paper document named exactly:
`File-Hosting · OG Social Cards V2 · 2026-08-03`

Use clearly named pages:

1. `00 · Brief & Reference Anatomy`
2. `01 · Raw OG · 1200×630`
3. `02 · iMessage Context · Dark & Light`
4. `03 · Stress · Crop, Unicode, Long Content`
5. `04 · Privacy & Fallback Contract`

Do not clear or modify the existing Admin Dashboard or Identity & Access documents.

## Required raw 1200×630 frames

Create at least these exact top-level frames on `01 · Raw OG · 1200×630`:

- `OG2-RAW-01 · Image · Landscape Hero · 1200×630`
- `OG2-RAW-02 · Image · Portrait Safe Crop · 1200×630`
- `OG2-RAW-03 · Video · Poster + Restrained Play · 1200×630`
- `OG2-RAW-04 · Video · No Poster Fallback · 1200×630`
- `OG2-RAW-05 · PDF · First Page Hero · 1200×630`
- `OG2-RAW-06 · Document · First Page / Title · 1200×630`
- `OG2-RAW-07 · Markdown · Content-Led · 1200×630`
- `OG2-RAW-08 · Code/Text · Readable Excerpt · 1200×630`
- `OG2-RAW-09 · Audio · Artwork + Duration · 1200×630`
- `OG2-RAW-10 · Audio · Waveform Fallback · 1200×630`
- `OG2-RAW-11 · Archive · tar.gz · 1200×630`
- `OG2-RAW-12 · Generic Binary · Premium Fallback · 1200×630`
- `OG2-RAW-13 · Unavailable · Privacy Safe · 1200×630`

Family rules:

### Image/photo
Use the uploaded image as the dominant hero. Show both landscape and portrait source behavior. Use deliberate cover/crop and safe-area treatment, with only a quiet filename/domain support layer when needed. Do not shrink the image into a thumbnail beside generic UI.

### Video
Use a poster/extracted frame as the hero when available. The play cue must be restrained and unmistakable, not a large glossy control. Include concise duration and useful format/type metadata. Also show a premium no-poster fallback.

### PDF/document
Use a recognizable first-page/document visual as the hero. Preserve page character while keeping title and concise type/size metadata legible. Do not reduce the file to a PDF icon.

### Markdown/text/code
Use readable content-led treatment: document structure, heading rhythm, or restrained syntax/code layout. Keep the excerpt visually meaningful while making it obvious this is a shared file. Do not use a generic icon. Avoid any dangerous/private sample content.

### Audio
Use artwork when available. Otherwise use an elegant, information-bearing waveform/type composition with duration. Do not imitate a player UI and do not include transport controls.

### Archive
Do not pretend contents can be previewed. Use filename, `tar.gz`, and size as the information hierarchy. The composition must still feel intentional and premium without a giant generic archive icon.

### Generic binary/unknown
Create an intentional fallback using restrained identity, filename, humanized/known MIME when safe, and size. It must not look like an error state.

### Private/missing/unavailable
Use one generic privacy-safe treatment that is visually and textually identical for private, protected, unauthorized, missing, expired, and unavailable resources. It must reveal no original filename, title, locator, ID, type, size, image, excerpt, tags, owner, or existence. Allowed copy is limited to generic File-Hosting identity/domain plus a terse neutral message such as `File unavailable`.

## Required iMessage context frames

On `02 · iMessage Context · Dark & Light`, create realistic recipient-side compositions for every raw family. Each composition must show:

- the full visual preview behavior with the generated card dominating;
- a clear title and `files.moulik.dev` below the image in an iMessage-style metadata area;
- realistic outer radius/tail and chat-surface spacing;
- both dark and light host-surface checks where contrast materially differs;
- no app chrome, contact identity, real messages, personal data, or copied Luma artwork.

Name each context frame with the matching raw number:
`OG2-IM-01` through `OG2-IM-13`.

The iMessage composition is review context, not part of the 1200×630 image export. The raw export must contain only the generated OG pixels.

## Required stress frames

On `03 · Stress · Crop, Unicode, Long Content`, create:

- `OG2-STRESS-01 · 255-byte Long Filename · Two-Line Clamp`
- `OG2-STRESS-02 · Unicode + Emoji · 研究データ📡-résumé-Δ.md`
- `OG2-STRESS-03 · Portrait Media · Safe Area`
- `OG2-STRESS-04 · Extreme Landscape · Safe Area`
- `OG2-STRESS-05 · No Thumbnail · Image/Video/Document`
- `OG2-STRESS-06 · Mobile Center Crop · Safe-Area Overlay`
- `OG2-STRESS-07 · Light/Dark Recipient Surfaces`

Review-only safe-area overlays must be visibly labeled and excluded from clean raw exports.

## Privacy/fallback contract board

On `04 · Privacy & Fallback Contract`, show a comparison proving that private, protected, unauthorized, missing, and unavailable inputs produce the exact same public card. Also show the no-thumbnail fallback decision by family. Keep this board terse and visual; no implementation architecture or rollout prose.

## Exports

Export clean PNGs into this directory:
`/Users/admin/Library/Caches/Hermes/Scratch/20260803-file-hosting-design-review/og-cards-v2/`

Required naming:

- Raw cards: `raw-01-image-landscape.png` through `raw-13-unavailable.png`
- iMessage contexts: `imessage-01-image-landscape.png` through `imessage-13-unavailable.png`
- Stress boards: `stress-01-long-filename.png` through `stress-07-light-dark.png`
- `contact-sheet.png`
- `File-Hosting-OG-Social-Cards-V2-Review.pdf` if Paper supports combined PDF export; otherwise record the exact limitation.

Every raw export must be exactly 1200×630 pixels. Context and review-board exports may be larger.

## Verification and freeze evidence

Before reporting completion:

1. Inspect the final Paper tree.
2. Record exact document ID/link, page IDs/names, every required top-level frame ID/name/bounds, and export path.
3. Inspect every exported PNG's actual pixel dimensions and visible pixels.
4. Verify titles, Unicode, type labels, duration labels, size labels, and domain spelling.
5. Verify no clipping, overlap, accidental controls, mini-dashboard UI, stale historical dashboard screenshot, copied Luma branding/artwork, personal content, secrets, or privacy leaks.
6. Confirm the privacy-safe unavailable variants are identical where required.
7. Run an anti-slop audit: wrong-surface, card-grid, pill-heavy, decorative-gradient, mini-dashboard, generic-icon-only, and excess-whitespace scores must all be zero.
8. Freeze/version the document if Paper supports it. Otherwise record the exact document/page/frame IDs and a UTC freeze timestamp plus export checksums.
9. Re-check the source checkout remains clean at the original commit.
10. Stop and ask for explicit user approval. Do not implement.

## Final report contract

Return only grounded evidence:

- exact Fable model proof;
- Paper document link/ID;
- page and frame inventory with exact identifiers/bounds;
- UTC freeze timestamp/version;
- exported absolute paths and pixel dimensions;
- contact sheet and PDF path/limitation;
- concise visual recommendation;
- explicit statement that no product code changed and no implementation activity occurred;
- one approval request.
