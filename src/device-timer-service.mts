import EventEmitter from 'node:events';
import * as fs from 'node:fs';
import { DetailedPeerCertificate } from 'node:tls';

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
import { DeviceStateLog } from './storage/entties/device-state-log.mjs';
import { IDevice } from './storage/entties/device.mjs';
import { DeviceStatusDeviceMessage, DeviceStatusDeviceMessageBody } from './messages/device/device-status-device-message.mjs';

export class DeviceTimerService {
    private devicesWssServer!: WssServer;
    private devicesWssEmitter!: EventEmitter;
    private devicesWebSocketPort = 65445;
    private connectedDevicesData = new Map<number, ConnectedDeviceData>();

    private operatorsWssServer!: WssServer;
    private operatorsWssEmitter!: EventEmitter;
    private operatorsStaticFilesServer?: StaticFilesServer;
    private operatorsWebSocketPort = 65446;
    private connectedOperatorsData = new Map<number, ConnectedOperatorData>();


    private storageProvider!: StorageProvider;
    private logger = new Logger();
    private readonly className = (this as any).constructor.name;

    async start(): Promise<boolean> {
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
        this.devicesWssServer = new WssServer();
        const wssServerConfig: WssServerConfig = {
            cert: fs.readFileSync('./certificates/ccs3.device-timer-service.local.crt').toString(),
            key: fs.readFileSync('./certificates/ccs3.device-timer-service.local.key').toString(),
            port: this.devicesWebSocketPort,
            sendText: true,
        };
        this.devicesWssServer.start(wssServerConfig);
        this.devicesWssEmitter = this.devicesWssServer.getEmitter();
        this.devicesWssEmitter.on(WssServerEventName.clientConnected, args => this.processDeviceConnected(args));
        this.devicesWssEmitter.on(WssServerEventName.connectionClosed, args => this.processDeviceConnectionClosed(args));
        this.devicesWssEmitter.on(WssServerEventName.connectionError, args => this.processDeviceConnectionError(args));
        this.devicesWssEmitter.on(WssServerEventName.messageReceived, args => this.processDeviceMessageReceived(args));
    }

