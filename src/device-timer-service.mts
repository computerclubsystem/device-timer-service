import EventEmitter from 'node:events';
import * as fs from 'node:fs';

import {
    ClientConnectedEventArgs, ConnectionClosedEventArgs, ConnectionErrorEventArgs,
    MessageReceivedEventArgs, WssServer, WssServerConfig, WssServerEventName
} from './wss-server.mjs';
import { Logger } from './logger.mjs';
import { DeviceMessage, OperatorMessage } from './messages/declarations/message.mjs';
import { DeviceMessageType, OperatorMessageType } from './messages/declarations/message-type.mjs';
import { IStaticFilesServerConfig, StaticFilesServer } from './static-files-server.mjs';
import { envVars } from './env-vars.mjs';
import { PostgreStorageProvider } from './postgre-storage/postgre-storage-provider.mjs';
import { StorageProviderConfig } from './storage/storage-provider-config.mjs';
import { StorageProvider } from './storage/storage-provider.mjs';
import { DeviceStateLog } from './storage/entities/device-state-log.mjs';
import { IDevice } from './storage/entities/device.mjs';
import { DeviceStatusDeviceMessage, DeviceStatusDeviceMessageBody } from './messages/device/device-status-device-message.mjs';
import { ConnectedDeviceData, ConnectedOperatorData, ConnectedWebSocketClientData, ConnectionCertificateData, ConnectionCleanUpReason } from './declarations.mjs';
import { FileSystemHelper } from './file-system-helper.mjs';
import { CryptoHelper } from './crypto-helper.mjs';
import { DetailedPeerCertificate } from 'node:tls';
import { OperatorAuthRequestMessage } from './messages/operator/auth-request.mjs';
import { OperatorMessageCreator } from './messages/operator/message-creator.mjs';

export class DeviceTimerService {
    private state!: DeviceTimerServiceState;
    private operatorMsgCreator = new OperatorMessageCreator();
    private storageProvider!: StorageProvider;
    private readonly logger = new Logger();
    private readonly className = (this as any).constructor.name;
    private readonly fileSystemHelper = new FileSystemHelper();
    private readonly cryptoHelper = new CryptoHelper();

    async start(): Promise<boolean> {
        this.state = this.createState();
        this.logger.setPrefix(this.className);
        const databaseInitialized = await this.initializeDatabase();
        if (!databaseInitialized) {
            this.logger.error('The database cannot be initialized');
            return false;
        }
        this.startDevicesWebSocketServer();
        this.startDeviceConnectionsMonitor();
        this.startOperatorsWebSocketServer();
        this.startOperatorConnectionsMonitor();
        // this.test_startSavingDeviceStateLog();
        return true;
    }

    // private test_startSavingDeviceStateLog(): void {
    //     setInterval(async () => {
    //         const deviceStateLog: DeviceStateLog = {
    //             device_id: 3,
    //             received_at: new Date().toISOString(),
    //         };
    //         await this.storageProvider.addDeviceStateLog(deviceStateLog);
    //     }, 200);
    // }

    private async initializeDatabase(): Promise<boolean> {
        const storageProviderConnectionString = this.getEnvVarValue(envVars.CCS3_DEVICE_TIMER_SERVICE_STORAGE_CONNECTION_STRING);
        this.storageProvider = this.getStorageProvider();
        const storageProviderConfig: StorageProviderConfig = {
            adminConnectionString: this.getEnvVarValue(envVars.CCS3_DEVICE_TIMER_SERVICE_STORAGE_ADMIN_CONNECTION_STRING),
            connectionString: storageProviderConnectionString!,
            databaseMigrationsPath: this.getEnvVarValue(envVars.CCS3_DEVICE_TIMER_SERVICE_STORAGE_PROVIDER_DATABASE_MIGRATION_SCRIPTS_DIRECTORY),
        };
        const initRes = await this.storageProvider.init(storageProviderConfig);
        return initRes.success;
    }

    private getStorageProvider(): StorageProvider {
        return new PostgreStorageProvider();
    }

