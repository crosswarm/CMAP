# Errors

## [ERR-20260805-001] codegraph_context

**Logged**: 2026-08-05T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
CodeGraph lookup was unavailable because the CMAP repository has not been initialized for CodeGraph.

### Error
```
Error: Tool execution failed: CodeGraph not initialized in /Users/cfone/Studio/CMAP. Run 'codegraph init' in that project first.
```

### Context
- Attempted a read-only architecture lookup for the WebUI design task.
- Continued with bounded source inspection instead of creating new index state.

### Suggested Fix
Initialize CodeGraph only when the repository team wants the index as local tooling state; otherwise retain the targeted source-read fallback.

### Metadata
- Reproducible: yes
- Related Files: docs/design/webui-brief.md

---

## [ERR-20260806-003] imagegen_prompt_template_literal

**Logged**: 2026-08-06T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: config

### Summary
An ImageGen orchestration script failed before generation because Markdown backticks inside a JavaScript template literal were not escaped.

### Error
```
SyntaxError: Unexpected identifier 'TaskEnvelope'
```

### Context
- The prompt used backticks around schema names inside a backtick-delimited JavaScript string.
- No image generation call was made and no project asset was changed.

### Suggested Fix
Use plain quotes or unformatted schema names inside JavaScript template-literal prompts.

### Metadata
- Reproducible: yes
- Related Files: design/prototype/chronicle-workspace.png

### Resolution
- **Resolved**: 2026-08-06T00:00:00+08:00
- **Notes**: Removed conflicting Markdown backticks and retried the same bounded generation.

---

## [ERR-20260806-002] github_publish_auth

**Logged**: 2026-08-06T00:00:00+08:00
**Priority**: high
**Status**: pending
**Area**: config

### Summary
GitHub CLI authentication is invalid, while SSH authentication succeeds but the requested `crosswarm/CMAP` repository is not currently accessible or present.

### Error
```
The token in default is invalid.
ERROR: Repository not found.
fatal: Could not read from remote repository.
```

### Context
- `gh auth status` failed for account `crosswarm`.
- `ssh -T git@github.com` authenticated successfully as `crosswarm`.
- `git ls-remote git@github.com:crosswarm/CMAP.git` reported repository not found.

### Suggested Fix
Re-authenticate `gh` with repository creation/write scope, then create or confirm `crosswarm/CMAP` before pushing.

### Metadata
- Reproducible: yes
- Related Files: design/prototype

---
