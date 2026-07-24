import type {
  ClientInfo,
  InitializeCapabilities,
  InitializeParams,
  InitializeResponse,
  ServerNotification
} from "../../.generated/app-server-types/index.js";
import type {
  ExternalAgentConfigImportParams,
  ExternalAgentConfigImportResponse,
  ConfigReadParams,
  ConfigReadResponse,
  GetAccountParams,
  GetAccountResponse,
  ReviewStartParams,
  ReviewStartResponse,
  ReviewTarget,
  Thread,
  ThreadItem,
  ThreadListParams,
  ThreadListResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams as RawThreadResumeParams,
  ThreadResumeResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadStartParams as RawThreadStartParams,
  ThreadStartResponse,
  Turn,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnSteerParams,
  TurnSteerResponse,
  TurnStartParams,
  TurnStartResponse,
  UserInput
} from "../../.generated/app-server-types/v2/index.js";

export type {
  ClientInfo,
  ExternalAgentConfigImportParams,
  InitializeCapabilities,
  InitializeParams,
  InitializeResponse,
  ReviewTarget,
  Thread,
  ThreadItem,
  ThreadListParams,
  Turn,
  TurnInterruptParams,
  TurnSteerParams,
  TurnStartParams,
  UserInput
};

export type ThreadStartParams = Omit<RawThreadStartParams, "persistExtendedHistory">;
export type ThreadResumeParams = Omit<RawThreadResumeParams, "persistExtendedHistory">;

export type CodexAppServerClientOptions = {
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  capabilities?: InitializeCapabilities;
};

export type AppServerMethodMap = {
  initialize: { params: InitializeParams; result: InitializeResponse };
  "account/read": { params: GetAccountParams; result: GetAccountResponse };
  "config/read": { params: ConfigReadParams; result: ConfigReadResponse };
  "externalAgentConfig/import": { params: ExternalAgentConfigImportParams; result: ExternalAgentConfigImportResponse };
  "thread/start": { params: ThreadStartParams; result: ThreadStartResponse };
  "thread/resume": { params: ThreadResumeParams; result: ThreadResumeResponse };
  "thread/name/set": { params: ThreadSetNameParams; result: ThreadSetNameResponse };
  "thread/list": { params: ThreadListParams; result: ThreadListResponse };
  "thread/read": { params: ThreadReadParams; result: ThreadReadResponse };
  "review/start": { params: ReviewStartParams; result: ReviewStartResponse };
  "turn/start": { params: TurnStartParams; result: TurnStartResponse };
  "turn/steer": { params: TurnSteerParams; result: TurnSteerResponse };
  "turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResponse };
};

export type AppServerMethod = keyof AppServerMethodMap;
export type AppServerRequestParams<M extends AppServerMethod> = AppServerMethodMap[M]["params"];
export type AppServerResponse<M extends AppServerMethod> = AppServerMethodMap[M]["result"];
export type AppServerNotification = ServerNotification;
export type AppServerNotificationHandler = (message: AppServerNotification) => void;
