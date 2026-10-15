# Final review: natural-demand skill nodes

## Scope and evidence

Read-only review of the current implementation against `2026-10-02-skill-demand-node.md` (including Global Constraints) and `../specs/2026-10-02-skill-node-design.md`, following the code-reviewer template. Reviewed execution planning, resource admission, matching/cache logic, both adapters, IPC, actual-input panel and canvas integration. No commits, real API calls, keys or user project data were accessed. This report is the only reviewer write.

Accepted supplied evidence: 136/136 related Node tests passed; the isolated actual-plugin canvas check passed import, ports, dragging, stale/live feedback, lazy input loading and scrolling. Unchanged tests were not rerun. Findings below are from direct current-code inspection, not claimed additional runtime reproductions. Root's concurrent title/gallery sizing adjustments need their final verification separately.

## Strengths

- Candidate construction excludes skill bodies and image paths. Matching uses current receiver demand, validates connected IDs and literal demand evidence, preserves candidate order and fails closed.
- Planning removes skill output edges before traversal and adds selected dependencies iteratively. Dormant exclusive sources stay outside the execution order, while ordinary shared dependencies remain reachable.
- The execution cache includes candidate metadata/version, selection order, selected full text and image content signatures. Unselected body changes are excluded. Selected full text is rebuilt rather than taken from the clamped skill summary.
- Both adapters validate shared image payloads before sending. Text preserves the one-argument empty-image path; image editing uses actual Blob bytes and repeated multipart `image` fields without a manual multipart header. Generation settings, timeout and no-retry behavior remain intact.
- UI distinguishes stale matching from current matching and labels the existing actual-input panel as historical. Its lazy read and revision guard avoid eager loading and stale async completion.

## Issues

### Critical

None found in the inspected scope.

### Important

1. **Combined actual input is unavailable before generation, and unavailable after a failed submission.** `electron/drama/lib/core.js:575` invokes the adapter before building/persisting `skillInput` at lines 583–599. `plugins/drama/skill-panel.js:27` renders only that historical snapshot; `plugins/drama/index.js:775` explicitly limits the earlier preview to ordinary inputs. Consequently the specification's pre-run preview of enabled complete skill text and reference images is absent. On adapter failure, the run is replaced with a failure record without the input snapshot, so the user cannot inspect what the failed request attempted to send. Build and persist the admitted input snapshot before invoking the adapter, emit it to the UI at the prepared-input stage, and retain it on failure. This is a spec-compliance gap; the existing historical label itself is accurate.

2. **Valid combined skill input can be permanently unreadable in the full-input panel.** `electron/drama/lib/core.js:589` saves the entire combined input without a 2 MB bound, but `electron/drama/drama-ipc.js:318` rejects every output/input file above 2 MB. Two valid generated text sources of approximately 1.1 MB each can therefore be sent successfully and stored, while expanding the resulting input panel always fails. Even one source at the permitted generated-output maximum crosses the limit once prompt/section labels are added. Give input snapshots an explicit independent read/size policy that supports valid combined inputs, or enforce and clearly report a matching input limit before submitting; never silently truncate. Add a focused case covering a combined snapshot exceeding the individual generated-output limit.

### Minor

1. **Reference count in the actual-input record differs from the submitted payload when skills share a reference.** `electron/drama/lib/core.js:511` concatenates each selected bundle's image list, whereas line 591 deduplicates filenames for the historical snapshot. Connecting one image source to two selected skills sends two identical image blocks but shows only one, and repeated shared sources can consume the four-image limit despite fewer distinct references. Prefer deduplicating by the project filename before shared admission and adapter dispatch, keeping the persisted ordered file list aligned with the actual payload; alternatively preserve multiplicity in the record if duplication is intentional. Add a shared-reference case.

## Adapter verdict

Both adapters pass the inspected implementation requirements and code-quality review. No adapter-specific blocking defect found. Existing adapter tests inspect exact multipart fields and bytes and text-runtime arguments. The real ACP subprocess test in `tests/drama-text-generator.test.js` exercises text only; the newly added image-forwarding test uses a stub runtime. A focused offline image-through-ACP fixture would strengthen the stated end-to-end evidence, but is not a demonstrated transport defect. No live-provider compatibility claim is made.

## Whole-feature assessment

**Ready to merge: With fixes.** Dormant-source isolation, matching cache and payload transport are well structured and backed by the supplied regression/UI evidence. The prepared-input lifecycle and combined-input reader limit should be corrected before calling the complete specification satisfied; shared-reference deduplication is a smaller integrity improvement. Preserve the current dirty checkout and avoid rerunning the entire unchanged suite merely for this report; verify the targeted fixes and then the relevant integration check.
