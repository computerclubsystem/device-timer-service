import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import * as url from 'node:url';

export class StaticFilesServer {
    private eventEmitter = new EventEmitter();
    private resolvedPath = '';
    private basePath = '';
    private readonly mimeMap: { [key: string]: string } = {};
    private totalRequests = 0;
    private reqHandler = (req: any, res: any): void => this.requestCallback(req, res);

    /**
     * Creates new instance using provided configuration
     */
    constructor(
        private readonly config: IStaticFilesServerConfig,
        private readonly httpServer: https.Server | http.Server
    ) {
        this.mimeMap = this.createMimeMap(config.mimeMap);
    }

    /**
     * Attaches listener to 'request' event of the provided server to serve static files
     */
    start(): void {
        this.basePath = this.config.path;
        this.resolvedPath = path.resolve(this.config.path);
        this.httpServer.addListener('request', this.reqHandler);
    }

    /**
     * Stops serving static files
     */
    stop(): void {
        this.httpServer.removeListener('request', this.reqHandler);
    }

    getEventEmitter(): EventEmitter {
        return this.eventEmitter;
    }

    getResolvedPath(): string {
        return this.resolvedPath;
    }

    private requestCallback(request: http.IncomingMessage, response: http.ServerResponse): void {
        this.totalRequests++;
        const requestId = this.totalRequests;
        this.emitRequestArrived(request, response, requestId);

        if (!this.isHttpMethodSupported(request.method)) {
            this.respondMethodNotAllowed(response);
            return;
        }
        if (!this.isUrlSafe(request.url)) {
            this.emitUnsafeUrl(request.url);
            this.respondNotFound(requestId, request, response);
            return;
        }
        this.serveUrl(request.url, requestId, request, response);
    }

    private getDesiredPath(requestUrl?: string): string {
        requestUrl = requestUrl || '';
        const urlPathName = url.parse(requestUrl).pathname || '';
        const decodedUrl = decodeURI(urlPathName);
        return path.join(this.basePath, decodedUrl);
    }

    private serveUrl(
        requestUrl: string | undefined, requestId: number, request: http.IncomingMessage, response: http.ServerResponse
    ): void {
        let fileReadStream: fs.ReadStream;
        const startTime = Date.now();
        request.on('error', () => {
            this.closeReadStream(fileReadStream);
        });

        request.on('close', () => {
            this.closeReadStream(fileReadStream);
        });

        response.on('error', () => {
            this.closeReadStream(fileReadStream);
        });

        response.on('finish', () => {
            const endTime = Date.now();
            this.emitResponseSent(request, response, endTime - startTime, requestId);
        });
        let desiredPath = this.getDesiredPath(requestUrl);
        this.emitDesiredPath(desiredPath);
        fs.stat(desiredPath, (err, stats) => {
            if (err) {
                this.closeReadStream(fileReadStream);
                this.emitErr(err);
                this.respondNotFound(requestId, request, response);
                return;
            }
            if (stats.isDirectory()) {
                if (!this.config.defaultFileName) {
                    this.respondNotFound(requestId, request, response);
                    return;
                }
                desiredPath = path.join(desiredPath, this.config.defaultFileName);
            }

            const mimeType = this.getMimeType(path.extname(desiredPath));
            if (!mimeType) {
                // This file extension is not allowed
                this.respondNotFound(requestId, request, response);
                return;
            }
            this.emitFileResolved(desiredPath, mimeType, requestId);
            fileReadStream = this.createFileReadStream(desiredPath);
            response.setHeader('Content-Type', mimeType);
            this.setCustomHeaders(response, this.config.responseHeaders);
            fileReadStream.on('error', (fileReadErr: Error) => {
                this.closeReadStream(fileReadStream);
                if ((fileReadErr as any).code === 'ENOENT') {
                    // File was not found. This could happen if fs.stats was executed on an existing file/directory
                    // but it was later changed to a non existing file before fs.createReadStream is called
                    // It happens if URL is a directory and the default file name was added to it which could not exists
                    this.respondNotFound(requestId, request, response);
                } else {
                    this.respondInternalServerError(response);
                }
            });
            fileReadStream.pipe(response);
        });
    }

    private setCustomHeaders(response: http.ServerResponse, customHeaders?: Record<string, string>): void {
        if (!customHeaders) {
            return;
        }
        Object.keys(customHeaders).forEach(headerName => response.setHeader(headerName, customHeaders[headerName]));
    }

    private createFileReadStream(filePath: string): fs.ReadStream {
        return fs.createReadStream(filePath);
    }

    private closeReadStream(stream?: fs.ReadStream): void {
        if (stream) {
            stream.close();
        }
    }

