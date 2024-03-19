import { DeviceMessageHeader, OperatorMessageHeader } from './message-header.mjs';

export interface DeviceMessage<TBody> {
    header: DeviceMessageHeader;
    body: TBody;
}

export interface OperatorMessage<TBody> {
    header: OperatorMessageHeader;
    body: TBody;
}