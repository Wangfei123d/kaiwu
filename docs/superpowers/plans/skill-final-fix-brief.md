# 技能节点最终审查修复任务

Read this first; this is the full fix contract. Work in E:/project/kaiwu, preserve dirty user work, no Git commits, no real API calls. Follow test-driven-development. Current relevant implementation plus reviewer evidence are docs/superpowers/plans/skill-final-review.md.

## Scope

Only edit electron/drama/lib/core.js, electron/drama/drama-ipc.js, plugins/drama/index.js, tests/drama-skill-execution.test.js, tests/drama-ipc.test.js, tools/check-skill-canvas.cjs. Write report docs/superpowers/plans/skill-final-fix-report.md. Root owns documentation and will not overlap these files during this fix.

## Fixes

1. Before selected-skill recipient adapter submission, persist the complete actual text and exact unique reference file list in outputs/ and graph.runs[nodeId].skillInput. This snapshot must remain on success AND failure, and become available while generation runs. Existing ordinary no-skill behavior stays unchanged. Emit a new optional onNodeInput callback carrying `{nodeId,run}` after persistence. Forward via existing scoped drama:runEvent with status `inputReady`; UI merges run into current graph and refreshes skill panel without cancelling running sweep or clearing previous image. Pre-run actual-input details must be able to load immediately, before generation resolves. File registration is required before reader can access it. Running and failed records must retain skillInput.

2. Combined selected input can exceed existing 2 MiB generated-text preview cap. Distinguish registered skillInput.file vs normal output file in reader. Define/export a shared core MAX_SKILL_INPUT_BYTES = 16 * 1024 * 1024. Reject combined actual input above this limit clearly BEFORE adapter submission (no truncation). Permit full registered skill-input snapshots up to same limit in readOutput while retaining existing 2 MiB normal-output cap and path guards. Include this limit in errors. Add tests for a >2 MiB combined full input that can be read and a >16 MiB selected input that never calls adapter.

3. Shared same project reference file connected via multiple selected skills must be sent once in stable first-occurrence order. Dedup file+image pairs across bundles before shared payload validation; actual snapshot image list must represent the exact sent file order. Continue including each selected skill's full text and per-skill fingerprints. Do not dedup different source files based on identical bytes.

## Tests and report

- Add failing behavior tests first for snapshot readable inside adapter callback, retained after adapter fails, scoped inputReady event, >2 MiB reader and >16 MiB refusal, and same reference repeated through multiple skills (four unique reference files, two skills) avoiding false image-count refusal.
- Extend isolation tools/check-skill-canvas.cjs fixture to emit inputReady while generation is pending and verify actual-input panel appears then. Existing import/ports/drag/stale/editable skill title/145px reference and >=88px generation gallery/scroll assertions must remain.
- Run node --test tests/drama-skill-execution.test.js tests/drama-ipc.test.js and node tools/check-skill-canvas.cjs after implementation; no unchanged adapter tests necessary.
- Shell currently requires exec_command require_escalated and explicit Set-Location E:/project/kaiwu; use apply_patch for edits. Full report must give commands, red then green results, files, concerns. Return concise summary and report path.
