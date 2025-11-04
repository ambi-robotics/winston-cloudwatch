const safeStringify = require('safe-stable-stringify');

// ANSI color codes
const ANSI_BLUE = '\x1b[34m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

function handleErrorObject(key, value) {
  if (value instanceof Error) {
    return Object.getOwnPropertyNames(value).reduce((error, key) => {
      error[key] = value[key];
      return error;
    }, {});
  }
  return value;
}

function stringify(o) {
  return safeStringify(o, handleErrorObject, '  ');
}

function debug(...args) {
  if (!process.env.WINSTON_CLOUDWATCH_DEBUG) {
    return;
  }

  const lastParam = args.pop();
  let color = ANSI_RED;
  if (lastParam !== true) {
    args.push(lastParam);
    color = ANSI_GREEN;
  }

  args[0] = color + args[0] + ANSI_RESET;
  args.unshift(ANSI_BLUE + 'DEBUG:' + ANSI_RESET);
  console.log(...args);
}

function isEmpty(value) {
  if (value == null) {
    return true;
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length === 0;
  }
  return false;
}

function isError(value) {
  return value instanceof Error;
}

module.exports = {
  stringify,
  debug,
  isEmpty,
  isError,
};
