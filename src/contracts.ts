import { randomUUID } from 'node:crypto';
export type Args = Record<string, any>;
export interface Service { call(action: string, args: Args): Promise<any>; close(): Promise<void>; }
export interface ServiceOptions { artifactDir: string; stateDir: string; }
export class ToolError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'ToolError'; }
}
export function fail(code: string, message: string, details?: unknown): never { throw new ToolError(code, message, details); }
export function id(prefix: string): string { return `${prefix}_${randomUUID().slice(0, 12)}`; }
export function required<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null || value === '') fail('INVALID_ARGUMENT', `${name} is required`);
  return value;
}
export function finite(value: unknown, name: string): number {
  const n = Number(value); if (!Number.isFinite(n)) fail('INVALID_ARGUMENT', `${name} must be finite`); return n;
}
