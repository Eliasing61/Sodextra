export class SodexError extends Error {
  override name = "SodexError";
}

/** The gateway answered with an error envelope (`code` != 0). The request was processed and rejected. */
export class SodexApiError extends SodexError {
  override name = "SodexApiError";
  constructor(
    readonly code: number,
    readonly apiMessage: string,
    readonly httpStatus: number,
    readonly path: string,
  ) {
    super(`SoDEX ${path} failed (code ${code}, HTTP ${httpStatus}): ${apiMessage}`);
  }
}

/** HTTP error without a SoDEX envelope (e.g. Cloudflare 5xx, 429). */
export class SodexHttpError extends SodexError {
  override name = "SodexHttpError";
  constructor(
    readonly httpStatus: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`SoDEX ${path} returned HTTP ${httpStatus}: ${body.slice(0, 300)}`);
  }
}

/**
 * The request may or may not have reached the engine (timeout, dropped connection).
 * For writes the outcome is UNKNOWN: reconcile by clOrdID before retrying.
 */
export class SodexNetworkError extends SodexError {
  override name = "SodexNetworkError";
  constructor(
    readonly path: string,
    readonly outcomeUnknown: boolean,
    options?: { cause?: unknown },
  ) {
    super(
      `SoDEX ${path}: network error${outcomeUnknown ? " (write outcome unknown)" : ""}`,
      options,
    );
  }
}
