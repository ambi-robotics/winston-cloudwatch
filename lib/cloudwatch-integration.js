const MAX_EVENT_MSG_SIZE_BYTES = 256000; // The real max size is 262144, we leave some room for overhead on each message
const MAX_BATCH_SIZE_BYTES = 1000000; // We leave some fudge factor here too.

// CloudWatch adds 26 bytes per log event based on their documentation:
// https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutLogEvents.html
const BASE_EVENT_SIZE_BYTES = 26;

const debug = require('./utils').debug;

// Module-level state is intentional - sequence tokens must be shared
// across all WinstonCloudWatch instances writing to the same streams
// to prevent InvalidSequenceTokenException race conditions
const lib = {
  _postingEvents: {},
  _nextToken: {},
};

lib.upload = async function (
  aws,
  groupName,
  streamName,
  logEvents,
  retentionInDays,
  options
) {
  debug('upload', logEvents);

  // trying to send a batch before the last completed
  // would cause InvalidSequenceTokenException.
  if (lib._postingEvents[streamName] || logEvents.length <= 0) {
    debug('nothing to do or already doing something');
    return;
  }

  lib._postingEvents[streamName] = true;

  try {
    await safeUpload();
  } finally {
    delete lib._postingEvents[streamName];
  }

  // safeUpload introduced after https://github.com/lazywithclass/winston-cloudwatch/issues/55
  // Note that calls to upload() can occur at a greater frequency
  // than getToken() responses are processed. By way of example, consider if add() is
  // called at 0s and 1.1s, each time with a single event, and upload() is called
  // at 1.0s and 2.0s, with the same logEvents array, but calls to getToken()
  // take 1.5s to return. When the first call to getToken() DOES return,
  // it will send both events and empty the array. Then, when the second call
  // go getToken() returns, without this check also here, it would attempt to send
  // an empty array, resulting in the InvalidParameterException.
  async function safeUpload() {
    const token = await lib.getToken(
      aws,
      groupName,
      streamName,
      retentionInDays,
      options
    );

    let entryIndex = 0;
    let bytes = 0;
    while (entryIndex < logEvents.length) {
      const ev = logEvents[entryIndex];
      // unit tests pass null elements
      let evSize = ev
        ? Buffer.byteLength(ev.message, 'utf8') + BASE_EVENT_SIZE_BYTES
        : 0;
      if (evSize > MAX_EVENT_MSG_SIZE_BYTES) {
        evSize = MAX_EVENT_MSG_SIZE_BYTES;
        ev.message = ev.message.substring(0, evSize);
        const msgTooBigErr = new Error(
          'Message Truncated because it exceeds the CloudWatch size limit'
        );
        msgTooBigErr.logEvent = ev;
        throw msgTooBigErr;
      }
      if (bytes + evSize > MAX_BATCH_SIZE_BYTES) break;
      bytes += evSize;
      entryIndex++;
    }

    const payload = {
      logGroupName: groupName,
      logStreamName: streamName,
      logEvents: logEvents.splice(0, entryIndex),
    };
    if (token) payload.sequenceToken = token;

    lib._postingEvents[streamName] = true;
    debug('send to aws');

    try {
      const data = await aws.putLogEvents(payload);
      debug('sent to aws, data: ', data);

      if (data && data.nextSequenceToken) {
        lib._nextToken[previousKeyMapKey(groupName, streamName)] =
          data.nextSequenceToken;
      }

      delete lib._postingEvents[streamName];
    } catch (err) {
      debug('sent to aws, err: ', err);
      // InvalidSequenceToken means we need to do a describe to get another token
      // also do the same if ResourceNotFound as that will result in the last token
      // for the group being set to null
      if (
        err.name === 'InvalidSequenceTokenException' ||
        err.name === 'ResourceNotFoundException'
      ) {
        debug(`${err.name}, retrying`, true);
        await lib.submitWithAnotherToken(
          aws,
          groupName,
          streamName,
          payload,
          retentionInDays,
          options
        );
      } else {
        debug('error during putLogEvents', err, true);
        await retrySubmit(aws, payload, 3);
      }
    }
  }
};

lib.submitWithAnotherToken = async function (
  aws,
  groupName,
  streamName,
  payload,
  retentionInDays,
  options
) {
  lib._nextToken[previousKeyMapKey(groupName, streamName)] = null;
  const token = await lib.getToken(
    aws,
    groupName,
    streamName,
    retentionInDays,
    options
  );
  payload.sequenceToken = token;
  await aws.putLogEvents(payload);
  delete lib._postingEvents[streamName];
};

