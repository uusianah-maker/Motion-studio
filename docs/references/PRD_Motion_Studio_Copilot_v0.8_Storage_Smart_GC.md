# Motion Studio Copilot — PRD v0.8: Storage Architecture & Smart Garbage Collection
**Status:** Design decisions finalized for Smart GC, implementation NOT started. 27 Oktober 2026.
**Relationship:** Addendum to `PRD_Motion_Studio_Copilot_v0.6_Guardrails.md`; existing implementation sequence remains unchanged unless user explicitly approves replanning. This document does not declare T01 complete.

## A. Decisions already locked by user
- Desktop/hybrid, local-first storage; one workspace root with one directory per project.
- Every project has `01_INPUT`, `02_ASSETS`, `03_PROJECT`, `04_CACHE`, `05_OUTPUT`.
- Shared Media Library exists outside individual projects; projects reference shared media by media/version identifiers without copying.
- Input footage backed up **manually** by user, not automatically. Project autosave/backup configuration remains a **proposal**, not an explicitly approved setting.
- Referenced media versions, including versions referenced by archived projects and retained recovery snapshots, are immutable/protected; no silent replacement.
- **Newly imported footage never used in any timeline/project is protected from Auto Trash** until it has first become referenced. New imports are not candidates merely because 30 days pass.
- Auto Trash after **30 continuous days of unreferenced eligibility** for media versions that were previously referenced. Trash is recoverable.
- **FINAL DECISION — Permanent Delete Option A:** permanent deletion is **always manual**, **never scheduled or automatically triggered**, and requires explicit user confirmation plus a fresh dependency audit. There is **no enforced minimum waiting period in Trash** for manual purge; 30 days refers to Auto Trash eligibility, not a purge timer. Any version still referenced or protected remains undeletable.

## B. Scope & definitions
- **Media**: logical `media_id`; **version**: immutable `version_id` + content hash and physical path.
- **Ever referenced**: a version has been bound to a committed project/timeline or retained snapshot at least once (`ever_referenced=true`). Merely previewing, indexing, or importing DOES NOT qualify.
- **Current**: designated current media version and always protected (until explicitly replaced/retires under separate user decision).
- **Referenced**: any active, archived, retained snapshot/undo record, AI job or render job holds this exact `media_id + version_id`.
- **Eligibility start**: first timestamp when a previously referenced, non-current version loses *all* references and protection flags (`unreferenced_since`). Re-reference/protection resets this clock.
- **KEEP flag**: user-protected media/version, exempt until manually removed.
- **Auto Trash**: controlled reversible relocation into workspace Trash, with registry, manifest, checksum and original path; it is **not** permanent deletion and usually doesn't free disk space if on same volume.
- **Purge**: permanent delete requiring user approval and second dependency check. Never performed silently by AI, scheduler, or cache cleanup.

## C. Workspace model
```
MOTION_STUDIO/
  SHARED_MEDIA/            # referenceable shared media versions
  SHARED_ASSETS/           # logos, licensed audio, fonts, templates
  PROJECTS/<PROJECT_ID>/
    01_INPUT/              # unique footage for project
    02_ASSETS/
    03_PROJECT/            # project manifest and timeline
    04_CACHE/              # disposable local proxies / thumbnails
    05_OUTPUT/             # final and intermediate renders
  BACKUP_PROJECTS/         # project recoveries; separate-device copy recommended
  .motionstudio/           # registry, policies, dependency database, audit log
  .trash/                  # reversible trashed media with manifests
```
Paths in manifests are scoped relative paths or `shared://media_id/version_id`, never unchecked arbitrary paths. Canonicalize paths and validate containment including Windows junctions/symlinks. App editing uses read-only permissions for media; importer/GC operate via restricted storage service.

## D. Smart GC eligibility — all must pass (AND)
1. Version `ever_referenced=true`.
2. Not current version; not user KEEP / PIN / legal hold.
3. Reference count exactly zero across *active and archived projects*, retained history/snapshots, and queued/running render or AI jobs.
4. `unreferenced_since` exists and 30 full continuous days have elapsed; time reset on any new reference/protection.
5. File is online, hash/registry consistent, fully indexed; not undergoing import, relink, move or export.
6. Dependency index reconciled successfully against project manifests. Missing/corrupt/incomplete metadata => **fail closed**, no trash.
7. Not a newly imported never-used asset, even if aged.
8. Just before move, repeat dependency/hold checks under transaction/lock; move atomically on same filesystem if possible; update manifest/registry, maintain audit record.
9. Filename conflicts and path traversal checks pass. Files outside allowed workspace boundaries are never operated on.

