import { apiError } from "@/lib/api-errors";

export function devOnlyGuard() {
  if (process.env.NODE_ENV === "production") {
    return apiError({
      status: 403,
      code: "forbidden",
      message: "On-ramp dev APIs are not available in production.",
    });
  }
  return null;
}
