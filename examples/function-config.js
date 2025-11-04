const winston = require('winston');
const WinstonCloudWatch = require('../index');
const crypto = require('crypto');

// Give ourselves a randomized (time-based) hash to append to our stream name
// so multiple instances of the server running don't log to the same
// date-separated stream.
const startTime = new Date().toISOString();

winston.loggers.add('access-log', {
  transports: [
    new winston.transports.Console({
      json: true,
      colorize: true,
      level: 'info',
    }),
    new WinstonCloudWatch({
      logGroupName: 'app-name',
      logStreamName: function () {
        // Spread log streams across dates as the server stays up
        let date = new Date().toISOString().split('T')[0];
        return (
          'express-server-' +
          date +
          '-' +
          crypto.createHash('md5').update(startTime).digest('hex')
        );
      },
      awsRegion: 'us-east-1',
      jsonMessage: true,
    }),
  ],
});
const log = winston.loggers.get('access-log');

log.info('This is a test');
