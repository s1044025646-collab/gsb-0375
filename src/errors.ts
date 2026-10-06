export type ErrorCode =
  | "INVALID_PARAM"
  | "LPN_OUT_OF_RANGE"
  | "DATA_TOO_LONG"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "NO_VICTIM"
  | "INTERNAL_INVARIANT";

export class FtlError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = "FtlError";
  }
}
