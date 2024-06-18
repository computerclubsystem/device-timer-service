import { OperatorMessage } from '../declarations/message.mjs';

export interface OperatorAuthRequestMessageBody {
    username: string;
    passwordHash: string;
}

export interface OperatorAuthRequestMessage extends OperatorMessage<OperatorAuthRequestMessageBody> {
}
