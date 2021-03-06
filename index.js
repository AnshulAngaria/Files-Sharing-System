// @ts-check
"use_strict";

const express = require('express');
const formidable = require('formidable');
const path = require('path');
const fs = require('fs');
const os = require('os');
const qr_image = require("qr-image");
const crypto = require('crypto');
const util = require("util");
const chokidar = require('chokidar');






const logDebug = (
    (process.env.NODE_ENV === "debug") ?
    (msg, ...args) => {console.log(msg, ...args.map(arg => util.inspect(arg, false, 10, true)))} :
    (msg, ...args) => {}
)





class LiveCache {
    constructor(filesFolderPath, orderByTime=true) {

        this.orderByTime = orderByTime;


        const rootContent = {
            "folder": true,
            "path": "",
            "contents": {},
            "timestamp": null
        };
        this.rootContent = rootContent;

        const watcher = chokidar.watch(filesFolderPath, {
            cwd: filesFolderPath,
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            alwaysStat: true,
        });
        this.watcher = watcher;

        watcher.on('error', error => {
            logDebug(`LiveCache: error`, error)
            // TODO(baris): Add error handling.
        })

        this.contentPrepPromise = new Promise((resolve) => {
            watcher.on('ready', () => {
                logDebug('Initial scan complete. Ready for changes')
                resolve();
            });
        })

        this._contentOutputJSON = null;
        this.contentOutputMD5 = null;



        function splitPath(pathStr) {
            if(pathStr == '') {
                return [];
            } else {
                return pathStr.split(path.sep);
            }
        }



        function addFolderToCache(pathStr, stats) {
            if(pathStr == "") {
                rootContent["timestamp"] = Math.max(...[stats.ctimeMs, stats.mtimeMs].filter(x => (x != null)))
            } else {
                const pathParts = splitPath(pathStr);
                const partCount = pathParts.length;

                let currentDir = rootContent;
                for (let index = 0; index <= (partCount-2); index++) {
                    // @ts-ignore
                    currentDir = currentDir.contents[pathParts[index]];
                }
                currentDir.contents[pathParts[partCount-1]] = {
                    "folder": true,
                    "path": pathStr,
                    "contents": {},

                    "timestamp": Math.max(...[stats.ctimeMs, stats.mtimeMs].filter(x => (x != null)))
                };
            }
        }


        function addFileToCache(pathStr, stats) {
            if(pathStr == "") {
                console.error("addFileToCache root cannot be a file");
                return;
            }
            const pathParts = splitPath(pathStr);
            const partCount = pathParts.length;

            let currentDir = rootContent;
            for (let index = 0; index <= (partCount-2); index++) {
                // @ts-ignore
                currentDir = currentDir.contents[pathParts[index]];
            }
            currentDir.contents[pathParts[partCount-1]] = {
                "folder": false,
                "path": pathStr,
                "timestamp": Math.max(...[stats.ctimeMs, stats.mtimeMs].filter(x => (x != null))),
                "size": stats.size
            }

        }



        function removeFromCache(pathStr) {
            if(pathStr == "") {
                console.error("removeFromCache root cannot be removed");
                return;
            }
            const pathParts = splitPath(pathStr);
            const partCount = pathParts.length;

            let currentDir = rootContent;
            for (let index = 0; index <= (partCount-2); index++) {
                // @ts-ignore
                currentDir = currentDir.contents[pathParts[index]];
            }
            delete currentDir.contents[pathParts[partCount-1]];
        }

        watcher
            .on('add', (path, stats) => {
                logDebug(`LiveCache: File has been added`, path, stats);
                this._invalidateOutputCache();
                addFileToCache(path, stats);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('change', (path, stats) => {
                logDebug(`LiveCache: File has been changed`, path, stats);
                this._invalidateOutputCache();
                addFileToCache(path, stats);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('unlink', path => {
                logDebug(`LiveCache: File has been removed`, path);
                this._invalidateOutputCache();
                removeFromCache(path);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('addDir',  (path, stats) => {
                logDebug(`LiveCache: Directory has been added`, path, stats);
                this._invalidateOutputCache();
                addFolderToCache(path, stats);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('unlinkDir', path => {
                logDebug(`LiveCache: Directory has been removed`, path);
                this._invalidateOutputCache();
                removeFromCache(path);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('error', error => {
                console.error("LiveCache error:", error);
            })

    }



    _getContentRecursive(baseFolderName, baseFolderContent) {

        const contentNames = Object.keys(baseFolderContent.contents);

        if(contentNames.length == 0) return null;

        let contents = contentNames.map((contentName) => {
            const content = baseFolderContent.contents[contentName];
            if (content.folder) {
                return this._getContentRecursive(contentName, content);
            } else {

                const fileContent = {
                    "folder": false,
                    "name": contentName,
                    "path": content.path,
                    "timestamp": content.timestamp
                }
                return fileContent;
            }
        }).filter(x => x != null);

        if (this.orderByTime) {
            contents = contents.sort((a, b) => {
                if (a.timestamp == null) return 1;
                if (b.timestamp == null) return -1;
                return b.timestamp - a.timestamp;
            });
        }

        return {
            "folder": true,
            "name": baseFolderName,
            "path": baseFolderContent.path,
            "contents": contents,

            "timestamp": baseFolderContent.timestamp,
        }
    }

    _invalidateOutputCache() {
        this._contentOutputJSON = null;
        this.contentOutputMD5 = null;
    }



    prepContentOutput() {
        return this.contentPrepPromise.then(() => {

            if(this.contentOutputMD5 == null) {
                this._contentOutputJSON = this._getContentRecursive(null, this.rootContent);
                this.contentOutputMD5 = crypto.createHash('md5').update(JSON.stringify(this._contentOutputJSON)).digest("hex")
            }
            return [this._contentOutputJSON, this.contentOutputMD5];
        });
    }




    destroy() {
        this.watcher.close().then(() => {
            logDebug("LiveCache destroy")
        })
    }
}

//

function normalizePort(val) {
    const port = parseInt(val, 10);

    if (isNaN(port)) {

        return val;
    }

    if (port >= 0) {

        return port;
    }

    return false;
}

function getAddresses() {
    let interfaces = os.networkInterfaces();
    let addresses = [];
    for (const k in interfaces) {
        for (const k2 in interfaces[k]) {
            let address = interfaces[k][k2];

            if (address.family === 'IPv4' && !address.internal) {
                addresses.push(address.address);
            }
        }
    }
    return addresses;
}

function generateQRCodeIfNotExists(imagePath, address, port) {
    return new Promise((resolve, reject) => {
        fs.exists(imagePath, function (exists) {
            if (exists) {
                resolve();
            } else {
                let qr_svg = qr_image.image(`http://${address}:${port}/`, { type: 'png' });
                qr_svg.pipe(fs.createWriteStream(imagePath))
                    .on("finish", () => { resolve(); })
                    .on("error", () => { reject(); });
            }
        })
    })
}

function getAddressesWQRCodes(publicPath, port) {
    const addresses = getAddresses();
    return Promise.all(addresses.map((address) => {
        const imagePath = path.join(publicPath, `./qr_codes/${address}_${port}.png`);
        return generateQRCodeIfNotExists(imagePath, address, port).catch(() => {

        });
    })).then(() => addresses);
}



let filesFolderPath = path.join(__dirname, 'files'),
    publicPath =  path.join(__dirname, 'public'),
    port = normalizePort( '8080'),
    allowDeletion =  true,
    progressCallback =  function (progress, doneFileName) {
        //TODO: connect to UI when writing the electron app.
        if(progress != null) {
            console.log("Progress: " + Math.floor(progress) + "%");
        } else {
            console.log("Done file", doneFileName);
        }
    },
    errorCallback = function (url, err) {
            if (err.status == 404) {
                console.log("(Not Found) " + url);
            } else {
                console.log("(errorCallback) " + url);
                console.error(err);
            }
        },
    progressThreshold = 10,
    orderByTime = true,
    maxFileSize = (100*1024*1024*1024), // 100GB
    disable = {"info": false, "fileDownload": false};

const vueDistPath = path.join(__dirname, "./node_modules/vue/dist");

let qrCodesPath = path.join(publicPath, "./qr_codes/");
if (!fs.existsSync(qrCodesPath)) {
    fs.mkdirSync(qrCodesPath);
}

const liveCache = new LiveCache(filesFolderPath, orderByTime);

//New express app
const app = express();

//For index. Basically app.get('/',...);
app.use(express.static(publicPath));

//For vue.js
app.use('/vue', express.static(vueDistPath));

//For downloading files
if (!disable.fileDownload) app.use('/f', express.static(filesFolderPath));

app.get('/delete/:filename', function (req, res) {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE'); // Just in case
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,contenttype'); // Just in case
    res.setHeader('Access-Control-Allow-Credentials', "true"); // Just in case

    if (allowDeletion) {
        const filename = decodeURIComponent(req.params.filename);
        const filesFolderFullPath = path.resolve(filesFolderPath);
        const fileFullPath = path.join(filesFolderFullPath, filename);
        logDebug("fileFullPath", fileFullPath);
        if(
            fileFullPath != filesFolderFullPath &&
            fileFullPath.startsWith(filesFolderFullPath)
        ) {
            try {
                fs.unlinkSync(fileFullPath)
                res.sendStatus(200);
            } catch (error) {
                error.status = 404;
                console.error("fs.unlinkSync error", error);
                res.send();
            }
        } else {
            res.statusCode = 500;
            res.send("Invalid filename");
        }
    } else {
        res.sendStatus(500);
    }

});

app.post('/', function (req, res) {



        if (!fs.existsSync(filesFolderPath)) {
            fs.mkdirSync(filesFolderPath);
        }


    const form = new formidable.IncomingForm();

    form.uploadDir = filesFolderPath;

    form.maxFields = 10000;
    form.multiples = true;
    form.maxFileSize = maxFileSize;

    let progress = 0;
    form.on('progress', function (bytesReceived, bytesExpected) {
        const temp = bytesReceived * 100 / bytesExpected;
        if (temp > progress + progressThreshold) {
            progress = Math.floor(temp);
            if (progressCallback) progressCallback(progress, null);
        }
    });

    const foldersCreated = new Map(); // given folder => duplicate handled folder
    form.on('fileBegin', function (webkitRelativePath, file) {

        logDebug("fileBegin", webkitRelativePath, file);

        let {dir:parsedPathDir, name:parsedPathName, ext:parsedPathExt} = path.parse(webkitRelativePath);
        if(parsedPathDir != "") {

            parsedPathDir = parsedPathDir.split(path.sep).reduce((currentPath, folder, index) => {
                let combinedPath = [currentPath, folder, path.sep].join('');
                if(index == 0) {
                    if(foldersCreated.has(folder)) {
                        combinedPath = [currentPath, foldersCreated.get(folder), path.sep].join('');
                    } else {
                        let i = 0;
                        let handledFolder = folder;
                        while(fs.existsSync(path.join(filesFolderPath, combinedPath))) {
                            handledFolder = [folder, " dup", (i++)].join('');
                            combinedPath = [currentPath, handledFolder, path.sep].join('');
                        }
                        foldersCreated.set(folder, handledFolder);
                        fs.mkdirSync(path.join(filesFolderPath, combinedPath));
                    }
                } else {
                    if (!fs.existsSync(path.join(filesFolderPath, combinedPath))) {
                        logDebug("combinedPath", combinedPath);
                        fs.mkdirSync(path.join(filesFolderPath, combinedPath));
                    }
                }
                return combinedPath;
            }, '');
        }

        let fileName = parsedPathName + parsedPathExt;
        let filePath = path.join(filesFolderPath, parsedPathDir, fileName);

        //For not overwriting files.
        let i = 0;
        while (fs.existsSync(filePath)) {
            fileName = [parsedPathName, " dup", (i++), ".", parsedPathExt].join('');
            filePath = path.join(filesFolderPath, parsedPathDir, fileName);
        }

        file.path = filePath;

    });

    form.on('file', function (name, file) {
        logDebug("file done", name, file);
        if (progressCallback) progressCallback(null, file.name);
    });

    form.parse(req, (error, fields, files) => {
        if(error != null) {
            console.error("form error", error);
            res.sendStatus(400);
        } else {
            // logDebug("files", files);
            logDebug("file uploads done");
            res.sendStatus(200);
        }
    });

});

app.get('/info', function (req, res) {

    if (disable.info) {
        res.sendStatus(404);
        return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE'); // Just in case
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,contenttype'); // Just in case
    res.setHeader('Access-Control-Allow-Credentials', "true"); // Just in case

    const addressesPromise = getAddressesWQRCodes(publicPath, port);


    let rootContentPromise;
    if(disable.fileDownload) {
        rootContentPromise = Promise.resolve([null, null]);
    } else if(req.query.md5 != null && liveCache.contentOutputMD5 === req.query.md5) {

        rootContentPromise = Promise.resolve([null, liveCache.contentOutputMD5]);
    } else {
        rootContentPromise = liveCache.prepContentOutput();
    }

    Promise.all([
        addressesPromise,
        rootContentPromise
    ]).then(([addresses, [rootContent, rootContentMD5]]) => {


        const info = {
            "addresses": addresses,
            "port": port,
            "allowDeletion": allowDeletion,
            "rootContent": rootContent,
            "rootContentMD5": rootContentMD5
        };

        res.json(info);
    })

});


app.use(function (req, res, next) {
    if (errorCallback) { // NOTE(baris): Preserved for backwards compatibility.
        var err = new Error('Not Found');

        err.status = 404;

        errorCallback(req.url, err);
    }
    res.sendStatus(404);
});

app.use(function (err, req, res, next) {
    // development error handler
    if (errorCallback) errorCallback(req.url, err);
    res.sendStatus(500);
});

app.listen(port, () => console.log(`listening at http://localhost:${port}`))
