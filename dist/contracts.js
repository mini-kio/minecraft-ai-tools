import { randomUUID } from 'node:crypto';
export class ToolError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'ToolError';
    }
}
export function fail(code, message, details) { throw new ToolError(code, message, details); }
export function id(prefix) { return `${prefix}_${randomUUID().slice(0, 12)}`; }
export function required(value, name) {
    if (value === undefined || value === null || value === '')
        fail('INVALID_ARGUMENT', `${name} is required`);
    return value;
}
export function finite(value, name) {
    const n = Number(value);
    if (!Number.isFinite(n))
        fail('INVALID_ARGUMENT', `${name} must be finite`);
    return n;
}
//# sourceMappingURL=contracts.js.map