import { jest } from '@jest/globals';
import WinstonCloudWatch from '../index';
import * as winston from 'winston';

// Mock the cloudwatch-integration module
jest.mock('../lib/cloudwatch-integration', () => ({
  upload: jest.fn(),
  clearSequenceToken: jest.fn(),
}));

// Mock winston-transport
jest.mock('winston-transport', () => {
  return jest.fn().mockImplementation(function(this: any, options: any) {
    Object.assign(this, options);
  });
});

// Mock AWS SDK
jest.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogs: jest.fn().mockImplementation(function(this: any, config: any) {
    this.config = config;
    this.putLogEvents = jest.fn();
    this.describeLogStreams = jest.fn();
    this.createLogGroup = jest.fn();
    this.createLogStream = jest.fn();
    this.putRetentionPolicy = jest.fn();
  }),
}));

describe('WinstonCloudWatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('creates transport with default options', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });

      expect(transport.level).toBe('info');
      expect(transport.name).toBe('CloudWatch');
      expect(transport.logGroupName).toBe('test-group');
      expect(transport.logStreamName).toBe('test-stream');
      expect(transport.uploadRate).toBe(2000);
      expect(transport.retentionInDays).toBe(0);
    });

    it('allows custom cloudWatchLogs instance', () => {
      const mockCloudWatch = { fakeOptions: { region: 'us-west-2' } };
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        cloudWatchLogs: mockCloudWatch as any,
      });

      expect((transport.cloudWatchLogs as any).fakeOptions.region).toBe('us-west-2');
    });

    it('configures AWS credentials when provided', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        awsAccessKeyId: 'test-key',
        awsSecretKey: 'test-secret',
        awsRegion: 'us-east-1',
      });

      expect(transport.cloudWatchLogs).toBeDefined();
    });

    it('merges awsOptions into existing config', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        awsRegion: 'eu-west-1',
        awsOptions: {
          region: 'us-east-1',
        },
      });

      expect(transport.cloudWatchLogs).toBeDefined();
    });
  });

  describe('log', () => {
    let transport: WinstonCloudWatch;
    const mockUpload = require('../lib/cloudwatch-integration').upload;

    beforeEach(() => {
      transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });
      mockUpload.mockClear();
    });

    it('does not upload if message is empty', (done) => {
      transport.log({ level: 'info', message: '' } as winston.LogEntry, () => {
        jest.advanceTimersByTime(2000);
        expect(mockUpload).not.toHaveBeenCalled();
        done();
      });
    });

    it('adds log to queue and sets up interval', (done) => {
      transport.log({ level: 'info', message: 'test message' } as winston.LogEntry, () => {
        expect(transport.logEvents).toHaveLength(1);
        expect(transport.logEvents[0].message).toBe('info - test message');
        expect(transport.intervalId).toBeDefined();
        done();
      });
    });

    it('flushes logs immediately on uncaught exception', (done) => {
      const submitSpy = jest.spyOn(transport, 'submit').mockImplementation((callback) => {
        callback?.();
      });

      transport.log({ level: 'error', message: 'uncaughtException: test error' } as winston.LogEntry, () => {
        expect(transport.intervalId).toBeNull();
        expect(submitSpy).toHaveBeenCalled();
        done();
      });
    });

    describe('message formatting', () => {
      it('logs as JSON when jsonMessage is true', (done) => {
        transport = new WinstonCloudWatch({
          logGroupName: 'test-group',
          logStreamName: 'test-stream',
          jsonMessage: true,
        });

        transport.log(
          { level: 'info', message: 'test', extra: 'data' } as winston.LogEntry,
          () => {
            jest.advanceTimersByTime(2000);
            expect(transport.logEvents).toHaveLength(1);
            const loggedMessage = JSON.parse(transport.logEvents[0].message);
            expect(loggedMessage.level).toBe('info');
            expect(loggedMessage.message).toBe('test');
            expect(loggedMessage.extra).toBe('data');
            done();
          }
        );
      });

      it('uses default text formatter', (done) => {
        transport.log({ level: 'info', message: 'test message' } as winston.LogEntry, () => {
          expect(transport.logEvents).toHaveLength(1);
          expect(transport.logEvents[0].message).toBe('info - test message');
          done();
        });
      });

      it('uses custom message formatter', (done) => {
        transport = new WinstonCloudWatch({
          logGroupName: 'test-group',
          logStreamName: 'test-stream',
          messageFormatter: (log) => `${log.level} ${log.message} custom`,
        });

        transport.log({ level: 'info', message: 'test' } as winston.LogEntry, () => {
          expect(transport.logEvents).toHaveLength(1);
          expect(transport.logEvents[0].message).toBe('info test custom');
          done();
        });
      });
    });

    describe('error handling', () => {
      beforeEach(() => {
        mockUpload.mockImplementation((_aws: any, _group: any, _stream: any, _events: any, _retention: any, _options: any, callback: any) => {
          callback(new Error('Test error'));
        });
      });

      it('calls errorHandler if provided', (done) => {
        const errorHandler = jest.fn();
        transport = new WinstonCloudWatch({
          logGroupName: 'test-group',
          logStreamName: 'test-stream',
          errorHandler,
        });

        transport.log({ level: 'info', message: 'test' } as winston.LogEntry, () => {
          jest.advanceTimersByTime(2000);
          expect(errorHandler).toHaveBeenCalledWith(new Error('Test error'));
          done();
        });
      });

      it('logs to console.error if no errorHandler provided', (done) => {
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        transport.log({ level: 'info', message: 'test' } as winston.LogEntry, () => {
          jest.advanceTimersByTime(2000);
          expect(consoleErrorSpy).toHaveBeenCalledWith(new Error('Test error'));
          done();
        });

        consoleErrorSpy.mockRestore();
      });
    });
  });

  describe('kthxbye', () => {
    let transport: WinstonCloudWatch;
    const mockClearSequenceToken = require('../lib/cloudwatch-integration').clearSequenceToken;

    beforeEach(() => {
      transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });
      mockClearSequenceToken.mockClear();
    });

    it('clears the interval and submits logs', (done) => {
      transport.intervalId = setInterval(() => {}, 1000) as any;
      const submitSpy = jest.spyOn(transport, 'submit').mockImplementation((callback) => {
        transport.logEvents = []; // Simulate logs being cleared
        callback?.();
      });

      transport.kthxbye((err) => {
        expect(err).toBeUndefined();
        expect(transport.intervalId).toBeNull();
        expect(submitSpy).toHaveBeenCalled();
        expect(mockClearSequenceToken).toHaveBeenCalledWith('test-group', 'test-stream');
        done();
      });
    });

    it('times out if logs are not cleared within timeout period', (done) => {
      transport.add({ level: 'info', message: 'test' } as winston.LogEntry);
      const submitSpy = jest.spyOn(transport, 'submit').mockImplementation((callback) => {
        // Don't clear logEvents, simulate logs not being submitted
        callback?.();
      });

      transport.kthxbye((err) => {
        expect(err).toBeDefined();
        expect(err?.message).toBe('Timeout reached while waiting for logs to submit');
        expect(transport.logEvents).toHaveLength(1);
        done();
      });

      // Advance time past the flush timeout
      jest.advanceTimersByTime(11000);
    });

    it('handles functional logGroupName and logStreamName', (done) => {
      transport = new WinstonCloudWatch({
        logGroupName: () => 'dynamic-group',
        logStreamName: () => 'dynamic-stream',
      });

      const submitSpy = jest.spyOn(transport, 'submit').mockImplementation((callback) => {
        transport.logEvents = [];
        callback?.();
      });

      transport.kthxbye((err) => {
        expect(err).toBeUndefined();
        expect(mockClearSequenceToken).toHaveBeenCalledWith('dynamic-group', 'dynamic-stream');
        done();
      });
    });
  });

  describe('submit', () => {
    let transport: WinstonCloudWatch;
    const mockUpload = require('../lib/cloudwatch-integration').upload;

    beforeEach(() => {
      transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });
      mockUpload.mockClear();
    });

    it('does nothing if no log events', () => {
      const callback = jest.fn();
      transport.submit(callback);
      expect(callback).toHaveBeenCalled();
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('uploads log events and sorts them chronologically', (done) => {
      const now = Date.now();
      transport.logEvents = [
        { message: 'second', timestamp: now + 1000 },
        { message: 'first', timestamp: now },
      ];

      mockUpload.mockImplementation((_aws: any, _group: any, _stream: any, events: any, _retention: any, _options: any, callback: any) => {
        expect(events[0].message).toBe('first');
        expect(events[1].message).toBe('second');
        callback();
        done();
      });

      transport.submit();
      expect(mockUpload).toHaveBeenCalled();
    });

    it('handles functional group and stream names', (done) => {
      transport = new WinstonCloudWatch({
        logGroupName: () => 'func-group',
        logStreamName: () => 'func-stream',
      });
      transport.logEvents = [{ message: 'test', timestamp: Date.now() }];

      mockUpload.mockImplementation((_aws: any, group: any, stream: any, _events: any, _retention: any, _options: any, callback: any) => {
        expect(group).toBe('func-group');
        expect(stream).toBe('func-stream');
        callback();
        done();
      });

      transport.submit();
    });
  });
});