declare module 'cloudflare:test' {
  export const env: {
    DB: D1Database;
    [key: string]: unknown;
  };
  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
}
