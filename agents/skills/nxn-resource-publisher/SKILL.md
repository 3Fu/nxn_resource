---
name: nxn-resource-publisher
description: Add, replace, retire, validate, publish, or roll back public NXN resource-center files and catalogs in 3Fu/nxn_resource from an input file or directory. Use for requests that change NXN resource-center content or say to update it to the official website; do not use for unrelated website downloads.
---

# NXN Resource Publisher

Use this skill as the normal entrypoint for NXN resource-center changes. The user may provide only a file or directory and say "更新到官网"; inspect it, prepare the catalog update, show the planned change, and publish when the request authorizes publication.

Read [references/catalog-schema.md](references/catalog-schema.md) before changing catalog fields, preview rules, or release behavior. Read [references/resource-metadata.json](references/resource-metadata.json) when mapping an input filename to a resource ID or adding metadata. Read [references/network-recovery.md](references/network-recovery.md) when GitHub access is unstable or a proxy is required.

## Repository Contract

- Run commands from the resource repository root.
- `doc/` is the human-readable index area. Keep only `README.md` and `manifest.json` there; original resources are stored in GitHub Releases.
- Every original resource is uploaded to GitHub Releases and must not be copied into `doc/`.
- `docs/catalog.json`, `docs/catalogs/`, and `docs/previews/` are generated publication artifacts. Do not hand-edit them for an ordinary file update.
- Keep historical Releases, historical catalog files, and historical preview paths. Never delete them as part of a normal update.

## Consumer Downloads

Reception and processing agents should use the public catalog plus `resource-download.mjs`. The script downloads Release assets under their original Chinese filenames, verifies SHA-256, skips already-valid files, and returns local paths as JSON:

```powershell
node agents/skills/nxn-resource-publisher/scripts/resource-download.mjs --catalog-url https://3fu.github.io/nxn_resource/catalog.json --output "<cache-dir>" --all --json
```

Use each returned `resources[].path` for local processing. The Release `assetKey` remains URL-safe English for stable URLs; `downloadName` and the downloaded filename remain the original name.

For unstable GitHub connections, use `--retries`, `--concurrency 1`, `--stall-timeout`, and the proxy options documented in `references/network-recovery.md`; valid files are skipped on rerun.

## Standard Workflow

1. Resolve exactly one input file or directory. Recursively scan a directory, but do not infer retirement from files that are merely absent. Use `--retire <id[,id...]>` only when the user explicitly asks to remove an active resource.
2. Inspect the input content. For every new or replacement filename, add or reuse a stable entry in `references/resource-metadata.json`. Include `id`, `type`, `typeLabel`, `title`, `description`, `format`, and any needed `previewKind` or `previewSections`. Never change an existing resource ID to represent unrelated content.
3. For a new active resource, add its original filename to the `doc/README.md` index before preparing the release. A replacement under the same filename may reuse the existing entry and ID.
4. Run the no-write plan:

   ```powershell
   node agents/skills/nxn-resource-publisher/scripts/resource-sync.mjs plan --input "<file-or-directory>" [--retire "<id[,id...]>"]
   ```

5. Show the version transition, ADD/CHANGE/UNCHANGED/RETIRE items, Release distribution, README/metadata changes, and any sensitive or large files. An explicit "更新到官网" or equivalent request is publication authorization, but stop for a credential error, hash mismatch, missing required preview tool, duplicate ID, or an unexplained destructive change.
6. Prepare the candidate workspace. This does not change the repository catalog or manifest yet:

   ```powershell
   node agents/skills/nxn-resource-publisher/scripts/resource-sync.mjs prepare --input "<file-or-directory>" [--retire "<id[,id...]>"]
   ```

   Use the workspace path printed by the command, normally `agents/skills/nxn-resource-publisher/.work/<version>`.

7. Validate the candidate:

   ```powershell
   node agents/skills/nxn-resource-publisher/scripts/resource-center.mjs validate --workspace "<workspace>"
   ```

8. If validation succeeds and publication is authorized, publish and mirror the generated catalog, previews, and manifest back into the source repository:

   ```powershell
   node agents/skills/nxn-resource-publisher/scripts/resource-center.mjs publish --workspace "<workspace>" --root "<repository-root>"
   ```

   The script loads `.env` from the skill directory when process variables are absent. Never print, copy, or pass the token on the command line.

9. Verify the published catalog and Release assets before claiming success:

   ```powershell
   node agents/skills/nxn-resource-publisher/scripts/resource-center.mjs verify-remote --workspace "<workspace>" --assets true
   ```

   This compares the workspace catalog with the public Pages catalog and probes every published original, public preview, cover, and bundle URL.

10. Report the catalog version, tag, changed resource IDs, catalog URL, and any Release assets that were skipped because they were already present.

## Rules and Recovery

- A no-op plan must stop without preparing or publishing.
- An explicit replacement uses the same stable ID and asset key unless a new resource is genuinely intended.
- A same-version retry is allowed only to finish a partial publish and only when the existing Release assets match. Duplicate releases or a second failed retry must stop and be reported.
- If publication succeeded but local mirroring failed, rerun `publish --workspace <workspace> --root <root> --allow-same-version true` after correcting the local issue.
- Roll back only the current catalog pointer with `rollback --version <catalog-version>`. This does not delete Releases or previews.
