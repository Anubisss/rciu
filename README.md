# RCIU (Random Capital Instrument Updates)
RCIU is a simple scheduled AWS Lambda function (managed via Serverless) which generates a HTML and a JSON data file and puts them to an AWS S3 bucket.
The JSON data file contains all the instruments (filtered) and also the updates (removed or added) about them.
The HTML file contains a table which shows all the updates from the JSON data file.

Live: http://rciu.anuka.me/

### Note
This is not a Random Capital product. Created for fun and personal usage.

### Deployment
1. ```yarn install```
2. ```./node_modules/.bin/serverless deploy --host-s3-bucket-name S3_BUCKET_NAME```

Check the serverless.yml file for further options.

### License
The MIT License (MIT)
