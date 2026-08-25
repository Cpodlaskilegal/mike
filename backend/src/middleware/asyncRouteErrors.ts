import {
  Router,
  type ErrorRequestHandler,
  type NextFunction,
  type RequestHandler,
  type RouterOptions,
} from "express";
import { safeErrorLog, safeErrorMessage } from "../lib/safeError";

const ASYNC_ERROR_WRAPPED = Symbol("async-error-wrapped");
const REGISTRATION_METHODS = [
  "use",
  "all",
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
] as const;

type ExpressCallback = RequestHandler | ErrorRequestHandler;
type MarkedCallback = ExpressCallback & {
  [ASYNC_ERROR_WRAPPED]?: true;
};

function forwardRejectedResult(result: unknown, next: NextFunction): unknown {
  if (
    result &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as PromiseLike<unknown>).then === "function"
  ) {
    return Promise.resolve(result).catch(next);
  }
  return result;
}

function wrapCallback(callback: ExpressCallback): ExpressCallback {
  if ((callback as MarkedCallback)[ASYNC_ERROR_WRAPPED]) return callback;

  let wrapped: ExpressCallback;
  if (callback.length === 4) {
    const errorCallback = callback as ErrorRequestHandler;
    wrapped = function asyncErrorCallback(error, req, res, next) {
      try {
        return forwardRejectedResult(
          errorCallback(error, req, res, next),
          next,
        );
      } catch (callbackError) {
        next(callbackError);
      }
    };
  } else {
    const requestCallback = callback as RequestHandler;
    wrapped = function asyncRequestCallback(req, res, next) {
      try {
        return forwardRejectedResult(requestCallback(req, res, next), next);
      } catch (callbackError) {
        next(callbackError);
      }
    };
  }

  Object.defineProperty(wrapped, ASYNC_ERROR_WRAPPED, { value: true });
  return wrapped;
}

function wrapRegistrationArgument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrapRegistrationArgument);
  if (typeof value === "function") {
    return wrapCallback(value as ExpressCallback);
  }
  return value;
}

/**
 * Express 4 ignores rejected Promises returned by route callbacks. This router
 * factory preserves Express's normal synchronous behavior while forwarding any
 * returned rejection to the application's error middleware.
 */
export function createAsyncRouter(options?: RouterOptions): Router {
  const router = Router(options);
  const registrations = router as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;

  for (const method of REGISTRATION_METHODS) {
    const register = registrations[method].bind(router);
    registrations[method] = (...args: unknown[]) =>
      register(...args.map(wrapRegistrationArgument));
  }

  return router;
}

function errorStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 500;
  const candidate =
    (error as { status?: unknown; statusCode?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 400 &&
    candidate < 500
    ? candidate
    : 500;
}

function clientErrorDetail(error: unknown, status: number): string {
  if (
    status === 400 &&
    error &&
    typeof error === "object" &&
    (error as { type?: unknown }).type === "entity.parse.failed"
  ) {
    return "Invalid JSON request body";
  }
  if (status < 500) return safeErrorMessage(error, "Request failed");
  return "Internal server error";
}

/** Final API error boundary. Register after every route. */
export const apiErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status = errorStatus(error);
  console.error("[http] unhandled request error", {
    method: req.method,
    path: req.path,
    status,
    error: safeErrorLog(error),
  });
  res.status(status).json({ detail: clientErrorDetail(error, status) });
};
