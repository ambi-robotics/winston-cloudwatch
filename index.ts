import * as winston from 'winston';
import TransportStream from 'winston-transport';
import { CloudWatchLogs } from '@aws-sdk/client-cloudwatch-logs';
import * as cloudWatchIntegration from './lib/cloudwatch-integration';
import { LogEvent, CloudWatchOptions } from './lib/cloudwatch-integration';
import { stringify } from './lib/utils';
import { debug } from './lib/utils';

const defaultFlushTimeoutMs = 10000;

export interface WinstonCloudWatchOptions extends TransportStream.TransportStreamOptions {
  level?: string;
  name?: string;
  logGroupName: string | (() => string);
  retentionInDays?: number;
  logStreamName: string | (() => string);
  awsAccessKeyId?: string;
  awsSecretKey?: string;
  awsRegion?: string;
  messageFormatter?: (log: winston.LogEntry) => string;
  jsonMessage?: boolean;
  uploadRate?: number;
  errorHandler?: (err: Error) => void;
  cloudWatchLogs?: CloudWatchLogs;
  awsOptions?: any;
  ensureLogGroup?: boolean;
}

class WinstonCloudWatch extends TransportStream {
  public level: string;
  public name: string;
  public logGroupName: string | (() => string);
  public retentionInDays: number;
  public logStreamName: string | (() => string);
  public options: WinstonCloudWatchOptions;
  public formatMessage: (log: winston.LogEntry) => string;
  public uploadRate: number;
  public logEvents: LogEvent[];
  public errorHandler?: (err: Error) => void;
  public cloudWatchLogs: CloudWatchLogs;
  public intervalId: NodeJS.Timeout | null = null;
  public flushTimeout?: number;

  private isEmpty(value: any): boolean {
    return value === null ||
           value === undefined ||
           value === '' ||
           (Array.isArray(value) && value.length === 0) ||
           (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  }

  private isError(value: any): boolean {
    return value instanceof Error;
  }

  constructor(options: WinstonCloudWatchOptions) {
    super(options);
    this.level = options.level || "info";
    this.name = options.name || "CloudWatch";
    this.logGroupName = options.logGroupName;
    this.retentionInDays = options.retentionInDays || 0;
    this.logStreamName = options.logStreamName;
    this.options = options;

    const awsAccessKeyId = options.awsAccessKeyId;
    const awsSecretKey = options.awsSecretKey;
    const awsRegion = options.awsRegion;
    const messageFormatter = options.messageFormatter
      ? options.messageFormatter
      : function (log: winston.LogEntry): string {
          return [log.level, log.message].join(" - ");
        };
    this.formatMessage = options.jsonMessage ? stringify : messageFormatter;
    this.uploadRate = options.uploadRate || 2000;
    this.logEvents = [];
    this.errorHandler = options.errorHandler;

    if (options.cloudWatchLogs) {
      this.cloudWatchLogs = options.cloudWatchLogs;
    } else {
      let config: any = {};

      if (awsAccessKeyId && awsSecretKey && awsRegion) {
        config = {
          credentials: {
            accessKeyId: awsAccessKeyId,
            secretAccessKey: awsSecretKey,
          },
          region: awsRegion,
        };
      } else if (awsRegion && !awsAccessKeyId && !awsSecretKey) {
        // Amazon SDK will automatically pull access credentials
        // from IAM Role when running on EC2 but region still
        // needs to be configured
        config = { region: awsRegion };
      }

      if (options.awsOptions) {
        config = Object.assign(config, options.awsOptions);
      }

      this.cloudWatchLogs = new CloudWatchLogs(config);
    }

    debug("constructor finished");
  }

  public log(info: winston.LogEntry, callback: (error?: any, level?: string, message?: string, meta?: any) => void): void {
    debug("log (called by winston)", info);

    if (!this.isEmpty(info.message) || this.isError(info.message)) {
      this.add(info);
    }

    if (!/^uncaughtException: /.test(info.message as string)) {
      // do not wait, just return right away
      return callback();
    }

    debug("message not empty, proceeding");

    // clear interval and send logs immediately
    // as Winston is about to end the process
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.submit(callback);
  }

  public add(log: winston.LogEntry): void {
    debug("add log to queue", log);

    if (!this.isEmpty(log.message) || this.isError(log.message)) {
      this.logEvents.push({
        message: this.formatMessage(log),
        timestamp: new Date().getTime(),
      });
    }

    if (!this.intervalId) {
      debug("creating interval");
      this.intervalId = setInterval(() => {
        this.submit((err?: Error) => {
          if (err) {
            debug("error during submit", err, true);
            this.errorHandler ? this.errorHandler(err) : console.error(err);
          }
        });
      }, this.uploadRate);
    }
  }

  public submit(callback?: (error?: Error) => void): void {
    const groupName =
      typeof this.logGroupName === "function"
        ? this.logGroupName()
        : this.logGroupName;
    const streamName =
      typeof this.logStreamName === "function"
        ? this.logStreamName()
        : this.logStreamName;
    const retentionInDays = this.retentionInDays;

    if (this.isEmpty(this.logEvents)) {
      return callback && callback();
    }

    const options: CloudWatchOptions = {
      ensureLogGroup: this.options.ensureLogGroup
    };

    cloudWatchIntegration.upload(
      this.cloudWatchLogs,
      groupName,
      streamName,
      this.logEvents.sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1)), // sort events into chronological order
      retentionInDays,
      options,
      callback || (() => {})
    );
  }

  public kthxbye(callback: (error?: Error) => void): void {
    debug("clearing interval");
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    debug("interval cleared");
    this.flushTimeout = this.flushTimeout || Date.now() + defaultFlushTimeoutMs;
    debug("flush timeout set to", this.flushTimeout);

    this.submit((error?: Error) => {
      debug("submit done", error);
      const groupName =
        typeof this.logGroupName === "function"
          ? this.logGroupName()
          : this.logGroupName;
      const streamName =
        typeof this.logStreamName === "function"
          ? this.logStreamName()
          : this.logStreamName;
      cloudWatchIntegration.clearSequenceToken(groupName, streamName);
      if (error) return callback(error);
      if (this.isEmpty(this.logEvents)) return callback();
      if (Date.now() > this.flushTimeout!)
        return callback(
          new Error("Timeout reached while waiting for logs to submit")
        );
      else setTimeout(() => this.kthxbye(callback), 0);
    });
  }
}

// Extend winston transports
declare module 'winston' {
  interface Transports {
    CloudWatch: typeof WinstonCloudWatch;
  }
}

(winston.transports as any).CloudWatch = WinstonCloudWatch;

export default WinstonCloudWatch;