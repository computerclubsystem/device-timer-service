import { DeviceMessage } from '../declarations/message.mjs';

export interface DeviceStatusDeviceMessageBody {
    cpuTemp?: number;
    cpuUsage?: number;
    storageFreeSpace?: number;
    input1Value?: boolean;
    input2Value?: boolean;
    input3Value?: boolean;
    output1Value?: boolean;
    output2Value?: boolean;
    output3Value?: boolean;
    lastTimeAddedAt?: string;
    remainingSeconds?: number;
    currentTime?: string;
}

export interface DeviceStatusDeviceMessage extends DeviceMessage<DeviceStatusDeviceMessageBody> {
}


