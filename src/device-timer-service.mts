import EventEmitter from 'node:events';
import * as fs from 'node:fs';
import { DetailedPeerCertificate } from 'node:tls';

import { ClientConnectedEventArgs, ConnectionClosedEventArgs, ConnectionErrorEventArgs, MessageReceivedEventArgs, WssServer, WssServerConfig, WssServerEventName } from './wss-server.mjs';
import { Logger } from './logger.mjs';
import { DeviceMessage, OperatorMessage } from './messages/declarations/message.mjs';
import { DeviceMessageType, OperatorMessageType } from './messages/declarations/message-type.mjs';
import { IStaticFilesServerConfig, StaticFilesServer } from './static-files-server.mjs';
import { envVars } from './env-vars.mjs';

export class DeviceTimerService {
    wssServer!: WssServer;
    wssEmitter!: EventEmitter;
    desktopSwitchCounter = 0;
    connectedClients = new Map<number, ConnectedClientData>();

    private logger = new Logger();
    private staticFilesServer?: StaticFilesServer;
    private webSocketPort = 65445;

    async start(): Promise<void> {
        this.startWebSocketServer();
        this.startDeviceConnectionsMonitor();
        this.serveStaticFiles();
    }

    private startWebSocketServer(): void {
        this.wssServer = new WssServer();
        const wssServerConfig: WssServerConfig = {
            cert: fs.readFileSync('./certificates/ccs3.device-timer-service.local.crt').toString(),
            key: fs.readFileSync('./certificates/ccs3.device-timer-service.local.key').toString(),
            port: 65445
        };
        this.wssServer.start(wssServerConfig);
        this.wssEmitter = this.wssServer.getEmitter();
        this.wssEmitter.on(WssServerEventName.clientConnected, args => this.processDeviceConnected(args));
        this.wssEmitter.on(WssServerEventName.connectionClosed, args => this.processDeviceConnectionClosed(args));
        this.wssEmitter.on(WssServerEventName.connectionError, args => this.processDeviceConnectionError(args));
        this.wssEmitter.on(WssServerEventName.messageReceived, args => this.processDeviceMessageReceived(args));
    }

    private processDeviceConnected(args: ClientConnectedEventArgs): void {
        this.logger.log('Device connected', args);
        const data: ConnectedClientData = {
            connectionId: args.connectionId,
            connectedAt: this.getNow(),
            deviceId: null,
            certificate: args.certificate,
            certificateThumbprint: this.getLowercasedCertificateThumbprint(args.certificate.fingerprint),
            ipAddress: args.ipAddress,
            lastMessageReceivedAt: null,
            receivedMessagesCount: 0,
            isAuthenticated: false,
        };
        this.connectedClients.set(args.connectionId, data);
        if (!args.ipAddress || !args.certificate?.fingerprint) {
            this.logger.warn('The device ip address is unknown or certificate does not have fingerprint');
            // TODO: Wither disconnect the client or the connection will timeout and the monitoring will disconnect the client
            return;
        }
        // TODO: Connect to the database and check if we have such certificate
        //       If there is such certificate, mark the device as connected
        //       If there is no such certificate, send message back and close the con
        // const msg = createBusDeviceGetByCertificateRequestMessage();
        // const roundTripData: ConnectionRoundTripData = {
        //     connectionId: data.connectionId,
        //     certificateThumbprint: data.certificateThumbprint,
        // };
        // msg.header.roundTripData = roundTripData;
        // msg.body.certificateThumbprint = args.certificate.fingerprint.replaceAll(':', '').toLowerCase();
        // msg.body.ipAddress = args.ipAddress;
        // this.publishToDevicesChannel(msg);
    }

