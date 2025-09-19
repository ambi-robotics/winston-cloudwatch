import { createLogger, format, transports } from 'winston';
import WinstonCloudWatch from '../index';

/**
 * Advanced usage example demonstrating various features of winston-cloudwatch
 */

// Example 1: Basic setup with error handling
const basicLogger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new WinstonCloudWatch({
      logGroupName: 'my-app/production',
      logStreamName: 'server-logs',
      awsRegion: 'us-east-1',
      level: 'info',
      jsonMessage: true,
      uploadRate: 2000,
      errorHandler: (error: Error) => {
        console.error('CloudWatch logging error:', error);
      }
    }),
    new transports.Console({ format: format.simple() })
  ]
});

// Example 2: Dynamic log group and stream names based on date
const dynamicLogger = createLogger({
  transports: [
    new WinstonCloudWatch({
      logGroupName: () => {
        const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        return `my-app/logs/${date}`;
      },
      logStreamName: () => {
        const instanceId = process.env.INSTANCE_ID || 'default';
        return `server-${instanceId}`;
      },
      awsRegion: 'us-west-2',
      retentionInDays: 14
    })
  ]
});

// Example 3: Multiple log levels with different destinations
const multiLevelLogger = createLogger({
  transports: [
    // All logs to general stream
    new WinstonCloudWatch({
      logGroupName: 'my-app/all-logs',
      logStreamName: 'general',
      level: 'debug',
      awsRegion: 'us-east-1'
    }),
    // Only errors to error-specific stream
    new WinstonCloudWatch({
      logGroupName: 'my-app/errors',
      logStreamName: 'errors-only',
      level: 'error',
      awsRegion: 'us-east-1',
      retentionInDays: 90
    })
  ]
});

// Example 4: Custom message formatter
const customFormatterLogger = createLogger({
  transports: [
    new WinstonCloudWatch({
      logGroupName: 'my-app/custom',
      logStreamName: 'formatted',
      awsRegion: 'us-east-1',
      messageFormatter: (log) => {
        const timestamp = new Date().toISOString();
        const level = log.level.toUpperCase();
        const message = log.message;
        const meta = log.meta ? JSON.stringify(log.meta) : '';
        return `[${timestamp}] ${level}: ${message} ${meta}`;
      }
    })
  ]
});

// Example 5: High-frequency logging with optimized settings
const highFrequencyLogger = createLogger({
  transports: [
    new WinstonCloudWatch({
      logGroupName: 'my-app/high-frequency',
      logStreamName: 'metrics',
      awsRegion: 'us-east-1',
      uploadRate: 500, // Upload every 500ms for high-frequency logs
      jsonMessage: true,
      ensureLogGroup: true
    })
  ]
});

// Example usage functions

export function demonstrateBasicUsage() {
  basicLogger.info('Application started');
  basicLogger.warn('This is a warning message', { userId: 123 });
  basicLogger.error('An error occurred', new Error('Sample error'));
}

export function demonstrateDynamicNames() {
  dynamicLogger.info('Dynamic log group and stream names');
  dynamicLogger.debug('Debug message with dynamic naming');
}

export function demonstrateMultiLevel() {
  multiLevelLogger.debug('Debug message - only goes to general stream');
  multiLevelLogger.info('Info message - only goes to general stream');
  multiLevelLogger.error('Error message - goes to both streams');
}

export function demonstrateCustomFormatter() {
  customFormatterLogger.info('Custom formatted message', { requestId: 'req-123' });
}

export function demonstrateHighFrequency() {
  // Simulate high-frequency logging
  for (let i = 0; i < 10; i++) {
    highFrequencyLogger.info('High frequency log', {
      counter: i,
      timestamp: Date.now(),
      memory: process.memoryUsage()
    });
  }
}

// Example: Graceful shutdown with log flushing
export async function gracefulShutdown() {
  console.log('Shutting down gracefully...');

  // Get all CloudWatch transports
  const cloudWatchTransports = [basicLogger, dynamicLogger, multiLevelLogger, customFormatterLogger, highFrequencyLogger]
    .flatMap(logger => logger.transports)
    .filter(transport => transport instanceof WinstonCloudWatch) as WinstonCloudWatch[];

  // Flush all pending logs
  const flushPromises = cloudWatchTransports.map(transport =>
    new Promise<void>((resolve, reject) => {
      transport.kthxbye((error) => {
        if (error) reject(error);
        else resolve();
      });
    })
  );

  try {
    await Promise.all(flushPromises);
    console.log('All logs flushed successfully');
  } catch (error) {
    console.error('Error flushing logs:', error);
  }
}

// Handle process shutdown
process.on('SIGINT', async () => {
  await gracefulShutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await gracefulShutdown();
  process.exit(0);
});

// Example: Error handling and recovery
export function demonstrateErrorHandling() {
  const robustLogger = createLogger({
    transports: [
      new WinstonCloudWatch({
        logGroupName: 'my-app/robust',
        logStreamName: 'error-handling',
        awsRegion: 'us-east-1',
        errorHandler: (error: Error) => {
          console.error('CloudWatch error:', error.message);
          // Could implement fallback logging here (file, database, etc.)
        }
      }),
      // Fallback to console if CloudWatch fails
      new transports.Console({
        format: format.simple(),
        handleExceptions: true
      })
    ]
  });

  robustLogger.info('This log should work normally');
  robustLogger.error('Error log with stack trace', new Error('Test error'));
}

// Run examples if script is executed directly
if (require.main === module) {
  console.log('Running winston-cloudwatch examples...');

  demonstrateBasicUsage();
  demonstrateDynamicNames();
  demonstrateMultiLevel();
  demonstrateCustomFormatter();
  demonstrateHighFrequency();
  demonstrateErrorHandling();

  // Let logs process for a bit before shutdown
  setTimeout(async () => {
    await gracefulShutdown();
  }, 5000);
}