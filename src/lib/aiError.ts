import type { NextApiResponse } from "next";
import {
  AISDKError,
  APICallError,
  EmptyResponseBodyError,
  InvalidPromptError,
  InvalidResponseDataError,
  JSONParseError,
  LoadAPIKeyError,
  NoContentGeneratedError,
  NoSuchModelError,
  TypeValidationError,
  UnsupportedFunctionalityError,
} from "ai";

type AnyError = unknown;

export type NormalizedAIError = {
  status: number;
  code: string;
  name: string;
  message: string;
  retryAfterMs?: number;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const hasProp = <T extends string>(
  obj: unknown,
  key: T
): obj is Record<T, unknown> => isObject(obj) && key in obj;

const readStatusFrom = (error: AnyError): number | undefined => {
  if (hasProp(error, "status") && typeof error.status === "number")
    return error.status;
  if (
    hasProp(error, "statusCode") &&
    typeof (error as any).statusCode === "number"
  )
    return (error as any).statusCode;
  if (
    hasProp(error, "response") &&
    hasProp((error as any).response, "status") &&
    typeof (error as any).response.status === "number"
  ) {
    return (error as any).response.status;
  }
  return undefined;
};

// Some AI SDK error classes are not exported, so we also match by name string.
const hasName = (error: AnyError, ...names: string[]) =>
  names.includes(getString((error as any)?.name));

export const normalizeAIError = (error: AnyError): NormalizedAIError => {
  const name = getString((error as any)?.name, "Error");
  const message = getString((error as any)?.message, "Unexpected error");

  // Map common cases first.
  if (error instanceof LoadAPIKeyError) {
    return {
      status: 401,
      code: "auth.no_api_key",
      name,
      message: "Missing or invalid API key",
    };
  }

  if (error instanceof NoSuchModelError) {
    return { status: 400, code: "model.not_found", name, message };
  }

  if (error instanceof UnsupportedFunctionalityError) {
    return {
      status: 400,
      code: "model.unsupported_functionality",
      name,
      message,
    };
  }

  if (
    error instanceof TypeValidationError ||
    error instanceof InvalidPromptError
  ) {
    return { status: 400, code: "input.invalid", name, message };
  }

  if (
    error instanceof EmptyResponseBodyError ||
    error instanceof InvalidResponseDataError ||
    error instanceof JSONParseError
  ) {
    return { status: 502, code: "provider.invalid_response", name, message };
  }

  if (error instanceof NoContentGeneratedError) {
    return { status: 502, code: "provider.no_output", name, message };
  }

  if (error instanceof APICallError) {
    const status = readStatusFrom(error) ?? 502;
    const code =
      status === 401
        ? "auth.unauthorized"
        : status === 403
        ? "auth.forbidden"
        : status === 404
        ? "provider.not_found"
        : status === 409
        ? "provider.conflict"
        : status === 422
        ? "provider.unprocessable"
        : status === 429
        ? "provider.rate_limited"
        : status >= 500
        ? "provider.error"
        : "provider.request_failed";
    return { status, code, name, message };
  }

  // Tooling and stream related errors (not all exported) — detect via name.
  if (
    hasName(
      error,
      "InvalidToolInputError",
      "NoSuchToolError",
      "ToolCallRepairError"
    )
  ) {
    return { status: 400, code: "tool.invalid", name, message };
  }

  if (
    hasName(
      error,
      "InvalidArgumentError",
      "InvalidDataContentError",
      "InvalidMessageRoleError",
      "MessageConversionError"
    )
  ) {
    return { status: 400, code: "input.invalid", name, message };
  }

  if (hasName(error, "InvalidStreamPartError")) {
    return { status: 502, code: "stream.invalid_part", name, message };
  }

  if (hasName(error, "UnsupportedModelVersionError", "NoSuchProviderError")) {
    return { status: 400, code: "model.unsupported", name, message };
  }

  if (hasName(error, "DownloadError", "MCPClientError")) {
    return { status: 502, code: "provider.network_error", name, message };
  }

  if (hasName(error, "RetryError")) {
    const status = readStatusFrom(error) ?? 503;
    return { status, code: "provider.retry", name, message };
  }

  // Generic fetch/node errors
  if (hasProp(error, "code") && typeof (error as any).code === "string") {
    const code = String((error as any).code);
    if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ENOTFOUND") {
      return {
        status: 502,
        code: `network.${code.toLowerCase()}`,
        name,
        message,
      };
    }
  }

  // Any AI SDK error not matched above.
  if (error instanceof AISDKError) {
    const status = readStatusFrom(error) ?? 500;
    return { status, code: "ai_sdk.error", name, message };
  }

  // Default fallback.
  return { status: 500, code: "unknown", name, message };
};

export const handleAIError = (res: NextApiResponse, error: AnyError) => {
  const { status, code, name, message } = normalizeAIError(error);

  // Structured server-side log with cause if present
  // eslint-disable-next-line no-console
  console.error("AI Error", {
    name,
    code,
    status,
    message,
    stack: (error as any)?.stack,
    cause: (error as any)?.cause,
  });

  const payload = {
    error: {
      code,
      name,
      message,
    },
  };

  try {
    res.status(status).json(payload);
  } catch {
    // As a last resort, ensure headers are set
    try {
      res.status(status).end(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }
};

// Friendly message to surface in streamed UI output
export const getStreamFriendlyMessage = (error: AnyError): string => {
  const normalized = normalizeAIError(error);
  if (normalized.code.startsWith("auth."))
    return "Authentication failed (check API key).";
  if (normalized.code === "provider.rate_limited")
    return "Rate limited. Please wait and try again.";
  if (normalized.code.startsWith("input."))
    return "Invalid input. Please adjust your request and try again.";
  if (normalized.code.startsWith("tool."))
    return "A tool call failed. Please try again.";
  if (normalized.code.startsWith("model."))
    return "Model configuration issue. Please try again later.";
  if (normalized.code.startsWith("network."))
    return "Network error. Please retry.";
  if (normalized.code === "provider.error")
    return "The model provider had an error. Please retry.";
  return "Something went wrong. Please try again.";
};
