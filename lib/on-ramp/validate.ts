import { StrKey } from "@stellar/stellar-sdk";
import { ApiRequestError } from "@/lib/api-errors";

export function validateCAddress(address: unknown): string {
  if (typeof address !== "string" || !address.trim()) {
    throw new ApiRequestError(
      "validation_error",
      "destinationCAddress is required.",
      400
    );
  }
  const trimmed = address.trim();
  if (!StrKey.isValidContract(trimmed)) {
    throw new ApiRequestError(
      "validation_error",
      "destinationCAddress must be a valid C-address (contract).",
      400
    );
  }
  return trimmed;
}