### State transitions
`IMPORTING -> AVAILABLE_NEW_PROTECTED -> REFERENCED -> UNREFERENCED_WAIT_30D -> GC_ELIGIBLE -> TRASHED -> RESTORED | PURGED_MANUALLY`.
At any point versions can be `PROTECTED`, `MISSING`, `CHANGED`, `RETIRED`, `FAILED_AUDIT`; such states cannot bypass eligibility checks. Latest/current remains protected. Once a trashed version is restored, clear eligibility and re-evaluate only after a new eligible unreferenced period.

## E. GC scheduler & trash retention
- Candidate scan: on app launch and configurable background schedule **when app is running**; no promise of always-on work while app closed. Reconciliation scan also required before automatic relocation.
- Each auto move logged with media/version, old/new path, checksum, eligibility timestamp, dependencies checked, operation ID, and errors; never log API keys.
- Trash retention: **indefinite until user explicitly chooses Permanent Delete**. No time-based auto purge (30/90 days or otherwise). There is **no minimum residence period** before an eligible Trash item may be manually purged. Protection and approval checks always apply.
- The 30-day timer only governs **when eligible media enters Trash automatically**, not how long it must remain there.
- Disk-space warnings may recommend a manual review but must **never** trigger permanent deletion.
- Trash preserves media ID/version, path manifest, and dependency status. Auto Trash doesn't guarantee reclaimed space.
- User sees queue/history and notification; protect current active player/project via locks to avoid live file moves.

## F. Restore & manual purge
**Restore:** validate hash and manifest; recheck dependencies, ensure destination path within workspace; if destination taken, require user choice of safe alternate path; no overwrite by default; update registry and restore all existing media ID/version references; log. If file absent/corrupt, report failure rather than claiming success.
**Purge (manual only):** user opens Trash, selects media versions, and explicitly requests Permanent Delete. Show filename, size, media/version IDs, referenced projects, irreversibility, and backup verification status. Require a distinct final confirmation (not implied by ordinary cleanup approval). Run a **fresh, locked** dependency audit immediately before deletion; any reference, protected flag, unknown index, active job, or error => block. Never execute purge from AI prompts, automation, startup tasks, storage quota triggers, or GC scheduler. No minimum waiting period is imposed on user-initiated purge. Audit every attempt and outcome. Deletion policy must not depend only on UI flags.

## G. Disk quotas and backup
- Configurable soft quota for media, hard max for cache; warn on low free space; estimate import/render temp requirements before processing.
- Cache cleanup may be automated only for regenerable files not used by active jobs. Original media never treated as cache.
- Manual footage backup to another drive remains user's choice. App can record a manually selected backup location and *verify* hashes/manifest read-only; unverified backup must not be shown as completed.
- Project autosave/snapshots are still **design proposals** pending separate decision. Project backups and original footage backups are distinct.

## H. AI & rendering contracts
- Copilot can request GC audit/status, but cannot directly delete, override holds, or trigger purge. Storage service enforces decisions.
- Each render and AI batch uses an immutable `media_id/version_id/content_hash` dependency snapshot and acquires leases/locks. No automatic upgrade to newer footage versions.
- Missing/changed media causes explicit failure or relink proposal, not silent replacement.
- Render preflight checks availability, locked versions, destination write permissions, and sufficient disk. Output path is versioned and cannot overwrite finals without explicit approval.

## I. Acceptance tests for future implementation
- GC-01 New never-referenced media aged 60 days: remains protected, zero trash operations.
- GC-02 Old previously-referenced non-current version unreferenced for 29d23h: not moved.
- GC-03 Same version unreferenced for 30d and all gates pass: moved to Trash; registry and audit log accurate.
- GC-04 Referenced archived project or retained undo/snapshot: never moved.
- GC-05 Queued or active render lease: never moved; preflight remains stable.
- GC-06 Re-referenced on day 29: `unreferenced_since` reset; not moved on old schedule.
- GC-07 Missing/corrupt dependency database or incomplete scan: GC stops safely, log explains why.
- GC-08 Manual deletion: fresh locked dependency check and explicit approval; no auto purge.
- GC-09 Restore version with conflicting destination: no overwrites, safe relocation or explicit user choice.
- GC-10 Trash file on same disk: reported freed disk space = 0 (unless verified otherwise).
- GC-11 Replaced source bytes without version creation: changed-media alert, no silent timeline upgrade.
- GC-12 AI prompt 'delete old media': blocked from direct filesystem write or purge.

