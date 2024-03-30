import { OperatorMessage } from '../declarations/message.mjs';

export interface AuthOperatorMessageBody {
    username: string;
    passwordHash: string;
}

export interface AuthOperatorMessage extends OperatorMessage<AuthOperatorMessageBody> {
}


