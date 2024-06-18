import { OperatorMessageType } from '../declarations/message-type.mjs';
import { OperatorAuthReplyMessage, OperatorAuthReplyMessageBody } from './auth-reply.mjs';
import { OperatorServerInfoReplyMessage, OperatorServerInfoReplyMessageBody } from './server-info-reply.mjs';

export class OperatorMessageCreator {
    createOperatorAuthReplyMessage(): OperatorAuthReplyMessage {
        const body = {} as OperatorAuthReplyMessageBody;
        const msg: OperatorAuthReplyMessage = {
            header: {
                type: OperatorMessageType.authReply,
            },
            body,
        };
        return msg;
    };

    createServerInfoReplyMessage(): OperatorServerInfoReplyMessage {
        const body = {} as OperatorServerInfoReplyMessageBody;
        const msg: OperatorServerInfoReplyMessage = {
            header: {
                type: OperatorMessageType.serverInfoReply,
            },
            body,
        };
        return msg;
    }
}
