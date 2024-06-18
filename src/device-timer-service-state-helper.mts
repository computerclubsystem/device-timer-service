import { DeviceTimerServiceState, ConnectedDeviceData, ConnectedOperatorData } from './declarations.mjs';

export class DeviceTimerServiceStateHelper {
    createState(): DeviceTimerServiceState {
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
}
