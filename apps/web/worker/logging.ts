export type BoundedErrorName =
  | "Error"
  | "AggregateError"
  | "EvalError"
  | "RangeError"
  | "ReferenceError"
  | "SyntaxError"
  | "TypeError"
  | "URIError"
  | "OtherError"
  | "UnknownError"
  | "ThrownBigInt"
  | "ThrownBoolean"
  | "ThrownFunction"
  | "ThrownNumber"
  | "ThrownObject"
  | "ThrownString"
  | "ThrownSymbol"
  | "ThrownUndefined";

const THROWN_VALUE_BUCKETS: Readonly<Record<string, BoundedErrorName>> = {
  bigint: "ThrownBigInt",
  boolean: "ThrownBoolean",
  function: "ThrownFunction",
  number: "ThrownNumber",
  object: "ThrownObject",
  string: "ThrownString",
  symbol: "ThrownSymbol",
  undefined: "ThrownUndefined"
};

function boundedBuiltInErrorName(name: unknown): BoundedErrorName {
  switch (name) {
    case "Error":
      return "Error";
    case "AggregateError":
      return "AggregateError";
    case "EvalError":
      return "EvalError";
    case "RangeError":
      return "RangeError";
    case "ReferenceError":
      return "ReferenceError";
    case "SyntaxError":
      return "SyntaxError";
    case "TypeError":
      return "TypeError";
    case "URIError":
      return "URIError";
    case "":
    case undefined:
    case null:
      return "UnknownError";
    default:
      return "OtherError";
  }
}

export function boundedErrorName(error: unknown): BoundedErrorName {
  try {
    if (error instanceof Error) {
      // Read a potentially hostile accessor exactly once. The explicit switch
      // below returns only compile-time literals even if the value changes on
      // subsequent reads.
      const name: unknown = error.name;
      return boundedBuiltInErrorName(name);
    }
  } catch {
    // Proxies can throw from getPrototypeOf during instanceof, and Error.name
    // itself can be an accessor. Logging must remain total on both paths.
    return "UnknownError";
  }
  return THROWN_VALUE_BUCKETS[typeof error] ?? "UnknownError";
}
