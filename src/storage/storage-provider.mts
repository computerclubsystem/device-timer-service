import { DeviceStateLog } from './entities/device-state-log.mjs';
import { IDevice } from './entities/device.mjs';
import { StorageProviderConfig } from './storage-provider-config.mjs';
import { StorageProviderInitResult } from './storage-provider-init-result.mjs';
import { IUser } from './entities/user.mjs';

export interface StorageProvider {
    init(config: StorageProviderConfig): Promise<StorageProviderInitResult>;
    addDeviceStateLog(entity: DeviceStateLog): Promise<void>;
    getDeviceByCertificateThumbprint(certificateThumbprint: string): Promise<IDevice | undefined>;
    saveDevice(device: IDevice): Promise<IDevice | undefined>;
    getUser(username: string, passwordHash: string): Promise<IUser | undefined>;
}