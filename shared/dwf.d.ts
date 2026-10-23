/**
 * Type declarations for ZCode dynamic workflow DSL (.dwf.ts)
 */

declare interface ModelRef {
  readonly __brand: "ModelRef";
  id?: string;
}

declare interface AgentOptions {
  system?: string;
  model?: ModelRef;
}

declare interface AgentInstance {
  ask<T = any>(prompt: string): Promise<T>;
}

declare interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

declare interface WorldAPI {
  run(command: string, args: string[]): Promise<ProcessResult>;
}

declare interface ArtifactAPI {
  markdown(id: string, content: string, options?: { title?: string; description?: string; primary?: boolean }): Promise<void>;
  board(id: string, options: { title: string; key: string; status: string; columns: string[]; cardTitle: string }): Promise<void>;
}

declare function agent(name: string, options?: AgentOptions): AgentInstance;
declare function phase(name: string): void;
declare function model(id: string): ModelRef;
declare function report(data: any, channel?: string): void;
declare function log(message: string): void;

declare const args: Record<string, any>;
declare const world: WorldAPI;
declare const artifact: ArtifactAPI;
