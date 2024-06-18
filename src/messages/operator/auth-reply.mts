import { OperatorMessage } from '../declarations/message.mjs';

export interface OperatorAuthReplyMessageBody {
    success: boolean;
    token?: string;
}

export interface OperatorAuthReplyMessage extends OperatorMessage<OperatorAuthReplyMessageBody> {
}
