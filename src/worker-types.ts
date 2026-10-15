/**
 * Minimal structural types for the Cloudflare Workers runtime surface this target uses.
 *
 * Why not `@cloudflare/workers-types`? That package declares its types as GLOBALS
 * (`Request`, `Response`, `fetch`, `DurableObjectState`, `SqlStorage`, ...). This repo's
 * `tsconfig.json` compiles the Node target with `lib: ["ES2022", "DOM"]`, and loading
 * the Workers globals alongside DOM produces duplicate-identifier errors across the
 * whole program. The Worker bundle is built by esbuild, which strips types, so the real
 * Workers types are not needed to build or deploy — only to typecheck, and these
 * structural declarations cover exactly the members this target touches.
 *
 * If a future change needs a Workers type not declared here, add it here rather than
 * pulling in the global package.
 */

/** Opaque handle to one Durable Object instance. */
export interface DurableObjectId {
  toString(): string;
}

/** A stub that routes calls to one Durable Object instance. */
export interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The binding that mints and addresses Durable Object instances. */
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** A cursor over the rows a SQL statement produced. */
export interface SqlStorageCursor<T> {
  toArray(): T[];
  one(): T;
}

/** The SQLite-backed storage API (`ctx.storage.sql`). */
export interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

/** The Durable Object's storage handle. */
export interface DurableObjectStorage {
  sql: SqlStorage;
}

/** The per-instance context handed to a Durable Object constructor. */
export interface DurableObjectState {
  storage: DurableObjectStorage;
}

/** The per-request context handed to a Worker's `fetch`. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
