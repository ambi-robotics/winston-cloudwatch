import {
  CloudWatchLogs,
  LogStream,
  PutLogEventsCommandInput,
  PutLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import { debug } from "./utils";

const MAX_EVENT_MSG_SIZE_BYTES = 256000; // The real max size is 262144, we leave some room for overhead on each message
const MAX_BATCH_SIZE_BYTES = 1000000; // We leave some fudge factor here too.

// CloudWatch adds 26 bytes per log event based on their documentation:
// https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutLogEvents.html
const BASE_EVENT_SIZE_BYTES = 26;

export interface LogEvent {
  message: string;
  timestamp: number;
}

export interface CloudWatchOptions {
  ensureLogGroup?: boolean;
}

interface CloudWatchLibrary {
  _postingEvents: Record<string, boolean>;
  _nextToken: Record<string, string | null>;
}

const lib: CloudWatchLibrary = {
  _postingEvents: {},
  _nextToken: {},
};

export function upload(
  aws: CloudWatchLogs,
  groupName: string,
  streamName: string,
  logEvents: LogEvent[],
  retentionInDays: number,
  options: CloudWatchOptions,
  cb: (err?: Error) => void
): void {
  debug("upload", logEvents);

  // trying to send a batch before the last completed
  // would cause InvalidSequenceTokenException.
  if (lib._postingEvents[streamName] || logEvents.length <= 0) {
    debug("nothing to do or already doing something");
    return cb();
  }

  lib._postingEvents[streamName] = true;
  safeUpload(function (err?: Error) {
    delete lib._postingEvents[streamName];
    return cb(err);
  });

  // safeUpload introduced after https://github.com/lazywithclass/winston-cloudwatch/issues/55
  // Note that calls to upload() can occur at a greater frequency
  // than getToken() responses are processed. By way of example, consider if add() is
  // called at 0s and 1.1s, each time with a single event, and upload() is called
  // at 1.0s and 2.0s, with the same logEvents array, but calls to getToken()
  // take 1.5s to return. When the first call to getToken() DOES return,
  // it will send both events and empty the array. Then, when the second call
  // go getToken() returns, without this check also here, it would attempt to send
  // an empty array, resulting in the InvalidParameterException.
  function safeUpload(cb: (err?: Error) => void): void {
    getToken(
      aws,
      groupName,
      streamName,
      retentionInDays,
      options,
      function (err?: Error, token?: string | null) {
        if (err) {
          debug("error getting token", err, true);
          return cb(err);
        }

        let entryIndex = 0;
        let bytes = 0;
        while (entryIndex < logEvents.length) {
          const ev = logEvents[entryIndex];
          // unit tests pass null elements
          let evSize = ev
            ? Buffer.byteLength(ev.message, "utf8") + BASE_EVENT_SIZE_BYTES
            : 0;
          if (evSize > MAX_EVENT_MSG_SIZE_BYTES) {
            evSize = MAX_EVENT_MSG_SIZE_BYTES;
            ev.message = ev.message.substring(0, evSize);
            const msgTooBigErr = new Error(
              "Message Truncated because it exceeds the CloudWatch size limit"
            ) as Error & { logEvent: LogEvent };
            msgTooBigErr.logEvent = ev;
            cb(msgTooBigErr);
          }
          if (bytes + evSize > MAX_BATCH_SIZE_BYTES) break;
          bytes += evSize;
          entryIndex++;
        }

        const payload: PutLogEventsCommandInput = {
          logGroupName: groupName,
          logStreamName: streamName,
          logEvents: logEvents.splice(0, entryIndex),
        };
        if (token) payload.sequenceToken = token;

        lib._postingEvents[streamName] = true;
        debug("send to aws");
        aws.putLogEvents(
          payload,
          function (err?: Error, data?: PutLogEventsCommandOutput) {
            debug("sent to aws, err: ", err, " data: ", data);
            if (err) {
              // InvalidSequenceToken means we need to do a describe to get another token
              // also do the same if ResourceNotFound as that will result in the last token
              // for the group being set to null
              if (
                err.name === "InvalidSequenceTokenException" ||
                err.name === "ResourceNotFoundException"
              ) {
                debug(err.name + ", retrying", true);
                submitWithAnotherToken(
                  aws,
                  groupName,
                  streamName,
                  payload,
                  retentionInDays,
                  options,
                  cb
                );
              } else {
                debug("error during putLogEvents", err, true);
                retrySubmit(aws, payload, 3, cb);
              }
            } else {
              if (data && data.nextSequenceToken) {
                lib._nextToken[previousKeyMapKey(groupName, streamName)] =
                  data.nextSequenceToken;
              }

              delete lib._postingEvents[streamName];
              cb();
            }
          }
        );
      }
    );
  }
}

export function submitWithAnotherToken(
  aws: CloudWatchLogs,
  groupName: string,
  streamName: string,
  payload: PutLogEventsCommandInput,
  retentionInDays: number,
  options: CloudWatchOptions,
  cb: (err?: Error) => void
): void {
  lib._nextToken[previousKeyMapKey(groupName, streamName)] = null;
  getToken(
    aws,
    groupName,
    streamName,
    retentionInDays,
    options,
    function (err?: Error, token?: string | null) {
      payload.sequenceToken = token || undefined;
      aws.putLogEvents(payload, function (err?: Error) {
        delete lib._postingEvents[streamName];
        cb(err);
      });
    }
  );
}

function retrySubmit(
  aws: CloudWatchLogs,
  payload: PutLogEventsCommandInput,
  times: number,
  cb: (err?: Error) => void
): void {
  debug("retrying to upload", times, "more times");
  aws.putLogEvents(payload, function (err?: Error) {
    if (err && times > 0) {
      retrySubmit(aws, payload, times - 1, cb);
    } else {
      delete lib._postingEvents[payload.logStreamName!];
      cb(err);
    }
  });
}

export function getToken(
  aws: CloudWatchLogs,
  groupName: string,
  streamName: string,
  retentionInDays: number,
  options: CloudWatchOptions,
  cb: (err?: Error, token?: string | null) => void
): void {
  const existingNextToken =
    lib._nextToken[previousKeyMapKey(groupName, streamName)];
  if (existingNextToken != null) {
    debug("using existing next token and assuming exists", existingNextToken);
    cb(undefined, existingNextToken);
    return;
  }

  if (options.ensureLogGroup !== false) {
    ensureGroupPresent(
      aws,
      groupName,
      retentionInDays,
      (err1, groupPresent) => {
        if (err1) return cb(err1);
        getStream(aws, groupName, streamName, (err2, stream) => {
          if (err2) return cb(err2);
          if (groupPresent && stream) {
            debug("token found", stream.uploadSequenceToken);
            cb(undefined, stream.uploadSequenceToken);
          } else {
            debug("token not found", err2);
            cb(err2);
          }
        });
      }
    );
  } else {
    getStream(aws, groupName, streamName, (err, stream) => {
      if (err) return cb(err);
      if (stream) {
        debug("token found", stream.uploadSequenceToken);
        cb(undefined, stream.uploadSequenceToken);
      } else {
        debug("token not found");
        cb(new Error("Stream not found"));
      }
    });
  }
}

function previousKeyMapKey(group: string, stream: string): string {
  return group + ":" + stream;
}

export function ensureGroupPresent(
  aws: CloudWatchLogs,
  name: string,
  retentionInDays: number,
  cb: (err?: Error, result?: boolean) => void
): void {
  debug("ensure group present");
  const params = { logGroupName: name };
  aws.describeLogStreams(params, function (err?: Error) {
    // TODO we should cb(err, false) if there's an error?
    if (err && err.name == "ResourceNotFoundException") {
      debug("create group");
      return aws.createLogGroup(
        params,
        ignoreInProgress(function (err?: Error) {
          if (!err) putRetentionPolicy(aws, name, retentionInDays);
          cb(err, err ? false : true);
        })
      );
    } else {
      putRetentionPolicy(aws, name, retentionInDays);
      cb(err, true);
    }
  });
}

export function putRetentionPolicy(
  aws: CloudWatchLogs,
  groupName: string,
  days: number
): void {
  const params = {
    logGroupName: groupName,
    retentionInDays: days,
  };
  if (days > 0) {
    debug(
      'setting retention policy for "' + groupName + '" to ' + days + " days"
    );
    aws.putRetentionPolicy(params, function (err?: Error) {
      if (err)
        console.error(
          "failed to set retention policy for " +
            groupName +
            " to " +
            days +
            " days due to " +
            err.stack
        );
    });
  }
}

export function getStream(
  aws: CloudWatchLogs,
  groupName: string,
  streamName: string,
  cb: (err?: Error, stream?: LogStream) => void
): void {
  const params = {
    logGroupName: groupName,
    logStreamNamePrefix: streamName,
  };

  aws.describeLogStreams(params, function (err?: Error, data?: any) {
    debug("ensure stream present");
    if (err) return cb(err);

    const stream = data.logStreams.find(function (stream: LogStream) {
      return stream.logStreamName === streamName;
    });

    if (!stream) {
      debug("create stream");
      aws.createLogStream(
        {
          logGroupName: groupName,
          logStreamName: streamName,
        },
        ignoreInProgress(function (err?: Error) {
          if (err) return cb(err);
          getStream(aws, groupName, streamName, cb);
        })
      );
    } else {
      cb(undefined, stream);
    }
  });
}

export function ignoreInProgress(
  cb: (err?: Error, data?: any) => void
): (err?: Error, data?: any) => void {
  return function (err?: Error, data?: any) {
    if (
      err &&
      (err.name == "OperationAbortedException" ||
        err.name == "ResourceAlreadyExistsException")
    ) {
      debug("ignore operation in progress", err.message);
      cb(undefined, data);
    } else {
      cb(err, data);
    }
  };
}

export function clearSequenceToken(group: string, stream: string): void {
  delete lib._nextToken[previousKeyMapKey(group, stream)];
}

// Test helper functions - only for testing
export function __getInternalState() {
  return { lib };
}

export function __clearInternalState() {
  lib._postingEvents = {};
  lib._nextToken = {};
}
