export class ApiError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.headers = options.headers ?? {};
  }
}

export function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    return new ApiError(400, "INVALID_REQUEST", error.message);
  }
  return new ApiError(500, "INTERNAL_ERROR", "サーバー内部でエラーが発生しました");
}
