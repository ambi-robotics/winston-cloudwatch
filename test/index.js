describe('index', function () {
  const assert = require('node:assert/strict');
  const sinon = require('sinon');
  const path = require('path');
  const rewiremock = require('rewiremock/node');

  const stubbedWinston = {
    transports: {},
    Transport: function () {},
  };
  const stubbedCloudwatchIntegration = {
    upload: sinon.spy(
      function (aws, groupName, streamName, logEvents, retention, options) {
        this.lastLoggedEvents = logEvents.splice(0, 20);
        return Promise.resolve();
      }
    ),
    clearSequenceToken: sinon.stub(),
  };
  const clock = sinon.useFakeTimers();

  let WinstonCloudWatch;

  before(function () {
    const indexPath = path.resolve(__dirname, '../index.js');
    const integrationPath = path.resolve(
      __dirname,
      '../lib/cloudwatch-integration'
    );

    WinstonCloudWatch = rewiremock.proxy(() => require(indexPath), {
      winston: stubbedWinston,
      [integrationPath]: stubbedCloudwatchIntegration,
    });
  });

  after(function () {
    clock.restore();
  });

  describe('constructor', function () {
    it('allows cloudWatchLogs', function () {
      const options = {
        cloudWatchLogs: { fakeOptions: { region: 'us-west-2' } },
      };
      const transport = new WinstonCloudWatch(options);
      assert.strictEqual(
        transport.cloudWatchLogs.fakeOptions.region,
        'us-west-2'
      );
    });

    it('allows awsOptions', function () {
      const options = {
        awsOptions: {
          region: 'us-east-1',
        },
      };
      const transport = new WinstonCloudWatch(options);
      transport.cloudWatchLogs.config.region().then((region) => {
        assert.strictEqual(region, 'us-east-1');
      });
    });

    it('merges awsOptions into existing ones', function () {
      const options = {
        region: 'eu-west-1',
        awsOptions: {
          region: 'us-east-1',
        },
      };
      const transport = new WinstonCloudWatch(options);
      return transport.cloudWatchLogs.config.region().then((region) => {
        assert.strictEqual(region, 'us-east-1');
      });
    });
  });

  describe('log', function () {
    let transport;

    beforeEach(function (done) {
      transport = new WinstonCloudWatch({});
      transport.log({ level: 'level' }, function () {
        clock.tick(2000);
        done();
      });
    });

    it('does not upload if empty message', function (done) {
      assert.strictEqual(stubbedCloudwatchIntegration.upload.called, false);
      done();
    });

    it('flushes logs and exits in case of an exception', function (done) {
      transport = new WinstonCloudWatch({});
      transport.log({ message: 'uncaughtException: ' }, function () {
        clock.tick(2000);
        assert.strictEqual(transport.intervalId, null);
        // if done is called it means submit(callback) has been called
        done();
      });
    });

    describe('as json', function () {
      let transport;
      const options = {
        jsonMessage: true,
      };

      before(function (done) {
        transport = new WinstonCloudWatch(options);
        transport.log(
          { level: 'level', message: 'message', something: 'else' },
          function () {
            clock.tick(2000);
            done();
          }
        );
      });

      it('logs json', function () {
        const message =
          stubbedCloudwatchIntegration.lastLoggedEvents[0].message;
        const jsonMessage = JSON.parse(message);
        assert.strictEqual(jsonMessage.level, 'level');
        assert.strictEqual(jsonMessage.message, 'message');
        assert.strictEqual(jsonMessage.something, 'else');
      });
    });

    describe('as text', function () {
      let transport;

      describe('using the default formatter', function () {
        before(function (done) {
          transport = new WinstonCloudWatch({});
          transport.log({ level: 'level', message: 'message' }, done);
          clock.tick(2000);
        });

        it('logs text', function () {
          const message =
            stubbedCloudwatchIntegration.lastLoggedEvents[0].message;
          assert.strictEqual(message, 'level - message');
        });
      });

      describe('using a custom formatter', function () {
        const options = {
          messageFormatter: function (log) {
            return log.level + ' ' + log.message + ' ' + log.something;
          },
        };

        before(function (done) {
          transport = new WinstonCloudWatch(options);
          transport.log(
            { level: 'level', message: 'message', something: 'else' },
            done
          );
          clock.tick(2000);
        });

        it('logs text', function () {
          const message =
            stubbedCloudwatchIntegration.lastLoggedEvents[0].message;
          assert.strictEqual(message, 'level message else');
        });
      });
    });

    describe('info object and a callback as arguments', function () {
      before(function (done) {
        transport = new WinstonCloudWatch({});
        transport.log({ level: 'level', message: 'message' }, function () {
          clock.tick(2000);
          done();
        });
      });

      it('logs text', function () {
        const message =
          stubbedCloudwatchIntegration.lastLoggedEvents[0].message;
        assert.strictEqual(message, 'level - message');
      });
    });

    describe('timestamp handling', function () {
      let transport;

      beforeEach(function () {
        transport = new WinstonCloudWatch({});
      });

      it('uses timestamp from info object when provided', function (done) {
        const customTimestamp = 1234567890;
        transport.log(
          { level: 'level', message: 'message', timestamp: customTimestamp },
          function () {
            clock.tick(2000);
            const loggedEvent =
              stubbedCloudwatchIntegration.lastLoggedEvents[0];
            assert.strictEqual(loggedEvent.timestamp, customTimestamp);
            done();
          }
        );
      });

      it('uses current time when no timestamp provided', function (done) {
        const beforeTime = Date.now();
        transport.log({ level: 'level', message: 'message' }, function () {
          clock.tick(2000);
          const loggedEvent = stubbedCloudwatchIntegration.lastLoggedEvents[0];
          assert.ok(
            Math.abs(loggedEvent.timestamp - beforeTime) <= 100,
            `Expected loggedEvent.timestamp to be approximately beforeTime ± 100`
          );
          done();
        });
      });

      it('passes timestamp from add method explicitly', function () {
        const customTimestamp = 9876543210;
        transport.add({ level: 'level', message: 'message' }, customTimestamp);
        clock.tick(2000);
        const loggedEvent = stubbedCloudwatchIntegration.lastLoggedEvents[0];
        assert.strictEqual(loggedEvent.timestamp, customTimestamp);
      });

      it('prioritizes explicit timestamp over log.timestamp', function () {
        const explicitTimestamp = 1111111111;
        const logTimestamp = 2222222222;
        transport.add(
          { level: 'level', message: 'message', timestamp: logTimestamp },
          explicitTimestamp
        );
        clock.tick(2000);
        const loggedEvent = stubbedCloudwatchIntegration.lastLoggedEvents[0];
        assert.strictEqual(loggedEvent.timestamp, explicitTimestamp);
      });
    });

    describe('handles error', function () {
      let consoleErrorStub;

      beforeEach(function () {
        stubbedCloudwatchIntegration.upload = sinon
          .stub()
          .rejects(new Error('ERROR'));
        consoleErrorStub = sinon.stub(console, 'error');
      });

      afterEach(function () {
        stubbedCloudwatchIntegration.upload = sinon.spy(
          function (aws, groupName, streamName, logEvents, retention, options) {
            this.lastLoggedEvents = logEvents.splice(0, 20);
            return Promise.resolve();
          }
        );
        if (consoleErrorStub && consoleErrorStub.restore) {
          consoleErrorStub.restore();
        }
      });

      it('invoking errorHandler if provided', async function () {
        const errorHandlerSpy = sinon.spy();
        const transport = new WinstonCloudWatch({
          errorHandler: errorHandlerSpy,
        });
        transport.log({ level: 'level', message: 'message' }, sinon.stub());
        await clock.tickAsync(2000);
        assert.strictEqual(errorHandlerSpy.args[0][0].message, 'ERROR');
      });

      it('console.error if errorHandler is not provided', async function () {
        const transport = new WinstonCloudWatch({});
        transport.log({ level: 'level', message: 'message' }, sinon.stub());
        await clock.tickAsync(2000);
        assert.strictEqual(console.error.args[0][0].message, 'ERROR');
      });
    });
  });

  describe('ktxhbye', function () {
    let transport;

    beforeEach(function () {
      sinon.stub(global, 'setInterval');
      sinon.stub(global, 'clearInterval');
      transport = new WinstonCloudWatch({});
      sinon.stub(transport, 'submit').callsFake(function (cb) {
        this.logEvents.splice(0, 20);
        cb();
      });
    });

    afterEach(function () {
      global.setInterval.restore();
      global.clearInterval.restore();
      transport.submit.restore();
    });

    it('clears the interval', function (done) {
      transport.intervalId = 'fake';

      transport.kthxbye(function () {
        assert.strictEqual(global.clearInterval.callCount, 1);
        assert.strictEqual(transport.intervalId, null);
        done();
      });
    });

    it('submit the logs', function (done) {
      transport.kthxbye(function () {
        assert.strictEqual(transport.submit.callCount, 1);
        done();
      });
    });

    it('should not send all messages if called while posting', function (done) {
      for (let index = 0; index < 30; index++) {
        transport.add({ message: 'message' + index });
      }

      transport.kthxbye(function () {
        assert.strictEqual(transport.logEvents.length, 0);
        done();
      });

      clock.tick(1);
    });

    it('should exit if logs are not cleared by the timeout period', function (done) {
      transport.add({ message: 'message' });
      transport.submit.callsFake(function (cb) {
        clock.tick(500);
        cb(); // callback is called but logEvents is not cleared
      });

      transport.kthxbye(function (error) {
        assert.ok(error instanceof Error, `Expected error to be an Error`);
        assert.strictEqual(transport.logEvents.length, 1);
        done();
      });

      clock.tick(1);
    });
  });
});
