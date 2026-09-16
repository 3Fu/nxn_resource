---
name: nxn-resource-publisher
description: Validate, publish, update, retire, or roll back public NXN 资料中心 files and catalogs in 3Fu/nxn_resource. Use for requests that change NXN 官网资料中心 content or download mirrors; do not use for unrelated website downloads.
---

# NXN Resource Publisher

Manage the public resource catalog without redeploying `nxnos.com`. Read [references/catalog-schema.md](references/catalog-schema.md) before changing catalog fields or preparing a release.

Use `scripts/resource-center.mjs`; do not reimplement hashing, bundle creation, GitHub upload, or rollback logic. Run it from the NXN website repository. A resource workspace contains `docs/catalog.json`, `assets/`, and `docs/previews/`.

## Workflow

1. For the initial migration, run `stage-initial --workspace <temporary-directory> --website-root <website-repository>`. It copies originals and preview sources and uses `ffmpeg` for the web video.
2. For later changes, edit `<workspace>/docs/catalog.json`, place every active original at `<workspace>/assets/<assetKey>`, and place previews at the Pages paths declared by the catalog.
3. Run `validate --workspace <directory>`. Resolve every error; never weaken hash, host, size, path-safety, or duplicate-ID checks to force a release.
4. Before `publish`, show the user the target `3Fu/nxn_resource`, catalog version, added/changed/retired IDs, and that the public catalog will change. An explicit request to publish is sufficient authorization.
5. Run `publish --workspace <directory>`. The script loads `agents/skills/nxn-resource-publisher/.env` when process environment variables are absent; never echo, store, or pass the token on the command line. It requires a catalog version newer than the currently published version.
6. Report the published tag and catalog URL. Keep historical releases and assets.

To retire a resource, remove it from the next catalog and publish a new version. Do not delete its old Release. Mirror-only changes update `sources`, validate, and publish without replacing originals.

For rollback, first identify `docs/catalogs/<catalogVersion>.json`, summarize the version transition, then run `rollback --version <catalogVersion>`. Rollback changes only the current catalog pointer.

## Authorization and stopping conditions

- The fine-grained PAT must be scoped only to `3Fu/nxn_resource`, with Metadata read and Contents read/write. Pages read/write is needed only for first-time Pages setup.
- Stop before publishing if the token is absent, the repository is not public, an asset hash differs, a preview is missing, or the video preview is at least 95 MiB.
- A failed publish may be retried once with the same version. The script finds the existing authenticated draft and skips same-sized uploaded assets. If duplicate releases exist for a tag, or the failure repeats, stop and report it instead of looping.
- Never delete a Release or historical asset unless the user explicitly requests that separate destructive action.
- Keep `.env` and `.work/` local and ignored; never commit either directory. Preview files are committed through the Git Database API so large browser previews do not exceed the Contents API limit.
