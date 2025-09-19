import * as winston from 'winston';
import WinstonCloudWatch from '../index';

const logger = winston.createLogger({
  transports: [
    new WinstonCloudWatch({
      name: 'using-kthxbye',
      logGroupName: 'testing',
      logStreamName: 'another',
      awsRegion: 'us-east-1'
    })
  ]
});

logger.error('1');

// flushes the logs and clears setInterval
const transport = logger.transports.find((t: any) => t.name === 'using-kthxbye') as WinstonCloudWatch;
if (transport) {
  transport.kthxbye(() => console.log('bye'));
}
