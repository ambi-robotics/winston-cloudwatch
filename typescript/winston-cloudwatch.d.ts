import TransportStream = require('winston-transport');

import {
  CloudWatchLogs,
  CloudWatchLogsClientConfig,
} from '@aws-sdk/client-cloudwatch-logs';

import winston = require('winston');

// Declare the default WinstonCloudwatch class
declare class WinstonCloudwatch extends TransportStream {
  // Public API methods (maintain callback-based signatures for backward compatibility)
  add(log: WinstonCloudwatch.LogObject, timestamp?: number): void;
  kthxbye(callback: (err?: Error) => void): void;
  submit(callback: (err?: Error) => void): void;

  // Constructor
  constructor(options?: WinstonCloudwatch.CloudwatchTransportOptions);
}
// Export the default winston cloudwatch class
export = WinstonCloudwatch;

// Declare optional exports
declare namespace WinstonCloudwatch {
  export type LogObject = winston.LogEntry;

  export interface CloudwatchTransportOptions {
    name?: string;
    cloudWatchLogs?: CloudWatchLogs;
    level?: string;
    ensureLogGroup?: boolean;
    logGroupName?: string | (() => string);
    logStreamName?: string | (() => string);
    awsAccessKeyId?: string;
    awsSecretKey?: string;
    awsRegion?: string;
    awsOptions?: CloudWatchLogsClientConfig;
    jsonMessage?: boolean;
    messageFormatter?: (logObject: LogObject) => string;
    uploadRate?: number;
    errorHandler?: (err: Error) => void;
    silent?: boolean;
    retentionInDays?: number;
  }
}
