import EventEmitter from 'node:events';
import { DetailedPeerCertificate } from 'node:tls';

import { IDevice } from './storage/entities/device.mjs';
import { WssServer } from './wss-server.mjs';
import { StaticFilesServer } from './static-files-server.mjs';

export interface ConnectionCertificateData {
    /**
     * The client certificate
     */
    certificate: DetailedPeerCertificate | null;
    /**
     * certificate.fingeprint without the colon separator and lowercased
     */
    certificateThumbprint: string;
}

export interface ConnectedWebSocketClientData {
    connectionId: number;
    connectedAt: number;
    ipAddress: string | null;
    lastMessageReceivedAt: number | null;
    receivedMessagesCount: number;
    sentMessagesCount: number;
    certificateData: ConnectionCertificateData;
    // TODO: These 3 are application specific - we could move them in ConnectedDeviceData / ConnectedOperatorData
    unauthenticatedMessagesCount: number;
    unknownMessagesReceived: number;
    isAuthenticated: boolean;
}

export interface ConnectedDeviceData extends ConnectedWebSocketClientData {
    /**
     * 
     */
    device?: IDevice | null;
    // /**
    //  * Device ID in the system
    //  */
    // deviceId: string | null;
    // /**
    //  * The client certificate
    //  */
    // certificate: DetailedPeerCertificate | null;
    // /**
    //  * certificate.fingeprint without the colon separator and lowercased
    //  */
    // certificateThumbprint: string;
}

export interface ConnectedOperatorData extends ConnectedWebSocketClientData {
    username: string | null;
    permissions: Set<string> | null;
    token: string | null;
}

export const enum ConnectionCleanUpReason {
    authenticationTimeout = 'authentication-timeout',
}

export interface DeviceTimerServiceState {
    devices: DeviceTimerServiceDevicesWrapper;
    operators: DeviceTimerServiceOperatorsWrapper;
}

export interface DeviceTimerServiceDevicesWrapper {
    devicesWssServer: WssServer;
    devicesWssEmitter: EventEmitter;
    devicesWebSocketPort: number;
    connectedDevicesData: Map<number, ConnectedDeviceData>;
    deviceConnectionsMonitorInterval: number;
}

export interface DeviceTimerServiceOperatorsWrapper {
    operatorsWssServer: WssServer;
    operatorsWssEmitter: EventEmitter;
    operatorsStaticFilesServer: StaticFilesServer;
    operatorsWebSocketPort: number;
    connectedOperatorsData: Map<number, ConnectedOperatorData>;
    operatorConnectionsMonitorInterval: number;
    issuedTokensCount: number;
}
