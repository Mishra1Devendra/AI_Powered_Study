/**
 * A document could not be processed for a reason the student can understand and act on.
 * The message is stored in `documents.processing_error` and shown in the UI, so it must be
 * safe: no paths, stack traces or library internals.
 */
export class ProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessingError";
  }
}
