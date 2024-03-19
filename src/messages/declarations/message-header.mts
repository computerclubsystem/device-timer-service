import { DeviceMessageType, OperatorMessageType } from './message-type.mjs';
import { RoundTripData } from './round-trip-data.mjs';

export interface OperatorMessageHeader {
    type: OperatorMessageType;
    correlationId?: string;
    source?: string;
    target?: string;
    roundTripData?: RoundTripData;
}

export interface DeviceMessageHeader {
    type: DeviceMessageType;
    correlationId?: string;
    roundTripData?: RoundTripData;
}