    private startDevicesWebSocketServer(): void {
        const devicesState = this.state.devices;
        devicesState.devicesWssServer = new WssServer();
        const wssServerConfig: WssServerConfig = {
            // cert: fs.readFileSync('./certificates/ccs3.device-timer-service.local.crt').toString(),
            // key: fs.readFileSync('./certificates/ccs3.device-timer-service.local.key').toString(),
            cert: this.fileSystemHelper.getFileTextContent('./certificates/ccs3.device-timer-service.local.crt'),
            key: this.fileSystemHelper.getFileTextContent('./certificates/ccs3.device-timer-service.local.key'),
            port: devicesState.devicesWebSocketPort,
            sendText: true,
        };
        devicesState.devicesWssServer.start(wssServerConfig);
        devicesState.devicesWssEmitter = devicesState.devicesWssServer.getEmitter();
        devicesState.devicesWssEmitter.on(WssServerEventName.clientConnected, args => this.processDeviceConnected(args));
        devicesState.devicesWssEmitter.on(WssServerEventName.connectionClosed, args => this.processDeviceConnectionClosed(args));
        devicesState.devicesWssEmitter.on(WssServerEventName.connectionError, args => this.processDeviceConnectionError(args));
        devicesState.devicesWssEmitter.on(WssServerEventName.messageReceived, args => this.processDeviceMessageReceived(args));
    }

