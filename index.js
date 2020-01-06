let express = require("express");
let fs = require("fs");
let path = require("path");
let WebSocket = require("ws");
let changeTime = require("change-file-time");

let app = express();

app.use(express.static("public"));

app.set("view engine", "ejs");
app.set("views", "./views");

app.listen(8080);

app.get("/api/getFolders", function (req, res) {
    //if(req.query.secret === "SECCCCCCRET321") {
    let dirs = [];
    scanDir("sync", dirs);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(dirs));
    /*} else {
        res.sendStatus(404);
    }*/
});

let server = new WebSocket.Server({port: 3000});

let fileSending = {};

server.on("connection", ws => {
    ws.on("message", msg => {
        if (msg === "exit") {
            ws.close();
        } else {
            msg = JSON.parse(msg);
            switch (msg["type"]) {
                case "sync": {
                    for(let key in fileSending) {
                        fs.closeSync(fileSending[key]);
                        delete fileSending[key];
                    }

                    let tree = [];
                    let serverDir = "sync" + msg["server"];
                    if (!fs.existsSync(serverDir)) {
                        fs.mkdirSync(serverDir);
                    }
                    scan(serverDir, tree);
                    let difLocal = compareDirs(msg["tree"], tree, serverDir);
                    let difServer = compareDirs(tree, msg["tree"], serverDir);
                    console.log(difLocal);
                    console.log(difServer);
                    difServer.forEach(el => {
                        let pathFile = path.join(el.path, el.local.id);

                        if (el.type === "fileNotExist")
                            fs.unlinkSync(pathFile);
                        if (el.type === "dirNotExist")
                            deleteFolderRecursive(pathFile);
                    });
                    difLocal.forEach(el => {
                        let pathFile = path.join(el.path, el.local.id);
                        let pathRelativeFile = path.join(el.pathRelative, el.local.id);

                        switch (el.type) {
                            case "fileNotExist":
                            case "fileIsDir":
                            case "differentSize":
                            case "differentChangeDate": {
                                if (el.type === "fileIsDir")
                                    deleteFolderRecursive(pathFile);
                                if (el.type === "differentSize" || el.type === "differentChangeDate")
                                    fs.unlinkSync(pathFile);
                                try {
                                    fs.writeFileSync(pathFile, "");
                                } catch (e) {
                                }
                                if(el.local.size !== 0)
                                    ws.send(JSON.stringify({
                                        type: "getFile",
                                        local: msg["local"],
                                        file: pathRelativeFile,
                                        offset: 0
                                    }));
                                break;
                            }
                            case "dirNotExist":
                            case "dirIsFile": {
                                if (el.type === "dirIsFile")
                                    fs.unlinkSync(pathFile);
                                fs.mkdirSync(pathFile);
                                break;
                            }
                        }
                    });
                    break;
                }
                case "sendFile": {
                    let serverDir = "sync" + msg["server"];
                    let pathFile = path.join(serverDir, msg["file"]);
                    let stats = fs.statSync(pathFile);
                    /*if(msg["part"].data.length > (msg["size"] - stats["size"])) {
                        for (let i = msg["part"].data.length - 1; i >= (msg["size"] - stats["size"]); i--) {
                            msg["part"].data.splice(i, 1);
                        }
                    }*/
                    console.log(msg["part"].data.length);
                    let buf = Buffer.alloc(msg["part"].data.length);
                    for (let i = 0; i < msg["part"].data.length; i++) {
                        buf.fill(msg["part"].data[i], i, i + 1);
                    }
                    if(fileSending[pathFile] === undefined)
                        fileSending[pathFile] = fs.openSync(pathFile, "w");
                    let fd = fileSending[pathFile];
                    fs.writeSync(fd, buf, 0, msg["part"].data.length, msg["offset"]);
                    //fs.closeSync(fd);
                    console.log(pathFile + ' ' + (msg["size"] - stats["size"]));
                    if (stats["size"] < msg["size"]) {
                        ws.send(JSON.stringify({
                            type: "getFile",
                            local: msg["local"],
                            file: msg["file"],
                            offset: msg["offset"] + msg["part"].data.length
                        }));
                        if(msg["part"].data.length === (msg["size"] - stats["size"])) {
                            console.log('file received');
                            fs.closeSync(fileSending[pathFile]);
                            delete fileSending[pathFile];
                            fs.utimesSync(pathFile, new Date(msg["change"]), new Date(msg["change"]));
                            ws.send(JSON.stringify({
                                type: "fileReceived",
                                local: msg["local"],
                                file: msg["file"]
                            }));
                        }
                    } else if (stats["size"] > msg["size"]) {
                        console.log("very big");
                        fs.unlinkSync(pathFile);
                        ws.send(JSON.stringify({
                            type: "getFile",
                            local: msg["local"],
                            file: msg["file"],
                            offset: 0
                        }));
                    }
                }
            }
        }
    });
    ws.send(JSON.stringify({type: "connect"}));
});

