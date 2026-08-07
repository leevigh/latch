import "server-only";
import * as crypto from "crypto";
import { ApiRequestError } from "@/lib/api-errors";

const MEMO_MIN = 1_000_000_000;
/** crypto.randomInt requires max - min <= 2^48 - 1 */
const MEMO_SPAN = 281_474_976_710_655;

export async function generateUniqueMemoId(
  exists: (memoId: string) => Promise<boolean>
): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const memoId = String(crypto.randomInt(MEMO_MIN, MEMO_MIN + MEMO_SPAN));
    if (!(await exists(memoId))) {
      return memoId;
    }
  }
  throw new ApiRequestError(
    "internal_error",
    "Failed to generate a unique memo ID.",
    500
  );
}
