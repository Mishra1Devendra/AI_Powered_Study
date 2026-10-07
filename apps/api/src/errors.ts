/** Errors with a safe, user-facing message and an HTTP status. Mapped centrally in app.ts. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra safe fields included in the JSON error body (e.g. the id of the existing duplicate). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super(404, "not_found", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "conflict", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that.", code = "forbidden") {
    super(403, code, message);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(400, "bad_request", message);
  }
}
