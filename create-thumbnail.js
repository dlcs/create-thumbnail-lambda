// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var gm = require('gm')
            .subClass({ imageMagick: true }); // Enable ImageMagick integration.
var util = require('util');
var fs = require('fs');

// constants for bounding boxes
var widths = [1000, 800, 400, 200];
var heights = [1000, 600, 300, 150];

var originalWidth = 0;
var originalHeight = 0;

var thumbnailJobs = widths.length;
var thumbnailSizes = new Array(widths.length);

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
									
									writeThumbnail(i, widths[i], heights[i], dstKeyBase, dstBucket, context);
								}
							}
						}
					});
				}
			});
	};

function writeThumbnail(index, requiredWidth, requiredHeight, dstKeyBase, dstBucket, context) {
	console.log('writeThumbnail(' + requiredWidth + ', ' + requiredHeight + ', ' + dstKeyBase + ', ' + dstBucket +')');
	var readStream = fs.createReadStream('/tmp/object.jp2');
	gm(readStream, '/tmp/object.jp2')
		.size({bufferStream: true}, function(err, size) {
			originalWidth = size.width;
			originalHeight = size.height;
			
			var width;
			var height;
			
			if(originalWidth <= requiredWidth && height <= requiredHeight) {
				width = originalWidth;
				height = originalHeight;
			} else {
				var scale1 = (requiredWidth / originalWidth);
				var scale2 = (requiredHeight / originalHeight);
				var scale = Math.min(scale1, scale2);
				width = Math.round(scale * originalWidth);
				height = Math.round(scale * originalHeight);
			}
			
			thumbnailSizes[index] = { width: width, height: height };
			
			this.resize(width, height);

			var dstKey = dstKeyBase;

			if(index == 0) {
				this.quality(95);
				dstKey = dstKey + "/low.jpg";
			} else {
				dstKey = dstKey + "/full/" + width + "," + height + "/0/default.jpg";
			}

			var tmpFilename = '/tmp/object-' + width + 'x' + height + '.jpg';

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
									closeContextIfFinished(context, dstBucket, dstKeyBase);
								}
							});
						});
					}
				}
			});
		});
}

function closeContextIfFinished(context, dstBucket, dstKeyBase) {
	console.log('reducing number of outstanding jobs (currently: ' + thumbnailJobs + ').');
	thumbnailJobs--;
	if(thumbnailJobs <= 0) {
		console.log('outstanding jobs <= zero. signalling end of context.');
		var result = {originalWidth: originalWidth, originalHeight: originalHeight, thumbnails: widths.length};
		for(var i = 0; i < widths.length; i++) {
			result[i] = thumbnailSizes[i];
		}
		
		writeInfoJson(dstBucket, dstKeyBase, function() {
			context.succeed(result);
		});
	}
}

function writeInfoJson(dstBucket, dstKeyBase, continuation) {
	
	var s3ThumbsUri = 'http://' + dstBucket + '.s3.eu-west-1.amazonaws.com/' + dstKeyBase;
	
	var thumbSizesSnippet = '';
	for(var i = 1; i < widths.length; i++) { // skip first set of dimensions
		thumbSizesSnippet = thumbSizesSnippet + '{ "width": ' + thumbnailSizes[i].width + ', "height": ' + thumbnailSizes[i].height + ' }';
		if(i < widths.length - 1) {
			thumbSizesSnippet = thumbSizesSnippet + ',\n';
		}
	}
	
	var fileContents =
	'{\n' +
	'"@context":"http://iiif.io/api/image/2/context.json",\n' +
	'"@id":"' + s3ThumbsUri + '",\n' +
	'"profile": [\n' +
    '"http://iiif.io/api/image/2/level0.json",\n' +
    '{\n' +
    '"formats" : [ "jpg" ],\n' +
    '"qualities" : [ "color" ],\n' +
    '"supports" : [ "sizeByWhListed" ]\n' +
    '}\n' +
	'],\n' +
    '"width" : ' + originalWidth + ',\n' +
    '"height" : ' + originalHeight + ',\n' +
    '"sizes" : [\n' +
	thumbSizesSnippet +
	']\n' +
    '}';
	

	s3.putObject({
		Bucket: dstBucket,
		Key: dstKeyBase + '/info.json',
		Body: fileContents,
		ContentType: 'application/json',
	}, function(err, response) {
		console.log('got to last callback for ' + dstKeyBase + '/info.json');
		if (err) {
			console.log(err);
		} else {
			console.log('good for ' + dstKeyBase + '/info.json');
			continuation();
		}
	});
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