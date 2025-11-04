describe('cloudwatch-integration', function () {
  const lib = require('../lib/cloudwatch-integration');
  const sinon = require('sinon');
  const assert = require('node:assert/strict');

  describe('upload', function () {
    const aws = {};

    beforeEach(function () {
      aws.putLogEvents = sinon.stub().resolves();
      aws.putRetentionPolicy = sinon.stub().resolves();
      sinon.stub(lib, 'getToken').resolves('token');
      sinon.stub(lib, 'submitWithAnotherToken').resolves();
      sinon.stub(console, 'error');
    });

    afterEach(function () {
      lib.getToken.restore();
      lib.submitWithAnotherToken.restore();
      console.error.restore();
      lib._nextToken = {};
    });

    it('ignores upload calls if putLogEvents already in progress', async function () {
      const events = [
        { message: 'test message', timestamp: new Date().toISOString() },
      ];
      // First call returns a pending promise (ongoing request)
      const pendingPromise = new Promise(() => {}); // Never resolves
      aws.putLogEvents.onFirstCall().returns(pendingPromise);
      aws.putLogEvents.onSecondCall().resolves();

      const promise1 = lib.upload(aws, 'group', 'stream', events, 0, {
        ensureGroupPresent: true,
      });

      const promise2 = lib.upload(aws, 'group', 'stream', events, 0, {
        ensureGroupPresent: true,
      });

      await promise2;
      // The second upload call should get ignored
      assert.strictEqual(aws.putLogEvents.calledOnce, true);
      delete lib._postingEvents['stream']; // reset
    });

    it('ignores upload calls if getToken already in progress', async function () {
      const events = [
        { message: 'test message', timestamp: new Date().toISOString() },
      ];
      const pendingPromise = new Promise(() => {}); // Never resolves
      lib.getToken.onFirstCall().returns(pendingPromise);
      lib.getToken.onSecondCall().resolves('token');

      const promise1 = lib.upload(aws, 'group', 'stream', events, 0, {
        ensureGroupPresent: true,
      });

      await lib.upload(aws, 'group', 'stream', events, 0, {
        ensureGroupPresent: true,
      });

      // The second upload call should get ignored
      assert.strictEqual(lib.getToken.calledOnce, true);
      delete lib._postingEvents['stream']; // reset
    });

    it('not ignores upload calls if getToken already in progress for another stream', async function () {
      const events = [
        { message: 'test message', timestamp: new Date().toISOString() },
      ];
      const pendingPromise = new Promise(() => {}); // Never resolves
      lib.getToken.onFirstCall().returns(pendingPromise);
      lib.getToken.onSecondCall().resolves('token');

      const promise1 = lib.upload(aws, 'group', 'stream1', events, 0, {
        ensureGroupPresent: true,
      });

      await lib.upload(aws, 'group', 'stream2', events, 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(lib.getToken.calledTwice, true);

      delete lib._postingEvents['stream1']; // reset
      delete lib._postingEvents['stream2']; // reset
    });

    it('truncates very large messages and alerts the error handler', async function () {
      const BIG_MSG_LEN = 300000;
      const events = [
        {
          message: new Array(BIG_MSG_LEN).join('A'),
          timestamp: new Date().toISOString(),
        },
      ];

      // The upload function will throw when it detects oversized message
      try {
        await lib.upload(aws, 'group', 'stream', events, 0, {
          ensureGroupPresent: true,
        });
        throw new Error('Should have thrown');
      } catch (err) {
        assert.strictEqual(
          err.message,
          'Message Truncated because it exceeds the CloudWatch size limit'
        );
      }
    });

    it('batches messages so as not to exceed CW limits', async function () {
      const BIG_MSG_LEN = 250000; // under single limit but a few of these will exceed the batch limit
      const bigMessage = new Array(BIG_MSG_LEN).join(' ');
      const events = [
        { message: bigMessage, timestamp: new Date().toISOString() },
        { message: bigMessage, timestamp: new Date().toISOString() },
        { message: bigMessage, timestamp: new Date().toISOString() },
        { message: bigMessage, timestamp: new Date().toISOString() },
        { message: bigMessage, timestamp: new Date().toISOString() },
      ];

      await lib.upload(aws, 'group', 'stream', events, 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(aws.putLogEvents.calledOnce, true);
      assert.strictEqual(aws.putLogEvents.args[0][0].logEvents.length, 3); // First Batch

      // Now, finish.
      await lib.upload(aws, 'group', 'stream', events, 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(aws.putLogEvents.args[1][0].logEvents.length, 2); // Second Batch
    });

    it('puts log events', async function () {
      await lib.upload(aws, 'group', 'stream', Array(20), 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(aws.putLogEvents.calledOnce, true);
      assert.strictEqual(aws.putLogEvents.args[0][0].logGroupName, 'group');
      assert.strictEqual(aws.putLogEvents.args[0][0].logStreamName, 'stream');
      assert.strictEqual(aws.putLogEvents.args[0][0].logEvents.length, 20);
      assert.strictEqual(aws.putLogEvents.args[0][0].sequenceToken, 'token');
    });

    it('adds token to the payload only if it exists', async function () {
      lib.getToken.resolves(null);

      await lib.upload(aws, 'group', 'stream', Array(20), 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(aws.putLogEvents.calledOnce, true);
      assert.strictEqual(aws.putLogEvents.args[0][0].logGroupName, 'group');
      assert.strictEqual(aws.putLogEvents.args[0][0].logStreamName, 'stream');
      assert.strictEqual(aws.putLogEvents.args[0][0].logEvents.length, 20);
      assert.strictEqual(aws.putLogEvents.args[0][0].sequenceToken, undefined);
    });

    it('does not put if events are empty', async function () {
      await lib.upload(aws, 'group', 'stream', [], 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(aws.putLogEvents.called, false);
    });

    it('errors if getting the token errors', async function () {
      const error = new Error('err');
      lib.getToken.rejects(error);

      try {
        await lib.upload(aws, 'group', 'stream', Array(20), 0, {
          ensureGroupPresent: true,
        });
        throw new Error('Should have thrown');
      } catch (err) {
        assert.strictEqual(err, error);
      }
    });

    it('errors if putting log events errors', async function () {
      const error = new Error('err');
      aws.putLogEvents.rejects(error);

      try {
        await lib.upload(aws, 'group', 'stream', Array(20), 0, {
          ensureGroupPresent: true,
        });
        throw new Error('Should have thrown');
      } catch (err) {
        assert.strictEqual(err, error);
      }
    });

    it('gets another token if InvalidSequenceTokenException', async function () {
      aws.putLogEvents.rejects({ name: 'InvalidSequenceTokenException' });

      await lib.upload(aws, 'group', 'stream', Array(20), 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(lib.submitWithAnotherToken.calledOnce, true);
    });

    it('gets another token if ResourceNotFoundException', async function () {
      aws.putLogEvents.rejects({ name: 'InvalidSequenceTokenException' });

      await lib.upload(aws, 'group', 'stream', Array(20), 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(lib.submitWithAnotherToken.calledOnce, true);
    });

    it('nextToken is saved when available', async function () {
      const nextSequenceToken = 'abc123';
      aws.putLogEvents.resolves({ nextSequenceToken: nextSequenceToken });

      await lib.upload(aws, 'group', 'stream', Array(20), 0, {
        ensureGroupPresent: true,
      });

      sinon.assert.match(lib._nextToken, {
        'group:stream': nextSequenceToken,
      });
    });
  });

  describe('putRetentionPolicy', function () {
    const aws = {};
    beforeEach(function () {
      aws.putRetentionPolicy = sinon.stub().resolves();
    });
    it('only logs retention policy if given > 0', function () {
      lib.putRetentionPolicy(aws, 'group', 1);
      assert.strictEqual(aws.putRetentionPolicy.calledOnce, true);
    });
    it('does not log retention policy if given = 0', function () {
      lib.putRetentionPolicy(aws, 'group', 0);
      assert.strictEqual(aws.putRetentionPolicy.calledOnce, false);
    });
  });

  describe('getToken', function () {
    let aws;

    beforeEach(function () {
      sinon.stub(lib, 'ensureGroupPresent').resolves();
      sinon.stub(lib, 'getStream').resolves();
    });

    afterEach(function () {
      lib.ensureGroupPresent.restore();
      lib.getStream.restore();
    });

    it('ensures group and stream are present if no nextToken for group/stream', async function () {
      lib.ensureGroupPresent.resolves(true);
      lib.getStream.resolves({ uploadSequenceToken: 'token' });

      await lib.getToken(aws, 'group', 'stream', 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(lib.ensureGroupPresent.calledOnce, true);
      assert.strictEqual(lib.getStream.calledOnce, true);
    });

    it('yields token when group and stream are present', async function () {
      lib.ensureGroupPresent.resolves(true);
      lib.getStream.resolves({
        uploadSequenceToken: 'token',
      });

      const token = await lib.getToken(aws, 'group', 'stream', 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(token, 'token');
    });

    it('errors when ensuring group errors', async function () {
      const error = new Error('err');
      lib.ensureGroupPresent.rejects(error);

      try {
        await lib.getToken(aws, 'group', 'stream', 0, {
          ensureGroupPresent: true,
        });
        throw new Error('Should have thrown');
      } catch (err) {
        assert.strictEqual(err, error);
      }
    });

    it('errors when ensuring stream errors', async function () {
      const error = new Error('err');
      lib.getStream.rejects(error);

      try {
        await lib.getToken(aws, 'group', 'stream', 0, {
          ensureGroupPresent: true,
        });
        throw new Error('Should have thrown');
      } catch (err) {
        assert.strictEqual(err, error);
      }
    });

    it('does not ensure group and stream are present if nextToken for group/stream', async function () {
      lib._nextToken = { 'group:stream': 'test123' };

      await lib.getToken(aws, 'group', 'stream', 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(lib.ensureGroupPresent.notCalled, true);
      assert.strictEqual(lib.getStream.notCalled, true);
    });
  });

  describe('ensureGroupPresent', function () {
    let aws;

    beforeEach(function () {
      aws = {
        describeLogStreams: sinon.stub().resolves({}),
      };
      lib.putRetentionPolicy = sinon.stub();
    });

    it('makes sure that a group is present', async function () {
      const isPresent = await lib.ensureGroupPresent(aws, 'group', 0);

      assert.strictEqual(isPresent, true);
      assert.strictEqual(
        lib.putRetentionPolicy.calledWith(aws, 'group', 0),
        true
      );
    });

    it('creates a group if it is not present', async function () {
      const err = { name: 'ResourceNotFoundException' };
      aws.describeLogStreams = sinon.stub().rejects(err);
      aws.createLogGroup = sinon.stub().resolves(null);

      const isPresent = await lib.ensureGroupPresent(aws, 'group', 0);

      assert.strictEqual(
        lib.putRetentionPolicy.calledWith(aws, 'group', 0),
        true
      );
      assert.strictEqual(isPresent, true);
    });

    it('errors if looking for a group errors', async function () {
      const error = new Error('err');
      aws.describeLogStreams = sinon.stub().rejects(error);

      // ensureGroupPresent catches errors and returns true/false instead of throwing
      // It returns true even on non-ResourceNotFoundException errors (line 224-225 in lib)
      const result = await lib.ensureGroupPresent(aws, 'group', 0);

      assert.strictEqual(result, true);
    });

    it('errors if creating a group errors', async function () {
      const notFoundErr = { name: 'ResourceNotFoundException' };
      const error = new Error('err');
      aws.describeLogStreams = sinon.stub().rejects(notFoundErr);
      aws.createLogGroup = sinon.stub().rejects(error);

      // ensureGroupPresent catches errors during createLogGroup and returns false (line 220-222)
      const result = await lib.ensureGroupPresent(aws, 'group', 0);

      assert.strictEqual(result, false);
      assert.strictEqual(lib.putRetentionPolicy.calledOnce, false);
    });
  });

  describe('getStream', function () {
    let aws;

    beforeEach(function () {
      aws = {
        describeLogStreams: sinon.stub().resolves({
          logStreams: [
            {
              logStreamName: 'stream',
            },
            {
              logStreamName: 'another-stream',
            },
          ],
        }),
      };
    });

    it('yields the stream we want', async function () {
      const stream = await lib.getStream(aws, 'group', 'stream');

      assert.strictEqual(stream.logStreamName, 'stream');
    });

    it('errors if getting streams errors', async function () {
      const error = new Error('err');
      aws.describeLogStreams = sinon.stub().rejects(error);

      try {
        await lib.getStream(aws, 'group', 'stream');
        throw new Error('Should have thrown');
      } catch (err) {
        assert.strictEqual(err, error);
      }
    });

    it('errors if creating stream errors', async function () {
      const error = new Error('err');
      aws.describeLogStreams = sinon.stub().resolves([]);
      aws.createLogStream = sinon.stub().rejects(error);

      try {
        await lib.getStream(aws, 'group', 'stream');
        throw new Error('Should have thrown');
      } catch (err) {
        assert.strictEqual(err, error);
      }
    });

    it('ignores in progress error (aborted)', async function () {
      aws.describeLogStreams = sinon.stub();
      aws.describeLogStreams
        .onCall(0)
        .resolves([])
        .onCall(1)
        .resolves({
          logStreams: [
            {
              logStreamName: 'stream',
            },
            {
              logStreamName: 'another-stream',
            },
          ],
        });
      const err = { name: 'OperationAbortedException' };
      aws.createLogStream = sinon.stub().rejects(err);

      const stream = await lib.getStream(aws, 'group', 'stream');

      assert.ok(
        { logStreamName: 'stream' },
        `Expected { logStreamName: "stream" } to exist`
      );
    });

    it('ignores in progress error (already exist)', async function () {
      aws.describeLogStreams = sinon.stub();
      aws.describeLogStreams
        .onCall(0)
        .resolves([])
        .onCall(1)
        .resolves({
          logStreams: [
            {
              logStreamName: 'stream',
            },
            {
              logStreamName: 'another-stream',
            },
          ],
        });
      const err = { name: 'ResourceAlreadyExistsException' };
      aws.createLogStream = sinon.stub().rejects(err);

      const stream = await lib.getStream(aws, 'group', 'stream');

      assert.ok(
        { logStreamName: 'stream' },
        `Expected { logStreamName: "stream" } to exist`
      );
    });
  });

  describe('ignoreInProgress', function () {
    it('can be used to filter callback errors', function (done) {
      function typicalCallback(err, result) {
        assert.strictEqual(err, 'err');
        assert.strictEqual(result, 'result');
        done();
      }

      const filter = lib.ignoreInProgress(typicalCallback);
      assert.ok(
        filter instanceof Function,
        `Expected filter to be instance of Function`
      );
      filter('err', 'result');
    });

    it('ignores a OperationAbortedException', function (done) {
      function runner(cb) {
        const err = { name: 'OperationAbortedException' };
        cb(err);
      }

      runner(
        lib.ignoreInProgress(function (err) {
          assert.strictEqual(err, null);
          done();
        })
      );
    });

    it('ignores a ResourceAlreadyExistsException', function (done) {
      function runner(cb) {
        const err = { name: 'ResourceAlreadyExistsException' };
        cb(err);
      }

      runner(
        lib.ignoreInProgress(function (err) {
          assert.strictEqual(err, null);
          done();
        })
      );
    });

    it('does not ignore any other error', function (done) {
      function runner(cb) {
        const err = { code: 'BoatTooLittleException' };
        cb(err);
      }

      runner(
        lib.ignoreInProgress(function (err) {
          assert.ok(err, `Expected err to exist`);
          assert.strictEqual(err.code, 'BoatTooLittleException');
          done();
        })
      );
    });
  });

  describe('submitWithAnotherToken', function () {
    const aws = {};

    beforeEach(function () {
      aws.putLogEvents = sinon.stub().resolves();
      sinon.stub(lib, 'getToken').resolves('new-token');
      sinon.stub(console, 'error');
    });

    afterEach(function () {
      lib.getToken.restore();
      console.error.restore();
    });

    it('gets a token then resubmits', async function () {
      await lib.submitWithAnotherToken(aws, 'group', 'stream', {}, 0, {
        ensureGroupPresent: true,
      });

      assert.strictEqual(aws.putLogEvents.calledOnce, true);
      assert.strictEqual(
        aws.putLogEvents.args[0][0].sequenceToken,
        'new-token'
      );
    });
  });

  describe('clearSequenceToken', function () {
    const aws = {};

    beforeEach(function () {
      sinon.stub(lib, 'getToken').resolves('token');
    });

    it('clears sequence token set by upload', async function () {
      const nextSequenceToken = 'abc123';
      const group = 'group';
      const stream = 'stream';
      aws.putLogEvents = sinon
        .stub()
        .resolves({ nextSequenceToken: nextSequenceToken });

      await lib.upload(aws, group, stream, Array(20), 0, {});

      assert.deepStrictEqual(lib._nextToken, {
        'group:stream': nextSequenceToken,
      });
      lib.clearSequenceToken(group, stream);
      assert.deepStrictEqual(lib._nextToken, {});
    });

    afterEach(function () {
      lib.getToken.restore();
    });
  });
});