    private async processDeviceConnected(args: ClientConnectedEventArgs): Promise<void> {
        this.logger.log('Device connected', args);
        const certThumbprint = args.certificate?.fingerprint;
        const data: ConnectedDeviceData = {
            connectionId: args.connectionId,
            connectedAt: this.getNow(),
            device: null,
            certificate: args.certificate,
            certificateThumbprint: certThumbprint ? this.getLowercasedCertificateThumbprint(certThumbprint) : '',
            ipAddress: args.ipAddress,
            lastMessageReceivedAt: null,
            receivedMessagesCount: 0,
            sentMessagesCount: 0,
            unknownMessagesReceived: 0,
            isAuthenticated: false,
        };
        this.connectedDevicesData.set(args.connectionId, data);
        if (!args.ipAddress || !args.certificate?.fingerprint) {
            this.logger.warn('The device ip address is unknown or certificate is not provided');
            // TODO: Either disconnect the client or the connection will timeout and the monitoring will disconnect the client
            return;
        }
        try {
            let device = await this.storageProvider.getDeviceByCertificateThumbprint(data.certificateThumbprint);
            if (!device) {
                // Create the device in non-approved state
                device = {
                    approved: false,
                    certificate_thumbprint: data.certificateThumbprint,
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
                    this.devicesWssServer.attachToConnection(args.connectionId);
                }
            }
        } catch (err) {
            this.logger.warn('Cannot get or save device with certificate thumbprint', data.certificateThumbprint, err);
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

    private processOperatorConnected(args: ClientConnectedEventArgs): void {
        this.logger.log('Operator connected', args);
        const data: ConnectedOperatorData = {
            connectionId: args.connectionId,
            username: null,
            connectedAt: this.getNow(),
            ipAddress: args.ipAddress,
            lastMessageReceivedAt: null,
            receivedMessagesCount: 0,
            sentMessagesCount: 0,
            unknownMessagesReceived: 0,
            permissions: null,
            isAuthenticated: false,
        };
        this.connectedOperatorsData.set(args.connectionId, data);
        if (!args.ipAddress) {
            this.logger.warn('The operator ip address is unknown');
            // TODO: Either disconnect the client or the connection will timeout and the monitoring will disconnect the client
            return;
        }
        this.operatorsWssServer.attachToConnection(data.connectionId);
        this.sendJSONToOperatorConnection({ header: { type: 'server-info-reply' }, body: { version: '1.0.0' } }, data.connectionId);
    }

    private sendJSONToOperatorConnection(json: any, connectionId: number): void {
        this.operatorsWssServer.sendJSON({ header: { type: 'server-info-reply' }, body: { version: '1.0.0' } }, connectionId);
    }

    startOperatorsWebSocketServer(): void {
        this.operatorsWssServer = new WssServer();
        const wssServerConfig: WssServerConfig = {
            cert: fs.readFileSync('./certificates/ccs3.device-timer-service.local.crt').toString(),
            key: fs.readFileSync('./certificates/ccs3.device-timer-service.local.key').toString(),
            port: this.operatorsWebSocketPort,
            sendText: true,
        };
        this.operatorsWssServer.start(wssServerConfig);
        this.operatorsWssEmitter = this.operatorsWssServer.getEmitter();
        this.operatorsWssEmitter.on(WssServerEventName.clientConnected, args => this.processOperatorConnected(args));
        this.operatorsWssEmitter.on(WssServerEventName.connectionClosed, args => this.processOperatorConnectionClosed(args));
        this.operatorsWssEmitter.on(WssServerEventName.connectionError, args => this.processOperatorConnectionError(args));
        this.operatorsWssEmitter.on(WssServerEventName.messageReceived, args => this.processOperatorMessageReceived(args));

        const noStaticFilesServing = this.getEnvVarValue(envVars.CCS3_DEVICE_TIMER_SERVICE_NO_STATIC_FILES_SERVING);
        if (noStaticFilesServing !== 'true' && noStaticFilesServing !== '1') {
            const staticFilesPath = this.getEnvVarValue(envVars.CCS3_DEVICE_TIMER_SERVICE_STATIC_FILES_PATH) || './web-app';
            const config = {
                notFoundFile: './index.html',
                path: staticFilesPath,
            } as IStaticFilesServerConfig;
            this.operatorsStaticFilesServer = new StaticFilesServer(config, this.devicesWssServer.getHttpsServer());
            this.operatorsStaticFilesServer.start();
            const resolvedStaticFilesPath = this.operatorsStaticFilesServer.getResolvedPath();
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
        // TODO: Some of the messages does not require authentication, like the message for authentication
        if (!clientData || !clientData.isAuthenticated) {
            // return;
        }
        let msg: OperatorMessage<any> | null;
        let type: OperatorMessageType | undefined;
        try {
            msg = this.deserializeWebSocketBufferToOperatorMessage(args.buffer);
            this.logger.log('Received message from operator', msg);
            type = msg?.header?.type;
            if (!type) {
                return;
            }
        } catch (err) {
            this.logger.warn(`Can't deserialize operator message`, args, err);
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

    deserializeWebSocketBufferToOperatorMessage(buffer: Buffer): OperatorMessage<any> | null {
        const text = buffer.toString();
        const json = JSON.parse(text);
        return json as OperatorMessage<any>;
    }

    private startDeviceConnectionsMonitor(): void {
        setInterval(() => this.cleanUpWebSocketConnections(this.connectedDevicesData, this.devicesWssServer), 10000);
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
        return this.connectedDevicesData.get(connectionId);
    }

    private removeDeviceClient(connectionId: number): void {
        this.connectedDevicesData.delete(connectionId);
    }

    private startOperatorConnectionsMonitor(): void {
        setInterval(() => this.cleanUpWebSocketConnections(this.connectedOperatorsData, this.operatorsWssServer), 10000);
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
        return this.connectedOperatorsData.get(connectionId);
    }

    private removeOperatorClient(connectionId: number): void {
        this.connectedOperatorsData.delete(connectionId);
    }
}

interface ConnectedWebSocketClientData {
    connectionId: number;
    connectedAt: number;
    ipAddress: string | null;
    lastMessageReceivedAt: number | null;
    receivedMessagesCount: number;
    sentMessagesCount: number;
    unknownMessagesReceived: number;
    isAuthenticated: boolean;
}

interface ConnectedDeviceData extends ConnectedWebSocketClientData {
    /**
     * 
     */
    device?: IDevice | null;
    // /**
    //  * Device ID in the system
    //  */
    // deviceId: string | null;
    /**
     * The client certificate
     */
    certificate: DetailedPeerCertificate | null;
    /**
     * certificate.fingeprint without the colon separator and lowercased
     */
    certificateThumbprint: string;
}

interface ConnectedOperatorData extends ConnectedWebSocketClientData {
    username: string | null;
    permissions: Set<string> | null;
}

const enum ConnectionCleanUpReason {
    authenticationTimeout = 'authentication-timeout',
}