    serveStaticFiles(): void {
        const noStaticFilesServing = this.getEnvVarValue(envVars.CCS3_DEVICE_TIMER_SERVICE_NO_STATIC_FILES_SERVING);
        if (noStaticFilesServing !== 'true' && noStaticFilesServing !== '1') {
            const staticFilesPath = this.getEnvVarValue(envVars.CCS3_DEVICE_TIMER_SERVICE_STATIC_FILES_PATH) || './web-app';
            const config = {
                notFoundFile: './index.html',
                path: staticFilesPath,
            } as IStaticFilesServerConfig;
            this.staticFilesServer = new StaticFilesServer(config, this.wssServer.getHttpsServer());
            this.staticFilesServer.start();
            const resolvedStaticFilesPath = this.staticFilesServer.getResolvedPath();
            const staticFilesPathExists = fs.existsSync(resolvedStaticFilesPath);
            if (staticFilesPathExists) {
                this.logger.log('Serving static files from', resolvedStaticFilesPath);
            } else {
                this.logger.warn('Static files path', resolvedStaticFilesPath, 'does not exist');
            }
        }
    }

    getNow(): number {
        return Date.now();
    }

    getEnvVarValue(envVarName: string, defaultValue?: string): string | undefined {
        return process.env[envVarName] || defaultValue;
    }

    private getLowercasedCertificateThumbprint(certificateFingerprint: string): string {
        return certificateFingerprint.replaceAll(':', '').toLowerCase();
    }

    private processDeviceConnectionClosed(args: ConnectionClosedEventArgs): void {
        this.logger.log('Device connection closed', args);
        this.removeClient(args.connectionId);
    }

    private processDeviceConnectionError(args: ConnectionErrorEventArgs): void {
        this.logger.warn('Device connection error', args);
        this.removeClient(args.connectionId);
    }

    private processDeviceMessageReceived(args: MessageReceivedEventArgs): void {
        let msg: DeviceMessage<any> | null;
        let type: DeviceMessageType | undefined;
        try {
            msg = this.deserializeWebSocketBufferToDeviceMessage(args.buffer);
            this.logger.log('Received message from device', msg);
            type = msg?.header?.type;
            if (!type) {
                return;
            }
        } catch (err) {
            this.logger.warn(`Can't deserialize device message`, args, err);
            return;
        }

        switch (type) {
        }

        // switch (type) {
        //     case MessageType....:
        //         this.process...Message(msg, args.connectionId);
        //         break;
        // }
    }

    deserializeWebSocketBufferToDeviceMessage(buffer: Buffer): DeviceMessage<any> | null {
        const text = buffer.toString();
        const json = JSON.parse(text);
        return json as DeviceMessage<any>;
    }

    private startDeviceConnectionsMonitor(): void {
        setInterval(() => this.cleanUpDeviceConnections(), 10000);
    }

    private cleanUpDeviceConnections(): void {
        const connectionIdsWithCleanUpReason = new Map<number, ConnectionCleanUpReason>();
        const now = this.getNow();
        // 20 seconds
        const maxNotAuthenticatedDuration = 20 * 1000;
        for (const entry of this.connectedClients.entries()) {
            const connectionId = entry[0];
            const data = entry[1];
            if (!data.isAuthenticated && (now - data.connectedAt) > maxNotAuthenticatedDuration) {
                connectionIdsWithCleanUpReason.set(connectionId, ConnectionCleanUpReason.authenticationTimeout);
            }
            // Add other conditions
        }

        for (const entry of connectionIdsWithCleanUpReason.entries()) {
            const connectionId = entry[0];
            const data = this.getConnectedClientData(connectionId);
            this.logger.warn('Disconnecting client', connectionId, entry[1], data);
            this.removeClient(connectionId);
            this.wssServer.closeConnection(connectionId);
        }
    }

    private getConnectedClientData(connectionId: number): ConnectedClientData | undefined {
        return this.connectedClients.get(connectionId);
    }

    private removeClient(connectionId: number): void {
        this.connectedClients.delete(connectionId);
    }
}

interface ConnectedClientData {
    connectionId: number;
    connectedAt: number;
    /**
     * Device ID in the system
     */
    deviceId: string | null;
    /**
     * The client certificate
     */
    certificate: DetailedPeerCertificate | null;
    /**
     * certificate.fingeprint without the colon separator and lowercased
     */
    certificateThumbprint: string;
    ipAddress: string | null;
    lastMessageReceivedAt: number | null;
    receivedMessagesCount: number;
    /**
     * Whether the client is authenticated to use the system
     * While the system checks the client, it will not send messages to the client or process messages from it
     */
    isAuthenticated: boolean;
}

const enum ConnectionCleanUpReason {
    authenticationTimeout = 'authentication-timeout',
}