async function retrySubmit(aws, payload, times) {
  debug('retrying to upload', times, 'more times');
  try {
    await aws.putLogEvents(payload);
    delete lib._postingEvents[payload.logStreamName];
  } catch (err) {
    if (times > 0) {
      await retrySubmit(aws, payload, times - 1);
    } else {
      delete lib._postingEvents[payload.logStreamName];
      throw err;
    }
  }
}

lib.getToken = async function (
  aws,
  groupName,
  streamName,
  retentionInDays,
  options
) {
  const existingNextToken =
    lib._nextToken[previousKeyMapKey(groupName, streamName)];
  if (existingNextToken != null) {
    debug('using existing next token and assuming exists', existingNextToken);
    return existingNextToken;
  }

  let groupPresent = true;
  let stream;

  if (options.ensureLogGroup !== false) {
    groupPresent = await lib.ensureGroupPresent(
      aws,
      groupName,
      retentionInDays
    );
    stream = await lib.getStream(aws, groupName, streamName);
  } else {
    stream = await lib.getStream(aws, groupName, streamName);
  }

  if (groupPresent && stream) {
    debug('token found', stream.uploadSequenceToken);
    return stream.uploadSequenceToken;
  } else {
    debug('token not found');
    throw new Error('Could not get token');
  }
};

function previousKeyMapKey(group, stream) {
  return `${group}:${stream}`;
}

lib.ensureGroupPresent = async function ensureGroupPresent(
  aws,
  name,
  retentionInDays
) {
  debug('ensure group present');
  const params = { logGroupName: name };

  try {
    await aws.describeLogStreams(params);
    lib.putRetentionPolicy(aws, name, retentionInDays);
    return true;
  } catch (err) {
    // TODO we should throw error if there's an error?
    if (err && err.name == 'ResourceNotFoundException') {
      debug('create group');
      try {
        await lib.ignoreInProgressAsync(() => aws.createLogGroup(params));
        lib.putRetentionPolicy(aws, name, retentionInDays);
        return true;
      } catch {
        return false;
      }
    } else {
      lib.putRetentionPolicy(aws, name, retentionInDays);
      return true;
    }
  }
};

lib.putRetentionPolicy = function putRetentionPolicy(aws, groupName, days) {
  const params = {
    logGroupName: groupName,
    retentionInDays: days,
  };
  if (days > 0) {
    debug(`setting retention policy for "${groupName}" to ${days} days`);
    aws
      .putRetentionPolicy(params)
      .then(() => {})
      .catch((err) => {
        console.error(
          `failed to set retention policy for ${groupName} to ${days} days due to ${err.stack}`
        );
      });
  }
};

lib.getStream = async function getStream(aws, groupName, streamName) {
  const params = {
    logGroupName: groupName,
    logStreamNamePrefix: streamName,
  };

  const data = await aws.describeLogStreams(params);
  debug('ensure stream present');

  const stream =
    data.logStreams &&
    data.logStreams.find((stream) => stream.logStreamName === streamName);

  if (!stream) {
    debug('create stream');
    await lib.ignoreInProgressAsync(() =>
      aws.createLogStream({
        logGroupName: groupName,
        logStreamName: streamName,
      })
    );
    return getStream(aws, groupName, streamName);
  } else {
    return stream;
  }
};

lib.ignoreInProgress = function ignoreInProgress(cb) {
  return (err, data) => {
    if (
      err &&
      (err.name == 'OperationAbortedException' ||
        err.name == 'ResourceAlreadyExistsException')
    ) {
      debug('ignore operation in progress', err.message);
      cb(null, data);
    } else {
      cb(err, data);
    }
  };
};

lib.ignoreInProgressAsync = async function ignoreInProgressAsync(fn) {
  try {
    const result = await fn();
    return result;
  } catch (err) {
    if (
      err &&
      (err.name == 'OperationAbortedException' ||
        err.name == 'ResourceAlreadyExistsException')
    ) {
      debug('ignore operation in progress', err.message);
      return null;
    } else {
      throw err;
    }
  }
};

lib.clearSequenceToken = function clearSequenceToken(group, stream) {
  delete lib._nextToken[previousKeyMapKey(group, stream)];
};

module.exports = lib;
