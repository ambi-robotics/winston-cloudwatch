import * as winston from 'winston';
import TransportStream from 'winston-transport';
import { CloudWatchLogs } from '@aws-sdk/client-cloudwatch-logs';
import * as cloudWatchIntegration from './lib/cloudwatch-integration';
import { LogEvent, CloudWatchOptions } from './lib/cloudwatch-integration';
import { stringify } from './lib/utils';
import { debug } from './lib/utils';

/**
 * Default timeout in milliseconds for flushing logs before giving up
 */
const defaultFlushTimeoutMs = 10000;

/**
 * Configuration options for Winston CloudWatch transport
 */
export interface WinstonCloudWatchOptions extends TransportStream.TransportStreamOptions {
  /** Log level threshold (defaults to 'info') */
  level?: string;
  /** Transport name (defaults to 'CloudWatch') */
  name?: string;
  /** CloudWatch log group name or function returning the name */
  logGroupName: string | (() => string);
  /** Log retention period in days (0 means no retention policy) */
  retentionInDays?: number;
  /** CloudWatch log stream name or function returning the name */
  logStreamName: string | (() => string);
  /** AWS access key ID (deprecated - use awsOptions.credentials instead) */
  awsAccessKeyId?: string;
  /** AWS secret key (deprecated - use awsOptions.credentials instead) */
  awsSecretKey?: string;
  /** AWS region (deprecated - use awsOptions.region instead) */
  awsRegion?: string;
  /** Custom message formatter function */
  messageFormatter?: (log: winston.LogEntry) => string;
  /** Whether to format messages as JSON */
  jsonMessage?: boolean;
  /** Upload frequency in milliseconds (defaults to 2000ms) */
  uploadRate?: number;
  /** Custom error handler function */
  errorHandler?: (err: Error) => void;
  /** Pre-configured CloudWatchLogs client instance */
  cloudWatchLogs?: CloudWatchLogs;
  /** AWS SDK configuration options */
  awsOptions?: any;
  /** Whether to ensure log group exists (defaults to true) */
  ensureLogGroup?: boolean;
}

/**
 * Winston transport for sending logs to AWS CloudWatch Logs
 *
 * @example
 * ```typescript
 * import { createLogger } from 'winston';
 * import WinstonCloudWatch from 'winston-cloudwatch';
 *
 * const logger = createLogger({
 *   transports: [
 *     new WinstonCloudWatch({
 *       logGroupName: 'my-app-logs',
 *       logStreamName: 'server-errors',
 *       awsRegion: 'us-east-1',
 *       level: 'error'
 *     })
 *   ]
 * });
 * ```
 */
class WinstonCloudWatch extends TransportStream {
  /** Winston log level threshold */
  public level: string;
  /** Transport name identifier */
  public name: string;
  /** CloudWatch log group name or function returning the name */
  public logGroupName: string | (() => string);
  /** Log retention period in days */
  public retentionInDays: number;
  /** CloudWatch log stream name or function returning the name */
  public logStreamName: string | (() => string);
  /** Original options passed to constructor */
  public options: WinstonCloudWatchOptions;
  /** Message formatting function */
  public formatMessage: (log: winston.LogEntry) => string;
  /** Upload frequency in milliseconds */
  public uploadRate: number;
  /** Queue of log events waiting to be uploaded */
  public logEvents: LogEvent[];
  /** Custom error handler function */
  public errorHandler?: (err: Error) => void;
  /** AWS CloudWatch Logs client instance */
  public cloudWatchLogs: CloudWatchLogs;
  /** Timer ID for periodic log uploads */
  public intervalId: NodeJS.Timeout | null = null;
  /** Timeout timestamp for flush operations */
  public flushTimeout?: number;
  /** Cache for resolved group and stream names to avoid repeated function calls */
  private _groupNameCache?: string;
  /** Cache for resolved group and stream names to avoid repeated function calls */
  private _streamNameCache?: string;
  /** Timestamp when names were last cached */
  private _namesCachedAt?: number;
  /** Cache duration for group/stream names in milliseconds */
  private readonly _nameCacheDuration = 60000; // 1 minute

