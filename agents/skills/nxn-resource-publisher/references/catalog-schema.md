# Catalog contract

The public repository is `https://github.com/3Fu/nxn_resource`. GitHub Pages serves `main/docs`; originals and the complete ZIP are Release assets.

## Workspace

```text
workspace/
|-- assets/<assetKey>                 Every active original file
`-- docs/
    |-- catalog.json                  Candidate/current catalog
    |-- catalogs/<version>.json       Written by publish
    `-- previews/<id>/<version>/...   Browser-safe preview files
```

Use `current` as the preview directory when a resource has no display version. Preview paths are immutable after publication.

## Top level

- `schemaVersion`: integer `1`.
- `catalogVersion`: dot-separated numeric identifier, unique and newer than the currently published version.
- `updatedAt`: ISO-8601 UTC timestamp.
- `sources`: unique `id`, human `label`, HTTPS `prefix`, boolean `enabled`, and numeric `order`. Keep GitHub enabled with an empty prefix.
- `bundle`: `assetKey`, `title`, `size`, official GitHub Release `url`, and lowercase `sha256`. Publishing recalculates bundle size and hash.
- `resources`: ordered website cards.

## Resource

Keep these website fields: `id`, optional `version`, `type`, `typeLabel`, `title`, `description`, `format`, `size`, optional `duration`, `url`, `downloadUrl`, optional `coverUrl`, `downloadName`, `downloadLabel`, `previewKind`, and optional `previewSections`.

Publishing fields are `assetKey`, lowercase 64-character `sha256`, and ISO-8601 `updatedAt`.

- `id`: stable lowercase letters, digits, and hyphens; never reuse an ID for unrelated content.
- `type`: `ppt`, `poster`, `video`, or `document`.
- `previewKind`: `pdf`, `image`, `video`, or `document`.
- Original URL: `https://github.com/3Fu/nxn_resource/releases/download/<tag>/<assetKey>`.
- Preview URL: `https://3fu.github.io/nxn_resource/previews/<id>/<version>/...`.
- `previewSections`: plain text only; no HTML.

## Preview requirements

- PPT: optimized PDF in `docs/previews`; `assetKey` names the PPTX.
- Image: browser-compatible image in `docs/previews`; original in the Release.
- Video: H.264/AAC MP4 with `faststart`, smaller than 95 MiB, plus a cover image; original in the Release.
- DOCX: plain-text `previewSections`; original in the Release.

All URLs use HTTPS and approved GitHub, GitHub Pages, jsDelivr, or configured mirror hosts. Chinese download names are allowed; keep `assetKey` URL-safe.
