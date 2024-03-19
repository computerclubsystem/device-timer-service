export class Logger {
    private output = console;

    log(message: string, ...params: any[]): void {
        this.outputMessage(this.output.log, message, ...params);
    }

    warn(message: string, ...params: any[]): void {
        this.outputMessage(this.output.warn, message, ...params);
    }

    error(message: string, ...params: any[]): void {
        this.outputMessage(this.output.error, message, ...params);
    }

    private outputMessage(func: typeof this.output.log, message: string, ...params: any[]): void {
        func(this.addTime(message), ...params);
    }

    private addTime(message: string): string {
        return `${new Date().toISOString()} : ${message}`;
    }
}