    private async processDeviceConnected(args: ClientConnectedEventArgs): Promise<void> {
        this.logger.log('Device connected', args);
        // const certThumbprint = args.certificate?.fingerprint;
        // const certData: ConnectionCertificateData = {
        //     certificateThumbprint: certThumbprint ? this.getLowercasedCertificateThumbprint(certThumbprint) : '',
        //     certificate: args.certificate,
        // };
        const data: ConnectedDeviceData = {
            connectionId: args.connectionId,
            connectedAt: this.getNow(),
            device: null,
            certificateData: this.createConnectionCertificateData(args.certificate),
            // certificate: args.certificate,
            // certificateThumbprint: certThumbprint ? this.getLowercasedCertificateThumbprint(certThumbprint) : '',
            ipAddress: args.ipAddress,
            lastMessageReceivedAt: null,
            receivedMessagesCount: 0,
            sentMessagesCount: 0,
            unknownMessagesReceived: 0,
            unauthenticatedMessagesCount: 0,
            isAuthenticated: false,
        };
        this.state.devices.connectedDevicesData.set(args.connectionId, data);
        if (!args.ipAddress || !args.certificate?.fingerprint) {
            this.logger.warn('The device ip address is unknown or certificate is not provided');
            // TODO: Either disconnect the client or the connection will timeout and the monitoring will disconnect the client
            return;
        }
        try {
            let device = await this.storageProvider.getDeviceByCertificateThumbprint(data.certificateData.certificateThumbprint);
            if (!device) {
                // Create the device in non-approved state
                device = {
                    approved: false,
                    certificate_thumbprint: data.certificateData.certificateThumbprint,
                    created_at: this.getNowISO(),
                    enabled: false,
                    id: 0,
                } as IDevice;
                device = await this.storageProvider.saveDevice(device);
                // Newly created devices must be approved before using them
                return;
            } else {
                // Check if device is approved and enabled
                // TODO: Also check if the certificate with this thumbprint is enabled
                if (device.approved && device.enabled) {
                    data.isAuthenticated = true;
                    data.device = device;
                    this.state.devices.devicesWssServer.attachToConnection(args.connectionId);
                }
            }
        } catch (err) {
            this.logger.warn('Cannot get or save device with certificate thumbprint', data.certificateData.certificateThumbprint, err);
        }
        // TODO: Connect to the database and check if we have such certificate
        //       If there is such certificate, mark the device as connected
        //       If there is no such certificate, send message back and close the connection
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

    private processOperatorConnected(args: ClientConnectedEventArgs): void {
        this.logger.log('Operator connected', args);
        const data: ConnectedOperatorData = {
            connectionId: args.connectionId,
            username: null,
            certificateData: this.createConnectionCertificateData(args.certificate),
            // certificate: args.certificate,
            // certificateThumbprint: certThumbprint ? this.getLowercasedCertificateThumbprint(certThumbprint) : '',
            connectedAt: this.getNow(),
            ipAddress: args.ipAddress,
            lastMessageReceivedAt: null,
            receivedMessagesCount: 0,
            sentMessagesCount: 0,
            unknownMessagesReceived: 0,
            unauthenticatedMessagesCount: 0,
            permissions: null,
            token: null,
            isAuthenticated: false,
        };
        this.state.operators.connectedOperatorsData.set(args.connectionId, data);
        if (!args.ipAddress) {
            // The IP address can be undefined if the socket was closed
            this.logger.warn('The operator ip address is not defined. Probably the connection was closed');
            // TODO: Either disconnect the client or the connection will timeout and the monitoring will disconnect the client
            return;
        }
        this.state.operators.operatorsWssServer.attachToConnection(data.connectionId);
        const serverInfoReplyMsg = this.operatorMsgCreator.createServerInfoReplyMessage();
        serverInfoReplyMsg.body.version = '1.0.0';
        this.sendJSONToOperatorConnection(serverInfoReplyMsg, data);
    }

    private sendJSONToOperatorConnection(json: any, connectedOperatorData: ConnectedOperatorData): void {
        connectedOperatorData.sentMessagesCount++;
        this.state.operators.operatorsWssServer.sendJSON(json, connectedOperatorData.connectionId);
    }

    startOperatorsWebSocketServer(): void {
        const operatorsState = this.state.operators;
        operatorsState.operatorsWssServer = new WssServer();
        const wssServerConfig: WssServerConfig = {
            cert: fs.readFileSync('./certificates/ccs3.device-timer-service.local.crt').toString(),
            key: fs.readFileSync('./certificates/ccs3.device-timer-service.local.key').toString(),
            port: operatorsState.operatorsWebSocketPort,
            sendText: true,
        };
        operatorsState.operatorsWssServer.start(wssServerConfig);
        operatorsState.operatorsWssEmitter = operatorsState.operatorsWssServer.getEmitter();
        operatorsState.operatorsWssEmitter.on(WssServerEventName.clientConnected, args => this.processOperatorConnected(args));
        operatorsState.operatorsWssEmitter.on(WssServerEventName.connectionClosed, args => this.processOperatorConnectionClosed(args));
        operatorsState.operatorsWssEmitter.on(WssServerEventName.connectionError, args => this.processOperatorConnectionError(args));
        operatorsState.operatorsWssEmitter.on(WssServerEventName.messageReceived, args => this.processOperatorMessageReceived(args));

        const noStaticFilesServing = this.getEnvVarValue(envVars.CCS3_DEVICE_TIMER_SERVICE_NO_STATIC_FILES_SERVING);
        if (noStaticFilesServing !== 'true' && noStaticFilesServing !== '1') {
            const staticFilesPath = this.getEnvVarValue(envVars.CCS3_DEVICE_TIMER_SERVICE_STATIC_FILES_PATH) || './web-app';
            const config = {
                notFoundFile: './index.html',
                path: staticFilesPath,
            } as IStaticFilesServerConfig;
            operatorsState.operatorsStaticFilesServer = new StaticFilesServer(config, operatorsState.operatorsWssServer.getHttpsServer());
            operatorsState.operatorsStaticFilesServer.start();
            const resolvedStaticFilesPath = operatorsState.operatorsStaticFilesServer.getResolvedPath();
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

    getNowISO(): string {
        return new Date(this.getNow()).toISOString();
    }

    getEnvVarValue(envVarName: string, defaultValue?: string): string | undefined {
        return process.env[envVarName] || defaultValue;
    }

    private getLowercasedCertificateThumbprint(certificateFingerprint: string): string {
        return certificateFingerprint.replaceAll(':', '').toLowerCase();
    }

    private processDeviceConnectionClosed(args: ConnectionClosedEventArgs): void {
        this.logger.log('Device connection closed', args);
        this.removeDeviceClient(args.connectionId);
    }

    private processOperatorConnectionClosed(args: ConnectionClosedEventArgs): void {
        this.logger.log('Operator connection closed', args);
        this.removeOperatorClient(args.connectionId);
    }

    private processDeviceConnectionError(args: ConnectionErrorEventArgs): void {
        this.logger.warn('Device connection error', args);
        this.removeDeviceClient(args.connectionId);
    }

    private processOperatorConnectionError(args: ConnectionErrorEventArgs): void {
        this.logger.warn('Operator connection error', args);
        this.removeOperatorClient(args.connectionId);
    }

    private processDeviceMessageReceived(args: MessageReceivedEventArgs): void {
        const clientData = this.getConnectedDeviceData(args.connectionId);
        if (!clientData || !clientData.isAuthenticated) {
            return;
        }
        let msg: DeviceMessage<any> | null;
        let type: DeviceMessageType | undefined;
        try {
            msg = this.deserializeWebSocketBufferToDeviceMessage(args.buffer);
            this.logger.log('Received message from device', msg);
            type = msg?.header?.type;
            if (!type) {
                return;
            }
            if (type === DeviceMessageType.deviceStatus) {
                this.processDeviceStatusDeviceMessage(msg!, clientData);
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

    private async processDeviceStatusDeviceMessage(msg: DeviceStatusDeviceMessage, clientData: ConnectedDeviceData): Promise<void> {
        try {
            const body = msg.body;
            const deviceStateLog: DeviceStateLog = {
                device_id: clientData.device?.id!,
                received_at: this.getNowISO(),
                cpu_temperature: body.cpuTemp,
                cpu_usage: body.cpuUsage,
                device_time: body.currentTime,
                input1_value: body.input1Value,
                input2_value: body.input2Value,
                input3_value: body.input3Value,
                output1_value: body.output1Value,
                output2_value: body.output2Value,
                output3_value: body.output3Value,
                remaining_seconds: body.remainingSeconds,
                storage_free_space: body.storageFreeSpace,
            };
            await this.storageProvider.addDeviceStateLog(deviceStateLog);
        } catch (err) {
            this.logger.error('Error adding device status log', err);
        }
    }

    private processOperatorMessageReceived(args: MessageReceivedEventArgs): void {
        const clientData = this.getConnectedOperatorData(args.connectionId);
        if (!clientData) {
            return;
        }
        clientData.receivedMessagesCount++;
        let msg: OperatorMessage<any> | null;
        let type: OperatorMessageType | undefined;
        try {
            msg = this.deserializeWebSocketBufferToOperatorMessage(args.buffer);
            type = msg?.header?.type;
            this.logger.log('Received message from operator', type, msg);
            // Some of the messages does not require authentication, like the message for authentication
            if (!this.isAllowedOperatorAnonymousMessage(type) && !clientData.isAuthenticated) {
                // This message type does not allow anonymous processing and the client is not authenticated
                clientData.unauthenticatedMessagesCount++;
                this.logger.warn('Operator message type', type, 'is not allowed for non-authenticated connections');
                return;
            }
            if (!msg || !type) {
                return;
            }
        } catch (err) {
            this.logger.warn(`Can't deserialize operator message`, args, err);
            return;
        }

        clientData.lastMessageReceivedAt = this.getNow();

        switch (type) {
            case OperatorMessageType.authRequest:
                this.processOperatorAuthRequestMessage(msg, clientData);
                break;
            default:
                clientData.unknownMessagesReceived++;
        }

        // switch (type) {
        //     case MessageType....:
        //         this.process...Message(msg, args.connectionId);
        //         break;
        // }
    }

    isAllowedOperatorAnonymousMessage(messageType?: OperatorMessageType): boolean {
        if (messageType === OperatorMessageType.authRequest) {
            return true;
        }
        return false;
    }

    async processOperatorAuthRequestMessage(msg: OperatorAuthRequestMessage, connectedOperatorData: ConnectedOperatorData): Promise<void> {
        try {
            const user = await this.storageProvider.getUser(msg.body.username, msg.body.passwordHash);
            const replyMsg = this.operatorMsgCreator.createOperatorAuthReplyMessage();
            if (!user || !user.enabled) {
                connectedOperatorData.isAuthenticated = false;
                replyMsg.body.success = false;
                this.sendJSONToOperatorConnection(replyMsg, connectedOperatorData);
                return;
            } else {
                connectedOperatorData.username = user.username;
                connectedOperatorData.isAuthenticated = true;
                connectedOperatorData.token = await this.createOperatorAuthenticationToken(connectedOperatorData);
                replyMsg.body.success = true;
                replyMsg.body.token = connectedOperatorData.token;
                this.sendJSONToOperatorConnection(replyMsg, connectedOperatorData);
            }
        } catch (err) {
            this.logger.warn('Cannot get user', msg?.body?.username, err);
        }
    }

    async createOperatorAuthenticationToken(connectedOperatorData: ConnectedOperatorData): Promise<string> {
        this.state.operators.issuedTokensCount++;
        return Promise.resolve('' + this.state.operators.issuedTokensCount + '-' + this.cryptoHelper.createRandomHexString(20));
    }

    deserializeWebSocketBufferToDeviceMessage(buffer: Buffer): DeviceMessage<any> | null {
        const text = buffer.toString();
        const json = JSON.parse(text);
        return json as DeviceMessage<any>;
    }

    deserializeWebSocketBufferToOperatorMessage(buffer: Buffer): OperatorMessage<any> | null {
        const text = buffer.toString();
        const json = JSON.parse(text);
        return json as OperatorMessage<any>;
    }

    private startDeviceConnectionsMonitor(): void {
        setInterval(() => this.cleanUpWebSocketConnections(
            this.state.devices.connectedDevicesData, this.state.devices.devicesWssServer
        ), this.state.devices.deviceConnectionsMonitorInterval);
    }

    // // TODO: Support generic clean up functions for both deviecs and operators
    // private cleanUpDeviceConnections(): void {
    //     const connectionIdsWithCleanUpReason = new Map<number, ConnectionCleanUpReason>();
    //     const now = this.getNow();
    //     // 20 seconds
    //     const maxNotAuthenticatedDuration = 20 * 1000;
    //     for (const entry of this.connectedDevicesData.entries()) {
    //         const connectionId = entry[0];
    //         const data = entry[1];
    //         if (!data.isAuthenticated && (now - data.connectedAt) > maxNotAuthenticatedDuration) {
    //             connectionIdsWithCleanUpReason.set(connectionId, ConnectionCleanUpReason.authenticationTimeout);
    //         }
    //         // Add other conditions
    //     }

    //     for (const entry of connectionIdsWithCleanUpReason.entries()) {
    //         const connectionId = entry[0];
    //         const data = this.getConnectedDeviceData(connectionId);
    //         this.logger.warn('Disconnecting device client', connectionId, entry[1], data);
    //         this.removeDeviceClient(connectionId);
    //         this.devicesWssServer.closeConnection(connectionId);
    //     }
    // }

    private getConnectedDeviceData(connectionId: number): ConnectedDeviceData | undefined {
        return this.state.devices.connectedDevicesData.get(connectionId);
    }

    private removeDeviceClient(connectionId: number): void {
        this.state.devices.connectedDevicesData.delete(connectionId);
    }

    private startOperatorConnectionsMonitor(): void {
        setInterval(() => this.cleanUpWebSocketConnections(this.state.operators.connectedOperatorsData, this.state.operators.operatorsWssServer), 10000);
    }

    private cleanUpWebSocketConnections(
        connectionsClientDataMap: Map<number, ConnectedWebSocketClientData>,
        wssServer: WssServer
    ): void {
        const connectionIdsWithCleanUpReason = new Map<number, ConnectionCleanUpReason>();
        const now = this.getNow();
        // 20 seconds
        const maxNotAuthenticatedDuration = 20 * 1000;
        for (const entry of connectionsClientDataMap.entries()) {
            const connectionId = entry[0];
            const data = entry[1];
            if (!data.isAuthenticated && (now - data.connectedAt) > maxNotAuthenticatedDuration) {
                connectionIdsWithCleanUpReason.set(connectionId, ConnectionCleanUpReason.authenticationTimeout);
            }
            // Add other conditions
        }

        for (const entry of connectionIdsWithCleanUpReason.entries()) {
            const connectionId = entry[0];
            const data = connectionsClientDataMap.get(connectionId);
            this.logger.warn('Disconnecting client', connectionId, entry[1], data);
            connectionsClientDataMap.delete(connectionId);
            wssServer.closeConnection(connectionId);
        }
    }

    // // TODO: Support generic clean up functions for both deviecs and operators
    // private cleanUpOperatorConnections(): void {
    //     const connectionIdsWithCleanUpReason = new Map<number, ConnectionCleanUpReason>();
    //     const now = this.getNow();
    //     // 20 seconds
    //     const maxNotAuthenticatedDuration = 20 * 1000;
    //     for (const entry of this.connectedOperatorsData.entries()) {
    //         const connectionId = entry[0];
    //         const data = entry[1];
    //         if (!data.isAuthenticated && (now - data.connectedAt) > maxNotAuthenticatedDuration) {
    //             connectionIdsWithCleanUpReason.set(connectionId, ConnectionCleanUpReason.authenticationTimeout);
    //         }
    //         // Add other conditions
    //     }

    //     for (const entry of connectionIdsWithCleanUpReason.entries()) {
    //         const connectionId = entry[0];
    //         const data = this.getConnectedOperatorData(connectionId);
    //         this.logger.warn('Disconnecting operator client', connectionId, entry[1], data);
    //         this.removeOperatorClient(connectionId);
    //         this.operatorsWssServer.closeConnection(connectionId);
    //     }
    // }

    private getConnectedOperatorData(connectionId: number): ConnectedOperatorData | undefined {
        return this.state.operators.connectedOperatorsData.get(connectionId);
    }

    private removeOperatorClient(connectionId: number): void {
        this.state.operators.connectedOperatorsData.delete(connectionId);
    }

    private createState(): DeviceTimerServiceState {
        const state = {
            devices: {
                devicesWebSocketPort: 65445,
                connectedDevicesData: new Map<number, ConnectedDeviceData>(),
                deviceConnectionsMonitorInterval: 10000,
            },
            operators: {
                operatorsWebSocketPort: 65446,
                connectedOperatorsData: new Map<number, ConnectedOperatorData>(),
                operatorConnectionsMonitorInterval: 10000,
                issuedTokensCount: 0,
            }
        } as DeviceTimerServiceState;
        return state;
    }

    private createConnectionCertificateData(detailedPeerCertificate: DetailedPeerCertificate | null): ConnectionCertificateData {
        const certThumbprint = detailedPeerCertificate?.fingerprint;
        const certData: ConnectionCertificateData = {
            certificateThumbprint: certThumbprint ? this.getLowercasedCertificateThumbprint(certThumbprint) : '',
            certificate: detailedPeerCertificate,
        };
        return certData;
    }
}

interface DeviceTimerServiceState {
    devices: DeviceTimerServiceDevicesWrapper;
    operators: DeviceTimerServiceOperatorsWrapper;
}

interface DeviceTimerServiceDevicesWrapper {
    devicesWssServer: WssServer;
    devicesWssEmitter: EventEmitter;
    devicesWebSocketPort: number;
    connectedDevicesData: Map<number, ConnectedDeviceData>;
    deviceConnectionsMonitorInterval: number;
}

interface DeviceTimerServiceOperatorsWrapper {
    operatorsWssServer: WssServer;
    operatorsWssEmitter: EventEmitter;
    operatorsStaticFilesServer: StaticFilesServer;
    operatorsWebSocketPort: number;
    connectedOperatorsData: Map<number, ConnectedOperatorData>;
    operatorConnectionsMonitorInterval: number;
    issuedTokensCount: number;
}