    private getMimeType(fileExtension: string): string {
        fileExtension = fileExtension || '';
        let ext = fileExtension.toLowerCase().substring(1);
        if (ext === '') {
            // Files without extensions will map to . map
            ext = '.';
        }
        return this.mimeMap.hasOwnProperty(ext) ? this.mimeMap[ext] : this.mimeMap['*'];
    }

    private isHttpMethodSupported(httpMethod?: string): boolean {
        return (httpMethod === 'GET');
    }

    private isUrlSafe(urlValue?: string): boolean {
        // Consider URL is safe if empty or if not containing any double dots (..)
        return !urlValue || (urlValue.indexOf('..') === -1);
    }

    private respondNotFound(requestId: number, request: http.IncomingMessage, response: http.ServerResponse): void {
        if (this.config.notFoundFile) {
            const fileExists = fs.existsSync(path.join(this.resolvedPath, this.config.notFoundFile));
            if (fileExists) {
                this.serveUrl(this.config.notFoundFile, requestId, request, response);
                return;
            }
        }

        response.statusCode = 404;
        response.end('Not Found');
    }

    private respondMethodNotAllowed(response: http.ServerResponse): void {
        response.statusCode = 405;
        response.end('Method Not Allowed');
    }

    private respondInternalServerError(response: http.ServerResponse): void {
        response.statusCode = 500;
        response.end('Internal Server Error');
    }

    private createMimeMap(overwrites?: { [key: string]: string }): { [key: string]: string } {
        const map: { [key: string]: string } = {
            'css': 'text/css',
            'gif': 'image/gif',
            'html': 'text/html',
            'ico': 'image/x-icon',
            'jpeg': 'image/jpeg',
            'jpg': 'image/jpeg',
            'js': 'application/javascript',
            'json': 'application/json',
            'otf': 'font/otf',
            'png': 'image/png',
            'svg': 'image/svg+xml',
            'ttf': 'font/ttf',
            'txt': 'text/plain',
            'woff': 'font/woff',
            'woff2': 'font/woff2',
            // tslint:disable-next-line:object-literal-sort-keys
            '.': 'application/octet-stream',
            '*': 'application/octet-stream'
        };

        if (overwrites) {
            Object.assign(map, overwrites);
        }
        return map;
    }

    private emitRequestArrived(request: http.IncomingMessage, response: http.ServerResponse, requestId: number): void {
        const args: IRequestArrivedEventArgs = {
            request: request,
            requestId: requestId,
            response: response
        };
        this.eventEmitter.emit(StaticFilesServerEventName.requestArrived, args);
    }
    private emitFileResolved(filePath: string, contentType: string, requestId: number): void {
        const args: IFileResolvedEventArgs = {
            contentType: contentType,
            path: filePath,
            requestId: requestId
        };
        this.eventEmitter.emit(StaticFilesServerEventName.fileResolved, args);
    }

    private emitDesiredPath(desiredPath: string): void {
        this.eventEmitter.emit(StaticFilesServerEventName.desiredPath, desiredPath);
    }

    private emitUnsafeUrl(unsafeUrl?: string): void {
        this.eventEmitter.emit(StaticFilesServerEventName.unsafeUrl, unsafeUrl);
    }

    private emitErr(err: NodeJS.ErrnoException): void {
        this.eventEmitter.emit(StaticFilesServerEventName.err, err);
    }

    private emitResponseSent(
        request: http.IncomingMessage,
        response: http.ServerResponse,
        duration: number,
        requestId: number
    ): void {
        const args: IResponseSent = {
            duration: duration,
            request: request,
            requestId: requestId,
            response: response
        };
        this.eventEmitter.emit(StaticFilesServerEventName.responseSent, args);
    }
}

export interface IStaticFilesServerConfig {
    path: string;
    defaultFileName: string;
    mimeMap?: { [key: string]: string };
    notFoundFile: string;
    responseHeaders?: Record<string, string>;
}

export const enum StaticFilesServerEventName {
    requestArrived = 'request-arrived',
    fileResolved = 'file-resolved',
    responseSent = 'response-sent',
    desiredPath = 'desired-path',
    unsafeUrl = 'unsafe-url',
    err = 'err'
}

export interface IRequestArrivedEventArgs {
    requestId: number;
    request: http.IncomingMessage;
    response: http.ServerResponse;
}

export interface IFileResolvedEventArgs {
    requestId: number;
    path: string;
    contentType: string;
}

export interface IResponseSent {
    requestId: number;
    request: http.IncomingMessage;
    response: http.ServerResponse;
    duration: number;
}

interface IDirectoryEntry {
    isDirectory: boolean;
    path: string;
}
