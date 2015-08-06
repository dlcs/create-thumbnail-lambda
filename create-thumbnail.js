// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var gm = require('gm')
            .subClass({ imageMagick: true }); // Enable ImageMagick integration.
var util = require('util');
var fs = require('fs');

// constants
var widths = [800, 400, 200];
var heights = [600, 300, 150];

var originalWidth = 0;
var originalHeight = 0;

var thumbnailJobs = widths.length;

// get reference to S3 client 
var s3 = new AWS.S3();

exports.handler = function(event, context) {
	// Read options from the event.
	console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
	var srcBucket = event.s3.bucket;
	// Object key may have spaces or unicode non-ASCII characters.
    var srcKey  =  decodeURIComponent(event.s3.key.replace(/\+/g, " "));
	
	var dstBucket = event.targetBucket;
	// srcKey like 2/1/image-id.jp2
	// for base we want 2/1/image-id
	
	var dstKeyBase = srcKey.substring(0, srcKey.lastIndexOf("."));
	
	console.log("srcKey: " + srcKey);
		
		// Download the image from S3, transform, and upload to a different S3 bucket.
		var file = fs.createWriteStream('/tmp/object.jp2');
		s3.getObject({
				Bucket: srcBucket,
				Key: srcKey
			}, function(err, data) {
				if(err) { console.log('error while reading: ' + err); }
				else {
					fs.writeFile('/tmp/object.jp2', data.Body, function(err) {
						if(err) { console.log('error while writing: ' + err); }
						else {
							console.log('got object');

							if(fileExists('/tmp/object.jp2')) {
								console.log('got to thumbnail');
								console.log('widths=' + widths.length);

								for(var i = 0; i < widths.length; i++) {
									var dstKey = dstKeyBase + "/full/" + widths[i] + "," + heights[i] + "/0/default.jpg";
									writeThumbnail(widths[i], heights[i], dstKey, dstBucket, context);
								}
							}
						}
					});
				}
			});
	};

function writeThumbnail(width, height, dstKey, dstBucket, context) {
	console.log('writeThumbnail(' + width + ', ' + height + ', ' + dstKey + ', ' + dstBucket +')');
	var tmpFilename = '/tmp/object-' + width + 'x' + height + '.jpg';
	var readStream = fs.createReadStream('/tmp/object.jp2');
	gm(readStream, '/tmp/object.jp2')
		.size({bufferStream: true}, function(err, size) {
			originalWidth = size.width;
			originalHeight = size.height;
			this.resize(width, height);
			this.write(tmpFilename, function(err) {
				if(err) { console.log('error while writing: ' + err); }
				else {
					console.log('written ' + tmpFilename);
					if(fileExists(tmpFilename)) {
						var readStream2 = fs.createReadStream(tmpFilename);
						
						readStream2.on('open', function() {
							s3.putObject({
								Bucket: dstBucket,
								Key: dstKey,
								Body: readStream2
							}, function(err, response) {
								console.log('got to last callback for ' + tmpFilename + ': ' + dstKey);
								if (err) {
									console.log(err);
								} else {
									console.log('good for ' + dstKey);
									closeContextIfFinished(context);
								}
							});
						});
					}
				}
			});
		});
}

function closeContextIfFinished(context) {
	console.log('reducing number of outstanding jobs (currently: ' + thumbnailJobs + ').');
	thumbnailJobs--;
	if(thumbnailJobs <= 0) {
		console.log('outstanding jobs <= zero. signalling end of context.');
		context.succeed({width: originalWidth, height: originalHeight});
	}
}
	
function fileExists(filename) {
	try {
		stats = fs.lstatSync(filename);
		if(stats.isFile()) {
			// yes it is
			console.log('found ' + filename);
			return true;
		}
	}
	catch(e) {
		// didn't exist at all
		console.log('could not find ' + filename);
		return false;
	}
	return false;
}