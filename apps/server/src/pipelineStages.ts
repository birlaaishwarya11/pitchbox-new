// Canonical definition of the pipeline's agent stages. Shared by the
// orchestrator (to drive execution + status) and surfaced to the client so the
// progress board and stage-selection panel stay in sync with the backend.

export type StageId = 'analyze' | 'plan' | 'research' | 'script' | 'flow' | 'record' | 'voiceover' | 'fuse';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StageDef {
  id: StageId;
  label: string;
  /** Which high-level task group this stage belongs to (for grouping on the board). */
  group: 'analyze' | 'script' | 'generate';
  /** Stages that must run before this one. The UI auto-selects dependencies. */
  dependsOn: StageId[];
  /** Optional stages can be toggled off; required ones always run. */
  optional: boolean;
}

// Order matters: this is the canonical left-to-right ordering on the board.
export const STAGE_DEFS: StageDef[] = [
  { id: 'analyze', label: 'Analyze project', group: 'analyze', dependsOn: [], optional: true },
  { id: 'plan', label: 'Plan', group: 'script', dependsOn: [], optional: false },
  { id: 'research', label: 'Research', group: 'script', dependsOn: ['plan'], optional: true },
  { id: 'script', label: 'Write script', group: 'script', dependsOn: ['plan'], optional: false },
  // Explores the target and proposes the flow to demonstrate, for the caller to
  // edit and approve before anything is recorded. Not optional when recording:
  // the whole point is that nobody finds out what the demo did afterwards.
  { id: 'flow', label: 'Plan the walkthrough', group: 'generate', dependsOn: ['script'], optional: true },
  { id: 'record', label: 'Screen recording', group: 'generate', dependsOn: [], optional: true },
  { id: 'voiceover', label: 'Voiceover', group: 'generate', dependsOn: ['script'], optional: false },
  { id: 'fuse', label: 'Assemble video', group: 'generate', dependsOn: ['voiceover'], optional: false },
];

export const STAGE_IDS: StageId[] = STAGE_DEFS.map((s) => s.id);

export function stageLabel(id: StageId): string {
  return STAGE_DEFS.find((s) => s.id === id)?.label ?? id;
}

/**
 * Resolve a user-selected stage set into the full set that will actually run:
 * required stages are always included, and dependencies of any selected stage
 * are pulled in transitively.
 */
export function resolveSelectedStages(selected: StageId[] | undefined): Set<StageId> {
  const result = new Set<StageId>();
  for (const def of STAGE_DEFS) {
    if (!def.optional) result.add(def.id);
  }
  if (selected) {
    for (const id of selected) result.add(id);
  } else {
    // Default: everything (optional legs included).
    for (const def of STAGE_DEFS) result.add(def.id);
  }
  // Pull in dependencies transitively.
  let changed = true;
  while (changed) {
    changed = false;
    for (const def of STAGE_DEFS) {
      if (result.has(def.id)) {
        for (const dep of def.dependsOn) {
          if (!result.has(dep)) {
            result.add(dep);
            changed = true;
          }
        }
      }
    }
  }
  return result;
}
