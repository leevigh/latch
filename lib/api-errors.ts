import { NextResponse } from "next/server";

export type ApiErrorBody = {
  error: string;
  code: string;
  message: string;
  suggestedAction?: string;
};

export function apiError(params: {
  status: number;
  code: string;
  message: string;
  suggestedAction?: string;
}): NextResponse<ApiErrorBody> {
  const { status, code, message, suggestedAction } = params;
  return NextResponse.json(
    {
      error: message,
      code,
      message,
      ...(suggestedAction ? { suggestedAction } : {}),
    },
    { status }
  );
}

export class ApiRequestError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
  }
}
