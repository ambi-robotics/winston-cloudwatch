import { jest } from '@jest/globals';
import * as lib from '../lib/cloudwatch-integration';

// Simple mock for CloudWatchLogs
const createMockAws = () => ({
  putLogEvents: jest.fn(),
  describeLogStreams: jest.fn(),
  createLogGroup: jest.fn(),
  createLogStream: jest.fn(),
  putRetentionPolicy: jest.fn(),
});

describe('cloudwatch-integration', () => {
  describe('upload', () => {
    let mockAws: ReturnType<typeof createMockAws>;

    beforeEach(() => {
      mockAws = createMockAws();
      // Reset the internal state
      lib.__clearInternalState();
    });

    it('ignores upload calls if putLogEvents already in progress', (done) => {
      mockAws.putLogEvents.mockImplementation((_params: any, callback: any) => {
        // Don't call callback immediately to simulate in-progress request
        setTimeout(() => callback(undefined, { nextSequenceToken: 'token' }), 50);
      });

      mockAws.describeLogStreams.mockImplementation((_params: any, callback: any) => {
        callback(undefined, { logStreams: [{ logStreamName: 'stream', uploadSequenceToken: null }] });
      });

      const logEvents = [{ message: 'test', timestamp: Date.now() }];

      // First call should proceed
      lib.upload(mockAws as any, 'group', 'stream', logEvents, 0, {}, (err) => {
        expect(err).toBeUndefined();
      });

      // Second call should be ignored
      lib.upload(mockAws as any, 'group', 'stream', [...logEvents], 0, {}, (err) => {
        expect(err).toBeUndefined();
        setTimeout(() => {
          expect(mockAws.putLogEvents).toHaveBeenCalledTimes(1);
          done();
        }, 100);
      });
    });

    it('handles empty log events', (done) => {
      lib.upload(mockAws as any, 'group', 'stream', [], 0, {}, (err) => {
        expect(err).toBeUndefined();
        expect(mockAws.putLogEvents).not.toHaveBeenCalled();
        done();
      });
    });

    it('truncates very large messages and calls error handler', (done) => {
      const largeMessage = 'x'.repeat(300000); // Exceeds MAX_EVENT_MSG_SIZE_BYTES
      const logEvents = [{ message: largeMessage, timestamp: Date.now() }];

      // Mock the getToken flow to reach the truncation logic
      mockAws.describeLogStreams.mockImplementation((_params: any, callback: any) => {
        callback(undefined, { logStreams: [{ logStreamName: 'stream', uploadSequenceToken: null }] });
      });

      lib.upload(mockAws as any, 'group', 'stream', logEvents, 0, {}, (err) => {
        expect(err).toBeDefined();
        expect(err?.message).toBe('Message Truncated because it exceeds the CloudWatch size limit');
        done();
      });
    });

    it('uploads log events successfully', (done) => {
      const logEvents = [
        { message: 'test1', timestamp: Date.now() },
        { message: 'test2', timestamp: Date.now() + 1000 }
      ];

      mockAws.putLogEvents.mockImplementation((params: any, callback: any) => {
        expect(params.logEvents).toHaveLength(2);
        expect(params.logGroupName).toBe('group');
        expect(params.logStreamName).toBe('stream');
        callback(undefined, { nextSequenceToken: 'token' });
      });

      mockAws.describeLogStreams.mockImplementation((_params: any, callback: any) => {
        callback(undefined, { logStreams: [{ logStreamName: 'stream', uploadSequenceToken: null }] });
      });

      lib.upload(mockAws as any, 'group', 'stream', logEvents, 0, {}, (err) => {
        expect(err).toBeUndefined();
        done();
      });
    });
  });

  describe('ensureGroupPresent', () => {
    let mockAws: ReturnType<typeof createMockAws>;

    beforeEach(() => {
      mockAws = createMockAws();
    });

    it('returns true if group already exists', (done) => {
      mockAws.describeLogStreams.mockImplementation((_params: any, callback: any) => {
        callback(undefined, { logStreams: [] });
      });

      lib.ensureGroupPresent(mockAws as any, 'existing-group', 0, (err, result) => {
        expect(err).toBeUndefined();
        expect(result).toBe(true);
        expect(mockAws.createLogGroup).not.toHaveBeenCalled();
        done();
      });
    });

    it('creates a group if it does not exist', (done) => {
      mockAws.describeLogStreams.mockImplementation((_params: any, callback: any) => {
        const error = new Error('Group not found') as any;
        error.name = 'ResourceNotFoundException';
        callback(error);
      });

      mockAws.createLogGroup.mockImplementation((_params: any, callback: any) => {
        callback(undefined, {});
      });

      lib.ensureGroupPresent(mockAws as any, 'new-group', 0, (err, result) => {
        expect(err).toBeUndefined();
        expect(result).toBe(true);
        expect(mockAws.createLogGroup).toHaveBeenCalledWith(
          { logGroupName: 'new-group' },
          expect.any(Function)
        );
        done();
      });
    });
  });

  describe('getStream', () => {
    let mockAws: ReturnType<typeof createMockAws>;

    beforeEach(() => {
      mockAws = createMockAws();
    });

    it('returns existing stream if found', (done) => {
      const existingStream = { logStreamName: 'test-stream', uploadSequenceToken: 'token123' };

      mockAws.describeLogStreams.mockImplementation((_params: any, callback: any) => {
        callback(undefined, { logStreams: [existingStream] });
      });

      lib.getStream(mockAws as any, 'group', 'test-stream', (err, stream) => {
        expect(err).toBeUndefined();
        expect(stream).toEqual(existingStream);
        expect(mockAws.createLogStream).not.toHaveBeenCalled();
        done();
      });
    });

    it('creates stream if not found', (done) => {
      const newStream = { logStreamName: 'new-stream', uploadSequenceToken: null };

      mockAws.describeLogStreams
        .mockImplementationOnce((_params: any, callback: any) => {
          // First call - stream not found
          callback(undefined, { logStreams: [] });
        })
        .mockImplementationOnce((_params: any, callback: any) => {
          // Second call after creation - stream found
          callback(undefined, { logStreams: [newStream] });
        });

      mockAws.createLogStream.mockImplementation((_params: any, callback: any) => {
        callback(undefined, {});
      });

      lib.getStream(mockAws as any, 'group', 'new-stream', (err, stream) => {
        expect(err).toBeUndefined();
        expect(stream).toEqual(newStream);
        expect(mockAws.createLogStream).toHaveBeenCalledWith(
          { logGroupName: 'group', logStreamName: 'new-stream' },
          expect.any(Function)
        );
        done();
      });
    });
  });

  describe('clearSequenceToken', () => {
    it('clears sequence token for given group and stream', () => {
      // Set up a token first
      const state = lib.__getInternalState();
      state.lib._nextToken['group:stream'] = 'test-token';

      lib.clearSequenceToken('group', 'stream');

      expect(state.lib._nextToken['group:stream']).toBeUndefined();
    });
  });
});