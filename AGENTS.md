# Resource Repository Instructions

This repository maintains the public NXN resource center. For any request that adds, replaces, retires, validates, publishes, or rolls back a resource, use the `nxn-resource-publisher` skill at `agents/skills/nxn-resource-publisher`.

- Start from the repository root and read `agents/skills/nxn-resource-publisher/SKILL.md`.
- Treat the user's "更新到官网" and equivalent wording as authorization to publish after the skill has prepared and summarized the planned change.
- Do not hand-edit generated `docs/catalog.json`, `docs/catalogs/`, or `docs/previews/` for a normal file update.
- Keep `doc/` as the index area containing only `README.md` and `manifest.json`; originals belong in GitHub Releases.
- Keep generated `docs/` as the GitHub Pages publication surface; never delete historical Releases, catalogs, or preview paths during a normal update.
- Never print or commit `agents/skills/nxn-resource-publisher/.env` or the ignored `.work/` directory.
- Stop and report anomalies such as missing credentials, hash mismatches, duplicate resource IDs, duplicate Releases, or unexplained deletions.
