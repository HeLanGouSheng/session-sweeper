export type ProviderId = 'claude' | 'codex';

/**
 * Why a conversation cannot be deleted right now.
 * - `process`: a running Claude Code process has it open
 * - `lock`: Codex holds its writer lock
 * - `recent`: its transcript was written to a moment ago
 */
export type BusyReason = 'process' | 'lock' | 'recent';

export interface SessionInfo {
  provider: ProviderId;
  /** Unique per row. Claude: `<project folder>/<id>`, Codex: the thread id. */
  key: string;
  id: string;
  title: string;
  /** Working folder the conversation belongs to, when it could be determined. */
  cwd?: string;
  /** Rows with the same group key are shown together. */
  groupKey: string;
  createdAt?: number;
  modifiedAt: number;
  /**
   * Disk space of the row's own data. Claude: the transcript plus its data folder
   * (sub-agent logs, tool results). Codex: the conversation and its helper threads.
   */
  sizeBytes: number;
  /** Claude: the data folder has not been measured yet, so `sizeBytes` only counts the transcript. */
  sizePending?: boolean;
  busy?: BusyReason;
  /** Files holding the conversation text, used for search and preview. */
  transcripts: string[];
  /** Claude: number of other project folders holding a copy of the same conversation. */
  otherCopies?: number;
  /** Codex: review / sub-agent threads that belong to this conversation. */
  helperCount?: number;
  /** Codex: lives under `archived_sessions`. */
  archived?: boolean;
}

export interface PlanItem {
  path: string;
  isDir: boolean;
  bytes: number;
  files: number;
}

export interface DeletionPlan {
  session: SessionInfo;
  /** Everything on disk that goes away with this conversation. */
  items: PlanItem[];
  /** Codex only: thread ids to hand to `codex delete`, the conversation itself first. */
  threadIds?: string[];
  totalBytes: number;
  totalFiles: number;
}

export interface Failure {
  target: string;
  message: string;
}

export type OutcomeStatus =
  /** Everything is gone and verification found nothing left. */
  | 'deleted'
  /** Some things were removed, some are still there. */
  | 'partial'
  /** Nothing was touched because the conversation is in use. */
  | 'busy'
  /** Nothing was touched for another reason (see `failures`). */
  | 'failed';

export interface DeletionOutcome {
  session: SessionInfo;
  status: OutcomeStatus;
  busy?: BusyReason;
  removed: number;
  failures: Failure[];
  /** Paths (or descriptions) that verification still found afterwards. */
  leftovers: string[];
}

/** Removes one file or folder. The UI supplies a Recycle Bin or a permanent implementation. */
export type Remover = (target: string, isDir: boolean) => Promise<void>;

export type LeftoverKind =
  /** Temp folders of conversations that no longer exist, containing no files at all. */
  | 'claude.emptyTemp'
  /** Temp folders of conversations that no longer exist, still holding files. */
  | 'claude.orphanTemp'
  /** File snapshots, environment and telemetry data of conversations that no longer exist. */
  | 'claude.orphanData'
  /** Codex review / sub-agent threads whose conversation no longer exists. */
  | 'codex.orphanThreads';

export interface LeftoverGroup {
  kind: LeftoverKind;
  items: PlanItem[];
  /** Codex only. */
  threadIds?: string[];
  totalBytes: number;
  totalFiles: number;
}

export interface CleanResult {
  removed: number;
  failures: Failure[];
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}
