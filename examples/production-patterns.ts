import { createLogger, format, transports } from 'winston';
import WinstonCloudWatch from '../index';

/**
 * Production-ready patterns and best practices for winston-cloudwatch
 */

// Configuration interface for production logging
interface LoggingConfig {
  environment: string;
  service: string;
  version: string;
  awsRegion: string;
  logLevel: string;
  retention: {
    errors: number;
    general: number;
    audit: number;
  };
}

// Production configuration
const config: LoggingConfig = {
  environment: process.env.NODE_ENV || 'development',
  service: process.env.SERVICE_NAME || 'my-service',
  version: process.env.SERVICE_VERSION || '1.0.0',
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  logLevel: process.env.LOG_LEVEL || 'info',
  retention: {
    errors: 90,  // Keep errors for 90 days
    general: 30, // Keep general logs for 30 days
    audit: 365   // Keep audit logs for 1 year
  }
};

// Pattern 1: Structured logging with consistent format
export const structuredLogger = createLogger({
  level: config.logLevel,
  format: format.combine(
    format.timestamp({ format: 'ISO' }),
    format.errors({ stack: true }),
    format.metadata({ fillExcept: ['message', 'level', 'timestamp', 'label'] }),
    format.json()
  ),
  defaultMeta: {
    service: config.service,
    version: config.version,
    environment: config.environment
  },
  transports: [
    // General application logs
    new WinstonCloudWatch({
      logGroupName: `/${config.environment}/${config.service}/application`,
      logStreamName: () => {
        const date = new Date().toISOString().slice(0, 10);
        const instanceId = process.env.INSTANCE_ID || 'local';
        return `${date}/${instanceId}`;
      },
      awsRegion: config.awsRegion,
      level: 'debug',
      jsonMessage: true,
      retentionInDays: config.retention.general,
      uploadRate: 2000,
      errorHandler: (error) => {
        console.error('CloudWatch logging failed:', error);
      }
    }),

    // Error-specific logs
    new WinstonCloudWatch({
      logGroupName: `/${config.environment}/${config.service}/errors`,
      logStreamName: () => {
        const date = new Date().toISOString().slice(0, 10);
        return `errors-${date}`;
      },
      awsRegion: config.awsRegion,
      level: 'error',
      jsonMessage: true,
      retentionInDays: config.retention.errors,
      uploadRate: 1000 // Faster upload for errors
    }),

    // Console transport for development
    ...(config.environment === 'development' ? [
      new transports.Console({
        format: format.combine(
          format.colorize(),
          format.simple()
        )
      })
    ] : [])
  ]
});

// Pattern 2: Audit logging for compliance
export const auditLogger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'ISO' }),
    format.json()
  ),
  transports: [
    new WinstonCloudWatch({
      logGroupName: `/${config.environment}/${config.service}/audit`,
      logStreamName: () => {
        const date = new Date().toISOString().slice(0, 7); // YYYY-MM for monthly streams
        return `audit-${date}`;
      },
      awsRegion: config.awsRegion,
      jsonMessage: true,
      retentionInDays: config.retention.audit,
      uploadRate: 5000, // Less frequent uploads for audit logs
      ensureLogGroup: true
    })
  ]
});

// Pattern 3: Performance/Metrics logging
export const metricsLogger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'ISO' }),
    format.json()
  ),
  transports: [
    new WinstonCloudWatch({
      logGroupName: `/${config.environment}/${config.service}/metrics`,
      logStreamName: () => {
        const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH for hourly streams
        return `metrics-${hour}`;
      },
      awsRegion: config.awsRegion,
      jsonMessage: true,
      retentionInDays: 7, // Short retention for metrics
      uploadRate: 1000 // Fast uploads for real-time metrics
    })
  ]
});

// Utility functions for different log types

export function logUserAction(userId: string, action: string, metadata: any = {}) {
  auditLogger.info('user_action', {
    userId,
    action,
    ...metadata,
    timestamp: new Date().toISOString()
  });
}

export function logAPICall(method: string, url: string, statusCode: number, duration: number, userId?: string) {
  structuredLogger.info('api_call', {
    http: {
      method,
      url,
      statusCode,
      duration
    },
    userId
  });
}

export function logError(error: Error, context: any = {}) {
  structuredLogger.error('application_error', {
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack
    },
    context
  });
}