function compareDirs(local, server, path = "", pathRelative = "") {
    let dif = [];
    for (let fileInd = 0; fileInd < local.length; fileInd++) {
        let fileServer = server.find(el => el["id"] === local[fileInd]["id"]);
        if (!local[fileInd].isDir) {
            if (fileServer === undefined) {
                dif.push({
                    type: "fileNotExist",
                    path: path,
                    pathRelative: pathRelative,
                    local: local[fileInd]
                });
                continue;
            }
            if (fileServer["isDir"]) {
                dif.push({
                    type: "fileIsDir",
                    path: path,
                    pathRelative: pathRelative,
                    local: local[fileInd]
                });
                continue;
            }
            if (fileServer["size"] !== local[fileInd]["size"]) {
                dif.push({
                    type: "differentSize",
                    path: path,
                    pathRelative: pathRelative,
                    local: local[fileInd]
                });
                continue;
            }
            if (Math.abs(fileServer["change"] - local[fileInd]["change"]) >= 100)
                dif.push({
                    type: "differentChangeDate",
                    path: path,
                    pathRelative: pathRelative,
                    local: local[fileInd]
                });
        } else {
            if (fileServer === undefined) {
                dif.push({
                    type: "dirNotExist",
                    path: path,
                    pathRelative: pathRelative,
                    local: local[fileInd]
                });
                continue;
            }
            if (!fileServer["isDir"]) {
                dif.push({
                    type: "dirIsFile",
                    path: path,
                    pathRelative: pathRelative,
                    local: local[fileInd]
                });
                continue;
            }
            path += (path === "" ? "" : "\\");
            pathRelative += (pathRelative === "" ? "" : "\\");
            dif = dif.concat(compareDirs(local[fileInd]["children"], fileServer["children"], path + local[fileInd]["id"], pathRelative + local[fileInd]["id"]));
        }
    }
    return dif;
}

function scanDir(dir, arr) {
    fs.readdirSync(dir).forEach(function (file) {
        let pathFile = path.join(dir, file);
        if (fs.statSync(pathFile).isDirectory()) {
            let dirNew = {
                id: file,
                children: []
            };
            arr.push(dirNew);
            scan(pathFile, dirNew.children);
        }
    });
}

function scan(dir, arr) {
    fs.readdirSync(dir).forEach(file => {
        let pathFile = path.join(dir, file);
        let stats = fs.statSync(pathFile);
        if (stats.isDirectory()) {
            let dirNew = {
                id: file,
                isDir: true,
                children: []
            };
            arr.push(dirNew);
            scan(pathFile, dirNew.children);
        } else {
            let dirNew = {
                id: file,
                isDir: false,
                size: stats["size"],
                change: stats["mtimeMs"]
            };
            arr.push(dirNew);
        }
    });
}

function deleteFolderRecursive(pathStr) {
    if (fs.existsSync(pathStr)) {
        fs.readdirSync(pathStr).forEach((file) => {
            const curPath = path.join(pathStr, file);
            if (fs.lstatSync(curPath).isDirectory()) { // recurse
                deleteFolderRecursive(curPath);
            } else { // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(pathStr);
    }
}
