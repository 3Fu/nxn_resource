# Catalog Contract

The public repository is `https://github.com/3Fu/nxn_resource`. GitHub Pages serves `main/docs`; original files and the complete ZIP are Release assets.

## Workspace Layout

`resource-sync.mjs prepare` creates the candidate workspace below the skill's `.work/` directory:

```text
workspace/
|-- assets/<assetKey>                 Active original files used for the release build
|-- doc/manifest.json                 Distribution and source-file mapping for root mirroring
`-- docs/
    |-- catalog.json                  Candidate/current catalog
    |-- catalogs/<version>.json       Candidate archive, updated with the bundle hash before publish
    `-- previews/<id>/<version>/...   Browser-safe preview files
```

The repository root contains the same `docs/` publication tree and `doc/` source tree. After a successful `publish --root <root>`, the script mirrors:

- `workspace/docs/catalog.json` to `root/docs/catalog.json`
- `workspace/docs/catalogs/<version>.json` to `root/docs/catalogs/<version>.json`
- `workspace/docs/previews/**` to `root/docs/previews/**`
- `workspace/doc/manifest.json` to `root/doc/manifest.json`
- only `distribution=git` originals from `doc/manifest.json` to `root/doc/<originalName>`

Release-only originals are intentionally absent from `root/doc/`. The mirror does not delete old preview files or historical source files.

## Top Level

- `schemaVersion`: integer `1`.
- `catalogVersion`: dot-separated numeric identifier. A new normal publish must be newer than the current online catalog.
- `updatedAt`: ISO-8601 UTC timestamp.
- `sources`: unique `id`, human `label`, HTTPS `prefix`, boolean `enabled`, and numeric `order`. Keep GitHub enabled with an empty prefix.
- `bundle`: `assetKey`, `title`, `size`, official GitHub Release `url`, and lowercase `sha256`. The bundle URL must target the current catalog version.
- `resources`: ordered website cards.

## Resource

Website fields are `id`, optional `version`, `type`, `typeLabel`, `title`, `description`, `format`, `size`, optional `duration`, `url`, `downloadUrl`, optional `coverUrl`, `downloadName`, `downloadLabel`, `previewKind`, and optional `previewSections`.

Publishing fields are `assetKey`, lowercase 64-character `sha256`, and ISO-8601 `updatedAt`.

- `id`: stable lowercase letters, digits, and hyphens; never reuse it for unrelated content.
- `type`: an extensible lowercase type token such as `ppt`, `poster`, `video`, or `document`.
- `previewKind`: an extensible lowercase token such as `pdf`, `image`, `video`, or `download`.
- `downloadName`: one URL-safe basename only; it must not contain `/`, `\`, `.` or `..` as a path.
- `downloadUrl`: `https://github.com/3Fu/nxn_resource/releases/download/<tag>/<assetKey>`.
- `url`: either an immutable Pages preview URL or a GitHub Release media URL for `video`/`download` previews.
- `previewSections`: plain text only; no HTML.

## URL History

A new resource points `downloadUrl` and its Release-backed `url` at the current tag. An unchanged original keeps its historical Release URL when metadata or display information changes. A page preview that is not rebuilt also keeps its historical immutable Pages URL. This is valid as long as the URL points to a real earlier-or-current `resources-<version>` tag and ends with the resource `assetKey`.

The bundle alone must always point to the current catalog version.

## Preview Requirements

- PPT: optimized PDF in `docs/previews`; `assetKey` names the PPTX.
- Image: browser-compatible image in `docs/previews`; the original remains in the Release.
- Video: never transcode or create a second video file. Use `previewKind: video` only for an H.264 MP4 that the browser can stream directly from the Release; point `url` and `downloadUrl` at the same Release asset. Use `previewKind: download` for HEVC, unsupported containers, or other browser-incompatible videos. Generate a cover image in `docs/previews` for either preview kind.
- DOCX or another download-only format: plain-text `previewSections` when available; the original remains in the Release.

The 95 MiB page-preview limit applies to files served from `docs/previews` (PDF and image previews), not to Release-backed videos.

All URLs use HTTPS and approved GitHub, GitHub Pages, jsDelivr, or configured mirror hosts. Chinese filenames are allowed for `downloadName`; keep `assetKey` URL-safe.

## Remote Verification

After publication, `resource-center.mjs verify-remote --workspace <workspace> --assets true` must confirm that the public Pages catalog is byte-equivalent after JSON parsing and that the bundle plus every referenced original returns a successful ranged request from GitHub Releases. A local tag or commit alone is not evidence that the public catalog and Release assets are complete.
