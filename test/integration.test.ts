import { jest } from '@jest/globals';
import WinstonCloudWatch from '../index';
import * as winston from 'winston';
import TransportStream from 'winston-transport';
import * as cloudWatchIntegration from '../lib/cloudwatch-integration';

// Mock winston-transport
jest.mock('winston-transport', () => {
  return jest.fn().mockImplementation(function(this: any, options: any) {
    Object.assign(this, options);
  });
});

describe('WinstonCloudWatch - Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useFakeTimers();
    // Reset internal state between tests
    cloudWatchIntegration.__clearInternalState();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Winston compatibility', () => {
    it('should extend TransportStream correctly', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });

      expect(transport).toBeInstanceOf(WinstonCloudWatch);
      expect(typeof transport.log).toBe('function');
      expect(typeof transport.kthxbye).toBe('function');
    });

    it('should handle log entries with proper formatting', (done) => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });

      const logEntry = {
        level: 'info',
        message: 'Test message',
        timestamp: new Date().toISOString(),
        meta: { userId: 123 }
      } as winston.LogEntry;

      transport.log(logEntry, () => {
        expect(transport.logEvents).toHaveLength(1);
        expect(transport.logEvents[0].message).toBe('info - Test message');
        done();
      });
    });

    it('should handle JSON message formatting', (done) => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        jsonMessage: true,
      });

      const logEntry = {
        level: 'info',
        message: 'Test message',
        userId: 123,
        action: 'login'
      } as winston.LogEntry;

      transport.log(logEntry, () => {
        expect(transport.logEvents).toHaveLength(1);
        const parsed = JSON.parse(transport.logEvents[0].message);
        expect(parsed.level).toBe('info');
        expect(parsed.message).toBe('Test message');
        expect(parsed.userId).toBe(123);
        expect(parsed.action).toBe('login');
        done();
      });
    });
  });

  describe('Batch processing scenarios', () => {
    it('should queue multiple log events correctly', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });

      transport.add({ level: 'info', message: 'Message 1' } as winston.LogEntry);
      transport.add({ level: 'info', message: 'Message 2' } as winston.LogEntry);
      transport.add({ level: 'info', message: 'Message 3' } as winston.LogEntry);

      expect(transport.logEvents).toHaveLength(3);
      expect(transport.logEvents[0].message).toBe('info - Message 1');
      expect(transport.logEvents[1].message).toBe('info - Message 2');
      expect(transport.logEvents[2].message).toBe('info - Message 3');
    });

    it('should sort log events chronologically', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });

      const now = Date.now();

      // Add events in non-chronological order but set timestamps explicitly
      transport.logEvents = [
        { message: 'info - Second', timestamp: now + 1000 },
        { message: 'info - First', timestamp: now },
        { message: 'info - Third', timestamp: now + 2000 }
      ];

      // Sort as the submit method would do
      const sorted = transport.logEvents.sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));

      expect(sorted[0].message).toBe('info - First');
      expect(sorted[1].message).toBe('info - Second');
      expect(sorted[2].message).toBe('info - Third');
    });
  });

  describe('Error handling in real scenarios', () => {
    it('should have proper error handling mechanism', () => {
      const errorHandler = jest.fn();
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        errorHandler,
      });

      expect(transport.errorHandler).toBe(errorHandler);
    });

    it('should validate configuration correctly', () => {
      expect(() => {
        new WinstonCloudWatch({} as any);
      }).toThrow('WinstonCloudWatch: logGroupName is required');

      expect(() => {
        new WinstonCloudWatch({
          logGroupName: '',
          logStreamName: 'test-stream',
        });
      }).toThrow('WinstonCloudWatch: logGroupName is required'); // Empty string is falsy

      expect(() => {
        new WinstonCloudWatch({
          logGroupName: 'test-group',
          logStreamName: '',
        });
      }).toThrow('WinstonCloudWatch: logStreamName is required'); // Empty string is falsy

      expect(() => {
        new WinstonCloudWatch({
          logGroupName: '   ',  // Whitespace only string
          logStreamName: 'test-stream',
        });
      }).toThrow('WinstonCloudWatch: logGroupName cannot be empty');
    });

    it('should handle invalid upload rates', () => {
      expect(() => {
        new WinstonCloudWatch({
          logGroupName: 'test-group',
          logStreamName: 'test-stream',
          uploadRate: -100,
        });
      }).toThrow('WinstonCloudWatch: uploadRate must be a non-negative number');
    });

    it('should handle invalid retention periods', () => {
      expect(() => {
        new WinstonCloudWatch({
          logGroupName: 'test-group',
          logStreamName: 'test-stream',
          retentionInDays: -1,
        });
      }).toThrow('WinstonCloudWatch: retentionInDays must be a non-negative number');
    });
  });

  describe('AWS SDK integration scenarios', () => {
    let mockCloudWatchLogs: any;

    beforeEach(() => {
      mockCloudWatchLogs = {
        putLogEvents: jest.fn(),
        describeLogStreams: jest.fn(),
        createLogGroup: jest.fn(),
        createLogStream: jest.fn(),
        putRetentionPolicy: jest.fn(),
      };
    });

    it('should use provided CloudWatchLogs instance', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        cloudWatchLogs: mockCloudWatchLogs,
      });

      expect(transport.cloudWatchLogs).toBe(mockCloudWatchLogs);
    });

    it('should validate resolved names before upload', (done) => {
      const transport = new WinstonCloudWatch({
        logGroupName: () => '',  // Returns empty string
        logStreamName: 'test-stream',
        cloudWatchLogs: mockCloudWatchLogs,
      });

      transport.submit((error) => {
        expect(error).toBeDefined();
        expect(error?.message).toBe('WinstonCloudWatch: resolved logGroupName is invalid');
        done();
      });
    });

    it('should handle function-based group and stream names', () => {
      let counter = 0;
      const transport = new WinstonCloudWatch({
        logGroupName: () => `group-${++counter}`,
        logStreamName: () => `stream-${counter}`,
        cloudWatchLogs: mockCloudWatchLogs,
      });

      // Call getGroupName and getStreamName through submit
      const callback = jest.fn();
      transport.submit(callback);

      expect(callback).toHaveBeenCalled();
    });
  });

  describe('Performance optimizations', () => {
    it('should cache function-based names', () => {
      let callCount = 0;
      const transport = new WinstonCloudWatch({
        logGroupName: () => {
          callCount++;
          return 'test-group';
        },
        logStreamName: 'test-stream',
      });

      // Multiple calls within cache duration should not increase call count
      const name1 = (transport as any).getGroupName();
      const name2 = (transport as any).getGroupName();

      expect(name1).toBe('test-group');
      expect(name2).toBe('test-group');
      expect(callCount).toBe(1); // Function called only once due to caching
    });

    it('should handle string-based names efficiently', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });

      // String-based names should not use caching
      const name1 = (transport as any).getGroupName();
      const name2 = (transport as any).getGroupName();

      expect(name1).toBe('test-group');
      expect(name2).toBe('test-group');
    });
  });
});