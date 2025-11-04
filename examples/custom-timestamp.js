const winston = require("winston");
const WinstonCloudWatch = require("../index");

// Example demonstrating custom timestamp usage
// This is useful when:
// - Replaying historical logs with original timestamps
// - Aggregating logs from multiple sources with their original timestamps
// - Testing with specific timestamps

const logger = winston.createLogger({
  transports: [
    new WinstonCloudWatch({
      logGroupName: "testing",
      logStreamName: "custom-timestamp-example",
      awsRegion: "us-east-1",
    }),
  ],
});

// Example 1: Log with current timestamp (default behavior)
logger.info("This log will use the current timestamp");

// Example 2: Log with a custom timestamp
// Winston allows passing metadata, which can include a timestamp
const historicalTimestamp = new Date("2024-01-01T12:00:00Z").getTime();
logger.info("This is a historical log entry", {
  timestamp: historicalTimestamp,
});

// Example 3: Directly calling add() with explicit timestamp
// This bypasses Winston's normal flow and gives you direct control
const transport = logger.transports[0];
const explicitTimestamp = new Date("2024-06-15T08:30:00Z").getTime();
transport.add(
  {
    level: "info",
    message: "Log with explicit timestamp via add()",
  },
  explicitTimestamp
);

// Example 4: Batch import of logs with original timestamps
const historicalLogs = [
  {
    timestamp: new Date("2024-01-01T10:00:00Z").getTime(),
    level: "info",
    message: "System started",
  },
  {
    timestamp: new Date("2024-01-01T10:05:00Z").getTime(),
    level: "warn",
    message: "High memory usage detected",
  },
  {
    timestamp: new Date("2024-01-01T10:10:00Z").getTime(),
    level: "error",
    message: "Connection timeout",
  },
];

historicalLogs.forEach((log) => {
  logger.log(log.level, log.message, { timestamp: log.timestamp });
});

console.log("Logs queued. They will be uploaded in batches.");
console.log("Note: Process will remain running due to setInterval.");
console.log(
  "Press Ctrl+C to exit, or use transport.kthxbye() to flush and exit."
);
