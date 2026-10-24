// One error class for every IceBase failure. `code` uses Firebase's codes where Firebase has one
// (so code that checks `e.code === 'permission-denied'` keeps working); `reason` says which
// IceBase check failed when the code alone is too coarse.

export type IceBaseErrorCode =
  | 'invalid-argument'
  | 'failed-precondition'
  | 'not-found'
  | 'already-exists'
  | 'permission-denied'
  | 'unauthenticated'
  | 'resource-exhausted'
  | 'unavailable'
  | 'unimplemented'
  | 'internal'
  | 'aborted'
  | 'cancelled'
  | 'deadline-exceeded'
  | 'out-of-range'
  | 'data-loss'
  | 'unknown';

export type IceBaseErrorReason =
  | 'schema'
  | 'missing-index'
  | 'unknown-collection'
  | 'config'
  | 'mode'
  | 'not-in-scope'
  | 'management';

export class IceBaseError extends Error {
  override readonly name = 'IceBaseError';
  constructor(
    readonly code: IceBaseErrorCode,
    message: string,
    readonly details: { reason?: IceBaseErrorReason; service?: string; [k: string]: unknown } = {},
  ) {
    super(message);
  }
  get reason(): IceBaseErrorReason | undefined {
    return this.details.reason;
  }
}

export const configError = (message: string) => new IceBaseError('failed-precondition', message, { reason: 'config' });
