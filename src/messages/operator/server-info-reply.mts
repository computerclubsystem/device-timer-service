import { OperatorMessage } from '../declarations/message.mjs';

export interface OperatorServerInfoReplyMessageBody {
    version: string;
}

export interface OperatorServerInfoReplyMessage extends OperatorMessage<OperatorServerInfoReplyMessageBody> {
}