export function logMetric(metricName: string, value: number, unit: string = 'Count', dimensions: any = {}) {
  metricsLogger.info('metric', {
    metricName,
    value,
    unit,
    dimensions,
    timestamp: new Date().toISOString()
  });
}

// Pattern 4: Request correlation with context
class RequestContext {
  constructor(
    public requestId: string,
    public userId?: string,
    public sessionId?: string
  ) {}
}

export function createContextualLogger(context: RequestContext) {
  return structuredLogger.child({
    requestId: context.requestId,
    userId: context.userId,
    sessionId: context.sessionId
  });
}

// Pattern 5: Health check and monitoring
export function logHealthCheck(service: string, status: 'healthy' | 'unhealthy', details: any = {}) {
  const level = status === 'healthy' ? 'info' : 'error';
  structuredLogger.log(level, 'health_check', {
    service,
    status,
    details,
    timestamp: new Date().toISOString()
  });
}

// Pattern 6: Database operation logging
export function logDatabaseOperation(
  operation: string,
  table: string,
  duration: number,
  success: boolean,
  error?: Error
) {
  const logData = {
    database: {
      operation,
      table,
      duration,
      success
    }
  };

  if (error) {
    structuredLogger.error('database_error', {
      ...logData,
      error: {
        message: error.message,
        stack: error.stack
      }
    });
  } else {
    structuredLogger.info('database_operation', logData);
  }
}

// Pattern 7: Rate limiting and circuit breaker logging
export function logRateLimit(identifier: string, limit: number, current: number, action: 'allowed' | 'blocked') {
  structuredLogger.warn('rate_limit', {
    identifier,
    limit,
    current,
    action,
    timestamp: new Date().toISOString()
  });
}

// Pattern 8: Security event logging
export function logSecurityEvent(
  eventType: string,
  severity: 'low' | 'medium' | 'high' | 'critical',
  details: any
) {
  auditLogger.warn('security_event', {
    eventType,
    severity,
    details,
    timestamp: new Date().toISOString()
  });
}

// Graceful shutdown pattern
export async function shutdownLoggers(): Promise<void> {
  console.log('Initiating logger shutdown...');

  const loggers = [structuredLogger, auditLogger, metricsLogger];
  const shutdownPromises: Promise<void>[] = [];

  for (const logger of loggers) {
    for (const transport of logger.transports) {
      if (transport instanceof WinstonCloudWatch) {
        shutdownPromises.push(
          new Promise((resolve, reject) => {
            transport.kthxbye((error) => {
              if (error) {
                console.error('Error during transport shutdown:', error);
                reject(error);
              } else {
                resolve();
              }
            });
          })
        );
      }
    }
  }

  try {
    await Promise.allSettled(shutdownPromises);
    console.log('Logger shutdown completed');
  } catch (error) {
    console.error('Error during logger shutdown:', error);
    throw error;
  }
}

// Example usage in an Express.js application
export function setupExpressLogging() {
  // Middleware for request logging
  return (req: any, res: any, next: any) => {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random()}`;
    const context = new RequestContext(requestId, req.user?.id, req.session?.id);

    req.logger = createContextualLogger(context);

    req.logger.info('request_start', {
      method: req.method,
      url: req.originalUrl,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });

    const originalSend = res.send;
    res.send = function(body: any) {
      const duration = Date.now() - startTime;
      req.logger.info('request_end', {
        statusCode: res.statusCode,
        duration,
        responseSize: Buffer.byteLength(body || '')
      });

      logMetric('http_requests_total', 1, 'Count', {
        method: req.method,
        status_code: res.statusCode.toString()
      });

      logMetric('http_request_duration', duration, 'Milliseconds');

      return originalSend.call(this, body);
    };

    next();
  };
}

// Process event handlers
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  try {
    await shutdownLoggers();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  try {
    await shutdownLoggers();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('uncaughtException', (error: Error) => {
  logError(error, { type: 'uncaught_exception' });
  console.error('Uncaught Exception:', error);
  // Give logs time to upload before exiting
  setTimeout(() => process.exit(1), 2000);
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logError(error, { type: 'unhandled_rejection', promise: promise.toString() });
  console.error('Unhandled Rejection:', reason);
});

// Export configuration for testing
export { config };