## J. Sequential implementation plan (not yet authorized to execute)
**Before work:** complete/resolve previously initiated T01 HTML v0.5 FIXED audit; capture baseline and determine PRD changes needed for transition from browser prototype to desktop/hybrid. No jumping to storage coding.

1. **ST-01** Workspace schema + path containment + permissions. Evidence: directory fixture and path traversal tests.
2. **ST-02** Media registry, stable IDs, immutable versions and metadata; test duplicate & changed-content behaviors.
3. **ST-03** Dependency index across active, archived, retained snapshots and job leases; test rebuild from manifests.
4. **ST-04** Eligibility state machine, protected-never-used rules, 30-day clock, KEEP/CURRENT flags; unit tests.
5. **ST-05** Candidate scan & conservative reconciliation (dry-run only); audit logs; cross-check eligible set against fixtures.

**CHECKPOINT AUDIT A (mandatory after ST-01..ST-05):** compare actual work with this PRD, run automated tests, inspect edge cases, log pass/fail. If any fail: repair and retest *before* ST-06. No commit until working tests and diff review pass.

6. **ST-06** Reversible Trash move and manifest writing with atomicity or safe fallback.
7. **ST-07** Restore behavior, conflict handling and integrity validation.
8. **ST-08** Explicit manual purge with second locked dependency audit and approval.
9. **ST-09** Scheduling, startup reconciliation, interruption/retry/idempotency.
10. **ST-10** Disk quota, recovery and audit dashboard integration with render preflight.

**CHECKPOINT AUDIT B (mandatory after ST-06..ST-10):** all GC acceptance tests, crash recovery, filesystem boundary security, capacity accounting, rerender integrity. Fix failures before sign-off; only then update implementation status.

## K. Work-tracking checklist / guardrails
- [ ] T01 baseline HTML audit — **not signed off**; do not skip.
- [x] Storage decisions collected in conversation — **design-only**, not implementation.
- [x] Smart GC behavior finalized — **design-only**, this addendum.
- [ ] Review/approve project autosave defaults (separate user decision).
- [ ] ST-01 [TODO]
- [ ] ST-02 [TODO]
- [ ] ST-03 [TODO]
- [ ] ST-04 [TODO]
- [ ] ST-05 [TODO]
- [ ] CHECKPOINT AUDIT A [TODO]
- [ ] ST-06 [TODO]
- [ ] ST-07 [TODO]
- [ ] ST-08 [TODO]
- [ ] ST-09 [TODO]
- [ ] ST-10 [TODO]
- [ ] CHECKPOINT AUDIT B [TODO]

For each task: plan and acceptance criteria first → implement one task → test → report result/defects → update PRD checklist. Never mark implementation DONE from UI mockups or paper design. Before any commit, inspect diff and tests; do not claim any git commit unless actually created and verified.

## L. Remaining decisions (not assumed approved)
- Autosave intervals/retention for project backups.
- No further decision needed on Trash purge cadence: **manual-only, no auto purge, no mandatory wait period** (approved).
- Cache budget, free-space reserve thresholds, GC scan frequency and backup verification UI.

## M. Decision log — v0.8
- **Approved:** Option A, Permanent Delete selalu manual, tidak ada Auto Purge.
- **Effect:** overrides any earlier suggestion to require 30 days in Trash before deletion.
- **Unchanged:** Auto Trash eligibility requires 30 days without dependencies; never-used media and all protected media remain excluded.
- **Implementation:** no code changes in this update; ST-01–ST-10 remain TODO, T01 not signed off.
- **Design acceptance checks:** (1) Trash item held 1 day can be manually purged only if fresh audit and explicit confirmation pass; (2) Trash item held 365 days is never auto-purged; (3) referenced/locked items cannot be manually purged; (4) AI prompt cannot trigger permanent deletion; (5) disk full never triggers purge.
