import { DeviceMessage, OperatorMessage } from './messages/declarations/message.mjs';

export class SerializerHelper {
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
}
