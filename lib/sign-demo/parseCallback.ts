import {
  parseCallbackResult as parseCallbackResultCore,
  stellarExpertTxUrl as stellarExpertTxUrlCore,
} from "./parseCallback.core.mjs";
import type { SignCallbackResult } from "./types";

export const parseCallbackResult = parseCallbackResultCore as (
  search: string,
  hash: string
) => SignCallbackResult;

export const stellarExpertTxUrl = stellarExpertTxUrlCore;
