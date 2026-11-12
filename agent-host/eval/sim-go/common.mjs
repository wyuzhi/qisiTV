// sim-go 各模块共用的小工具：深拷贝、摘要，以及和 Go 操作层一致的错误类型。

import crypto from 'node:crypto';

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export class OpError extends Error {
  constructor(status, code, reason, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.details = details;
  }
}

export function invalidArg(reason, message, details = null) {
  return new OpError(400, 'invalid_argument', reason, message, details);
}
export function notFound(reason, message, details = null) {
  return new OpError(404, 'not_found', reason, message, details);
}
export function conflict(reason, message, details = null) {
  return new OpError(409, 'conflict', reason, message, details);
}
export function preconditionFailed(reason, message, details = null) {
  return new OpError(412, 'precondition_failed', reason, message, details);
}
export function permissionDenied(reason, message, details = null) {
  return new OpError(403, 'permission_denied', reason, message, details);
}
