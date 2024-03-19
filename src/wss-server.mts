import EventEmitter from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';
import { DetailedPeerCertificate, TLSSocket } from 'node:tls';
import { TextEncoder } from 'node:util';
import { RawData, WebSocket, WebSocketServer } from 'ws';

export class WssServer {
    private wsServer!: WebSocketServer;
    private clientsByInstance = new Map<WebSocket, number>();
    private clientsByConnectionId = new Map<number, WebSocket>();
    private clientConnectionsTotal = 0;
    private connectionId = 0;
    private httpsServer!: https.Server;
    private config!: WssServerConfig
    private emitter = new EventEmitter();

    start(config: WssServerConfig): void {
        this.config = config;
        this.httpsServer = https.createServer({
            cert: config.cert,
            key: config.key,
            // requestCert is needed so the clients send their certificates
            requestCert: true,
            // Accept invalid / self-signed certificates
            rejectUnauthorized: false,
        });
        // this.httpsServer.listen(8899, '0.0.0.0');
        // this.httpsServer.on('connection', aaa => {
        //     console.log(aaa);
        // });
        // this.httpsServer.on('secureConnection', aaa => {
        //     console.log(aaa);
        // });
        // this.httpsServer.on('connect', (req, socket, ref) => {
        //     console.log(req, socket, ref);
        // });
        this.wsServer = new WebSocketServer({
            server: this.httpsServer,
            // host: '0.0.0.0',
            // port: 65443,
            // 5 MB
            maxPayload: 5 * 1024 * 1024,
            backlog: 50,
            // If set to true, keeps clients in .clients
            // clientTracking: false,
            // verifyClient: (info: any) => {
            //     const ggg = info.req.client.getPeerX509Certificate(true);
            //     console.log(ggg);
            //     console.log(info);
            // },
        });

        this.wsServer.on('connection', (webSocket, request) => this.clientConnected(webSocket, request));
        this.httpsServer.listen(config.port, '0.0.0.0', 50);
    }

    closeConnection(connectionId: number): void {
        const webSocket = this.clientsByConnectionId.get(connectionId);
        if (webSocket) {
            try {
                webSocket.close();
            } catch (err) { }
            this.removeClient(webSocket);
        }
    }

    getHttpsServer(): https.Server {
        return this.httpsServer;
    }

    getConnectionIds(): number[] {
        const ids: number[] = [];
        this.clientsByConnectionId.forEach((webSocket, key) => ids.push(key));
        return ids;
    }

    sendJSON(message: Record<string | number, any>, connectionId: number): number {
        const client = this.clientsByConnectionId.get(connectionId);
        if (!client || client.readyState !== client.OPEN) {
            return 0;
        }

        const data = this.config.sendText ? JSON.stringify(message) : this.toBinary(message);
        client.send(data, err => {
            if (err) {
                console.error('sendJSON error', connectionId, message, err);
            }
        });
        return data.length;
    }

    sendJSONToAll(message: Record<string | number, any>): number {
        let bytesSent = 0;
        this.clientsByConnectionId.forEach((webSocket, id) => {
            bytesSent += this.sendJSON(message, id);
        });
        return bytesSent;
    }

    getEmitter(): EventEmitter {
        return this.emitter;
    }

    private toBinary(obj: Record<string | number, any>): Uint8Array {
        const string = JSON.stringify(obj);
        const te = new TextEncoder();
        const array = te.encode(string);
        return array;
    }

    private clientConnected(webSocket: WebSocket, request: IncomingMessage): void {
        this.clientConnectionsTotal++;
        const socketConnectionId = this.createNewConnectionId();
        this.addNewClient(webSocket, socketConnectionId);

        const tlsSocket = request.socket as TLSSocket;
        const peerCert = tlsSocket.getPeerCertificate(true);
        const clientConnectedEventArgs: ClientConnectedEventArgs = {
            connectionId: socketConnectionId,
            certificate: peerCert,
            ipAddress: request.socket.remoteAddress ?? null,
        };
        this.emitter.emit(WssServerEventName.clientConnected, clientConnectedEventArgs);
    }

    attachToConnection(connectionId: number): boolean {
        const webSocket = this.clientsByConnectionId.get(connectionId);
        if (!webSocket) {
            return false;
        }

        webSocket.on('message', (data: RawData, isBinary: boolean) => {
            if (data instanceof Buffer) {
                const args: MessageReceivedEventArgs = {
                    connectionId: connectionId,
                    buffer: data,
                };
                this.emitter.emit(WssServerEventName.messageReceived, args);
            }
        });

        webSocket.on('ping', (data: Buffer) => {
            console.log('ping', data.toString());
        });

        webSocket.on('error', err => {
            this.closeSocket(webSocket);
            this.removeClient(webSocket);
            const args: ConnectionErrorEventArgs = {
                connectionId: connectionId,
                err
            };
            this.emitter.emit(WssServerEventName.connectionError, args);
        });

        webSocket.on('close', (code: number, reason: Buffer) => {
            this.removeClient(webSocket);
            const args: ConnectionClosedEventArgs = {
                connectionId: connectionId,
            };
            this.emitter.emit(WssServerEventName.connectionClosed, args);
        });

        return true;
    }

    private closeSocket(webSocket: WebSocket): void {
        try {
            webSocket?.close();
        } catch (err) { }
    }

    private createNewConnectionId(): number {
        this.connectionId++;
        return this.connectionId;
    }

    private addNewClient(webSocket: WebSocket, id: number): void {
        this.clientsByInstance.set(webSocket, id);
        this.clientsByConnectionId.set(id, webSocket);
    }

    private removeClient(webSocket: WebSocket): void {
        const id = this.clientsByInstance.get(webSocket);
        if (!id) {
            return;
        }
        this.clientsByInstance.delete(webSocket);
        this.clientsByConnectionId.delete(id);
    }
}

export interface WssServerConfig {
    cert: string;
    key: string;
    port: number;
    sendText?: boolean;
}

export interface ConnectionEventArgs {
    connectionId: number;
}

export interface ClientConnectedEventArgs extends ConnectionEventArgs {
    certificate: DetailedPeerCertificate;
    ipAddress: string | null;
}

export interface MessageReceivedEventArgs extends ConnectionEventArgs {
    buffer: Buffer;
}

export interface ConnectionClosedEventArgs extends ConnectionEventArgs {
}

export interface ConnectionErrorEventArgs extends ConnectionEventArgs {
    err: Error;
}

export const enum WssServerEventName {
    clientConnected = 'client-connected',
    messageReceived = 'message-received',
    connectionClosed = 'connection-closed',
    connectionError = 'connection-error',
}