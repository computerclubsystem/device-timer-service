import { readFileSync } from 'node:fs';

export class FileSystemHelper {
    getFileTextContent(filePath: string): string {
        return readFileSync(filePath).toString();
    }
}
