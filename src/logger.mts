export class Logger {
    private output = console;
    private prefix?: string;

    log(message: string, ...params: any[]): void {
        this.outputMessage(this.output.log, message, ...params);
    }

    warn(message: string, ...params: any[]): void {
        this.outputMessage(this.output.warn, message, ...params);
    }

    error(message: string, ...params: any[]): void {
        this.outputMessage(this.output.error, message, ...params);
    }

    /**
     * Sets prefix text for all messages
     * @param text The text that must be added before each message
     */
    setPrefix(text: string): void {
        this.prefix = text;
    }

    private outputMessage(func: typeof this.output.log, message: string, ...params: any[]): void {
        if (this.prefix) {
            message = this.prefix + ' ' + message;
        }
        func(this.addTime(message), ...params);
    }

    private addTime(message: string): string {
        return `${new Date().toISOString()} : ${message}`;
    }
}
