# Learnings

## [LRN-20260807-001] correction

**Logged**: 2026-08-07T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: docs

### Summary
CMAP generated design images belong under the repository `docs` tree, not under `.codex` or a root-level `design` directory.

### Details
The user corrected the asset location after images had been generated in `.codex/generated_images` and the first set had been committed under `design/prototype`.

### Suggested Action
Use `docs/design/prototype/` as the canonical location for every generated CMAP design image, verify all copies, then remove the corresponding `.codex` sources.

### Metadata
- Source: user_feedback
- Related Files: docs/design/prototype
- Tags: design-assets, repository-layout

### Resolution
- **Resolved**: 2026-08-07T00:00:00+08:00
- **Notes**: Relocated all six generated images and removed the `.codex` source copies after hash verification.

---
