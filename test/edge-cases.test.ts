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

describe('WinstonCloudWatch - Edge Cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Input validation', () => {
    it('should throw error when logGroupName is missing', () => {
      expect(() => {
        new WinstonCloudWatch({
          logStreamName: 'test-stream',
        } as any);
      }).toThrow();
    });

    it('should throw error when logStreamName is missing', () => {
      expect(() => {
        new WinstonCloudWatch({
          logGroupName: 'test-group',
        } as any);
      }).toThrow();
    });

    it('should handle empty string as logGroupName', () => {
      expect(() => {
        new WinstonCloudWatch({
          logGroupName: '',
          logStreamName: 'test-stream',
        });
      }).toThrow();
    });

    it('should handle empty string as logStreamName', () => {
      expect(() => {
        new WinstonCloudWatch({
          logGroupName: 'test-group',
          logStreamName: '',
        });
      }).toThrow();
    });
  });

  describe('Message handling edge cases', () => {
    let transport: WinstonCloudWatch;

    beforeEach(() => {
      transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });
    });

    it('should handle null message', (done) => {
      transport.log({ level: 'info', message: null } as any, () => {
        expect(transport.logEvents).toHaveLength(0);
        done();
      });
    });

    it('should handle undefined message', (done) => {
      transport.log({ level: 'info', message: undefined } as any, () => {
        expect(transport.logEvents).toHaveLength(0);
        done();
      });
    });

    it('should handle Error object as message', (done) => {
      const error = new Error('Test error');
      transport.log({ level: 'error', message: error } as any, () => {
        expect(transport.logEvents).toHaveLength(1);
        expect(transport.logEvents[0].message).toBe('error - Error: Test error');
        done();
      });
    });

    it('should handle very long messages', (done) => {
      const longMessage = 'x'.repeat(10000);
      transport.log({ level: 'info', message: longMessage } as winston.LogEntry, () => {
        expect(transport.logEvents).toHaveLength(1);
        expect(transport.logEvents[0].message).toContain('x'.repeat(100));
        done();
      });
    });

    it('should handle messages with special characters', (done) => {
      const specialMessage = 'Test with émojis 🚀 and únicode ñ characters';
      transport.log({ level: 'info', message: specialMessage } as winston.LogEntry, () => {
        expect(transport.logEvents).toHaveLength(1);
        expect(transport.logEvents[0].message).toBe(`info - ${specialMessage}`);
        done();
      });
    });

    it('should handle messages with newlines and tabs', (done) => {
      const multilineMessage = 'Line 1\nLine 2\tTabbed content';
      transport.log({ level: 'info', message: multilineMessage } as winston.LogEntry, () => {
        expect(transport.logEvents).toHaveLength(1);
        expect(transport.logEvents[0].message).toBe(`info - ${multilineMessage}`);
        done();
      });
    });
  });

  describe('Timing and concurrency edge cases', () => {
    let transport: WinstonCloudWatch;

    beforeEach(() => {
      transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        uploadRate: 100, // Fast uploads for testing
      });
    });

    it('should handle multiple rapid log calls', (done) => {
      let callbackCount = 0;
      const totalCalls = 5;

      const callback = () => {
        callbackCount++;
        if (callbackCount === totalCalls) {
          expect(transport.logEvents).toHaveLength(totalCalls);
          done();
        }
      };

      for (let i = 0; i < totalCalls; i++) {
        transport.log({ level: 'info', message: `Message ${i}` } as winston.LogEntry, callback);
      }
    });

    it('should handle kthxbye called multiple times', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
      });

      transport.add({ level: 'info', message: 'test' } as winston.LogEntry);

      // Both calls should complete without throwing
      expect(() => {
        transport.kthxbye(() => {});
        transport.kthxbye(() => {});
      }).not.toThrow();
    });

    it('should handle submit called before any logs are added', () => {
      const callback = jest.fn();
      transport.submit(callback);
      expect(callback).toHaveBeenCalledWith();
    });
  });

  describe('Configuration edge cases', () => {
    it('should reject negative uploadRate', () => {
      expect(() => {
        new WinstonCloudWatch({
          logGroupName: 'test-group',
          logStreamName: 'test-stream',
          uploadRate: -1000,
        });
      }).toThrow('WinstonCloudWatch: uploadRate must be a non-negative number');
    });

    it('should handle zero uploadRate', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        uploadRate: 0,
      });
      expect(transport.uploadRate).toBe(0);
    });

    it('should reject negative retentionInDays', () => {
      expect(() => {
        new WinstonCloudWatch({
          logGroupName: 'test-group',
          logStreamName: 'test-stream',
          retentionInDays: -1,
        });
      }).toThrow('WinstonCloudWatch: retentionInDays must be a non-negative number');
    });

    it('should handle very large retentionInDays', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        retentionInDays: 99999,
      });
      expect(transport.retentionInDays).toBe(99999);
    });
  });

  describe('Function-based configuration', () => {
    it('should handle logGroupName function that throws', (done) => {
      const transport = new WinstonCloudWatch({
        logGroupName: () => { throw new Error('Group name error'); },
        logStreamName: 'test-stream',
      });

      transport.submit((error) => {
        expect(error).toBeDefined();
        expect(error?.message).toBe('Group name error');
        done();
      });
    });

    it('should handle logStreamName function that throws', (done) => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: () => { throw new Error('Stream name error'); },
      });

      transport.submit((error) => {
        expect(error).toBeDefined();
        expect(error?.message).toBe('Stream name error');
        done();
      });
    });

    it('should handle logGroupName function that returns empty string', () => {
      const transport = new WinstonCloudWatch({
        logGroupName: () => '',
        logStreamName: 'test-stream',
      });

      transport.add({ level: 'info', message: 'test' } as winston.LogEntry);
      const callback = jest.fn();
      transport.submit(callback);

      // Should complete but with empty group name
      expect(callback).toHaveBeenCalled();
    });

    it('should handle dynamic logGroupName and logStreamName', (done) => {
      let counter = 0;
      const transport = new WinstonCloudWatch({
        logGroupName: () => `group-${++counter}`,
        logStreamName: () => `stream-${counter}`,
      });

      const mockUpload = require('../lib/cloudwatch-integration').upload;
      mockUpload.mockImplementation((_aws: any, group: string, stream: string, _events: any, _retention: any, _options: any, callback: any) => {
        expect(group).toBe('group-1');
        expect(stream).toBe('stream-1');
        callback();
        done();
      });

      transport.add({ level: 'info', message: 'test' } as winston.LogEntry);
      transport.submit();
    });
  });

  describe('JSON message formatting edge cases', () => {
    it('should handle circular references in JSON mode', (done) => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        jsonMessage: true,
      });

      const circular: any = { name: 'circular' };
      circular.self = circular;

      transport.log({ level: 'info', message: 'test', circular } as any, () => {
        expect(transport.logEvents).toHaveLength(1);
        // Should not throw and should handle circular reference
        expect(transport.logEvents[0].message).toContain('"name": "circular"');
        done();
      });
    });

    it('should handle Error objects in JSON mode', (done) => {
      const transport = new WinstonCloudWatch({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        jsonMessage: true,
      });

      const error = new Error('Test error');
      transport.log({ level: 'error', message: 'error occurred', error } as any, () => {
        expect(transport.logEvents).toHaveLength(1);
        const parsed = JSON.parse(transport.logEvents[0].message);
        expect(parsed.error.message).toBe('Test error');
        expect(typeof parsed.error.stack).toBe('string');
        done();
      });
    });
  });
});