import safeStringify from 'fast-safe-stringify';

function handleErrorObject(key: string, value: any): any {
  if (value instanceof Error) {
    return Object.getOwnPropertyNames(value).reduce(function (error: any, key: string) {
      error[key] = value[key as keyof Error];
      return error;
    }, {});
  }
  return value;
}

export function stringify(o: any): string {
  return safeStringify(o, handleErrorObject, "  ");
}

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