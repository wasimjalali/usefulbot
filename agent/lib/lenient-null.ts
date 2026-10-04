import { z } from "zod";

/**
 * Models fill a "no value" field in several ways: null, nothing at all, the
 * string "null" or an empty string. All of them mean null. The JSON schema the
 * model sees stays a plain union of the real type, string and null, with the
 * field optional; the transform only runs when the tool parses the call.
 */
const isNone = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "string" && ["", "null"].includes(value.trim().toLowerCase()));

/** Only a plain integer string counts as a number: no hex, exponent or fraction. */
const INTEGER_TEXT = /^-?\d+$/;
const toNumber = (value: unknown): unknown => (typeof value === "string" ? (INTEGER_TEXT.test(value.trim()) ? Number(value.trim()) : NaN) : value);

/** A string or null: "null", "" and a missing value become null. */
export const lenientNullableString = (describe: string, check: z.ZodString = z.string()) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .describe(describe)
    .transform((value, ctx) => {
      if (isNone(value)) return null;
      const parsed = check.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message });
        return z.NEVER;
      }
      return parsed.data;
    });

/** A number or null: "null", "" and a missing value become null, a numeric string becomes a number. */
export const lenientNullableNumber = (describe: string) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .describe(describe)
    .transform((value, ctx) => {
      if (isNone(value)) return null;
      const number = toNumber(value);
      if (typeof number !== "number" || !Number.isInteger(number)) {
        ctx.addIssue({ code: "custom", message: "expected an integer or null" });
        return z.NEVER;
      }
      return number;
    });

/** A required number the model may send as a numeric string. */
export const lenientNumber = (describe: string, check: z.ZodNumber = z.number()) =>
  z.union([z.number(), z.string()]).describe(describe).transform((value, ctx) => {
    const parsed = check.safeParse(toNumber(value));
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "expected an integer" });
      return z.NEVER;
    }
    return parsed.data;
  });
