# Publication Checklist

This package intentionally contains no `.git` directory and does not create a repository.

Before publishing:

- [ ] Choose a license and add the corresponding `LICENSE` file.
- [ ] Replace `UNLICENSED` in `package.json` and `.codex-plugin/plugin.json` with the selected license identifier.
- [ ] Confirm the author/developer name in `.codex-plugin/plugin.json`.
- [ ] Add the repository URL and issue tracker once they exist.
- [ ] Run `npm run check` on Windows and Linux.
- [ ] Run the live `npm run test:integration` test against Neo4j on Windows and Linux.
- [ ] Run both operating-system installers from a clean extracted archive.
- [ ] Confirm neither installer overwrites unrelated personal marketplace entries.
- [ ] Review `AGENTS.md.snippet` and both bundled skills for public wording.
- [ ] Regenerate `CHECKSUMS.txt` and the release archive checksum after the final changes.
- [ ] Tag the release with the same version used in `package.json`, `.codex-plugin/plugin.json`, and `server/index.mjs`.