  /**
   * Checks if a value is considered empty for logging purposes
   * @param value - The value to check
   * @returns True if the value is null, undefined, empty string, empty array, or empty object
   */
  private isEmpty(value: any): boolean {
    return value === null ||
           value === undefined ||
           value === '' ||
           (Array.isArray(value) && value.length === 0) ||
           (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  }

  /**
   * Checks if a value is an Error instance
   * @param value - The value to check
   * @returns True if the value is an instance of Error
   */
  private isError(value: any): boolean {
    return value instanceof Error;
  }

  /**
   * Gets the resolved group name with caching for performance
   * @returns The resolved group name
   */
  private getGroupName(): string {
    const now = Date.now();
    if (typeof this.logGroupName === 'string') {
      return this.logGroupName;
    }

    // Use cache if available and not expired
    if (this._groupNameCache && this._namesCachedAt && (now - this._namesCachedAt) < this._nameCacheDuration) {
      return this._groupNameCache;
    }

    // Resolve and cache
    const resolved = this.logGroupName();
    this._groupNameCache = resolved;
    this._namesCachedAt = now;
    return resolved;
  }

  /**
   * Gets the resolved stream name with caching for performance
   * @returns The resolved stream name
   */
  private getStreamName(): string {
    const now = Date.now();
    if (typeof this.logStreamName === 'string') {
      return this.logStreamName;
    }

    // Use cache if available and not expired
    if (this._streamNameCache && this._namesCachedAt && (now - this._namesCachedAt) < this._nameCacheDuration) {
      return this._streamNameCache;
    }

    // Resolve and cache
    const resolved = this.logStreamName();
    this._streamNameCache = resolved;
    this._namesCachedAt = now;
    return resolved;
  }

  /**
   * Creates a new Winston CloudWatch transport instance
   * @param options - Configuration options for the transport
   * @throws Error if required options are missing or invalid
   */
  constructor(options: WinstonCloudWatchOptions) {
    super(options);

    // Input validation
    if (!options) {
      throw new Error('WinstonCloudWatch: options are required');
    }

    if (!options.logGroupName) {
      throw new Error('WinstonCloudWatch: logGroupName is required');
    }

    if (!options.logStreamName) {
      throw new Error('WinstonCloudWatch: logStreamName is required');
    }

    if (typeof options.logGroupName === 'string' && options.logGroupName.trim() === '') {
      throw new Error('WinstonCloudWatch: logGroupName cannot be empty');
    }

    if (typeof options.logStreamName === 'string' && options.logStreamName.trim() === '') {
      throw new Error('WinstonCloudWatch: logStreamName cannot be empty');
    }

    if (options.uploadRate !== undefined && (typeof options.uploadRate !== 'number' || options.uploadRate < 0)) {
      throw new Error('WinstonCloudWatch: uploadRate must be a non-negative number');
    }

    if (options.retentionInDays !== undefined && (typeof options.retentionInDays !== 'number' || options.retentionInDays < 0)) {
      throw new Error('WinstonCloudWatch: retentionInDays must be a non-negative number');
    }

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
    this.uploadRate = options.uploadRate !== undefined ? options.uploadRate : 2000;
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

  /**
   * Winston transport log method called when a log entry needs to be processed
   * @param info - The log entry information from Winston
   * @param callback - Callback function to signal completion
   */
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

  /**
   * Adds a log entry to the upload queue and starts the upload interval if not already running
   * @param log - The Winston log entry to add to the queue
   */
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

  /**
   * Submits queued log events to CloudWatch Logs
   * @param callback - Optional callback function called when submission completes
   */
  public submit(callback?: (error?: Error) => void): void {
    try {
      const groupName = this.getGroupName();
      const streamName = this.getStreamName();
      const retentionInDays = this.retentionInDays;

      // Validate resolved names
      if (!groupName || typeof groupName !== 'string' || groupName.trim() === '') {
        const error = new Error('WinstonCloudWatch: resolved logGroupName is invalid');
        if (callback) callback(error);
        return;
      }

      if (!streamName || typeof streamName !== 'string' || streamName.trim() === '') {
        const error = new Error('WinstonCloudWatch: resolved logStreamName is invalid');
        if (callback) callback(error);
        return;
      }

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
    } catch (error) {
      const err = error instanceof Error ? error : new Error(`Unknown error: ${error}`);
      if (callback) callback(err);
      else if (this.errorHandler) this.errorHandler(err);
      else console.error('WinstonCloudWatch submit error:', err);
    }
  }

  /**
   * Flushes all pending logs and stops the upload interval
   * This method ensures all logs are sent before the process exits
   * @param callback - Callback function called when flush completes or times out
   */
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
      const groupName = this.getGroupName();
      const streamName = this.getStreamName();
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