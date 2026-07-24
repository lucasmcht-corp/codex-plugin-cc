export type ProcessIdentity = {
  pid: number;
  startKey: string;
  processGroupId?: number | null;
};

export type PosixOwnedWorker = {
  version: 1;
  pid: number;
  token: string;
  startKey: string;
  platform: "linux";
  processGroupId: number;
};

export type WindowsOwnedWorker = {
  version: 2;
  pid: number;
  token: string;
  startKey: string;
  platform: "win32";
  processGroupId: null;
  jobName: string;
};

export type OwnedWorker = PosixOwnedWorker | WindowsOwnedWorker;

export type SteeringDescriptor = {
  version: 1;
  kind: "unix" | "pipe";
  address: string;
  worker: OwnedWorker;
  threadId: string;
  turnId: string;
};

export type SessionEnding = {
  sessionId: string;
  endedAt: string;
  token?: string;
  markerFile?: string;
};

export type JobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type JobRecord = {
  id: string;
  status: JobStatus;
  jobClass?: string;
  kind?: string;
  title?: string;
  summary?: string;
  workspaceRoot?: string;
  sessionId?: string | null;
  singletonKey?: string | null;
  launchToken?: string | null;
  launcher?: ProcessIdentity | null;
  worker?: OwnedWorker | null;
  steering?: SteeringDescriptor | null;
  threadId?: string | null;
  turnId?: string | null;
  logFile?: string | null;
  phase?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
  errorMessage?: string | null;
  kindLabel?: string;
  write?: boolean;
  progressPreview?: string[];
  elapsed?: string | null;
  duration?: string | null;
  rendered?: string | null;
  result?: unknown;
  cancellation?: { token?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
};

export type PluginConfig = {
  stopReviewGate: boolean;
  [key: string]: unknown;
};

export type PersistedState = {
  version: number;
  revision: number;
  config: PluginConfig;
  endedSessions: SessionEnding[];
  retiredLegacyJobIds: string[];
  jobs: JobRecord[];
};

export type StoredState = {
  version: number;
  revision?: number;
  config?: Partial<PluginConfig>;
  endedSessions?: SessionEnding[];
  retiredLegacyJobIds?: string[];
  jobs: JobRecord[];
};

export type SteeringRequest = {
  version: 1;
  requestId: string;
  jobId: string;
  worker: OwnedWorker;
  threadId: string;
  turnId: string;
  instruction: string;
};

export type SteeringResponse =
  | {
      ok: true;
      requestId: string;
      jobId: string;
      threadId: string;
      turnId: string;
    }
  | {
      ok: false;
      requestId: string | null;
      error: {
        message: string;
        delivery: "rejected" | "unknown";
      };
    };
