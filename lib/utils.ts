import safeStringify from 'fast-safe-stringify';

/**
 * JSON replacer function that properly serializes Error objects
 * @param _key - The property key being stringified (unused)
 * @param value - The property value being stringified
 * @returns The processed value for JSON serialization
 */
function handleErrorObject(_key: string, value: any): any {
  if (value instanceof Error) {
    return Object.getOwnPropertyNames(value).reduce(function (error: any, key: string) {
      error[key] = value[key as keyof Error];
      return error;
    }, {});
  }
  return value;
}

/**
 * Safely stringify an object to JSON, handling circular references and Error objects
 * @param o - The object to stringify
 * @returns JSON string representation of the object
 */
export function stringify(o: any): string {
  return safeStringify(o, handleErrorObject, "  ");
}

/**
 * Debug logging function that only outputs when WINSTON_CLOUDWATCH_DEBUG environment variable is set
 * Supports colored output with the last parameter being a boolean indicating error (red) vs info (green)
 * @param args - Arguments to log, with optional boolean as last parameter for error coloring
 */
export function debug(...args: any[]): void {
  if (!process.env.WINSTON_CLOUDWATCH_DEBUG) return;
  const argsCopy = [...args];
  const lastParam = argsCopy.pop();

  // Simple color codes since chalk is now ES module only
  const red = '\x1b[31m';
  const green = '\x1b[32m';
  const blue = '\x1b[34m';
  const reset = '\x1b[0m';

  let color = red;
  if (lastParam !== true) {
    argsCopy.push(lastParam);
    color = green;
  }

  argsCopy[0] = color + argsCopy[0] + reset;
  argsCopy.unshift(blue + "DEBUG:" + reset);
  console.log.apply(console, argsCopy);
}