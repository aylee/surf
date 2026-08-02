export class RpcTarget {}

export class WorkflowEntrypoint {}

export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const env: Record<string, unknown> = {};

export const exports: Record<string, unknown> = {};

export const tracing = undefined;
