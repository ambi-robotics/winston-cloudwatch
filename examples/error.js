const winston = require("winston");
const WinstonCloudWatch = require("../index");

// when you don't provide a name the default one
// is CloudWatch
winston.add(
  new WinstonCloudWatch({
    logGroupName: "testing",
    logStreamName: "another",
    awsRegion: "us-east-1",
  })
);

const error1 = new Error("are we doooooomed?");
winston.error({ message: error1 });

// or also

const error2 = new Error("definitely.");
winston.error(error2);
